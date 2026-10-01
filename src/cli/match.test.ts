import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { findMatchingEntries } from "./match.ts";
import type { PackageEntry } from "./settings.ts";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-rules-match-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const entry = (source: string, kind: "string" | "object" = "string"): PackageEntry => kind === "string" ? { kind, source } : { kind, source };

describe("findMatchingEntries", () => {
  test("matches only the exact npm package and captures an exact pin", async () => {
    const result = await findMatchingEntries([
      entry("npm:pi-rules-md"), entry("npm:pi-rules-md@1.2.3"), entry("npm:pi-rules-md-extra"),
      entry("npm:elsewhere"), entry("npm:pi-rules-md", "object"),
    ], { settingsDir: "/fixture/settings" });
    expect(result.matches.map(({ kind, version }) => ({ kind, version }))).toEqual([
      { kind: "npm", version: undefined }, { kind: "npm-pinned", version: "1.2.3" }, { kind: "npm", version: undefined },
    ]);
  });

  test("matches git sources by final repository basename", async () => {
    const result = await findMatchingEntries([entry("git:https://example.test/team/pi-rules-md.git#v1"), entry("git:https://example.test/team/other.git")], { settingsDir: "/fixture" });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.kind).toBe("git");
  });

  test("matches relative paths by package identity and groups realpath duplicates", async () => {
    const root = await fixture();
    const settingsDir = path.join(root, "config", "settings");
    const local = path.join(root, "Documents", "pi-rules-md");
    await mkdir(settingsDir, { recursive: true });
    await mkdir(local, { recursive: true });
    await writeFile(path.join(local, "package.json"), JSON.stringify({ name: "pi-rules-md" }));
    const relative = path.relative(settingsDir, local);
    expect(relative.split(path.sep).slice(0, 2)).toEqual(["..", ".."]);
    const result = await findMatchingEntries([entry(relative), entry(local), entry("../wrong")], { settingsDir });
    expect(result.matches.map((match) => match.kind)).toEqual(["local", "local"]);
    expect(result.matches[0]?.canonicalPath).toBe(local);
    expect(result.duplicates.get(local)).toHaveLength(2);
    expect(result.unmatchedLocal).toHaveLength(1);
  });

  test("expands tilde through an injected home and rejects wrong-name packages", async () => {
    const root = await fixture();
    const home = path.join(root, "home");
    const good = path.join(home, "project");
    const wrong = path.join(root, "wrong");
    await mkdir(good, { recursive: true });
    await mkdir(wrong, { recursive: true });
    await writeFile(path.join(good, "package.json"), JSON.stringify({ name: "pi-rules-md" }));
    await writeFile(path.join(wrong, "package.json"), JSON.stringify({ name: "another-package" }));
    vi.stubEnv("HOME", home);
    const result = await findMatchingEntries([entry("~/project"), entry(wrong)], { settingsDir: root });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.canonicalPath).toBe(good);
    expect(result.unmatchedLocal).toHaveLength(1);
  });

  test("unparseable and nonexistent local targets are unmatched, never matches", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "broken.json"), "{");
    const malformed = path.join(root, "broken");
    await mkdir(malformed);
    await writeFile(path.join(malformed, "package.json"), "{");
    const result = await findMatchingEntries([entry("./missing"), entry("./broken")], { settingsDir: root });
    expect(result.matches).toEqual([]);
    expect(result.unmatchedLocal).toHaveLength(2);
  });
});
