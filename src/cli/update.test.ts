import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { updateFlow } from "./update.ts";
import type { CliIO, FlowOptions } from "./main.ts";

const roots: string[] = [];
async function fixture(personal: unknown[] = [], project?: unknown[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-rules-update-"));
  roots.push(root);
  const agentDir = path.join(root, "agent");
  const bin = path.join(root, "bin");
  await mkdir(agentDir, { recursive: true });
  await mkdir(bin);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: personal }));
  if (project) {
    const projectDir = path.join(root, "project");
    await mkdir(path.join(projectDir, ".git"), { recursive: true });
    await mkdir(path.join(projectDir, ".pi"), { recursive: true });
    await writeFile(path.join(projectDir, ".pi", "settings.json"), JSON.stringify({ packages: project }));
  }
  const record = path.join(root, "record");
  const pi = path.join(bin, "pi");
  await writeFile(pi, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PI_RULES_TEST_RECORD"\nexit "${PI_RULES_TEST_EXIT:-0}"\n');
  await chmod(pi, 0o755);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, PI_RULES_TEST_RECORD: record, VITEST: "true" };
  const io: CliIO = { env, stdout: [], stderr: [] };
  const options: FlowOptions = { agentDir, dryRun: false, io, fetchImpl: offlineFetch };
  return { root, agentDir, record, io, options };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function records(record: string): Promise<string[]> {
  try { return (await readFile(record, "utf8")).trim().split("\n"); } catch { return []; }
}

const neverFetch = (() => new Promise<Response>(() => {})) as typeof fetch;
const offlineFetch = (async () => {
  throw new Error("network disabled in tests");
}) as typeof fetch;

describe("updateFlow", () => {
  test("reports local entries as tracking the working tree and never calls pi", async () => {
    const f = await fixture(["../local-package"]);
    await mkdir(path.join(f.root, "local-package"));
    await writeFile(path.join(f.root, "local-package", "package.json"), JSON.stringify({ name: "pi-rules-md" }));
    expect(await updateFlow(f.options)).toBe(0);
    expect(f.io.stdout.join("\n")).toContain("personal: ../local-package tracks the working tree (not updated)");
    expect(await records(f.record)).toEqual([]);
  });

  test("writes fallback output to the console when no io is supplied", async () => {
    const f = await fixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await updateFlow({ agentDir: f.agentDir, dryRun: false })).toBe(0);
      expect(log).toHaveBeenCalledWith("nothing to update (no pi-rules-md entries found)");
    } finally { log.mockRestore(); }
  });

  test("reports pinned npm entries without updating", async () => {
    const f = await fixture(["npm:pi-rules-md@0.1.0"]);
    expect(await updateFlow(f.options)).toBe(0);
    expect(f.io.stdout.join("\n")).toContain("personal: npm:pi-rules-md@0.1.0 pinned to 0.1.0, not updating");
    expect(await records(f.record)).toEqual([]);
  });

  test("updates unpinned npm entries and uses --local in project scope", async () => {
    const f = await fixture([], ["npm:pi-rules-md"]);
    const project = path.join(f.root, "project");
    const oldCwd = process.cwd();
    process.chdir(project);
    try {
      expect(await updateFlow(f.options)).toBe(0);
      expect(await records(f.record)).toEqual(["update npm:pi-rules-md --local"]);
    } finally { process.chdir(oldCwd); }
  });

  test("deduplicates repeated npm sources within a scope", async () => {
    const f = await fixture(["npm:pi-rules-md", { source: "npm:pi-rules-md" }]);
    expect(await updateFlow(f.options)).toBe(0);
    expect(await records(f.record)).toEqual(["update npm:pi-rules-md"]);
  });

  test("local mode reads and updates project scope only", async () => {
    const f = await fixture(["npm:pi-rules-md"], ["npm:pi-rules-md"]);
    const oldCwd = process.cwd();
    process.chdir(path.join(f.root, "project"));
    f.options.local = true;
    try {
      expect(await updateFlow(f.options)).toBe(0);
      expect(await records(f.record)).toEqual(["update npm:pi-rules-md --local"]);
    } finally { process.chdir(oldCwd); }
  });

  test("continues across scopes after a pi failure and returns 1", async () => {
    const f = await fixture(["npm:pi-rules-md"], ["npm:pi-rules-md"]);
    f.io.env.PI_RULES_TEST_EXIT = "4";
    const oldCwd = process.cwd();
    process.chdir(path.join(f.root, "project"));
    try {
      expect(await updateFlow(f.options)).toBe(1);
      expect(await records(f.record)).toEqual(["update npm:pi-rules-md", "update npm:pi-rules-md --local"]);
    } finally { process.chdir(oldCwd); }
  });

  test("interlock refusal returns 3 without invoking pi", async () => {
    const f = await fixture(["npm:pi-rules-md"]);
    delete f.options.agentDir;
    expect(await updateFlow(f.options)).toBe(3);
    expect(await records(f.record)).toEqual([]);
  });

  test("reports zero matching entries", async () => {
    const f = await fixture(["npm:elsewhere"]);
    expect(await updateFlow(f.options)).toBe(0);
    expect(f.io.stdout).toContain("nothing to update (no pi-rules-md entries found)");
  });

  test("updates even when the optional registry fetch hangs", async () => {
    const f = await fixture(["npm:pi-rules-md"]);
    f.options.fetchImpl = neverFetch;
    expect(await updateFlow(f.options)).toBe(0);
    expect(await records(f.record)).toEqual(["update npm:pi-rules-md"]);
  });
});
