import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readPackageVersion, statusFlow } from "./status.ts";
import type { CliIO, FlowOptions } from "./main.ts";

const roots: string[] = [];
async function fixture(personal: unknown[] = [], project?: unknown[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-rules-status-"));
  roots.push(root);
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: personal }));
  const projectDir = path.join(root, "project");
  if (project) {
    await mkdir(path.join(projectDir, ".git"), { recursive: true });
    await mkdir(path.join(projectDir, ".pi"), { recursive: true });
    await writeFile(path.join(projectDir, ".pi", "settings.json"), JSON.stringify({ packages: project }));
  }
  const io: CliIO = { env: { ...process.env, VITEST: "true" }, stdout: [], stderr: [] };
  const options: FlowOptions = { agentDir, dryRun: false, io };
  return { root, agentDir, projectDir, io, options };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function writeVersion(directory: string, version: unknown) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ version }));
}
const registryFetch = (version: unknown, calls?: string[]): typeof fetch => (async (input) => {
  calls?.push(String(input));
  return { ok: true, json: async () => ({ version }) } as Response;
}) as typeof fetch;

describe("readPackageVersion", () => {
  test("returns a string package version and undefined for missing or malformed metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-rules-version-"));
    roots.push(root);
    expect(readPackageVersion(root)).toBeUndefined();
    await writeFile(path.join(root, "package.json"), "{");
    expect(readPackageVersion(root)).toBeUndefined();
    await writeFile(path.join(root, "package.json"), JSON.stringify({ version: 123 }));
    expect(readPackageVersion(root)).toBeUndefined();
    await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "0.1.0" }));
    expect(readPackageVersion(root)).toBe("0.1.0");
  });
});

describe("statusFlow", () => {
  test("reports installed versions across personal and project scopes", async () => {
    const f = await fixture(["npm:pi-rules-md"], ["../../local-package"]);
    await writeVersion(path.join(f.agentDir, "npm", "node_modules", "pi-rules-md"), "0.1.0");
    await mkdir(path.join(f.root, "local-package"), { recursive: true });
    await writeFile(path.join(f.root, "local-package", "package.json"), JSON.stringify({ name: "pi-rules-md", version: "0.2.0" }));
    const oldCwd = process.cwd();
    process.chdir(f.projectDir);
    f.options.fetchImpl = registryFetch("0.2.0");
    try {
      expect(await statusFlow(f.options)).toBe(0);
      expect(f.io.stdout).toContain("personal: npm:pi-rules-md (npm, installed 0.1.0)");
      expect(f.io.stdout).toContain("project: ../../local-package (local, installed 0.2.0)");
    } finally { process.chdir(oldCwd); }
  });

  test("reports no matching installation", async () => {
    const f = await fixture(["npm:another-package"]);
    expect(await statusFlow(f.options)).toBe(0);
    expect(f.io.stdout).toContain("pi-rules-md not installed");
  });

  test("prints latest once and reports stale npm installations", async () => {
    const f = await fixture(["npm:pi-rules-md", "npm:pi-rules-md@0.1.0"]);
    await writeVersion(path.join(f.agentDir, "npm", "node_modules", "pi-rules-md"), "0.1.0");
    const calls: string[] = [];
    f.options.fetchImpl = registryFetch("0.2.0", calls);
    expect(await statusFlow(f.options)).toBe(0);
    expect(f.io.stdout).toContain("latest: 0.2.0");
    expect(f.io.stdout).toContain("stale: personal npm:pi-rules-md installed 0.1.0 < latest 0.2.0");
    expect(f.io.stdout).toContain("stale: personal npm:pi-rules-md@0.1.0 installed 0.1.0 < latest 0.2.0");
    expect(calls).toHaveLength(1);
  });

  test("prints unknown installed versions and no stale line", async () => {
    const f = await fixture(["npm:pi-rules-md"]);
    f.options.fetchImpl = registryFetch("0.2.0");
    expect(await statusFlow(f.options)).toBe(0);
    expect(f.io.stdout).toContain("personal: npm:pi-rules-md (npm, installed unknown)");
    expect(f.io.stdout.some((line) => line.startsWith("stale:"))).toBe(false);
  });

  test("skips latest and stale lines when registry fetch returns null", async () => {
    const f = await fixture(["npm:pi-rules-md"]);
    f.options.fetchImpl = (async () => ({ ok: false, json: async () => ({}) }) as Response) as typeof fetch;
    expect(await statusFlow(f.options)).toBe(0);
    expect(f.io.stdout.some((line) => line.startsWith("latest:"))).toBe(false);
    expect(f.io.stdout.some((line) => line.startsWith("stale:"))).toBe(false);
  });
});
