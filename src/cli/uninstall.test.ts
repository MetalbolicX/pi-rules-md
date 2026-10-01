import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { uninstallFlow } from "./uninstall.ts";
import type { CliIO, FlowOptions } from "./main.ts";

const roots: string[] = [];
async function fixture(personal: unknown[] = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-rules-uninstall-"));
  roots.push(root);
  const agentDir = path.join(root, "agent");
  const bin = path.join(root, "bin");
  await mkdir(agentDir, { recursive: true });
  await mkdir(bin);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: personal }));
  const record = path.join(root, "record");
  const pi = path.join(bin, "pi");
  await writeFile(pi, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PI_RULES_TEST_RECORD"\nexit "${PI_RULES_TEST_EXIT:-0}"\n');
  await chmod(pi, 0o755);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, PI_RULES_TEST_RECORD: record, VITEST: "true" };
  const io: CliIO = { env, stdout: [], stderr: [] };
  const options: FlowOptions = { agentDir, dryRun: false, io };
  return { root, agentDir, record, io, options };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function records(record: string): Promise<string[]> {
  try { return (await readFile(record, "utf8")).trim().split("\n"); } catch { return []; }
}
async function store(agentDir: string) {
  const location = path.join(agentDir, "npm", "node_modules", "pi-rules-md");
  await mkdir(location, { recursive: true });
  return location;
}

describe("uninstallFlow", () => {
  test("continues attempting every matching removal after failures", async () => {
    const f = await fixture(["npm:pi-rules-md", "git:https://example.test/pi-rules-md.git"]);
    f.io.env.PI_RULES_TEST_EXIT = "4";
    expect(await uninstallFlow(f.options)).toBe(1);
    expect(await records(f.record)).toEqual(["remove npm:pi-rules-md", "remove git:https://example.test/pi-rules-md.git"]);
  });

  test("reports when no matching entries are installed", async () => {
    const f = await fixture(["npm:other"]);
    expect(await uninstallFlow(f.options)).toBe(0);
    expect(f.io.stdout).toContain("✓ pi-rules-md not installed");
  });

  test("warns about unmatched local entries and never removes them", async () => {
    const f = await fixture(["./missing-package"]);
    expect(await uninstallFlow(f.options)).toBe(0);
    expect(f.io.stderr).toContain("warning: local entry does not look like pi-rules-md, leaving it: ./missing-package");
    expect(await records(f.record)).toEqual([]);
  });

  test("refuses to purge a store resolved outside the agent directory", async () => {
    const f = await fixture(["npm:pi-rules-md"]);
    const outside = path.join(f.root, "outside");
    await mkdir(path.join(outside, "node_modules", "pi-rules-md"), { recursive: true });
    await symlink(outside, path.join(f.agentDir, "npm"));
    f.options.purge = true;
    expect(await uninstallFlow(f.options)).toBe(1);
    expect(f.io.stderr.join("\n")).toContain("refusing to purge unsafe package store path:");
    expect(await records(f.record)).toEqual(["remove npm:pi-rules-md"]);
  });

  test("purges the guarded personal store after removals", async () => {
    const f = await fixture(["npm:pi-rules-md"]);
    const storePath = await store(f.agentDir);
    f.options.purge = true;
    expect(await uninstallFlow(f.options)).toBe(0);
    await expect(readFile(storePath)).rejects.toThrow();
    expect(f.io.stdout.join("\n")).toContain("✓ removed package store");
  });

  test("purges the guarded personal store when no matches exist", async () => {
    const f = await fixture();
    const storePath = await store(f.agentDir);
    f.options.purge = true;
    expect(await uninstallFlow(f.options)).toBe(0);
    await expect(readFile(storePath)).rejects.toThrow();
  });

  test("does not purge the personal store for project-scope purge", async () => {
    const f = await fixture();
    const storePath = await store(f.agentDir);
    const project = path.join(f.root, "project");
    await mkdir(path.join(project, ".git"), { recursive: true });
    await mkdir(path.join(project, ".pi"), { recursive: true });
    await writeFile(path.join(project, ".pi", "settings.json"), JSON.stringify({ packages: [] }));
    const oldCwd = process.cwd();
    process.chdir(project);
    f.options.local = true;
    f.options.purge = true;
    try {
      expect(await uninstallFlow(f.options)).toBe(0);
      expect(f.io.stdout).toContain("nothing to purge in project scope");
      expect(existsSync(storePath)).toBe(true);
    } finally { process.chdir(oldCwd); }
  });

  test("local uninstall only reads and removes project entries", async () => {
    const f = await fixture(["npm:pi-rules-md"]);
    const project = path.join(f.root, "project");
    await mkdir(path.join(project, ".git"), { recursive: true });
    await mkdir(path.join(project, ".pi"), { recursive: true });
    await writeFile(path.join(project, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:pi-rules-md"] }));
    const oldCwd = process.cwd();
    process.chdir(project);
    f.options.local = true;
    try {
      expect(await uninstallFlow(f.options)).toBe(0);
      expect(await records(f.record)).toEqual(["remove npm:pi-rules-md --local"]);
    } finally { process.chdir(oldCwd); }
  });
});
