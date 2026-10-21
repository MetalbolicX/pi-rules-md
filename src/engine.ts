/**
 * Evaluation pipeline (rule format v1): the functional-core entry point.
 *
 * `evaluate` composes the existing pure stages into one total call:
 *
 * 1. Trust gate (defense-in-depth) — project-source rules are skipped as
 *    unmatched, with a reason naming the untrusted project, when the project
 *    is not trusted. Discovery (shell task 10) gates too; the engine never
 *    relies on the caller having done it. Gated rules contribute nothing
 *    else — not even to the exists-scan pool, so an untrusted project never
 *    causes scans on its behalf.
 * 2. Context enrichment — `withExistingPaths` fills `existingPaths` through
 *    the injected {@link GlobScanner}, receiving ONLY rules whose match mode
 *    consults existing paths ("exists" | "both"), so touched-only rules
 *    never widen the scan. With no positive patterns the helper no-ops.
 * 3. Path matching — `matchRule` decides each rule's path/always condition
 *    over the enriched context (applied per rule, in rule order).
 * 4. Non-path conditions — declared tools/model/branch are ANDed with the
 *    path outcome using the existing predicate factories; an absent
 *    condition is vacuously true. `alwaysApply` bypasses path AND non-path
 *    conditions entirely: the `always` reason alone carries the rule (it
 *    never bypasses the trust gate, which runs first).
 * 5. Selection — `selectRules` dedupes by content, priority-sorts and
 *    budget-folds the matched rules, taken in rule order.
 * 6. Rendering — `renderSection` joins `selection.active` with each rule's
 *    merged reasons (by rule id) into one block; `undefined` when empty.
 *
 * The result is an immutable {@link EvaluationTrace}. Deterministic for
 * identical inputs; async only for the injected scan; no other I/O. Neither
 * `ctx`, `rules` nor any input is mutated — every output is fresh readonly
 * data built by the composed stages.
 */
import { branchPredicate, modelPredicate, toolsPredicate } from "./conditions/predicates.ts";
import { detectIntentGlobs } from "./intent.ts";
import { matchRule, withExistingPaths } from "./match.ts";
import type { GlobScanner } from "./match.ts";
import { renderSection } from "./render.ts";
import { selectRules } from "./select.ts";
import type { EvaluationContext, EvaluationTrace, MatchReason, MatchResult, Rule } from "./types.ts";

/** Injected options for `evaluate`: the scan seam and the token budget. */
export interface EvaluationOptions {
	/** Project scan resolving the rules' positive globs (exists matching). */
	readonly scan: GlobScanner;
	/** Token budget handed to the selection pipeline. */
	readonly budget: number;
	/** Current turn prompt used only for intent preload detection. */
	readonly prompt?: string;
}

/** Trust gate (defense-in-depth): project rules require a trusted project. */
const isTrustGated = (rule: Rule, ctx: EvaluationContext): boolean =>
	rule.source === "project" && !ctx.isProjectTrusted;

/** Unmatched result for a trust-gated rule; names the untrusted project. */
const trustGateResult = (rule: Rule, ctx: EvaluationContext): MatchResult => ({
	matched: false,
	ruleId: rule.id,
	reason: `project rule skipped: project (${ctx.cwd}) is not trusted`,
});

/**
 * Human-readable reason for the FIRST declared non-path condition that
 * fails, checked in report order tools → model → branch (the same order the
 * matched reasons follow). `undefined` when every declared condition holds.
 * The model reason names both the rule's pattern and the session model id,
 * and the branch reason mirrors it for the session branch (v1.2): the pattern
 * is what the reader has to compare against.
 */
const firstFailingCondition = (rule: Rule, ctx: EvaluationContext): string | undefined => {
	if (rule.tools !== undefined && !toolsPredicate(rule.tools)(ctx)) {
		return `tool mismatch: none of the declared tools are available in the session (${rule.tools.join(", ")})`;
	}
	if (rule.model !== undefined && !modelPredicate(rule.model)(ctx)) {
		return `model mismatch: session model ${ctx.model ?? "absent"} does not match the rule's model pattern ${rule.model}`;
	}
	if (rule.branch !== undefined && !branchPredicate(rule.branch)(ctx)) {
		return `branch mismatch: session branch ${ctx.branch ?? "absent"} does not match the rule's branch pattern ${rule.branch}`;
	}
	return undefined;
};

/**
 * Tool reasons for a matched rule: one per declared tool present in the
 * session, in the rule's own declaration order.
 */
const toolReasons = (rule: Rule, ctx: EvaluationContext): readonly MatchReason[] =>
	(rule.tools ?? [])
		.filter((tool) => ctx.toolNames.includes(tool))
		.map((tool) => ({ kind: "tool", tool }));

/**
 * Merged per-rule outcome: the path condition AND every declared non-path
 * condition. Path failures keep their reason; non-path failures name the
 * failing condition; a matched rule's reasons run path → tool → model →
 * branch. `alwaysApply` bypasses path AND non-path conditions.
 */
const evaluateRule = (rule: Rule, ctx: EvaluationContext): MatchResult => {
	const pathResult = matchRule(rule, ctx);
	if (!pathResult.matched || rule.alwaysApply) {
		return pathResult;
	}
	const failing = firstFailingCondition(rule, ctx);
	if (failing !== undefined) {
		return { matched: false, ruleId: rule.id, reason: failing };
	}
	const reasons: MatchReason[] = [
		...pathResult.reasons,
		...toolReasons(rule, ctx),
		...(rule.model !== undefined ? [{ kind: "model", model: rule.model } as const] : []),
		...(rule.branch !== undefined ? [{ kind: "branch", branch: rule.branch } as const] : []),
	];
	return { matched: true, ruleId: rule.id, reasons };
};

/**
 * Runs the full pipeline (trust gate → enrichment → matching → non-path
 * conditions → selection → rendering) and returns the immutable trace.
 */
export const evaluate = async (
	rules: readonly Rule[],
	ctx: EvaluationContext,
	opts: EvaluationOptions,
): Promise<EvaluationTrace> => {
	// 2. Enrich a copy of the context — scanning ONLY for rules whose match
	// mode consults existing paths; trust-gated rules are excluded entirely.
	const intentGlobs = opts.prompt === undefined ? [] : detectIntentGlobs(opts.prompt, rules);
	const intentContext: EvaluationContext = { ...ctx, intentGlobs };
	const candidates = rules.filter((rule) => !isTrustGated(rule, ctx));
	const enriched = await withExistingPaths(
		intentContext,
		candidates.filter((rule) => rule.match === "exists" || rule.match === "both"),
		opts.scan,
	);

	// 3–4. Final merged outcome per rule, in rule order.
	const outcomes = rules.map((rule) =>
		isTrustGated(rule, ctx)
			? { rule, result: trustGateResult(rule, ctx) }
			: { rule, result: evaluateRule(rule, enriched) },
	);
	const results = outcomes.map((outcome) => outcome.result);

	// 5. Selection over the matched rules, in rule order.
	const matched = outcomes.flatMap((outcome) =>
		outcome.result.matched ? [{ rule: outcome.rule, reasons: outcome.result.reasons }] : [],
	);
	const selection = selectRules(
		matched.map((entry) => entry.rule),
		opts.budget,
	);

	// 6. Render the active rules with their merged reasons, by rule id.
	const reasonsById = new Map(matched.map((entry) => [entry.rule.id, entry.reasons]));
	const block = renderSection(
		selection.active.map((rule) => ({ rule, reasons: reasonsById.get(rule.id) ?? [] })),
		selection.onDemand,
	);

	return {
		evaluatedAt: ctx.now,
		results,
		selection,
		block,
		matchedPaths: matched.map(({ rule }) => rule.path),
		estimatedTokens: block === undefined ? 0 : Math.ceil(block.content.length / 4),
	};
};
