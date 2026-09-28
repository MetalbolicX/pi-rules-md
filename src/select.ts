/**
 * Selection pipeline (rule format v1): dedupe → sort → budget fold.
 *
 * Turns candidate rules into the final injection set. Three small pure
 * stages, each exported so the engine (task 8) and tests can drive them
 * independently, composed by `selectRules`:
 *
 * 1. `dedupeByContent` — equal content keeps higher priority, then later
 *    discovery index; losers drop with cause "duplicate".
 * 2. Candidates are budgeted by priority DESC, then discovery index ASC.
 * 3. `foldBudget` skips non-fitting candidates and continues; the first
 *    candidate is always kept if there is at least one candidate.
 * 4. Presentation order (unconditional group, priority DESC, index ASC) is
 *    applied to survivors only, after budget selection.
 *
 * Token estimate: `estimateTokens` is ceil(chars / 4) of the rule content —
 * a deliberate approximation (~4 chars per token, no tokenizer). Budgeting
 * needs a stable deterministic estimate, not linguistic accuracy.
 *
 * Each stage returns a partial Selection: its `active` survivors plus its
 * own drops. `selectRules` concatenates drops in stage order — duplicates
 * first (input order), then budget drops (priority-sorted order).
 * All functions are pure and deterministic: no I/O, no module state.
 */
import { createHash } from "node:crypto";
import type { DroppedRule, Rule, Selection } from "./types.ts";

/**
 * Approximate token count of a rule's content: ceil(chars / 4). Deliberate
 * approximation — see the module notes; no tokenizer is used.
 */
export const estimateTokens = (rule: Rule): number => Math.ceil(rule.content.length / 4);

/** Content identity for dedupe: sha-256 hex digest of the rule content. */
export const contentHash = (rule: Rule): string => createHash("sha256").update(rule.content).digest("hex");

/**
 * Stage 1 — for equal content, higher priority wins; ties go to the later
 * discovery index. Input order is only a fallback when indices are absent.
 */
export const dedupeByContent = (rules: readonly Rule[]): Selection => {
	const winners = new Map<string, { rule: Rule; inputIndex: number }>();
	const dropped: DroppedRule[] = [];
	for (const [inputIndex, rule] of rules.entries()) {
		const hash = contentHash(rule);
		const previous = winners.get(hash);
		if (previous === undefined) {
			winners.set(hash, { rule, inputIndex });
			continue;
		}
		const ruleIndex = rule.index ?? inputIndex;
		const previousIndex = previous.rule.index ?? previous.inputIndex;
		if (rule.priority > previous.rule.priority || (rule.priority === previous.rule.priority && ruleIndex > previousIndex)) {
			dropped.push({ rule: previous.rule, cause: "duplicate" });
			winners.set(hash, { rule, inputIndex });
		} else {
			dropped.push({ rule, cause: "duplicate" });
		}
	}
	const active = [...winners.values()].sort((a, b) => a.inputIndex - b.inputIndex).map(({ rule }) => rule);
	return { active, onDemand: [], dropped };
};

/**
 * Presentation order: rules without declared activation conditions first,
 * then priority DESCENDING, then stable discovery index ASC. Pure reorder.
 */
const isUnconditional = (rule: Rule): boolean =>
	rule.alwaysApply ||
		((rule.globs === undefined || rule.globs.length === 0) &&
			(rule.tools === undefined || rule.tools.length === 0) &&
			rule.branch === undefined &&
			rule.model === undefined);

export const sortByPriority = (rules: readonly Rule[]): readonly Rule[] =>
	[...rules]
		.map((rule, inputIndex) => ({ rule, inputIndex }))
		.sort((a, b) =>
			Number(isUnconditional(b.rule)) - Number(isUnconditional(a.rule)) ||
			b.rule.priority - a.rule.priority ||
			(a.rule.index ?? a.inputIndex) - (b.rule.index ?? b.inputIndex),
		)
		.map(({ rule }) => rule);

/**
 * Budget fold skips non-fitting entries and continues. The first candidate
 * is retained even when it exceeds the budget.
 */
export const foldBudget = (rules: readonly Rule[], budget: number): Selection => {
	const active: Rule[] = [];
	const dropped: DroppedRule[] = [];
	let remaining = budget;
	for (const [index, rule] of rules.entries()) {
		const tokens = estimateTokens(rule);
		if (index === 0 || tokens <= remaining) {
			active.push(rule);
			remaining -= tokens;
		} else {
			dropped.push({ rule, cause: "budget" });
		}
	}
	return { active, onDemand: [], dropped };
};

/**
 * Composed pipeline: priority/index budget order → dedupe → greedy budget
 * fill → stability presentation order. Duplicates precede budget drops.
 */
export const selectRules = (rules: readonly Rule[], budget: number): Selection => {
	const onDemand = rules.filter((rule) => rule.load === "on-demand");
	const pinned = rules.filter((rule) => rule.load !== "on-demand");
	const deduped = dedupeByContent(pinned);
	const candidates = [...deduped.active].sort((a, b) => b.priority - a.priority || (a.index ?? 0) - (b.index ?? 0));
	const budgeted = foldBudget(candidates, budget);
	return { active: sortByPriority(budgeted.active), onDemand, dropped: [...deduped.dropped, ...budgeted.dropped] };
};
