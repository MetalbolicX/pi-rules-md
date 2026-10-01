import { loadSettings, type SettingsResult } from "./settings.js";

export type SettingsScope = "personal" | "project";

export interface LoadedScope {
  scope: SettingsScope;
  settings: SettingsResult;
}

export async function loadScopes(
  scopes: SettingsScope[],
  opts: { agentDir: string; cwd: string },
): Promise<LoadedScope[]> {
  const loaded: LoadedScope[] = [];
  for (const scope of scopes) {
    loaded.push({ scope, settings: await loadSettings(scope, opts) });
  }
  return loaded;
}
