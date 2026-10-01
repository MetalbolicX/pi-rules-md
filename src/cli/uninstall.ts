import { realpathSync, rmSync } from "node:fs";
import path from "node:path";
import type { CliIO, FlowOptions } from "./main.js";
import { sandboxRefusal } from "./interlock.js";
import { findMatchingEntries } from "./match.js";
import { resolveAgentDir, resolveNpmStorePath } from "./paths.js";
import { runPi } from "./pi-runner.js";
import { loadScopes, type SettingsScope } from "./scopes.js";
import type { SettingsResult } from "./settings.js";

function ioFor(options: FlowOptions): CliIO {
  return options.io ?? { env: process.env, stdout: [], stderr: [] };
}

function settingsProblem(settings: SettingsResult): string | undefined {
  if (settings.readError) return settings.readError;
  if (settings.parseError) return settings.parseError;
  return settings.shapeError;
}

function isStrictlyInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function purgeStore(agentDir: string, io: CliIO, dryRun: boolean): number {
  const storePath = resolveNpmStorePath(agentDir);
  try {
    const realAgent = realpathSync(agentDir);
    const npm = realpathSync(path.join(agentDir, "npm"));
    const nodeModules = realpathSync(path.join(agentDir, "npm", "node_modules"));
    const store = realpathSync(storePath);
    if (!isStrictlyInside(realAgent, npm) || !isStrictlyInside(npm, nodeModules)
      || !isStrictlyInside(nodeModules, store) || path.basename(storePath) !== "pi-rules-md") {
      io.stderr.push(`refusing to purge unsafe package store path: ${storePath}`);
      return 1;
    }
  } catch {
    io.stderr.push(`refusing to purge unsafe package store path: ${storePath}`);
    return 1;
  }

  if (dryRun) {
    io.stdout.push(`[pi-rules] [dry-run] Would remove ${storePath}`);
    return 0;
  }
  rmSync(storePath, { recursive: true, force: true });
  io.stdout.push(`✓ removed package store ${storePath}`);
  io.stderr.push("run pi update --extensions to reconcile the package store");
  return 0;
}

export async function uninstallFlow(options: FlowOptions): Promise<number> {
  const io = ioFor(options);
  const refusal = sandboxRefusal({ agentDir: options.agentDir, env: io.env });
  if (refusal) {
    io.stderr.push(refusal);
    return 3;
  }

  const agentDir = resolveAgentDir(options.agentDir, process.env);
  const scopes: SettingsScope[] = options.local ? ["project"] : ["personal", "project"];
  const loaded = await loadScopes(scopes, { agentDir, cwd: process.cwd() });
  const matches: { scope: SettingsScope; source: string }[] = [];
  for (const { scope, settings } of loaded) {
    const problem = settingsProblem(settings);
    if (problem) {
      io.stderr.push(`error: unable to read settings at ${settings.path}: ${problem}`);
      return 1;
    }
    if (!settings.exists) continue;
    const result = await findMatchingEntries(settings.packages, { settingsDir: path.dirname(settings.path) });
    for (const entry of result.unmatchedLocal) {
      if (entry.kind !== "malformed") io.stderr.push(`warning: local entry does not look like pi-rules-md, leaving it: ${entry.source}`);
    }
    matches.push(...result.matches.map(({ source }) => ({ scope, source })));
  }

  const hasPersonalScope = scopes.includes("personal");
  if (matches.length === 0) {
    io.stdout.push("✓ pi-rules-md not installed");
    if (options.purge && hasPersonalScope) return purgeStore(agentDir, io, options.dryRun);
    if (options.purge && options.local) io.stdout.push("nothing to purge in project scope");
    return 0;
  }

  let anyFailed = false;
  for (const match of matches) {
    const result = await runPi({
      argv: ["remove", match.source, ...(match.scope === "project" ? ["--local"] : [])],
      dryRun: options.dryRun,
      env: io.env,
      stdout: io.stdout,
    });
    if (result.exitCode !== 0) anyFailed = true;
  }
  if (options.purge) {
    const purgeResult = purgeStore(agentDir, io, options.dryRun);
    if (purgeResult !== 0) anyFailed = true;
  }
  return anyFailed ? 1 : 0;
}
