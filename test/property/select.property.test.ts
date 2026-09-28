/** Seeded property tests for selection semantics across generated rule sets. */
import { describe, expect, it } from "vitest";
import { contentHash, dedupeByContent, estimateTokens, foldBudget, selectRules, sortByPriority } from "../../src/select.ts";
import type { Rule } from "../../src/types.ts";
import { CONTENT_POOL, randomRule, times } from "./support/generators.ts";
import { createSeeded } from "./support/seeded.ts";

const CASES = 200;
const generateRulesWithDuplicates = (rng: ReturnType<typeof createSeeded>, count: number): readonly Rule[] =>
	rng.shuffle(times(count, (index) => randomRule(rng, index, rng.pick(CONTENT_POOL))));
const unconditional = (rule: Rule): boolean => rule.alwaysApply ||
	((rule.globs === undefined || rule.globs.length === 0) && (rule.tools === undefined || rule.tools.length === 0) && rule.branch === undefined && rule.model === undefined);

describe("dedupeByContent — priority wins, later index breaks ties (property)", () => {
	it(`keeps the highest-priority, latest-index occurrence across ${CASES} generated sets`, () => {
		const rng = createSeeded(0x44455531);
		for (let n = 0; n < CASES; n += 1) {
			const rules = generateRulesWithDuplicates(rng, rng.int(1, 40));
			const { active, dropped } = dedupeByContent(rules);
			const winners = new Map<string, Rule>();
			for (const rule of rules) {
				const hash = contentHash(rule);
				const previous = winners.get(hash);
				if (previous === undefined || rule.priority > previous.priority || (rule.priority === previous.priority && (rule.index ?? 0) > (previous.index ?? 0))) winners.set(hash, rule);
			}
			expect(new Set(active.map(contentHash)).size).toBe(active.length);
			for (const rule of active) expect(rule).toBe(winners.get(contentHash(rule)));
			expect(dropped.every((drop) => drop.cause === "duplicate")).toBe(true);
		}
	});
});

describe("sortByPriority — stability groups then priority/index (property)", () => {
	it(`orders unconditional first, then priority DESC and index ASC across ${CASES} sets`, () => {
		const rng = createSeeded(0x534f5254);
		for (let n = 0; n < CASES; n += 1) {
			const sorted = sortByPriority(generateRulesWithDuplicates(rng, rng.int(1, 40)));
			for (let k = 1; k < sorted.length; k += 1) {
				const a = sorted[k - 1]; const b = sorted[k];
				if (a === undefined || b === undefined) continue;
				expect(Number(unconditional(a))).toBeGreaterThanOrEqual(Number(unconditional(b)));
				if (unconditional(a) === unconditional(b)) {
					expect(a.priority).toBeGreaterThanOrEqual(b.priority);
					if (a.priority === b.priority) expect(a.index).toBeLessThanOrEqual(b.index ?? Number.MAX_SAFE_INTEGER);
				}
			}
		}
	});
});

describe("foldBudget — greedy skip-and-continue (property)", () => {
	it(`stays within budget except for the guaranteed first candidate and retains every fitting continuation (${CASES} cases)`, () => {
		const rng = createSeeded(0x42444731);
		for (let n = 0; n < CASES; n += 1) {
			const rules = generateRulesWithDuplicates(rng, rng.int(1, 40)); const budget = rng.int(0, 300);
			const { active, dropped } = foldBudget(rules, budget);
			const activeSet = new Set(active);
			let remaining = budget;
			for (const [index, rule] of rules.entries()) {
				if (index === 0 || estimateTokens(rule) <= remaining) {
					expect(activeSet.has(rule)).toBe(true); remaining -= estimateTokens(rule);
				} else expect(activeSet.has(rule)).toBe(false);
			}
			expect(dropped.every((drop) => drop.cause === "budget")).toBe(true);
			expect(active.length > 0).toBe(true);
		}
	});
});

describe("selectRules — composed contract (property)", () => {
	it(`dedupes, greedily fills, presentation-orders survivors, and preserves drop grouping (${CASES} cases)`, () => {
		const rng = createSeeded(0x434d5031);
		for (let n = 0; n < CASES; n += 1) {
			const rules = generateRulesWithDuplicates(rng, rng.int(1, 40)); const selection = selectRules(rules, rng.int(0, 300));
			expect(new Set(selection.active.map(contentHash)).size).toBe(selection.active.length);
			for (let k = 1; k < selection.active.length; k += 1) {
				const a = selection.active[k - 1]; const b = selection.active[k];
				if (a !== undefined && b !== undefined) {
					expect(Number(unconditional(a))).toBeGreaterThanOrEqual(Number(unconditional(b)));
					if (unconditional(a) === unconditional(b)) expect(a.priority).toBeGreaterThanOrEqual(b.priority);
				}
			}
			let budgetDropped = false;
			for (const drop of selection.dropped) {
				if (drop.cause === "budget") budgetDropped = true;
				else expect(budgetDropped).toBe(false);
			}
		}
	});
});
