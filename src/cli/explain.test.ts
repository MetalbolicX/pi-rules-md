/**
 * Tests for `pi-rules explain` (S12): print the S4 `why` report from the CLI.
 *
 * Scope pinned here: the command answers the PATH-condition question only. It
 * reads lint's default directories (`<cwd>/.pi/rules` and the global rules
 * dir), native rule files only, and prints `explainPath` lines verbatim — no
 * session, no trust gate, no muting, no injection. Nested and ancestor rule
 * directories are deliberately out of scope, and that is pinned too.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { CliIO, FlowOptions } from "./main.ts";
import { runCli } from "./main.ts";
import { EXPLAIN_USAGE, discoverNativeRules, explainFlow, toCwdScale } from "./explain.ts";
import type { ExplainDeps } from "./explain.ts";
import { explainPath } from "../explain.ts";
import { normalizedPath, ruleId } from "../types.ts";
import type { Rule } from "../types.ts";

const roots: string[] = [];
const originalCwd = process.cwd();

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-rules-explain-"));
  roots.push(root);
  return root;
}

async function writeFileAt(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

/** CliIO whose agent directory is a temp path, never the real home. */
async function flowIo(parent?: string): Promise<{ io: CliIO; agentDir: string }> {
  const base = parent ?? (await workspace());
  const agentDir = path.join(base, "agent");
  await mkdir(agentDir, { recursive: true });
  return { io: { env: { ...process.env, PI_RULES_AGENT_DIR: agentDir, VITEST: "true" }, stdout: [], stderr: [] }, agentDir };
}

function flowOptions(io: CliIO, agentDir: string, extra: Partial<FlowOptions> = {}): FlowOptions {
  return { dryRun: false, io, agentDir, ...extra };
}

const ALWAYS = "---\ndescription: Always\nversion: 1\nalwaysApply: true\n---\n\nAlways body.\n";
const DOCS = '---\ndescription: Docs rules\nversion: 1\nglobs: "docs/**"\nmatch: touched\n---\n\nDocs body.\n';
const TOOLS_ONLY = "---\ndescription: Tools only\nversion: 1\ntools: [bash]\n---\n\nTools body.\n";
const TABS = '---\ndescription: Tabs\nversion: 1\nglobs: "src/**/*.ts"\nmatch: touched\ntools: [edit]\n---\n\nTabs body.\n';

/** Writes the standard fixture tree into one project's `.pi/rules`. */
async function fixtureProject(parent: string): Promise<string> {
  const project = path.join(parent, "project");
  const rules = path.join(project, ".pi", "rules");
  await writeFileAt(path.join(rules, "always.md"), ALWAYS);
  await writeFileAt(path.join(rules, "docs.md"), DOCS);
  await writeFileAt(path.join(rules, "tabs.md"), TABS);
  await writeFileAt(path.join(rules, "tools-only.md"), TOOLS_ONLY);
  return project;
}

/** The pinned report for `src/app.ts` over the fixture tree, in discovery order. */
const EXPECTED_SRC_APP = [
  "why src/app.ts (treated as touched this session):",
  "always: always active (path-independent)",
  "docs: not activated by this path (no touched path matches globs: docs/**)",
  "tabs: would activate — glob `src/**/*.ts`",
  "  also requires tools: edit",
  "tools-only: path-independent (activated by its non-path conditions, not by this path)",
  "  trigger tools: bash",
];

const ruleWith = (fields: { readonly id: string; readonly globs?: readonly string[] }): Rule => ({
  id: ruleId(fields.id),
  path: normalizedPath(`/work/.pi/rules/${fields.id}.md`),
  source: "project",
  description: `rule ${fields.id}`,
  ...(fields.globs === undefined ? {} : { globs: fields.globs }),
  match: "touched",
  priority: 0,
  enforcement: "inform",
  alwaysApply: false,
  version: 1,
  content: `body of ${fields.id}\n`,
});

describe("pi-rules explain — report", () => {
  test("prints the why report for the default project rules dir verbatim, exit 0", async () => {
    const root = await workspace();
    const project = await fixtureProject(root);
    process.chdir(project);
    const { io, agentDir } = await flowIo(root);

    await expect(explainFlow(flowOptions(io, agentDir, { path: "src/app.ts" }))).resolves.toBe(0);

    expect(io.stdout).toEqual(EXPECTED_SRC_APP);
    expect(io.stderr).toEqual([]);
  });

  test("an empty rules tree prints the header line only and still exits 0", async () => {
    const root = await workspace();
    const project = path.join(root, "project");
    await mkdir(project, { recursive: true });
    process.chdir(project);
    const { io, agentDir } = await flowIo(root);

    await expect(explainFlow(flowOptions(io, agentDir, { path: "src/app.ts" }))).resolves.toBe(0);

    expect(io.stdout).toEqual(["why src/app.ts (treated as touched this session):"]);
    expect(io.stderr).toEqual([]);
  });

  test("a path no rule matches is reported, not treated as an error", async () => {
    const root = await workspace();
    const project = await fixtureProject(root);
    process.chdir(project);
    const { io, agentDir } = await flowIo(root);

    await expect(explainFlow(flowOptions(io, agentDir, { path: "other/file.txt" }))).resolves.toBe(0);

    expect(io.stdout).toContain("tabs: not activated by this path (no touched path matches globs: src/**/*.ts)");
    expect(io.stdout[0]).toBe("why other/file.txt (treated as touched this session):");
  });

  test("global rules come after project rules in one report", async () => {
    const root = await workspace();
    const project = path.join(root, "project");
    await mkdir(project, { recursive: true });
    const { io, agentDir } = await flowIo(root);
    await writeFileAt(path.join(agentDir, "rules", "global-always.md"), ALWAYS);
    await writeFileAt(path.join(project, ".pi", "rules", "project-always.md"), ALWAYS);
    process.chdir(project);

    await expect(explainFlow(flowOptions(io, agentDir, { path: "src/app.ts" }))).resolves.toBe(0);

    expect(io.stdout).toEqual([
      "why src/app.ts (treated as touched this session):",
      "project-always: always active (path-independent)",
      "global-always: always active (path-independent)",
    ]);
  });

  test("an absolute path inside the working directory explains on the cwd scale", async () => {
    const root = await workspace();
    const project = await fixtureProject(root);
    process.chdir(project);
    const { io, agentDir } = await flowIo(root);

    await expect(
      explainFlow(flowOptions(io, agentDir, { path: path.join(project, "src", "app.ts") })),
    ).resolves.toBe(0);

    expect(io.stdout).toEqual(EXPECTED_SRC_APP);
  });

  test("backslash paths are normalized before matching", async () => {
    const root = await workspace();
    const project = await fixtureProject(root);
    process.chdir(project);
    const { io, agentDir } = await flowIo(root);

    await expect(explainFlow(flowOptions(io, agentDir, { path: "src\\app.ts" }))).resolves.toBe(0);

    expect(io.stdout).toEqual(EXPECTED_SRC_APP);
  });

  test("a rule file that fails to parse is reported on stderr without changing stdout or the exit code", async () => {
    const root = await workspace();
    const project = await fixtureProject(root);
    const broken = path.join(project, ".pi", "rules", "broken.md");
    await writeFileAt(broken, "---\ndescription: Broken\nversion: 1\nbanana: yes\n---\n\nBroken body.\n");
    process.chdir(project);
    const { io, agentDir } = await flowIo(root);

    await expect(explainFlow(flowOptions(io, agentDir, { path: "src/app.ts" }))).resolves.toBe(0);

    expect(io.stdout).toEqual(EXPECTED_SRC_APP);
    expect(io.stderr).toEqual([`${broken}: unknown-key: unknown frontmatter key "banana"`]);
  });

  test("nested .pi/rules below cwd are out of scope (lint's default read set only)", async () => {
    const root = await workspace();
    const project = await fixtureProject(root);
    await writeFileAt(path.join(project, "packages", "app", ".pi", "rules", "nested.md"), ALWAYS);
    process.chdir(project);
    const { io, agentDir } = await flowIo(root);

    await expect(explainFlow(flowOptions(io, agentDir, { path: "src/app.ts" }))).resolves.toBe(0);

    expect(io.stdout).toEqual(EXPECTED_SRC_APP);
    expect(io.stdout.some((line) => line.startsWith("nested:"))).toBe(false);
  });

  test("discovery errors on an absent agent dir do not appear (nothing to read)", async () => {
    const root = await workspace();
    const project = path.join(root, "project");
    await mkdir(project, { recursive: true });
    process.chdir(project);
    const { io, agentDir } = await flowIo(root);

    await expect(explainFlow(flowOptions(io, agentDir, { path: "src/app.ts" }))).resolves.toBe(0);

    expect(io.stderr).toEqual([]);
  });
});

describe("pi-rules explain — injected discovery", () => {
  test("stdout is exactly explainPath output for the discovered rules", async () => {
    const rules = [ruleWith({ id: "a", globs: ["src/**"] }), ruleWith({ id: "b", globs: ["docs/**"] })];
    const deps: ExplainDeps = { discover: async () => ({ rules, errors: [] }) };
    const output: CliIO = { env: {}, stdout: [], stderr: [] };

    await expect(explainFlow(flowOptions(output, "/agent", { path: "src/x.ts" }), deps)).resolves.toBe(0);

    expect(output.stdout).toEqual(explainPath(rules, "src/x.ts"));
  });

  test("a discovery failure is reported on stderr and exits 1", async () => {
    const deps: ExplainDeps = {
      discover: async () => {
        throw new Error("boom");
      },
    };
    const output: CliIO = { env: {}, stdout: [], stderr: [] };

    await expect(explainFlow(flowOptions(output, "/agent", { path: "src/x.ts" }), deps)).resolves.toBe(1);

    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual(["error: failed to discover rules: boom"]);
  });
});

describe("toCwdScale", () => {
  test("a relative path passes through with separators normalized", () => {
    expect(toCwdScale("src\\app.ts", "/work")).toBe("src/app.ts");
    expect(toCwdScale("./src/app.ts", "/work")).toBe("./src/app.ts");
  });

  test("an absolute path inside cwd becomes cwd-relative", () => {
    expect(toCwdScale("/work/src/app.ts", "/work")).toBe("src/app.ts");
    expect(toCwdScale("/work/a/b/c.md", "/work/a")).toBe("b/c.md");
  });

  test("cwd itself becomes .", () => {
    expect(toCwdScale("/work", "/work")).toBe(".");
  });

  test("an absolute path outside cwd is explained as given", () => {
    expect(toCwdScale("/elsewhere/app.ts", "/work")).toBe("/elsewhere/app.ts");
  });
});

describe("pi-rules explain — usage errors", () => {
  test("a missing path argument exits 2 with the explain usage", async () => {
    const output: CliIO = { env: {}, stdout: [], stderr: [] };

    await expect(explainFlow(flowOptions(output, "/agent"))).resolves.toBe(2);

    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual(["error: a path argument is required", EXPLAIN_USAGE]);
  });

  test("a blank path argument is a usage error", async () => {
    const output: CliIO = { env: {}, stdout: [], stderr: [] };

    await expect(explainFlow(flowOptions(output, "/agent", { path: "   " }))).resolves.toBe(2);

    expect(output.stderr.join("\n")).toContain("a path argument is required");
  });
});

describe("pi-rules explain — end-to-end through the CLI dispatch", () => {
  test("runCli(['explain', path]) prints the same report and exits 0", async () => {
    const root = await workspace();
    const project = await fixtureProject(root);
    process.chdir(project);
    const { io } = await flowIo(root);

    await expect(runCli(["explain", "src/app.ts"], io)).resolves.toBe(0);

    expect(io.stdout).toEqual(EXPECTED_SRC_APP);
    expect(io.stderr).toEqual([]);
  });

  test("runCli(['explain']) without a path exits 2 with the explain usage", async () => {
    const root = await workspace();
    process.chdir(root);
    const { io } = await flowIo(root);

    await expect(runCli(["explain"], io)).resolves.toBe(2);

    expect(io.stderr.join("\n")).toContain("Usage: pi-rules explain <path>");
  });

  test("runCli(['explain', a, b]) rejects the extra positional argument", async () => {
    const root = await workspace();
    process.chdir(root);
    const { io } = await flowIo(root);

    await expect(runCli(["explain", "a", "b"], io)).resolves.toBe(2);

    expect(io.stderr.join("\n")).toContain("Usage: pi-rules explain <path>");
  });

  test("runCli(['explain', path, '--agent-dir', dir]) moves the global rules root", async () => {
    const root = await workspace();
    const project = path.join(root, "project");
    await mkdir(project, { recursive: true });
    const elsewhere = path.join(root, "elsewhere");
    await writeFileAt(path.join(elsewhere, "rules", "global-always.md"), ALWAYS);
    process.chdir(project);
    const { io } = await flowIo(root);

    await expect(runCli(["explain", "src/app.ts", "--agent-dir", elsewhere], io)).resolves.toBe(0);

    expect(io.stdout).toEqual([
      "why src/app.ts (treated as touched this session):",
      "global-always: always active (path-independent)",
    ]);
  });

  test("discoverNativeRules reads the cwd project dir and the agent rules dir", async () => {
    const root = await workspace();
    const project = await fixtureProject(root);
    const { agentDir } = await flowIo(root);
    await writeFileAt(path.join(agentDir, "rules", "global.md"), ALWAYS);

    const found = await discoverNativeRules({ cwd: project, agentDir });

    expect(found.rules.map((rule) => rule.id)).toEqual(["always", "docs", "tabs", "tools-only", "global"]);
    expect(found.rules.map((rule) => rule.source)).toEqual(["project", "project", "project", "project", "global"]);
    expect(found.errors).toEqual([]);
  });
});

describe("pi-rules explain — help", () => {
  test("help documents the command shape, read set, scope and exit codes", () => {
    expect(EXPLAIN_USAGE).toContain("Usage: pi-rules explain <path>");
    expect(EXPLAIN_USAGE).toContain(".pi/rules");
    expect(EXPLAIN_USAGE).toContain("~/.pi/agent/rules");
    expect(EXPLAIN_USAGE).toContain("path-condition");
    expect(EXPLAIN_USAGE).toContain("Exit code: 0");
  });
});
