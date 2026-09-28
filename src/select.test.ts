/**
 * Tests for the selection pipeline (rule format v1): content-hash dedupe,
 * stable priority sort, token-budget fold, and the composed selectRules.
 *
 * Pure behavior only: no network, no disk. Content strings are sized so the
 * ceil(chars/4) estimate yields exact token counts (4 chars per token),
 * which keeps budget boundaries readable in the assertions.
 */
import { describe, expect, it } from "vitest";
import { contentHash, dedupeByContent, estimateTokens, foldBudget, selectRules, sortByPriority } from "./select.ts";
import { normalizedPath, ruleId } from "./types.ts";
import type { DropCause, Rule, Selection } from "./types.ts";

/**
 * Content of exactly `tokens` estimated tokens under the ceil(chars/4)
 * approximation. `fill` varies the characters so two rules can hold equal
 * token counts with distinct content (dedupe keys on content, not size).
 */
const contentOfTokens = (tokens: number, fill = "x"): string => fill.repeat(tokens * 4);

/**
 * Builds a Rule with only the interesting fields set; the rest mirror the
 * parser's materialized defaults (same fixture policy as match.test.ts).
 */
const ruleWith = (fields: { readonly id?: string; readonly priority?: number; readonly content?: string; readonly index?: number; readonly alwaysApply?: boolean; readonly globs?: readonly string[]; readonly tools?: readonly string[]; readonly load?: "pinned" | "on-demand" }): Rule => ({
	...(fields.load === undefined ? {} : { load: fields.load }),
	id: ruleId(fields.id ?? "test-rule"),
	path: normalizedPath(".pi/rules/test.md"),
	source: "project",
	description: "test rule",
	index: fields.index ?? 0,
	...(fields.globs === undefined ? {} : { globs: fields.globs }),
	...(fields.tools === undefined ? {} : { tools: fields.tools }),
	match: "both",
	priority: fields.priority ?? 0,
	enforcement: "inform",
	alwaysApply: fields.alwaysApply ?? false,
	version: 1,
	content: fields.content ?? "body",
});

/** Compact view of a selection's active rules, for readable assertions. */
const activeIds = (selection: Selection): readonly string[] => selection.active.map((rule) => rule.id);

/** Compact view of a selection's drops: rule id plus cause, in order. */
const droppedSummaries = (selection: Selection): ReadonlyArray<{ readonly id: string; readonly cause: DropCause }> =>
	selection.dropped.map(({ rule, cause }) => ({ id: rule.id, cause }));

describe("estimateTokens", () => {
	it("estimates ceil(chars / 4) — the documented approximation", () => {
		expect(estimateTokens(ruleWith({ content: "" }))).toBe(0);
		expect(estimateTokens(ruleWith({ content: "abcd" }))).toBe(1);
		expect(estimateTokens(ruleWith({ content: "abcde" }))).toBe(2);
	});
});

describe("contentHash", () => {
	it("depends only on content, not identity metadata", () => {
		expect(contentHash(ruleWith({ id: "a", content: "same" }))).toBe(contentHash(ruleWith({ id: "b", content: "same" })));
		expect(contentHash(ruleWith({ content: "same" }))).not.toBe(contentHash(ruleWith({ content: "other" })));
	});
});

describe("dedupeByContent", () => {
	it("keeps the later discovery index when priority ties", () => {
		const first = ruleWith({ id: "first", content: "same body", index: 1 });
		const second = ruleWith({ id: "second", content: "same body", index: 2 });
		const result = dedupeByContent([first, second]);
		expect(activeIds(result)).toEqual(["second"]);
		expect(droppedSummaries(result)).toEqual([{ id: "first", cause: "duplicate" }]);
	});

	it("dedupe: higher priority wins on equal content", () => {
		const first = ruleWith({ id: "first", content: "same body", priority: 1 });
		const second = ruleWith({ id: "second", content: "same body", priority: 9 });
		expect(activeIds(dedupeByContent([first, second]))).toEqual(["second"]);
	});

	it("resolves equal priority duplicates by later discovery index", () => {
		const first = ruleWith({ id: "first", content: "same body", index: 1 });
		const second = ruleWith({ id: "second", content: "same body", index: 2 });
		const result = dedupeByContent([first, second]);
		expect(activeIds(result)).toEqual(["second"]);
		expect(droppedSummaries(result)).toEqual([{ id: "first", cause: "duplicate" }]);
		expect(result.dropped[0]?.rule).toEqual(first);
	});

	it("dedupes on content, with higher priority winning", () => {
		const first = ruleWith({ id: "a", content: "same body", priority: 0 });
		const second = ruleWith({ id: "b", content: "same body", priority: 9 });
		const result = dedupeByContent([first, second]);
		expect(activeIds(result)).toEqual(["b"]);
		expect(droppedSummaries(result)).toEqual([{ id: "a", cause: "duplicate" }]);
	});

	it("keeps distinct content in input order and accepts empty input", () => {
		const a = ruleWith({ id: "a", content: "one" });
		const b = ruleWith({ id: "b", content: "two" });
		expect(dedupeByContent([a, b])).toEqual({ active: [a, b], onDemand: [], dropped: [] });
		expect(dedupeByContent([])).toEqual({ active: [], onDemand: [], dropped: [] });
	});
});

describe("sortByPriority", () => {
	it("orders unconditional rules before conditional within the same priority", () => {
		const conditional = ruleWith({ id: "conditional", priority: 3, globs: ["src/**"] });
		const unconditional = ruleWith({ id: "unconditional", priority: 3 });
		expect(sortByPriority([conditional, unconditional]).map((rule) => rule.id)).toEqual(["unconditional", "conditional"]);
	});

	it("orders by priority desc then discovery index asc within a stability group", () => {
		const late = ruleWith({ id: "late", priority: 3, index: 8 });
		const high = ruleWith({ id: "high", priority: 9, index: 9 });
		const early = ruleWith({ id: "early", priority: 3, index: 2 });
		expect(sortByPriority([late, high, early]).map((rule) => rule.id)).toEqual(["high", "early", "late"]);
	});

	it("sorts by priority descending", () => {
		const low = ruleWith({ id: "low", priority: 1 });
		const high = ruleWith({ id: "high", priority: 10 });
		const mid = ruleWith({ id: "mid", priority: 5 });
		expect(sortByPriority([low, high, mid]).map((rule) => rule.id)).toEqual(["high", "mid", "low"]);
	});

	it("orders equal-priority ties by discovery index", () => {
		const first = ruleWith({ id: "first", priority: 3 });
		const second = ruleWith({ id: "second", priority: 3 });
		const third = ruleWith({ id: "third", priority: 3 });
		expect(sortByPriority([first, second, third]).map((rule) => rule.id)).toEqual(["first", "second", "third"]);
	});

	it("does not mutate its input — pure reorder into a new array", () => {
		const low = ruleWith({ id: "low", priority: 1 });
		const high = ruleWith({ id: "high", priority: 9 });
		const input = [low, high];
		const output = sortByPriority(input);
		expect(input.map((rule) => rule.id)).toEqual(["low", "high"]);
		expect(output).not.toBe(input);
	});
});

describe("foldBudget", () => {
	it("budget fill skips non-fitting entries and continues", () => {
		const first = ruleWith({ id: "first", content: contentOfTokens(1) });
		const tooBig = ruleWith({ id: "too-big", content: contentOfTokens(3) });
		const fits = ruleWith({ id: "fits", content: contentOfTokens(1, "y") });
		expect(activeIds(foldBudget([first, tooBig, fits], 2))).toEqual(["first", "fits"]);
	});

	it("budget always keeps the first sorted entry", () => {
		const first = ruleWith({ id: "first", content: contentOfTokens(2) });
		expect(activeIds(foldBudget([first], 0))).toEqual(["first"]);
	});

	it("budget cannot yield zero survivors", () => {
		const first = ruleWith({ id: "first", content: contentOfTokens(2) });
		const second = ruleWith({ id: "second", content: contentOfTokens(1) });
		expect(activeIds(foldBudget([first, second], 0))).toEqual(["first"]);
	});

	it("admits rules while they fit and drops entries that do not fit", () => {
		const one = ruleWith({ id: "one", content: contentOfTokens(1) });
		const two = ruleWith({ id: "two", content: contentOfTokens(1) });
		const three = ruleWith({ id: "three", content: contentOfTokens(2) });
		const four = ruleWith({ id: "four", content: contentOfTokens(1) });
		const result = foldBudget([one, two, three, four], 2);
		expect(activeIds(result)).toEqual(["one", "two"]);
		expect(droppedSummaries(result)).toEqual([
			{ id: "three", cause: "budget" },
			{ id: "four", cause: "budget" },
		]);
	});

	it("admits an exactly-fitting rule (tokens equal remaining budget)", () => {
		const exact = ruleWith({ id: "exact", content: contentOfTokens(2) });
		const result = foldBudget([exact], 2);
		expect(activeIds(result)).toEqual(["exact"]);
		expect(result.dropped).toEqual([]);
	});

	it("keeps zero-token content whenever budget remains, including at zero budget", () => {
		const empty = ruleWith({ id: "empty", content: "" });
		expect(activeIds(foldBudget([empty], 0))).toEqual(["empty"]);
	});

	it("keeps the first non-fitting rule at zero budget", () => {
		const one = ruleWith({ id: "one", content: contentOfTokens(1) });
		const result = foldBudget([one], 0);
		expect(activeIds(result)).toEqual(["one"]);
		expect(droppedSummaries(result)).toEqual([]);
	});

	it("accepts empty input", () => {
		expect(foldBudget([], 5)).toEqual({ active: [], onDemand: [], dropped: [] });
	});

	it("continues after the first overflow and admits later fitting rules", () => {
		const big = ruleWith({ id: "big", content: contentOfTokens(2) });
		const over = ruleWith({ id: "over", content: contentOfTokens(1) });
		const tiny = ruleWith({ id: "tiny", content: "" });
		const result = foldBudget([big, over, tiny], 2);
		expect(activeIds(result)).toEqual(["big", "tiny"]);
		expect(droppedSummaries(result)).toEqual([{ id: "over", cause: "budget" }]);
	});
});

describe("selectRules", () => {
	it("partitions on-demand rules out of the pinned selection", () => {
		const pinned = ruleWith({ id: "pinned" });
		const reference = ruleWith({ id: "reference", load: "on-demand" });
		expect(selectRules([pinned, reference], 100)).toMatchObject({ active: [pinned], onDemand: [reference] });
	});

	it("on-demand entries bypass dedupe (equal content kept)", () => {
		const first = ruleWith({ id: "first", content: "same", load: "on-demand" });
		const second = ruleWith({ id: "second", content: "same", load: "on-demand" });
		expect(selectRules([first, second], 100).onDemand).toEqual([first, second]);
	});

	it("on-demand entries bypass the token budget", () => {
		const reference = ruleWith({ id: "reference", content: contentOfTokens(100), load: "on-demand" });
		expect(selectRules([reference], 0).onDemand).toEqual([reference]);
	});

	it("returns an empty selection for empty input", () => {
		expect(selectRules([], 10)).toEqual({ active: [], onDemand: [], dropped: [] });
	});

	it("composes dedupe → priority sort → budget fold", () => {
		const high = ruleWith({ id: "high", priority: 10, content: contentOfTokens(2) });
		const duplicate = ruleWith({ id: "duplicate", priority: 10, content: contentOfTokens(2) });
		const mid = ruleWith({ id: "mid", priority: 5, content: contentOfTokens(1, "y") });
		const low = ruleWith({ id: "low", priority: 0, content: contentOfTokens(1, "z") });
		const result = selectRules([high, duplicate, mid, low], 3);
		expect(activeIds(result)).toEqual(["high", "mid"]);
		expect(droppedSummaries(result)).toEqual([
			{ id: "duplicate", cause: "duplicate" },
			{ id: "low", cause: "budget" },
		]);
	});

	it("applies stability presentation order after budget selection", () => {
		const conditional = ruleWith({ id: "conditional", priority: 10, globs: ["src/**"], content: contentOfTokens(1), index: 0 });
		const unconditional = ruleWith({ id: "unconditional", priority: 1, content: contentOfTokens(1, "y"), index: 1 });
		expect(activeIds(selectRules([unconditional, conditional], 2))).toEqual(["unconditional", "conditional"]);
	});

	it("orders active rules by priority descending with stable ties", () => {
		const a = ruleWith({ id: "a", priority: 2, content: "one" });
		const b = ruleWith({ id: "b", priority: 5, content: "two" });
		const c = ruleWith({ id: "c", priority: 5, content: "three" });
		const d = ruleWith({ id: "d", priority: 0, content: "four" });
		const result = selectRules([a, b, c, d], 100);
		expect(activeIds(result)).toEqual(["b", "c", "a", "d"]);
	});

	it("drops rules beyond the budget, preserving their original Rule data", () => {
		const keep = ruleWith({ id: "keep", priority: 10, content: contentOfTokens(2) });
		const drop = ruleWith({ id: "drop", priority: 5, content: contentOfTokens(8) });
		const result = selectRules([drop, keep], 2);
		expect(activeIds(result)).toEqual(["keep"]);
		expect(result.dropped).toEqual([{ rule: drop, cause: "budget" }]);
	});

	it("at zero budget, keeps the first rule and drops later non-fitting rules", () => {
		const empty = ruleWith({ id: "empty", content: "" });
		const one = ruleWith({ id: "one", content: contentOfTokens(1) });
		const result = selectRules([empty, one], 0);
		expect(activeIds(result)).toEqual(["empty"]);
		expect(droppedSummaries(result)).toEqual([{ id: "one", cause: "budget" }]);
	});

	it("dedupes before sorting — the higher-priority occurrence wins", () => {
		const first = ruleWith({ id: "first", priority: 1, content: "twin" });
		const twin = ruleWith({ id: "twin", priority: 9, content: "twin" });
		const result = selectRules([first, twin], 100);
		expect(activeIds(result)).toEqual(["twin"]);
		expect(droppedSummaries(result)).toEqual([{ id: "first", cause: "duplicate" }]);
	});
});
