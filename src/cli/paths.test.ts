import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveAgentDir, resolveNpmStorePath, resolvePersonalSettingsPath, resolveProjectSettingsPath } from "./paths.ts";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-rules-paths-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CLI paths", () => {
  test("agent directory precedence is explicit, environment, then the default", () => {
    expect(resolveAgentDir("/explicit", { PI_RULES_AGENT_DIR: "/env" })).toBe("/explicit");
    expect(resolveAgentDir(undefined, { PI_RULES_AGENT_DIR: "/env" })).toBe("/env");
    expect(resolveAgentDir(undefined, {})).toBe(path.join(os.homedir(), ".pi", "agent"));
  });

  test("resolves personal settings and npm store paths", () => {
    expect(resolvePersonalSettingsPath("/sandbox/agent")).toBe("/sandbox/agent/settings.json");
    expect(resolveNpmStorePath("/sandbox/agent")).toBe("/sandbox/agent/npm/node_modules/pi-rules-md");
  });

  test("finds the nearest project settings from cwd but never above the git root", async () => {
    const root = await fixture();
    const nested = path.join(root, "repo", "packages", "app");
    await mkdir(path.join(root, "repo", ".git"), { recursive: true });
    await mkdir(path.join(nested, ".pi"), { recursive: true });
    await writeFile(path.join(nested, ".pi", "settings.json"), "{}");
    expect(resolveProjectSettingsPath({ cwd: nested })).toBe(path.join(nested, ".pi", "settings.json"));
    const insideWithoutSettings = path.join(root, "repo", "other");
    await mkdir(insideWithoutSettings, { recursive: true });
    await mkdir(path.join(root, ".pi"), { recursive: true });
    await writeFile(path.join(root, ".pi", "settings.json"), "{}");
    expect(resolveProjectSettingsPath({ cwd: insideWithoutSettings })).toBeUndefined();
  });

  test("without a git root scans cwd only", async () => {
    const root = await fixture();
    const cwd = path.join(root, "work");
    await mkdir(path.join(cwd, ".pi"), { recursive: true });
    await mkdir(path.join(root, ".pi"), { recursive: true });
    await writeFile(path.join(cwd, ".pi", "settings.json"), "{}");
    await writeFile(path.join(root, ".pi", "settings.json"), "{}");
    expect(resolveProjectSettingsPath({ cwd })).toBe(path.join(cwd, ".pi", "settings.json"));
    expect(resolveProjectSettingsPath({ cwd: path.join(cwd, "child") })).toBeUndefined();
  });
});
