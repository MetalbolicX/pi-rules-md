import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { doctorFlow, checkNodeVersion, MIN_NODE_VERSION, DIST_FILES } from "./doctor.ts";
import type { CliIO, FlowOptions } from "./main.ts";
import { resolveNpmStorePath } from "./paths.ts";

const roots: string[] = [];
const offlineFetch = (async () => { throw new Error("network disabled in test"); }) as typeof fetch;

async function fixture(personal: unknown[] = [], project?: unknown[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-rules-doctor-"));
  roots.push(root);
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: personal }));
  const projectDir = path.join(root, "project");
  await mkdir(projectDir, { recursive: true });
  if (project) {
    await mkdir(path.join(projectDir, ".git"), { recursive: true });
    await mkdir(path.join(projectDir, ".pi"), { recursive: true });
    await writeFile(path.join(projectDir, ".pi", "settings.json"), JSON.stringify({ packages: project }));
  }
  const io: CliIO = { env: { ...process.env, VITEST: "true" }, stdout: [], stderr: [] };
  const options: FlowOptions = { agentDir, dryRun: false, io, fetchImpl: offlineFetch };
  return { root, agentDir, projectDir, io, options };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function writePackage(directory: string, version = "1.2.3") {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "pi-rules-md", version }));
}
async function writeDist(directory: string, files: readonly string[] = DIST_FILES) {
  for (const file of files) {
    const target = path.join(directory, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "// fixture");
  }
}
async function inProject<T>(projectDir: string, run: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(projectDir);
  try { return await run(); } finally { process.chdir(previous); }
}

const storeFor = (agentDir: string) => resolveNpmStorePath(agentDir);

describe("checkNodeVersion", () => {
  test.each([
    ["22.19.0", "ok"],
    ["18.0.0", "outdated"],
    ["not-a-version", "unknown"],
    ["22.19.0-rc.1", "ok"],
  ] as const)("classifies %s as %s", (current, expected) => {
    expect(checkNodeVersion(current)).toBe(expected);
  });

  test("pins the minimum to package.json engines.node", async () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const metadata = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(root, "package.json"), "utf8")) as { engines: { node: string } };
    expect(MIN_NODE_VERSION).toBe("22.19.0");
    expect(metadata.engines.node).toBe(`>=${MIN_NODE_VERSION}`);
  });
});

describe("doctorFlow", () => {
  test("reports a healthy npm installation with both distribution files", async () => {
    const f = await fixture(["npm:pi-rules-md"]);
    await writePackage(storeFor(f.agentDir));
    await writeDist(storeFor(f.agentDir));
    expect(await inProject(f.projectDir, () => doctorFlow(f.options))).toBe(0);
    expect(f.io.stdout).toContain("personal: npm:pi-rules-md (npm, installed 1.2.3)");
    expect(f.io.stdout).toContain("summary: healthy");
    expect(f.io.stdout.some((line) => line.startsWith("structural:"))).toBe(false);
  });

  test("reports any missing npm-store distribution file as structural", async () => {
    const f = await fixture(["npm:pi-rules-md"]);
    await writePackage(storeFor(f.agentDir));
    await writeDist(storeFor(f.agentDir), DIST_FILES.slice(0, 1));
    expect(await inProject(f.projectDir, () => doctorFlow(f.options))).toBe(1);
    expect(f.io.stdout).toContain("structural: personal npm:pi-rules-md package store missing dist/cli.mjs");
    expect(f.io.stdout).toContain("summary: 1 structural issue(s)");
  });

  test("reports missing local distribution files as advisory", async () => {
    const f = await fixture(["../local-package"]);
    const local = path.join(f.root, "local-package");
    await writePackage(local);
    expect(await inProject(f.projectDir, () => doctorFlow(f.options))).toBe(0);
    expect(f.io.stdout.some((line) => line.startsWith("advisory: personal ../local-package missing dist/extension.js (run pnpm build in "))).toBe(true);
    expect(f.io.stdout).toContain("summary: healthy");
  });

  test("reports duplicate canonical local entries once per group", async () => {
    const f = await fixture(["../local-package", "../local-package"]);
    const local = path.join(f.root, "local-package");
    await writePackage(local);
    await writeDist(local);
    expect(await inProject(f.projectDir, () => doctorFlow(f.options))).toBe(0);
    expect(f.io.stdout.filter((line) => line.startsWith("advisory: duplicate entries resolve to "))).toHaveLength(1);
    expect(f.io.stdout.some((line) => line.includes("(2 entries)"))).toBe(true);
  });

  test("reports unreadable settings as advisory", async () => {
    const f = await fixture([], ["npm:pi-rules-md"]);
    await writeFile(path.join(f.agentDir, "settings.json"), "{");
    await writePackage(storeFor(f.agentDir));
    await writeDist(storeFor(f.agentDir));
    expect(await inProject(f.projectDir, () => doctorFlow(f.options))).toBe(0);
    expect(f.io.stdout.some((line) => line.startsWith("advisory: personal settings unreadable ("))).toBe(true);
  });

  test("reports zero matches structurally and skips registry", async () => {
    const f = await fixture(["npm:another-package"]);
    let calls = 0;
    f.options.fetchImpl = (async () => { calls++; throw new Error("unexpected fetch"); }) as typeof fetch;
    expect(await inProject(f.projectDir, () => doctorFlow(f.options))).toBe(1);
    expect(f.io.stdout).toContain("structural: pi-rules-md is not installed (run pi-rules install)");
    expect(f.io.stdout).toContain("summary: 1 structural issue(s)");
    expect(calls).toBe(0);
  });

  test("reports latest and stale npm advice", async () => {
    const f = await fixture(["npm:pi-rules-md"]);
    await writePackage(storeFor(f.agentDir), "1.0.0");
    await writeDist(storeFor(f.agentDir));
    f.options.fetchImpl = (async () => ({ ok: true, json: async () => ({ version: "2.0.0" }) }) as Response) as typeof fetch;
    expect(await inProject(f.projectDir, () => doctorFlow(f.options))).toBe(0);
    expect(f.io.stdout).toContain("latest: 2.0.0");
    expect(f.io.stdout).toContain("advisory: personal npm:pi-rules-md stale (installed 1.0.0 < latest 2.0.0)");
  });

  test("advises that pinned npm entries require manual updates", async () => {
    const f = await fixture(["npm:pi-rules-md@1.0.0"]);
    await writePackage(storeFor(f.agentDir), "1.0.0");
    await writeDist(storeFor(f.agentDir));
    f.options.fetchImpl = (async () => ({ ok: true, json: async () => ({ version: "2.0.0" }) }) as Response) as typeof fetch;
    expect(await inProject(f.projectDir, () => doctorFlow(f.options))).toBe(0);
    expect(f.io.stdout).toContain("advisory: personal npm:pi-rules-md@1.0.0 pinned to 1.0.0 — update manually if stale");
  });

  test("reports registry unavailability without changing health", async () => {
    const f = await fixture(["npm:pi-rules-md"]);
    await writePackage(storeFor(f.agentDir));
    await writeDist(storeFor(f.agentDir));
    expect(await inProject(f.projectDir, () => doctorFlow(f.options))).toBe(0);
    expect(f.io.stdout).toContain("advisory: registry unreachable, staleness skipped");
  });
});
