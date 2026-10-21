/**
 * Single source of truth for pi's rules layout (M2), the environment-budget
 * resolution seam (M5), and the mid-run attachment toggle (S9/D3).
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

/**
 * Resolves the mid-run attachment toggle (S9/D3: on by default). Mirroring
 * `resolveBudget`, the default wins unless the value is recognized: only a
 * trimmed, case-insensitive `off` disables attachment, so an absent variable, an
 * empty string, or any unrecognized value keeps the feature enabled.
 */
export const resolveAttach = (raw: string | undefined): boolean => (raw ?? "").trim().toLowerCase() !== "off";
