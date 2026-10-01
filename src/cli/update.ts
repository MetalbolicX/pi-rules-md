import path from "node:path";
import type { CliIO, FlowOptions } from "./main.js";
import { sandboxRefusal } from "./interlock.js";
import { findMatchingEntries } from "./match.js";
import { fetchLatestVersion } from "./registry.js";
import { resolveAgentDir } from "./paths.js";
import { runPi } from "./pi-runner.js";
import { loadScopes, type SettingsScope } from "./scopes.js";
import type { SettingsResult } from "./settings.js";

function ioFor(options: FlowOptions): CliIO {
  return options.io ?? { env: process.env, stdout: [], stderr: [] };
}

function settingsProblem(settings: SettingsResult): string | undefined {
  return settings.readError ?? settings.parseError ?? settings.shapeError;
}

export async function updateFlow(options: FlowOptions): Promise<number> {
  const io = ioFor(options);
  const refusal = sandboxRefusal({ agentDir: options.agentDir, env: io.env });
  if (refusal) {
    io.stderr.push(refusal);
    return 3;
  }

  const agentDir = resolveAgentDir(options.agentDir, process.env);
  const scopes: SettingsScope[] = options.local ? ["project"] : ["personal", "project"];
  const loaded = await loadScopes(scopes, { agentDir, cwd: process.cwd() });
  const matches: { scope: SettingsScope; source: string; kind: "npm" | "npm-pinned" | "git" | "local"; version?: string }[] = [];
  for (const { scope, settings } of loaded) {
    const problem = settingsProblem(settings);
    if (problem) {
      io.stderr.push(`error: unable to read settings at ${settings.path}: ${problem}`);
      continue;
    }
    if (!settings.exists) continue;
    const result = await findMatchingEntries(settings.packages, { settingsDir: path.dirname(settings.path) });
    matches.push(...result.matches.map(({ source, kind, version }) => ({ scope, source, kind, ...(version === undefined ? {} : { version }) })));
  }

  if (matches.length === 0) {
    io.stdout.push("nothing to update (no pi-rules-md entries found)");
    return 0;
  }

  if (matches.some(({ kind }) => kind === "npm" || kind === "npm-pinned")) {
    const latest = await fetchLatestVersion(options.fetchImpl ?? fetch);
    if (latest) io.stdout.push(`latest: ${latest}`);
  }

  let anyFailed = false;
  const seen = new Set<string>();
  for (const match of matches) {
    if (match.kind === "local") {
      io.stdout.push(`${match.scope}: ${match.source} tracks the working tree (not updated)`);
      continue;
    }
    if (match.kind === "npm-pinned") {
      io.stdout.push(`${match.scope}: ${match.source} pinned to ${match.version}, not updating`);
      continue;
    }
    if (match.kind !== "npm") continue;
    const key = `${match.scope}:${match.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const result = await runPi({
      argv: ["update", match.source, ...(match.scope === "project" ? ["--local"] : [])],
      dryRun: options.dryRun,
      env: io.env,
      stdout: io.stdout,
    });
    if (result.exitCode !== 0) anyFailed = true;
  }
  return anyFailed ? 1 : 0;
}
