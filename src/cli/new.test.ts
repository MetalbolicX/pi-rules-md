/**
 * Tests for `pi-rules new` (S12): scaffold a valid native rule file and refuse
 * to overwrite an existing one.
 *
 * The two claims that matter are pinned here as bytes and as behavior:
 * - the scaffold PARSES with the extension's own strict parser (`parseRule`),
 *   so a scaffolded rule can never be a file `/rules` would reject;
 * - an existing file is never touched — the refusal is the write itself
 *   (`flag: "wx"`), not a check-then-write race.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { CliIO, FlowOptions } from "./main.ts";
import { runCli } from "./main.ts";
import {
  NEW_USAGE,
  newFlow,
  nodeNewDeps,
  resolveNewTarget,
  scaffoldRuleFile,
  validateRuleName,
} from "./new.ts";
import type { NewDeps } from "./new.ts";
import { parseRule } from "../frontmatter.ts";
import { normalizedPath } from "../types.ts";

const roots: string[] = [];
const originalCwd = process.cwd();

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-rules-new-"));
  roots.push(root);
  return root;
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

/** The documented scaffold for one rule name — an independent copy of the bytes. */
const scaffold = (name: string): string =>
  [
    "---",
    `description: "${name}: describe when this rule applies"`,
    "version: 1",
    'globs: "src/**/*"',
    "match: touched",
    "priority: 0",
    "enforcement: inform",
    "load: pinned",
    "---",
    "",
    "Describe the rule here: what the agent should do, and when. This body is",
    "injected into the prompt whenever the rule activates, so replace this",
    "placeholder before relying on it.",
    "",
  ].join("\n");

describe("pi-rules new — scaffold content", () => {
  test("the scaffold is a valid native rule: parseRule accepts it", () => {
    const parsed = parseRule(scaffoldRuleFile("use-tabs"), {
      path: normalizedPath("/work/.pi/rules/use-tabs.md"),
      source: "project",
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.description).toBe("use-tabs: describe when this rule applies");
    expect(parsed.value.version).toBe(1);
    expect(parsed.value.globs).toEqual(["src/**/*"]);
    expect(parsed.value.match).toBe("touched");
    expect(parsed.value.priority).toBe(0);
    expect(parsed.value.enforcement).toBe("inform");
    expect(parsed.value.load).toBe("pinned");
    expect(parsed.value.alwaysApply).toBe(false);
  });

  test("the scaffold pins the documented bytes", () => {
    expect(scaffoldRuleFile("use-tabs")).toBe(scaffold("use-tabs"));
  });

  test("a name with YAML-significant characters still parses (quoted description)", () => {
    const parsed = parseRule(scaffoldRuleFile('a: "b"'), {
      path: normalizedPath("/work/.pi/rules/a.md"),
      source: "project",
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.description).toBe('a: "b": describe when this rule applies');
  });
});

describe("pi-rules new — rule name validation", () => {
  test.each(["use-tabs", "my_rule", "Rule2"])("accepts the plain name %s", (name) => {
    expect(validateRuleName(name)).toEqual({ ok: true, value: name });
  });

  test("a trailing .md is stripped instead of doubled", () => {
    expect(validateRuleName("use-tabs.md")).toEqual({ ok: true, value: "use-tabs" });
  });

  test.each(["", "   ", ".md"])("rejects the empty name %j", (name) => {
    const result = validateRuleName(name);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("required");
  });

  test.each(["a/b", "../escape", "nested/rule", "win\\path"])("rejects the path-like name %s", (name) => {
    const result = validateRuleName(name);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("path separators");
  });

  test.each([".", "..", ".hidden"])("rejects the dot name %s", (name) => {
    const result = validateRuleName(name);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('"."');
  });

  test("rejects names carrying whitespace", () => {
    const result = validateRuleName("two words");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("whitespace");
  });

  test("rejects surrounding whitespace", () => {
    const result = validateRuleName(" rule");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("whitespace");
  });
});

describe("pi-rules new — target resolution", () => {
  test("the project target is <cwd>/.pi/rules/<name>.md", () => {
    expect(resolveNewTarget({ cwd: "/work", name: "use-tabs", global: false, agentDir: "/agent" })).toEqual({
      dir: "/work/.pi/rules",
      file: "/work/.pi/rules/use-tabs.md",
    });
  });

  test("--global targets <agent dir>/rules/<name>.md", () => {
    expect(resolveNewTarget({ cwd: "/work", name: "use-tabs", global: true, agentDir: "/agent" })).toEqual({
      dir: "/agent/rules",
      file: "/agent/rules/use-tabs.md",
    });
  });
});

describe("pi-rules new — creating rule files", () => {
  test("creates the rules directory and the file, prints the created path, exits 0", async () => {
    const root = await workspace();
    const project = path.join(root, "project");
    await mkdir(project, { recursive: true });
    process.chdir(project);
    const { io, agentDir } = await flowIo(root);

    await expect(newFlow(flowOptions(io, agentDir, { name: "use-tabs" }))).resolves.toBe(0);

    const file = path.join(project, ".pi", "rules", "use-tabs.md");
    expect(io.stdout).toEqual([`created ${file}`]);
    expect(io.stderr).toEqual([]);
    expect(await readFile(file, "utf8")).toBe(scaffold("use-tabs"));
    // The created file is a valid rule for the extension's own parser.
    expect(parseRule(await readFile(file, "utf8"), { path: normalizedPath(file), source: "project" }).ok).toBe(true);
  });

  test("--global scaffolds into the agent rules directory and leaves the project alone", async () => {
    const root = await workspace();
    const project = path.join(root, "project");
    await mkdir(project, { recursive: true });
    process.chdir(project);
    const { io, agentDir } = await flowIo(root);

    await expect(newFlow(flowOptions(io, agentDir, { name: "global-rule", global: true }))).resolves.toBe(0);

    const file = path.join(agentDir, "rules", "global-rule.md");
    expect(io.stdout).toEqual([`created ${file}`]);
    expect(await readFile(file, "utf8")).toBe(scaffold("global-rule"));
    await expect(stat(path.join(project, ".pi", "rules", "global-rule.md"))).rejects.toThrow();
  });

  test("an existing file is never overwritten: exit 1, file untouched", async () => {
    const root = await workspace();
    const project = path.join(root, "project");
    const existing = path.join(project, ".pi", "rules", "use-tabs.md");
    await mkdir(path.dirname(existing), { recursive: true });
    await writeFile(existing, "hand-written rule\n");
    process.chdir(project);
    const { io, agentDir } = await flowIo(root);

    await expect(newFlow(flowOptions(io, agentDir, { name: "use-tabs" }))).resolves.toBe(1);

    expect(io.stdout).toEqual([]);
    expect(io.stderr).toEqual([`error: ${existing} already exists; refusing to overwrite`]);
    expect(await readFile(existing, "utf8")).toBe("hand-written rule\n");
  });

  test("a write failure is reported and exits 1 without a crash", async () => {
    const root = await workspace();
    process.chdir(root);
    const { io, agentDir } = await flowIo(root);
    const deps: NewDeps = {
      mkdir: nodeNewDeps().mkdir,
      writeFile: async () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
    };

    await expect(newFlow(flowOptions(io, agentDir, { name: "use-tabs" }), deps)).resolves.toBe(1);

    expect(io.stdout).toEqual([]);
    expect(io.stderr).toEqual([
      `error: failed to create ${path.join(root, ".pi", "rules", "use-tabs.md")}: EACCES: permission denied`,
    ]);
  });

  test("a directory creation failure is reported and exits 1 without a crash", async () => {
    const root = await workspace();
    process.chdir(root);
    const { io, agentDir } = await flowIo(root);
    let wrote = false;
    const deps: NewDeps = {
      mkdir: async () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
      writeFile: async () => {
        wrote = true;
      },
    };

    await expect(newFlow(flowOptions(io, agentDir, { name: "use-tabs" }), deps)).resolves.toBe(1);

    expect(wrote).toBe(false);
    expect(io.stderr[0]).toContain("failed to create");
  });

  test("a target path occupied by a directory is refused, not clobbered", async () => {
    const root = await workspace();
    const project = path.join(root, "project");
    const occupied = path.join(project, ".pi", "rules", "use-tabs.md");
    await mkdir(occupied, { recursive: true });
    process.chdir(project);
    const { io, agentDir } = await flowIo(root);

    await expect(newFlow(flowOptions(io, agentDir, { name: "use-tabs" }))).resolves.toBe(1);

    expect(io.stdout).toEqual([]);
    // The exclusive create reports EEXIST for any existing path, directory included.
    expect(io.stderr).toEqual([`error: ${occupied} already exists; refusing to overwrite`]);
    expect((await stat(occupied)).isDirectory()).toBe(true);
  });

  test("a missing name is a usage error: exit 2 and the new usage on stderr", async () => {
    const root = await workspace();
    process.chdir(root);
    const { io, agentDir } = await flowIo(root);

    await expect(newFlow(flowOptions(io, agentDir))).resolves.toBe(2);

    expect(io.stdout).toEqual([]);
    expect(io.stderr).toEqual(["error: rule name is required", NEW_USAGE]);
  });

  test("an invalid name is a usage error that never touches the filesystem", async () => {
    const root = await workspace();
    process.chdir(root);
    const { io, agentDir } = await flowIo(root);

    await expect(newFlow(flowOptions(io, agentDir, { name: "../escape" }))).resolves.toBe(2);

    expect(io.stdout).toEqual([]);
    expect(io.stderr[0]).toContain("invalid rule name");
    expect(io.stderr[0]).toContain("path separators");
    expect(io.stderr[1]).toBe(NEW_USAGE);
  });
});

describe("pi-rules new — end-to-end through the CLI dispatch", () => {
  test("runCli(['new', name]) scaffolds a file, and refuses the second run", async () => {
    const root = await workspace();
    const project = path.join(root, "project");
    await mkdir(project, { recursive: true });
    process.chdir(project);
    const { io, agentDir } = await flowIo(root);
    const file = path.join(project, ".pi", "rules", "use-tabs.md");

    await expect(runCli(["new", "use-tabs"], io)).resolves.toBe(0);
    expect(io.stdout).toEqual([`created ${file}`]);
    expect(await readFile(file, "utf8")).toBe(scaffold("use-tabs"));

    const second: CliIO = { ...io, stdout: [], stderr: [] };
    await expect(runCli(["new", "use-tabs"], second)).resolves.toBe(1);
    expect(second.stdout).toEqual([]);
    expect(second.stderr).toEqual([`error: ${file} already exists; refusing to overwrite`]);
    expect(await readFile(file, "utf8")).toBe(scaffold("use-tabs"));
    expect(io.env.PI_RULES_AGENT_DIR).toBe(agentDir);
  });

  test("runCli(['new', name, '--global']) scaffolds into the agent rules directory", async () => {
    const root = await workspace();
    process.chdir(root);
    const { io, agentDir } = await flowIo(root);

    await expect(runCli(["new", "shared", "--global"], io)).resolves.toBe(0);

    const file = path.join(agentDir, "rules", "shared.md");
    expect(io.stdout).toEqual([`created ${file}`]);
    expect(await readFile(file, "utf8")).toBe(scaffold("shared"));
  });

  test("runCli(['new']) without a name exits 2 with the new usage", async () => {
    const root = await workspace();
    process.chdir(root);
    const { io } = await flowIo(root);

    await expect(runCli(["new"], io)).resolves.toBe(2);

    expect(io.stderr.join("\n")).toContain("Usage: pi-rules new <name>");
  });

  test("runCli(['new', a, b]) rejects the extra positional argument", async () => {
    const root = await workspace();
    process.chdir(root);
    const { io } = await flowIo(root);

    await expect(runCli(["new", "a", "b"], io)).resolves.toBe(2);

    expect(io.stderr.join("\n")).toContain("Usage: pi-rules new <name>");
  });
});

describe("pi-rules new — help", () => {
  test("help documents the command shape, target, refusal and exit codes", () => {
    expect(NEW_USAGE).toContain("Usage: pi-rules new <name> [--global]");
    expect(NEW_USAGE).toContain(".pi/rules");
    expect(NEW_USAGE).toContain("--global");
    expect(NEW_USAGE).toContain("refus");
    expect(NEW_USAGE).toContain("Exit code: 0 when the file was created, 1 when");
  });
});
