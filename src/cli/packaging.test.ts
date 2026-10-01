import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

type PackageManifest = {
  bin: Record<string, string>;
  files: string[];
  engines: { node: string };
  scripts: { prepublishOnly: string };
  pi: { extensions: string[] };
  dependencies: Record<string, string>;
};

async function readPackageManifest(): Promise<PackageManifest> {
  const root = path.resolve(import.meta.dirname, "../..");
  return JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as PackageManifest;
}

describe("npm packaging contract", () => {
  test("ships the built CLI and extension while preserving source-mode support", async () => {
    const manifest = await readPackageManifest();

    expect(manifest.bin["pi-rules"]).toBe("dist/cli.mjs");
    expect(manifest.files).toEqual(expect.arrayContaining([
      "dist",
      "index.ts",
      "src",
      "shell",
      "README.md",
      "RULE-SPEC.md",
    ]));
    expect(manifest.engines.node).toBe(">=22.19.0");
    expect(manifest.scripts.prepublishOnly.split(/\s*&&\s*/)).toEqual(expect.arrayContaining([
      "pnpm typecheck",
      "pnpm lint",
      "pnpm test",
      "pnpm build",
    ]));
    expect(manifest.pi.extensions).toEqual(["./dist/extension.js"]);
    expect(manifest.dependencies).toEqual(expect.objectContaining({
      picomatch: expect.any(String),
      tinyglobby: expect.any(String),
      typebox: expect.any(String),
      yaml: expect.any(String),
    }));
  });
});
