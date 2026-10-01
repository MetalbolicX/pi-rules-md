import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { PACKAGE_NAME } from "./constants.js";

export function resolveAgentDir(explicit: string | undefined, env: NodeJS.ProcessEnv): string {
  return explicit ?? env.PI_RULES_AGENT_DIR ?? path.join(homedir(), ".pi", "agent");
}

export function resolvePersonalSettingsPath(agentDir: string): string {
  return path.join(agentDir, "settings.json");
}

export function resolveProjectSettingsPath(opts: { cwd: string }): string | undefined {
  const cwd = path.resolve(opts.cwd);
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) return settingsPathIfPresent(cwd);

  let current = cwd;
  while (true) {
    const settings = settingsPathIfPresent(current);
    if (settings) return settings;
    if (current === gitRoot) return undefined;
    current = path.dirname(current);
  }
}

export function resolveNpmStorePath(agentDir: string): string {
  return path.join(agentDir, "npm", "node_modules", PACKAGE_NAME);
}

function settingsPathIfPresent(directory: string): string | undefined {
  const settings = path.join(directory, ".pi", "settings.json");
  return existsSync(settings) ? settings : undefined;
}

function findGitRoot(start: string): string | undefined {
  let current = start;
  while (true) {
    if (existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
