/**
 * Single source of truth for pi's rules layout (M2), the environment-budget
 * resolution seam (M5), the mid-run attachment toggle (S9/D3), and the importer
 * toggle (S11/D2).
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

/**
 * Resolves the importer toggle (S11/D2: importers are on by default for trusted
 * projects). Mirroring `resolveAttach`, only a trimmed, case-insensitive `none`
 * disables them — an absent variable, an empty string, or any unrecognized value
 * keeps every configured importer enabled. The composition root turns a `false`
 * answer into an EMPTY importer list, so discovery never lists an importer root
 * in that mode (zero globs, zero reads).
 */
export const resolveImport = (raw: string | undefined): boolean => (raw ?? "").trim().toLowerCase() !== "none";
