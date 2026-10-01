import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadSettings } from "./settings.ts";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-rules-settings-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const opts = { agentDir: "/unused-sandbox", cwd: "/unused-cwd" };

describe("loadSettings", () => {
  test("reports a missing file without errors", async () => {
    const root = await fixture();
    const result = await loadSettings(path.join(root, "missing.json"), opts);
    expect(result).toEqual({ path: path.join(root, "missing.json"), exists: false, packages: [] });
  });

  test("reports unreadable files without attempting to write", async () => {
    const root = await fixture();
    const directory = path.join(root, "directory.json");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(directory));
    const result = await loadSettings(directory, opts);
    expect(result).toMatchObject({ path: directory, exists: true, readError: expect.any(String), packages: [] });
  });

  test("reports malformed JSON and invalid package shape", async () => {
    const root = await fixture();
    const file = path.join(root, "settings.json");
    await writeFile(file, "{");
    expect(await loadSettings(file, opts)).toMatchObject({ exists: true, parseError: expect.any(String), packages: [] });
    await writeFile(file, JSON.stringify({ packages: "not-an-array" }));
    expect(await loadSettings(file, opts)).toMatchObject({ exists: true, shapeError: expect.any(String), packages: [] });
    await writeFile(file, JSON.stringify({ unrelated: true }));
    expect(await loadSettings(file, opts)).toMatchObject({ exists: true, shapeError: expect.any(String), packages: [] });
  });

  test("parses string, object, and malformed package entries without writing", async () => {
    const root = await fixture();
    const file = path.join(root, "settings.json");
    const input = { packages: ["npm:pi-rules-md", { source: "git:https://example/pi-rules-md" }, { source: 7 }, null] };
    await writeFile(file, JSON.stringify(input));
    const before = await stat(file);
    const result = await loadSettings(file, opts);
    const after = await stat(file);
    expect(result).toEqual({
      path: file,
      exists: true,
      packages: [
        { kind: "string", source: "npm:pi-rules-md" },
        { kind: "object", source: "git:https://example/pi-rules-md" },
        { kind: "malformed", raw: { source: 7 } },
        { kind: "malformed", raw: null },
      ],
    });
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(file, "utf8")).toBe(JSON.stringify(input));
  });

  test("resolves personal and project scopes using the supplied sandbox", async () => {
    const root = await fixture();
    const agentDir = path.join(root, "agent");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(agentDir));
    await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
    expect((await loadSettings("personal", { agentDir, cwd: root })).path).toBe(path.join(agentDir, "settings.json"));
    expect(await loadSettings("project", { agentDir, cwd: root })).toMatchObject({ exists: false, packages: [] });
  });
});
