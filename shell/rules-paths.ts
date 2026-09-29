/**
 * Single source of truth for pi's rules layout (M2) and the environment-budget
 * resolution seam (M5).
 */
import { normalizedPath } from "../src/types.ts";

/** Returns pi's global rules directory for the given home directory. */
export const globalRulesDir = (home: string): string => normalizedPath(`${home}/.pi/agent/rules`);

/** Returns pi's project rules directory for the given working directory. */
export const projectRulesDir = (cwd: string): string => normalizedPath(`${cwd}/.pi/rules`);

/** Resolves a configured token budget, falling back for invalid/non-positive values. */
export const resolveBudget = (raw: string | undefined, fallback: number): number => {
	const parsed = Number.parseInt(raw ?? "", 10);
	return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
};
