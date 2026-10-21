import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { CliIO, FlowOptions } from "./main.ts";
import { runCli } from "./main.ts";
import { LINT_USAGE, lintFlow, lintRuleDirs, nodeLintDeps, resolveLintTargets } from "./lint.ts";
import type { LintDeps, LintTarget } from "./lint.ts";
import { normalizedPath } from "../types.ts";

const roots: string[] = [];
const originalCwd = process.cwd();

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-rules-lint-"));
  roots.push(root);
  return root;
}

async function writeFileAt(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

const VALID = "---\ndescription: Use tabs\nversion: 1\nalwaysApply: true\n---\n\nTabs please.\n";
const UNKNOWN_KEY = "---\ndescription: Use tabs\nversion: 1\nalwaysApply: true\nbanana: yes\n---\n\nTabs please.\n";
const NO_FRONTMATTER = "just markdown\n";

/** CliIO whose agent directory is a temp path, never the real home. */
async function flowIo(parent?: string): Promise<{ io: CliIO; agentDir: string }> {
  const base = parent ?? (await workspace());
  const agentDir = path.join(base, "agent");
  await mkdir(agentDir, { recursive: true });
  return { io: { env: { ...process.env, PI_RULES_AGENT_DIR: agentDir, VITEST: "true" }, stdout: [], stderr: [] }, agentDir };
}

function flowOptions(io: CliIO, extra: Partial<FlowOptions> = {}): FlowOptions {
  return { dryRun: false, io, ...extra };
}

const target = (dir: string, required = true): LintTarget => ({ dir: normalizedPath(dir), source: "project", required });

describe("pi-rules lint — output and exit codes", () => {
  test("a directory with only valid rules exits 0 and prints just the summary", async () => {
    const root = await workspace();
    await writeFileAt(path.join(root, "valid.md"), VALID);
    const { io } = await flowIo();

    await expect(lintFlow(flowOptions(io, { dirs: [root] }))).resolves.toBe(0);

    expect(io.stdout).toEqual(["lint: 1 rule files, 0 errors"]);
    expect(io.stderr).toEqual([]);
  });

  test("a parse error prints one `<file>: <code>: <message>` line and exits 1", async () => {
    const root = await workspace();
    const file = path.join(root, "bad.md");
    await writeFileAt(file, UNKNOWN_KEY);
    const { io } = await flowIo();

    await expect(lintFlow(flowOptions(io, { dirs: [root] }))).resolves.toBe(1);

    expect(io.stdout).toEqual([`${file}: unknown-key: unknown frontmatter key "banana"`, "lint: 1 rule files, 1 errors"]);
    expect(io.stderr).toEqual([]);
  });

  test("multiple errors are sorted by path then code", async () => {
    const root = await workspace();
    const first = path.join(root, "a.md");
    const second = path.join(root, "b.md");
    await writeFileAt(second, UNKNOWN_KEY);
    await writeFileAt(first, NO_FRONTMATTER);
    await writeFileAt(path.join(root, "valid.md"), VALID);
    const { io } = await flowIo();

    await expect(lintFlow(flowOptions(io, { dirs: [root] }))).resolves.toBe(1);

    const lines = io.stdout;
    expect(lines).toHaveLength(3);
    expect(lines[0]?.startsWith(`${first}: missing-frontmatter: `)).toBe(true);
    expect(lines[1]).toBe(`${second}: unknown-key: unknown frontmatter key "banana"`);
    expect(lines[2]).toBe("lint: 3 rule files, 2 errors");
  });

  test("non-.md files are ignored and nested directories are scanned recursively", async () => {
    const root = await workspace();
    await writeFileAt(path.join(root, "valid.md"), VALID);
    await writeFileAt(path.join(root, "notes.txt"), NO_FRONTMATTER);
    const nested = path.join(root, "packages", "app", "deep", "bad.md");
    await writeFileAt(nested, UNKNOWN_KEY);
    const { io } = await flowIo();

    await expect(lintFlow(flowOptions(io, { dirs: [root] }))).resolves.toBe(1);

    expect(io.stdout).toEqual([
      `${nested}: unknown-key: unknown frontmatter key "banana"`,
      "lint: 2 rule files, 1 errors",
    ]);
  });

  test(".git and node_modules subtrees are never scanned", async () => {
    const root = await workspace();
    await writeFileAt(path.join(root, ".git", "bad.md"), UNKNOWN_KEY);
    await writeFileAt(path.join(root, "node_modules", "pkg", "bad.md"), UNKNOWN_KEY);
    const { io } = await flowIo();

    await expect(lintFlow(flowOptions(io, { dirs: [root] }))).resolves.toBe(0);

    expect(io.stdout).toEqual(["lint: 0 rule files, 0 errors"]);
  });

  test("an explicit directory that does not exist is an error (exit 1)", async () => {
    const root = await workspace();
    const missing = path.join(root, "absent");
    const { io } = await flowIo();

    await expect(lintFlow(flowOptions(io, { dirs: [missing] }))).resolves.toBe(1);

    expect(io.stdout).toEqual([`${missing}: source-unreadable: rules directory does not exist`, "lint: 0 rule files, 1 errors"]);
  });

  test("an unreadable rule file becomes a read-failure error line", async () => {
    const root = await workspace();
    const file = path.join(root, "locked.md");
    const deps: LintDeps = {
      listRuleFiles: async () => ["locked.md"],
      readFile: async () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
    };

    const report = await lintRuleDirs([target(root)], deps);

    expect(report.files).toBe(1);
    expect(report.errors).toEqual([
      { file, code: "read-failure", message: "failed to read rule file: EACCES: permission denied" },
    ]);
  });

  test("a rejected directory listing is collected as one source-unreadable error", async () => {
    const root = await workspace();
    const deps: LintDeps = {
      listRuleFiles: async () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
      readFile: nodeLintDeps().readFile,
    };

    const report = await lintRuleDirs([target(root)], deps);

    expect(report.files).toBe(0);
    expect(report.errors).toEqual([
      { file: root, code: "source-unreadable", message: "failed to list rules source: EACCES: permission denied" },
    ]);
  });
});

describe("pi-rules lint — default directories", () => {
  test("defaults are <cwd>/.pi/rules and <agent dir>/rules; absent defaults are not errors", async () => {
    const root = await workspace();
    const project = path.join(root, "project");
    await mkdir(project, { recursive: true });
    const { io, agentDir } = await flowIo();
    process.chdir(project);

    await expect(lintFlow(flowOptions(io))).resolves.toBe(0);

    expect(io.stdout).toEqual(["lint: 0 rule files, 0 errors"]);
    expect(resolveLintTargets({ cwd: project, dirs: [], agentDir })).toEqual([
      { dir: path.join(project, ".pi", "rules"), source: "project", required: false },
      { dir: path.join(agentDir, "rules"), source: "global", required: false },
    ]);
  });

  test("present default directories are linted", async () => {
    const root = await workspace();
    const project = path.join(root, "project");
    const projectRule = path.join(project, ".pi", "rules", "bad.md");
    await writeFileAt(projectRule, UNKNOWN_KEY);
    const { io, agentDir } = await flowIo(root);
    const globalRule = path.join(agentDir, "rules", "nested", "bad.md");
    await writeFileAt(globalRule, NO_FRONTMATTER);
    process.chdir(project);

    await expect(lintFlow(flowOptions(io))).resolves.toBe(1);

    expect(io.stdout).toEqual([
      `${globalRule}: missing-frontmatter: no frontmatter block: rule files must start with a \`---\` line and close it with a second \`---\` line`,
      `${projectRule}: unknown-key: unknown frontmatter key "banana"`,
      "lint: 2 rule files, 2 errors",
    ]);
  });

  test("explicit directories replace the defaults", async () => {
    const root = await workspace();
    const explicit = path.join(root, "explicit");
    await writeFileAt(path.join(explicit, "bad.md"), UNKNOWN_KEY);
    await writeFileAt(path.join(root, ".pi", "rules", "bad.md"), NO_FRONTMATTER);
    const { io } = await flowIo();
    process.chdir(root);

    await expect(lintFlow(flowOptions(io, { dirs: [explicit] }))).resolves.toBe(1);

    expect(io.stdout.at(-1)).toBe("lint: 1 rule files, 1 errors");
  });

  test("the same directory named twice is linted once", async () => {
    const root = await workspace();
    const file = path.join(root, "bad.md");
    await writeFileAt(file, UNKNOWN_KEY);
    const { io } = await flowIo();

    await expect(lintFlow(flowOptions(io, { dirs: [root, root, path.join(root, ".")] }))).resolves.toBe(1);

    expect(io.stdout).toEqual([`${file}: unknown-key: unknown frontmatter key "banana"`, "lint: 1 rule files, 1 errors"]);
  });

  test("relative explicit directories resolve against the working directory", async () => {
    const root = await workspace();
    const file = path.join(root, "rules", "bad.md");
    await writeFileAt(file, UNKNOWN_KEY);
    const { io } = await flowIo();
    process.chdir(root);

    await expect(lintFlow(flowOptions(io, { dirs: ["rules"] }))).resolves.toBe(1);

    expect(io.stdout[0]).toBe(`${file}: unknown-key: unknown frontmatter key "banana"`);
  });
});

describe("pi-rules lint — end-to-end through the CLI dispatch", () => {
  // Functional probe (a dist build would write outside this task's edit surface):
  // one valid + one invalid rule file, real fs, real `runCli` dispatch.
  test("runCli(['lint', dir]) prints one error line and exits 1", async () => {
    const root = await workspace();
    const invalid = path.join(root, "invalid.md");
    await writeFileAt(invalid, UNKNOWN_KEY);
    await writeFileAt(path.join(root, "valid.md"), VALID);
    const { io } = await flowIo();

    await expect(runCli(["lint", root], io)).resolves.toBe(1);

    expect(io.stdout).toEqual([`${invalid}: unknown-key: unknown frontmatter key "banana"`, "lint: 2 rule files, 1 errors"]);
    expect(io.stderr).toEqual([]);
  });

  test("runCli(['lint', dir]) exits 0 with only the summary when every rule is valid", async () => {
    const root = await workspace();
    await writeFileAt(path.join(root, "valid.md"), VALID);
    const { io } = await flowIo();

    await expect(runCli(["lint", root], io)).resolves.toBe(0);

    expect(io.stdout).toEqual(["lint: 1 rule files, 0 errors"]);
    expect(io.stderr).toEqual([]);
  });
});

describe("pi-rules lint — help", () => {
  test("help documents the command shape, defaults, output format and exit codes", () => {
    expect(LINT_USAGE).toContain("Usage: pi-rules lint [dir...]");
    expect(LINT_USAGE).toContain(".pi/rules");
    expect(LINT_USAGE).toContain("~/.pi/agent/rules");
    expect(LINT_USAGE).toContain("<file>: <code>: <message>");
    expect(LINT_USAGE).toContain("NOT linted");
    expect(LINT_USAGE).toContain("Exit code: 1");
  });
});
