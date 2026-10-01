import { readFileSync } from "node:fs";
import path from "node:path";
import type { CliIO, FlowOptions } from "./main.js";
import { findMatchingEntries, type MatchingEntry } from "./match.js";
import { resolveAgentDir, resolveNpmStorePath } from "./paths.js";
import { fetchLatestVersion, isStale } from "./registry.js";
import { loadScopes, type SettingsScope } from "./scopes.js";
import type { SettingsResult } from "./settings.js";

function ioFor(options: FlowOptions): CliIO {
  return options.io ?? { env: process.env, stdout: [], stderr: [] };
}

function settingsProblem(settings: SettingsResult): string | undefined {
  return settings.readError ?? settings.parseError ?? settings.shapeError;
}

export function readPackageVersion(pkgDir: string): string | undefined {
  try {
    const metadata: unknown = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
    const { version } = metadata as { version?: unknown };
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

function installedVersion(match: MatchingEntry, agentDir: string): string | undefined {
  const packageDir = match.kind === "local" ? match.canonicalPath : resolveNpmStorePath(agentDir);
  return packageDir ? readPackageVersion(packageDir) : undefined;
}

function kindLabel(kind: MatchingEntry["kind"]): string {
  return kind === "npm" ? "npm" : kind === "npm-pinned" ? "npm-pinned" : kind;
}

export async function statusFlow(options: FlowOptions): Promise<number> {
  const io = ioFor(options);
  const agentDir = resolveAgentDir(options.agentDir, process.env);
  const loaded = await loadScopes(["personal", "project"], { agentDir, cwd: process.cwd() });
  const matches: { scope: SettingsScope; match: MatchingEntry; installed: string | undefined }[] = [];
  for (const { scope, settings } of loaded) {
    const problem = settingsProblem(settings);
    if (problem) {
      io.stderr.push(`error: unable to read settings at ${settings.path}: ${problem}`);
      continue;
    }
    if (!settings.exists) continue;
    const result = await findMatchingEntries(settings.packages, { settingsDir: path.dirname(settings.path) });
    for (const match of result.matches) {
      const installed = installedVersion(match, agentDir);
      matches.push({ scope, match, installed });
      io.stdout.push(`${scope}: ${match.source} (${kindLabel(match.kind)}, installed ${installed ?? "unknown"})`);
    }
  }

  if (matches.length === 0) {
    io.stdout.push("pi-rules-md not installed");
    return 0;
  }

  const latest = await fetchLatestVersion(options.fetchImpl ?? fetch);
  if (latest) {
    io.stdout.push(`latest: ${latest}`);
    for (const { scope, match, installed } of matches) {
      if ((match.kind === "npm" || match.kind === "npm-pinned") && installed && isStale(installed, latest)) {
        io.stdout.push(`stale: ${scope} ${match.source} installed ${installed} < latest ${latest}`);
      }
    }
  }
  return 0;
}
