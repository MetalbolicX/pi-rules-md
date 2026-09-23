/**
 * Property tests for the selection pipeline (rule format v1).
 *
 * Invariants over generated rule sets (content drawn from a small pool so
 * duplicates arise naturally), 200 cases each, fixed seeds:
 * - dedupeByContent keeps the FIRST occurrence of every content hash;
 *   everything it drops has cause "duplicate" and repeats earlier content.
 * - sortByPriority is priority DESCENDING and stable on ties (input order).
 * - foldBudget admits a PREFIX of its input, never admits a rule after the
 *   first non-fit stop, stays within budget, and the first drop is exactly
 *   the rule that did not fit; estimateTokens is non-negative.
 * - selectRules composes the three: unique contents, descending priorities,
 *   within budget, and drops stage-ordered (all duplicates, then all budget).
 *
 * Deterministic via the seeded harness; no I/O, no clocks.
 */
import { describe, expect, it } from "vitest";
import { contentHash, dedupeByContent, estimateTokens, foldBudget, selectRules, sortByPriority } from "../../src/select.ts";
import type { Rule } from "../../src/types.ts";
import { CONTENT_POOL, randomRule, times } from "./support/generators.ts";
import { createSeeded } from "./support/seeded.ts";

const CASES = 200;

/** Random rule set with pooled contents (forced duplicate pressure) in seeded shuffled order. */
const generateRulesWithDuplicates = (rng: ReturnType<typeof createSeeded>, count: number): readonly Rule[] => {
	const rules = times(count, (index) => randomRule(rng, index, rng.pick(CONTENT_POOL)));
	return rng.shuffle(rules);
};

/** Identity index map for subsequence/stability assertions. */
const inputIndexes = (rules: readonly Rule[]): Map<Rule, number> => {
	const indexes = new Map<Rule, number>();
	rules.forEach((rule, index) => {
		indexes.set(rule, index);
	});
	return indexes;
};

describe("dedupeByContent — first occurrence wins (property)", () => {
	it(`keeps the first rule per content hash across ${CASES} generated rule sets`, () => {
		const rng = createSeeded(0x44455531);
		for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
			const rules = generateRulesWithDuplicates(rng, rng.int(1, 40));
			const indexes = inputIndexes(rules);
			const firstIndexOf = new Map<string, number>();
			rules.forEach((rule, index) => {
				const hash = contentHash(rule);
				if (!firstIndexOf.has(hash)) {
					firstIndexOf.set(hash, index);
				}
			});

			const { active, dropped } = dedupeByContent(rules);
			const context = `case ${caseIndex}`;

			// Active contents are unique, form an input subsequence, and every
			// survivor IS the first occurrence of its content.
			const hashes = active.map(contentHash);
			expect(new Set(hashes).size, context).toBe(hashes.length);
			let previousIndex = -1;
			for (const rule of active) {
				const index = indexes.get(rule);
				expect(index, `${context}: active rules come from the input`).toBeDefined();
				if (index === undefined) {
					continue;
				}
				expect(index, context).toBeGreaterThan(previousIndex);
				previousIndex = index;
				const first = firstIndexOf.get(contentHash(rule));
				expect(index, `${context}: survivor is the first with its content`).toBe(first);
			}

			// Every drop repeats an EARLIER rule's content, with cause "duplicate".
			for (const drop of dropped) {
				expect(drop.cause, context).toBe("duplicate");
				const index = indexes.get(drop.rule);
				const first = firstIndexOf.get(contentHash(drop.rule));
				if (first !== undefined && index !== undefined) {
					expect(first, context).toBeLessThan(index);
				}
			}
		}
	});
});

describe("sortByPriority — descending, stable ties (property)", () => {
	it(`sorts priority DESC without reordering ties across ${CASES} generated rule sets`, () => {
		const rng = createSeeded(0x534f5254);
		for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
			const rules = generateRulesWithDuplicates(rng, rng.int(1, 40));
			const indexes = inputIndexes(rules);
			const sorted = sortByPriority(rules);
			const context = `case ${caseIndex}`;
			for (let k = 1; k < sorted.length; k += 1) {
				const previous = sorted[k - 1];
				const current = sorted[k];
				if (previous === undefined || current === undefined) {
					continue;
				}
				expect(previous.priority, context).toBeGreaterThanOrEqual(current.priority);
				if (previous.priority === current.priority) {
					const previousIndex = indexes.get(previous);
					const currentIndex = indexes.get(current);
					if (previousIndex !== undefined && currentIndex !== undefined) {
						expect(previousIndex, `${context}: ties keep input order`).toBeLessThan(currentIndex);
					}
				}
			}
		}
	});
});

describe("foldBudget — prefix fold with a hard stop (property)", () => {
	it(`admits a prefix, stops at the first non-fit, and never exceeds budget (${CASES} cases)`, () => {
		const rng = createSeeded(0x42444731);
		for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
			const rules = generateRulesWithDuplicates(rng, rng.int(1, 40));
			const budget = rng.int(0, 300);
			const indexes = inputIndexes(rules);
			const context = `case ${caseIndex}`;

			for (const rule of rules) {
				expect(estimateTokens(rule), context).toBeGreaterThanOrEqual(0);
			}

			const { active, dropped } = foldBudget(rules, budget);
			let consumed = 0;
			for (const rule of active) {
				consumed += estimateTokens(rule);
			}
			expect(consumed, `${context}: total estimate stays within budget`).toBeLessThanOrEqual(budget);

			// Active is exactly the input prefix [0, active.length).
			expect(active.length, context).toBeLessThanOrEqual(rules.length);
			for (let k = 0; k < active.length; k += 1) {
				const activeRule = active[k];
				const inputRule = rules[k];
				expect(activeRule, `${context}: admitted rules form a prefix`).toBe(inputRule);
			}

			if (dropped.length > 0) {
				// Nothing is admitted after the first non-fit: every drop comes
				// after the last admitted rule, and all drops are budget drops.
				expect(dropped.every((drop) => drop.cause === "budget"), context).toBe(true);
				const lastActive = active[active.length - 1];
				const lastActiveIndex = lastActive === undefined ? -1 : indexes.get(lastActive) ?? -1;
				for (const drop of dropped) {
					const dropIndex = indexes.get(drop.rule) ?? Number.MAX_SAFE_INTEGER;
					expect(dropIndex, `${context}: drops follow the stop`).toBeGreaterThan(lastActiveIndex);
				}
				// The first drop is precisely the rule that did not fit.
				const firstDropped = dropped[0];
				if (firstDropped !== undefined) {
					expect(budget - consumed, `${context}: first drop does not fit the remainder`).toBeLessThan(
						estimateTokens(firstDropped.rule),
					);
				}
			}
		}
	});
});

describe("selectRules — composed pipeline (property)", () => {
	it(`keeps selection unique, priority-desc, within budget, drops stage-ordered (${CASES} cases)`, () => {
		const rng = createSeeded(0x434d5031);
		for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
			const rules = generateRulesWithDuplicates(rng, rng.int(1, 40));
			const budget = rng.int(0, 300);
			const selection = selectRules(rules, budget);
			const context = `case ${caseIndex}`;

			const hashes = selection.active.map(contentHash);
			expect(new Set(hashes).size, `${context}: no duplicate content survives`).toBe(hashes.length);
			let consumed = 0;
			for (let k = 0; k < selection.active.length; k += 1) {
				const rule = selection.active[k];
				if (rule === undefined) {
					continue;
				}
				consumed += estimateTokens(rule);
				const previous = selection.active[k - 1];
				if (k > 0 && previous !== undefined) {
					expect(previous.priority, `${context}: priority descending`).toBeGreaterThanOrEqual(rule.priority);
				}
			}
			expect(consumed, `${context}: within budget`).toBeLessThanOrEqual(budget);

			// Drops are stage-ordered: all "duplicate" drops precede all
			// "budget" drops — the "budget"→"duplicate" transition never occurs.
			let seenBudget = false;
			for (const drop of selection.dropped) {
				if (drop.cause === "budget") {
					seenBudget = true;
				} else {
					expect(seenBudget, `${context}: duplicates never follow budget drops`).toBe(false);
				}
			}
		}
	});
});
