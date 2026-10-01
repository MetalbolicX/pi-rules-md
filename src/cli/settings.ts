import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveAgentDir, resolvePersonalSettingsPath, resolveProjectSettingsPath } from "./paths.js";

export type PackageEntry =
  | { kind: "string"; source: string }
  | { kind: "object"; source: string }
  | { kind: "malformed"; raw: unknown };

export interface SettingsResult {
  path: string;
  exists: boolean;
  readError?: string;
  parseError?: string;
  shapeError?: string;
  packages: PackageEntry[];
}

export async function loadSettings(
  target: "personal" | "project" | (string & {}),
  opts: { agentDir: string; cwd: string },
): Promise<SettingsResult> {
  const settingsPath = target === "personal"
    ? resolvePersonalSettingsPath(resolveAgentDir(opts.agentDir, {}))
    : target === "project"
      ? resolveProjectSettingsPath({ cwd: opts.cwd }) ?? path.join(opts.cwd, ".pi", "settings.json")
      : path.resolve(target);

  let text: string;
  try {
    text = await readFile(settingsPath, "utf8");
  } catch (error) {
    if (isMissing(error)) return { path: settingsPath, exists: false, packages: [] };
    return { path: settingsPath, exists: true, readError: errorMessage(error), packages: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { path: settingsPath, exists: true, parseError: errorMessage(error), packages: [] };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.packages)) {
    return { path: settingsPath, exists: true, shapeError: '"packages" must be an array', packages: [] };
  }

  return {
    path: settingsPath,
    exists: true,
    packages: parsed.packages.map((raw): PackageEntry => {
      if (typeof raw === "string") return { kind: "string", source: raw };
      if (isRecord(raw) && typeof raw.source === "string") return { kind: "object", source: raw.source };
      return { kind: "malformed", raw };
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
