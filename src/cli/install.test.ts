import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { installFlow } from "./install.ts";
import type { CliIO, FlowOptions } from "./main.ts";

const roots: string[] = [];
async function fixture(packages: unknown[] = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-rules-install-"));
  roots.push(root);
  const agentDir = path.join(root, "agent");
  const bin = path.join(root, "bin");
  await mkdir(agentDir, { recursive: true });
  await mkdir(bin);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages }));
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

describe("installFlow", () => {
  test("removes matching settings entries in order before installing", async () => {
    const f = await fixture(["npm:pi-rules-md", "git:https://example.test/pi-rules-md.git", "npm:other"]);
    expect(await installFlow(f.options)).toBe(0);
    expect(await records(f.record)).toEqual(["remove npm:pi-rules-md", "remove git:https://example.test/pi-rules-md.git", "install npm:pi-rules-md"]);
  });

  test("aborts on the first failed stale removal", async () => {
    const f = await fixture(["npm:pi-rules-md"]);
    f.io.env.PI_RULES_TEST_EXIT = "4";
    expect(await installFlow(f.options)).toBe(4);
    expect(await records(f.record)).toEqual(["remove npm:pi-rules-md"]);
  });

  test("skips dedupe after settings errors and still installs", async () => {
    const f = await fixture();
    await writeFile(path.join(f.agentDir, "settings.json"), "{");
    expect(await installFlow(f.options)).toBe(0);
    expect(await records(f.record)).toEqual(["install npm:pi-rules-md"]);
    expect(f.io.stderr).toHaveLength(1);
  });

  test("uses project scope for removals and install", async () => {
    const f = await fixture();
    const project = path.join(f.root, "project");
    await mkdir(path.join(project, ".git"), { recursive: true });
    await mkdir(path.join(project, ".pi"), { recursive: true });
    await writeFile(path.join(project, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:pi-rules-md"] }));
    const oldCwd = process.cwd();
    process.chdir(project);
    f.options.local = true;
    try {
      expect(await installFlow(f.options)).toBe(0);
      expect(await records(f.record)).toEqual(["remove npm:pi-rules-md --local", "install npm:pi-rules-md --local"]);
    } finally { process.chdir(oldCwd); }
  });

  test("reports installation and stale-entry count with doctor tip", async () => {
    const f = await fixture(["npm:pi-rules-md"]);
    expect(await installFlow(f.options)).toBe(0);
    expect(f.io.stdout.join("\n")).toContain("✓ Installed pi-rules-md (npm:pi-rules-md), removed 1 stale entry\ntip: Run pi-rules doctor");
  });

  test("writes fallback output to the console when no io is supplied", async () => {
    const f = await fixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await installFlow({ agentDir: f.agentDir, dryRun: true })).toBe(0);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("[dry-run] Would run: pi install npm:pi-rules-md"));
    } finally { log.mockRestore(); }
  });

  test("reports installation without stale-entry count", async () => {
    const f = await fixture();
    expect(await installFlow(f.options)).toBe(0);
    expect(f.io.stdout.join("\n")).toBe("✓ Installed pi-rules-md (npm:pi-rules-md)\ntip: Run pi-rules doctor");
  });

  test("dry run prints commands without creating the record file", async () => {
    const f = await fixture(["npm:pi-rules-md"]);
    f.options.dryRun = true;
    expect(await installFlow(f.options)).toBe(0);
    expect(await records(f.record)).toEqual([]);
    expect(f.io.stdout.join("\n")).toContain("[dry-run] Would run: pi install npm:pi-rules-md");
  });
});
