/**
 * Path-based rule matching (rule format v1).
 *
 * This module owns the path-SET half of activation that `globMatcher`
 * deliberately avoids: given a rule and an EvaluationContext, decide whether
 * the rule's
 * `match` mode ("touched" | "exists" | "both", materialized by the parser —
 * never re-defaulted here) is satisfied by the touched/existing path sets,
 * and attribute MatchReasons to the positive patterns that fired.
 *
 * Functional core / imperative shell:
 * - `matchRule` and `matchRules` are pure — no I/O, no module state.
 * - The project scan for "exists" is a seam: `withExistingPaths` takes the
 *   scan call as an injected {@link GlobScanner} parameter, so the tinyglobby
 *   adapter lives with the wiring (engine/shell tasks), not here. Tests
 *   inject deterministic fake scanners.
 *
 * Contract notes pinned by tests:
 * - `alwaysApply` matches with the `always` reason before any path look.
 * - A rule without `globs` passes the path condition vacuously with no
 *   reasons: the parser rejects match-only rules, so such a rule always
 *   carries another trigger (tools/branch/model), and the engine (task 8)
 *   ANDs those in — the path slice must not veto them.
 * - `!`-negated patterns never appear as reasons; they only exclude paths
 *   (exactly as `globMatcher` composes positive/negative sets).
 * - Scan-level patterns are the deduplicated positive globs across all
 *   rules. Negations stay per-rule on purpose: a scan-level `!` would drop
 *   paths from the shared existing set and corrupt other rules' matching.
 */
import { globMatcher } from "./conditions/predicates.ts";
import { normalizedPath } from "./types.ts";
import type { EvaluationContext, MatchMode, MatchReason, MatchResult, NormalizedPath, Rule } from "./types.ts";

/**
 * Injected scan seam: resolves patterns against the project and returns the
 * found paths (any shape — normalization to NormalizedPath happens in
 * `withExistingPaths`). The production adapter wraps tinyglobby; tests
 * inject deterministic fakes.
 */
export type GlobScanner = (patterns: readonly string[], cwd: NormalizedPath) => Promise<readonly string[]>;

/** True for a non-negated glob (negations are exclusions, not scan targets). */
const isPositive = (glob: string): boolean => !glob.startsWith("!");

/**
 * Derives the extension-targeted scan patterns from the rules' globs:
 * positive patterns only, deduplicated, in first-seen order (rule order,
 * then declaration order — deterministic). Rules without globs and
 * negation-only rules contribute nothing.
 */
export const deriveScanPatterns = (rules: readonly Rule[]): readonly string[] => {
	const seen = new Set<string>();
	const patterns: string[] = [];
	for (const rule of rules) {
		for (const glob of rule.globs ?? []) {
			if (isPositive(glob) && !seen.has(glob)) {
				seen.add(glob);
				patterns.push(glob);
			}
		}
	}
	return patterns;
};

/** Human-readable explanation for an unmatched rule, naming mode and globs. */
const unmatchedReason = (mode: MatchMode, globs: readonly string[]): string => {
	const listed = globs.join(", ");
	switch (mode) {
		case "touched":
			return `no touched path matches globs: ${listed}`;
		case "exists":
			return `no existing path matches globs: ${listed}`;
		case "both":
			return `no touched or existing path matches globs: ${listed}`;
	}
};

/**
 * Evaluates the path condition of one rule against the context's path sets.
 * Pure and total: returns a MatchResult, never throws.
 */
export const matchRule = (rule: Rule, ctx: EvaluationContext): MatchResult => {
	if (rule.alwaysApply) {
		return { matched: true, ruleId: rule.id, reasons: [{ kind: "always" }] };
	}
	if (rule.globs === undefined) {
		// Vacuous path condition — see module contract notes.
		return { matched: true, ruleId: rule.id, reasons: [] };
	}
	const globs = rule.globs;
	const matchesRule = globMatcher(globs);
	// Mode selects which pools are considered; "both" unions them.
	const pool: readonly NormalizedPath[] = [
		...(rule.match === "exists" ? [] : ctx.touchedPaths),
		...(rule.match === "touched" ? [] : ctx.existingPaths),
	];
	const hits = pool.filter(matchesRule);
	if (hits.length === 0) {
		return { matched: false, ruleId: rule.id, reason: unmatchedReason(rule.match, globs) };
	}
	// Attribute one reason per positive pattern that matched at least one
	// relevant path (a single positive pattern composes with the empty
	// negative set, i.e. it is its own matcher). Declaration order.
	const reasons: MatchReason[] = [];
	for (const pattern of globs) {
		if (isPositive(pattern) && hits.some(globMatcher([pattern]))) {
			reasons.push({ kind: "glob", pattern });
		}
	}
	return { matched: true, ruleId: rule.id, reasons };
};

/** Evaluates every rule in order — the mixed-mode entry point for the engine. */
export const matchRules = (rules: readonly Rule[], ctx: EvaluationContext): readonly MatchResult[] =>
	rules.map((rule) => matchRule(rule, ctx));

/**
 * Fills the context's `existingPaths` by scanning the project once for all
 * rules' glob triggers. Scan results are separator-normalized, deduplicated,
 * and sorted for deterministic downstream behavior. When no rule contributes
 * a positive pattern, the context is returned as-is (no scan call).
 * Scanner failures propagate — nothing here swallows I/O errors.
 */
export const withExistingPaths = async (
	ctx: EvaluationContext,
	rules: readonly Rule[],
	scan: GlobScanner,
): Promise<EvaluationContext> => {
	const patterns = deriveScanPatterns(rules);
	if (patterns.length === 0) {
		return ctx;
	}
	const found = await scan(patterns, ctx.cwd);
	const existingPaths = [...new Set(found.map(normalizedPath))].sort();
	return { ...ctx, existingPaths };
};
