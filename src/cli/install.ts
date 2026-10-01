import path from "node:path";
import { PACKAGE_NAME } from "./constants.js";
import { sandboxRefusal } from "./interlock.js";
import { findMatchingEntries } from "./match.js";
import type { CliIO, FlowOptions } from "./main.js";
import { resolveAgentDir } from "./paths.js";
import { runPi } from "./pi-runner.js";
import { loadSettings } from "./settings.js";

function ioFor(options: FlowOptions): CliIO {
  return options.io ?? { env: process.env, stdout: [], stderr: [] };
}

function settingsProblem(settings: { readError?: string; parseError?: string; shapeError?: string }): string | undefined {
  if (settings.readError) return settings.readError;
  if (settings.parseError) return settings.parseError;
  return settings.shapeError;
}

export async function installFlow(options: FlowOptions): Promise<number> {
  const io = ioFor(options);
  const refusal = sandboxRefusal({ agentDir: options.agentDir, env: io.env });
  if (refusal) {
    io.stderr.push(refusal);
    return 3;
  }

  const agentDir = resolveAgentDir(options.agentDir, process.env);
  const local = options.local === true;
  let matches: Awaited<ReturnType<typeof findMatchingEntries>>["matches"] = [];
  const settings = await loadSettings(local ? "project" : "personal", { agentDir, cwd: process.cwd() });
  const { path: settingsPath, exists, packages } = settings;
  const problem = settingsProblem(settings);
  if (problem) io.stderr.push(`warning: unable to read settings at ${settingsPath}: ${problem}`);
  else if (exists) {
    const { matches: foundMatches } = await findMatchingEntries(packages, { settingsDir: path.dirname(settingsPath) });
    matches = foundMatches;
  }

  let removed = 0;
  for (const match of matches) {
    const result = await runPi({
      argv: ["remove", match.source, ...(local ? ["--local"] : [])],
      dryRun: options.dryRun,
      env: io.env,
      stdout: io.stdout,
    });
    if (result.exitCode !== 0) return result.exitCode;
    removed++;
  }

  const result = await runPi({
    argv: ["install", `npm:${PACKAGE_NAME}`, ...(local ? ["--local"] : [])],
    dryRun: options.dryRun,
    env: io.env,
    stdout: io.stdout,
  });
  if (result.exitCode !== 0) return result.exitCode;

  const stale = removed > 0 ? `, removed ${removed} stale entr${removed === 1 ? "y" : "ies"}` : "";
  io.stdout.push(`✓ Installed ${PACKAGE_NAME} (npm:${PACKAGE_NAME})${stale}\ntip: Run pi-rules doctor`);
  return 0;
}
