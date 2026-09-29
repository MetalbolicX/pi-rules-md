/**
 * Property tests for path matching (rule format v1).
 *
 * Two invariants over generated rule sets and contexts, 200 cases each,
 * fixed seeds:
 * - Applying matchRule to the same (rules, ctx) twice produces deep-equal
 *   results, one entry per rule, in rule order.
 * - deriveScanPatterns yields exactly the positive globs across all rules,
 *   deduplicated in first-seen order — negations and glob-less rules
 *   contribute nothing (they stay per-rule matching concerns).
 *
 * Deterministic via the seeded harness; no I/O, no clocks.
 */
import { describe, expect, it } from "vitest";
import { deriveScanPatterns, matchRule } from "../../src/match.ts";
import { randomContext, randomRule, times } from "./support/generators.ts";
import { createSeeded } from "./support/seeded.ts";
import type { Rule } from "../../src/types.ts";

const CASES = 200;

describe("matchRule composition — determinism (property)", () => {
	it(`evaluates the same (rules, ctx) pair identically across ${CASES} generated cases`, () => {
		const rng = createSeeded(0x4d415443);
		for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
			const rules: readonly Rule[] = times(rng.int(1, 12), (index) => randomRule(rng, index));
			const ctx = randomContext(rng);
			const first = rules.map((rule) => matchRule(rule, ctx));
			const second = rules.map((rule) => matchRule(rule, ctx));
			const context = `case ${caseIndex}`;
			expect(first, context).toEqual(second);
			expect(first.length, context).toBe(rules.length);
		}
	});
});

describe("deriveScanPatterns — positive-glob dedupe (property)", () => {
	it(`returns deduped positive globs in first-seen order across ${CASES} generated rule sets`, () => {
		const rng = createSeeded(0x5343414e);
		for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
			const rules: readonly Rule[] = times(rng.int(0, 10), (index) => randomRule(rng, index));
			const patterns = deriveScanPatterns(rules);
			// Independent expected-value fold: positive globs only, deduped,
			// first-seen order (rule order, then declaration order).
			const seen = new Set<string>();
			const expected: string[] = [];
			for (const rule of rules) {
				for (const glob of rule.globs ?? []) {
					if (!glob.startsWith("!") && !seen.has(glob)) {
						seen.add(glob);
						expected.push(glob);
					}
				}
			}
			expect(patterns, `case ${caseIndex}`).toEqual(expected);
		}
	});
});
