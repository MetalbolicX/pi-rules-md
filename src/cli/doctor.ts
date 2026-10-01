import { existsSync } from "node:fs";
import path from "node:path";
import type { CliIO, FlowOptions } from "./main.js";
import { findMatchingEntries, type MatchingEntry } from "./match.js";
import { resolveAgentDir, resolveNpmStorePath } from "./paths.js";
import { compareSemver, fetchLatestVersion, isStale } from "./registry.js";
import { loadScopes, type SettingsScope } from "./scopes.js";
import type { SettingsResult } from "./settings.js";
import { readPackageVersion } from "./status.js";

export const MIN_NODE_VERSION = "22.19.0";
export const DIST_FILES = ["dist/extension.js", "dist/cli.mjs"] as const;

function ioFor(options: FlowOptions): CliIO {
  return options.io ?? { env: process.env, stdout: { push: (...lines: string[]) => console.log(...lines) } as unknown as string[], stderr: { push: (...lines: string[]) => console.error(...lines) } as unknown as string[] };
}

function settingsProblem(settings: SettingsResult): string | undefined {
  return settings.readError ?? settings.parseError ?? settings.shapeError;
}

export function checkNodeVersion(current: string): "ok" | "outdated" | "unknown" {
  const comparison = compareSemver(current, MIN_NODE_VERSION);
  if (comparison === null) return "unknown";
  return comparison >= 0 ? "ok" : "outdated";
}

function installedVersion(match: MatchingEntry, agentDir: string): string | undefined {
  const packageDir = match.kind === "local" ? match.canonicalPath : resolveNpmStorePath(agentDir);
  return packageDir ? readPackageVersion(packageDir) : undefined;
}

function kindLabel(kind: MatchingEntry["kind"]): string {
  return kind === "npm-pinned" ? "npm-pinned" : kind;
}

export async function doctorFlow(options: FlowOptions): Promise<number> {
  const io = ioFor(options);
  const agentDir = resolveAgentDir(options.agentDir, process.env);
  const loaded = await loadScopes(["personal", "project"], { agentDir, cwd: process.cwd() });
  const structural: string[] = [];
  const advisory: string[] = [];
  const matches: { scope: SettingsScope; match: MatchingEntry; installed: string | undefined }[] = [];

  for (const { scope, settings } of loaded) {
    const problem = settingsProblem(settings);
    if (problem) {
      advisory.push(`advisory: ${scope} settings unreadable (${problem})`);
      continue;
    }
    if (!settings.exists) {
      io.stdout.push(`${scope}: no settings`);
      continue;
    }

    const result = await findMatchingEntries(settings.packages, { settingsDir: path.dirname(settings.path) });
    for (const match of result.matches) {
      const installed = installedVersion(match, agentDir);
      matches.push({ scope, match, installed });
      io.stdout.push(`${scope}: ${match.source} (${kindLabel(match.kind)}, installed ${installed ?? "unknown"})`);
      if (match.kind === "local") {
        for (const file of DIST_FILES) {
          if (!match.canonicalPath || !existsSync(path.join(match.canonicalPath, file))) {
            advisory.push(`advisory: ${scope} ${match.source} missing ${file} (run pnpm build in ${match.canonicalPath ?? "unknown"})`);
          }
        }
      } else {
        for (const file of DIST_FILES) {
          if (!existsSync(path.join(resolveNpmStorePath(agentDir), file))) {
            structural.push(`structural: ${scope} ${match.source} package store missing ${file}`);
          }
        }
      }
    }
    for (const [canonicalPath, group] of result.duplicates) {
      advisory.push(`advisory: duplicate entries resolve to ${canonicalPath} (${group.length} entries)`);
    }
  }

  const nodeVersion = process.versions.node;
  const nodeStatus = checkNodeVersion(nodeVersion);
  if (nodeStatus === "outdated") structural.push(`structural: node ${nodeVersion} < ${MIN_NODE_VERSION} (engines requirement)`);
  if (nodeStatus === "unknown") advisory.push(`advisory: unable to verify node version (${nodeVersion})`);
  if (matches.length === 0) structural.push("structural: pi-rules-md is not installed (run pi-rules install)");

  let latestLine: string | undefined;
  if (matches.length > 0) {
    const latest = await fetchLatestVersion(options.fetchImpl ?? fetch);
    if (latest) {
      latestLine = `latest: ${latest}`;
      for (const { scope, match, installed } of matches) {
        if (match.kind === "npm-pinned") {
          advisory.push(`advisory: ${scope} ${match.source} pinned to ${match.version} — update manually if stale`);
        } else if (match.kind === "npm" && installed && isStale(installed, latest)) {
          advisory.push(`advisory: ${scope} ${match.source} stale (installed ${installed} < latest ${latest})`);
        }
      }
    } else {
      advisory.push("advisory: registry unreachable, staleness skipped");
    }
  }

  io.stdout.push(...structural);
  if (latestLine) io.stdout.push(latestLine);
  io.stdout.push(...advisory);
  const structuralCount = structural.length;
  io.stdout.push(structuralCount === 0 ? "summary: healthy" : `summary: ${structuralCount} structural issue(s)`);
  return structuralCount === 0 ? 0 : 1;
}
