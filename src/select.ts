/**
 * Selection pipeline (rule format v1): dedupe → sort → budget fold.
 *
 * Turns candidate rules into the final injection set. Three small pure
 * stages, each exported so the engine (task 8) and tests can drive them
 * independently, composed by `selectRules`:
 *
 * 1. `dedupeByContent` — rule identity is the sha-256 of the rule content
 *    (node:crypto). The FIRST occurrence in input order wins; later rules
 *    with identical content drop with cause "duplicate". Runs BEFORE
 *    sorting, so "first" is input order, never priority order.
 * 2. `sortByPriority` — priority DESCENDING, stable on ties (input order
 *    preserved; Array.prototype.sort is stable per spec).
 * 3. `foldBudget` — walks the sorted rules and stops at the FIRST rule
 *    whose token estimate does not fit the remaining budget; that rule and
 *    the whole remainder drop with cause "budget". Priority-honoring and
 *    deterministic: no backtracking, no "skip and try the next". Content
 *    with zero estimated tokens still consumes its rule slot and fits
 *    whenever the remaining budget is non-negative (including budget 0).
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
 * Stage 1 — drops later rules whose content equals an earlier rule's
 * (sha-256 content hash). First occurrence in input order wins; priorities
 * are irrelevant at this stage by design (dedupe precedes the sort).
 */
export const dedupeByContent = (rules: readonly Rule[]): Selection => {
	const seen = new Set<string>();
	const active: Rule[] = [];
	const dropped: DroppedRule[] = [];
	for (const rule of rules) {
		const hash = contentHash(rule);
		if (seen.has(hash)) {
			dropped.push({ rule, cause: "duplicate" });
			continue;
		}
		seen.add(hash);
		active.push(rule);
	}
	return { active, dropped };
};

/**
 * Stage 2 — priority DESCENDING, stable on ties (input order preserved).
 * Pure: returns a new sorted array, never mutates the input.
 */
export const sortByPriority = (rules: readonly Rule[]): readonly Rule[] =>
	[...rules].sort((a, b) => b.priority - a.priority);

/**
 * Stage 3 — token-budget fold. Admits rules while their estimate fits the
 * remaining budget; stops at the FIRST rule that does not fit and drops it
 * and every rule after it with cause "budget". A zero-token rule fits
 * whenever the remaining budget is non-negative and still consumes its
 * active slot.
 */
export const foldBudget = (rules: readonly Rule[], budget: number): Selection => {
	const active: Rule[] = [];
	const dropped: DroppedRule[] = [];
	let remaining = budget;
	let exhausted = false;
	for (const rule of rules) {
		const tokens = estimateTokens(rule);
		if (exhausted || tokens > remaining) {
			exhausted = true;
			dropped.push({ rule, cause: "budget" });
			continue;
		}
		active.push(rule);
		remaining -= tokens;
	}
	return { active, dropped };
};

/**
 * Composed pipeline: dedupe (input order) → sort (priority desc, stable) →
 * budget fold. Drops are stage-ordered: duplicates first (input order),
 * then budget drops (priority-sorted order).
 */
export const selectRules = (rules: readonly Rule[], budget: number): Selection => {
	const deduped = dedupeByContent(rules);
	const sorted = sortByPriority(deduped.active);
	const budgeted = foldBudget(sorted, budget);
	return { active: budgeted.active, dropped: [...deduped.dropped, ...budgeted.dropped] };
};
