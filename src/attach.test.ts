/**
 * Tests for the mid-run attachment core (S9, pure half): which rules are
 * newly activated, how much attachment budget is left, and how one batch
 * renders into an appendable markdown block.
 *
 * Every case is pure — no I/O, no clock, no session. The central pin is
 * reuse: an attached pinned entry must be byte-identical to the entry the
 * section renderer produces for the same rule and reasons, so mid-run
 * attachment and the system-prompt section can never drift apart.
 *
 * Reading of the delivered contract: `newlyActivated` is given the set of
 * ids already delivered (the current section's actives plus everything
 * attached earlier). Any id in that set is excluded; a caller that seeds the
 * set from the live section therefore excludes exactly the rules the section
 * already renders and receives only genuinely new ones.
 */
import { describe, expect, it } from "vitest";
import { newlyActivated, remainingBudget, renderAttachments } from "./attach.ts";
import { estimateTokens } from "./select.ts";
import { renderSection } from "./render.ts";
import type { RenderEntry } from "./render.ts";
import { normalizedPath, ruleId } from "./types.ts";
import type { DroppedRule, EvaluationTrace, MatchReason, MatchResult, Rule, RuleId } from "./types.ts";

/** Content of exactly `tokens` estimated tokens under the ceil(chars/4) estimate. */
const contentOfTokens = (tokens: number): string => "x".repeat(tokens * 4);

/**
 * Builds a Rule with only the interesting fields set; the rest mirror the
 * parser's materialized defaults (same fixture policy as render.test.ts).
 */
const ruleWith = (fields: {
	readonly id?: string;
	readonly description?: string;
	readonly content?: string;
	readonly relativePath?: string;
	readonly load?: "pinned" | "on-demand";
	readonly enforcement?: "enforce" | "recommend" | "inform";
}): Rule => ({
	...(fields.relativePath === undefined ? {} : { relativePath: normalizedPath(fields.relativePath) }),
	...(fields.load === undefined ? {} : { load: fields.load }),
	id: ruleId(fields.id ?? "test-rule"),
	path: normalizedPath(".pi/rules/test.md"),
	source: "project",
	description: fields.description ?? "test rule",
	match: "both",
	priority: 0,
	enforcement: fields.enforcement ?? "inform",
	alwaysApply: false,
	version: 1,
	content: fields.content ?? "body",
});

/** Wraps a rule and the trigger reasons that selected it into an entry. */
const entry = (rule: Rule, reasons: readonly MatchReason[] = []): RenderEntry => ({ rule, reasons });

/**
 * Builds an EvaluationTrace whose selection holds `active`/`onDemand` and
 * whose results mirror them as matched rules. `reasons` supplies the trigger
 * reasons per rule id (absent → matched with no reasons); `results` overrides
 * the derived list entirely, for totality cases.
 */
const traceWith = (fields: {
	readonly active?: readonly Rule[];
	readonly onDemand?: readonly Rule[];
	readonly dropped?: readonly DroppedRule[];
	readonly reasons?: ReadonlyMap<string, readonly MatchReason[]>;
	readonly results?: readonly MatchResult[];
}): EvaluationTrace => {
	const active = fields.active ?? [];
	const onDemand = fields.onDemand ?? [];
	const results: readonly MatchResult[] = fields.results ?? [...active, ...onDemand].map((rule) => ({
		matched: true as const,
		ruleId: rule.id,
		reasons: fields.reasons?.get(rule.id) ?? [],
	}));
	return {
		evaluatedAt: 1_700_000_000_000,
		matchedPaths: [...active, ...onDemand].map((rule) => rule.path),
		estimatedTokens: 0,
		results,
		selection: { active, onDemand, dropped: fields.dropped ?? [] },
		block: undefined,
	};
};

/** Ids of a batch, for readable order assertions. */
const ids = (batch: readonly RenderEntry[]): readonly string[] => batch.map(({ rule }) => rule.id);

/** An empty delivered set — the common starting point for these cases. */
const noneDelivered: ReadonlySet<RuleId> = new Set<RuleId>();

/** The delivered set a caller builds from already-delivered rule ids. */
const delivered = (...ids: readonly string[]): ReadonlySet<RuleId> => new Set(ids.map(ruleId));

/**
 * Independent oracle for one pinned entry: render a probe rule through the
 * exported section renderer to measure the fixed `# Rules` + framing prefix,
 * then apply that exact prefix length to the target rule's own section and
 * drop the renderer's single trailing newline. Whatever bytes the section
 * renderer emits for an entry must be the bytes the attachment emits.
 */
const sectionEntryText = (target: RenderEntry): string => {
	const probe = entry(ruleWith({ id: "probe", description: "PROBE-HEADING", content: "PROBE-BODY" }));
	const probeSection = renderSection([probe]);
	const targetSection = renderSection([target]);
	if (probeSection === undefined || targetSection === undefined) {
		throw new Error("unreachable: a single entry always renders a section");
	}
	const prefix = probeSection.content.slice(0, probeSection.content.indexOf("## PROBE-HEADING"));
	return targetSection.content.slice(prefix.length, -1);
};

/** The exact attachment header the renderer emits, including separation. */
const header = "\n\n---\n\n## Rules newly activated by this tool result\n\n";

describe("newlyActivated", () => {
	it("returns nothing for a trace with an empty selection", () => {
		expect(newlyActivated(traceWith({}), noneDelivered)).toEqual([]);
	});

	it("returns active and on-demand rules in selection order, carrying their reasons", () => {
		const first = ruleWith({ id: "first", description: "First", content: "first body" });
		const second = ruleWith({ id: "second", description: "Second", load: "on-demand", relativePath: "second.md" });
		const trace = traceWith({
			active: [first],
			onDemand: [second],
			reasons: new Map([["first", [{ kind: "glob", pattern: "src/**" }] as const]]),
		});

		expect(newlyActivated(trace, noneDelivered)).toEqual([
			entry(first, [{ kind: "glob", pattern: "src/**" }]),
			entry(second, []),
		]);
	});

	it("orders pinned candidates before on-demand candidates, as the section does", () => {
		const pinnedA = ruleWith({ id: "a", description: "A" });
		const pinnedB = ruleWith({ id: "b", description: "B" });
		const reference = ruleWith({ id: "ref", load: "on-demand", relativePath: "ref.md" });
		const trace = traceWith({ active: [pinnedA, pinnedB], onDemand: [reference] });

		expect(ids(newlyActivated(trace, noneDelivered))).toEqual(["a", "b", "ref"]);
	});

	it("never re-attaches an active rule that is already delivered by the section", () => {
		const deliveredRule = ruleWith({ id: "already", description: "Already" });
		const fresh = ruleWith({ id: "fresh", description: "Fresh" });
		const trace = traceWith({ active: [deliveredRule, fresh] });

		expect(ids(newlyActivated(trace, delivered("already")))).toEqual(["fresh"]);
	});

	it("never re-attaches a rule attached by an earlier batch", () => {
		const attached = ruleWith({ id: "attached", description: "Attached" });
		const fresh = ruleWith({ id: "fresh", description: "Fresh" });
		const trace = traceWith({ active: [attached, fresh] });

		expect(ids(newlyActivated(trace, delivered("attached")))).toEqual(["fresh"]);
	});

	it("excludes an on-demand rule that was already delivered", () => {
		const reference = ruleWith({ id: "ref", load: "on-demand", relativePath: "ref.md" });
		const other = ruleWith({ id: "other", load: "on-demand", relativePath: "other.md" });
		const trace = traceWith({ onDemand: [reference, other] });

		expect(ids(newlyActivated(trace, delivered("ref")))).toEqual(["other"]);
	});

	it("returns nothing when every matched rule is already delivered", () => {
		const one = ruleWith({ id: "one" });
		const two = ruleWith({ id: "two", load: "on-demand", relativePath: "two.md" });
		const trace = traceWith({ active: [one], onDemand: [two] });

		expect(newlyActivated(trace, delivered("one", "two"))).toEqual([]);
	});

	it("never returns a budget-dropped rule (the section budget already refused it)", () => {
		const kept = ruleWith({ id: "kept" });
		const dropped = ruleWith({ id: "dropped", content: contentOfTokens(50) });
		const trace = traceWith({ active: [kept], dropped: [{ rule: dropped, cause: "budget" }] });

		expect(ids(newlyActivated(trace, noneDelivered))).toEqual(["kept"]);
	});

	it("never returns a muted rule, which cannot appear in the selection at all", () => {
		const kept = ruleWith({ id: "kept" });
		const muted = ruleWith({ id: "muted", content: contentOfTokens(4) });
		const trace = traceWith({ active: [kept] });

		expect(ids(newlyActivated(trace, noneDelivered))).not.toContain(String(muted.id));
	});

	it("degrades to no reasons when a selected rule has no matched result", () => {
		const rule = ruleWith({ id: "orphan" });
		const trace = traceWith({ active: [rule], results: [{ matched: false, ruleId: rule.id, reason: "not matched" }] });

		expect(newlyActivated(trace, noneDelivered)).toEqual([entry(rule, [])]);
	});

	it("is deterministic and does not mutate the delivered set", () => {
		const one = ruleWith({ id: "one" });
		const two = ruleWith({ id: "two", load: "on-demand", relativePath: "two.md" });
		const trace = traceWith({ active: [one], onDemand: [two] });
		const set = delivered("two");

		const first = newlyActivated(trace, set);
		const second = newlyActivated(trace, set);

		expect(first).toEqual(second);
		expect([...set].map(String)).toEqual(["two"]);
	});
});

describe("remainingBudget", () => {
	it("returns the whole budget when nothing is pinned in the section", () => {
		expect(remainingBudget(traceWith({}), 2000)).toBe(2000);
	});

	it("subtracts the estimated tokens of the pinned active bodies only", () => {
		const pinned = ruleWith({ id: "pinned", content: contentOfTokens(30) });
		const reference = ruleWith({ id: "ref", load: "on-demand", relativePath: "ref.md", content: contentOfTokens(100) });
		const dropped = ruleWith({ id: "dropped", content: contentOfTokens(40) });
		const trace = traceWith({ active: [pinned], onDemand: [reference], dropped: [{ rule: dropped, cause: "budget" }] });

		expect(estimateTokens(pinned)).toBe(30);
		expect(remainingBudget(trace, 100)).toBe(70);
	});

	it("may be zero or negative when the section itself overran the budget", () => {
		const big = ruleWith({ id: "big", content: contentOfTokens(60) });
		const trace = traceWith({ active: [big] });

		expect(remainingBudget(trace, 60)).toBe(0);
		expect(remainingBudget(trace, 30)).toBe(-30);
	});
});

describe("renderAttachments", () => {
	it("returns undefined for an empty batch", () => {
		expect(renderAttachments([], 100)).toBeUndefined();
	});

	it("renders one pinned rule that fits as a self-contained block", () => {
		const rule = ruleWith({ id: "alpha", description: "Alpha", content: "alpha body" });
		const reasons: readonly MatchReason[] = [{ kind: "glob", pattern: "src/**" }];

		const attachment = renderAttachments([entry(rule, reasons)], 100);

		expect(attachment).toEqual({
			content: `${header}## Alpha\n> Triggered by: glob \`src/**\`\nalpha body\n`,
			delivered: [rule.id],
		});
	});

	it("emits pinned bodies byte-identically to the section renderer", () => {
		const cases: readonly RenderEntry[] = [
			entry(ruleWith({ id: "plain", description: "Plain", content: "plain body" })),
			entry(ruleWith({ id: "always", description: "Always", content: "always body" }), [{ kind: "always" }]),
			entry(ruleWith({ id: "enforced", description: "Enforced", content: "enforced body", enforcement: "enforce" }), [
				{ kind: "tool", tool: "bash" },
			]),
			entry(ruleWith({ id: "recommended", description: "Recommended", content: "recommended body", enforcement: "recommend" })),
			entry(ruleWith({ id: "padded", description: "Padded", content: "padded body.\n\n\n" }), [{ kind: "always" }]),
		];

		for (const target of cases) {
			const attachment = renderAttachments([target], 100);
			expect(attachment?.content).toBe(`${header}${sectionEntryText(target)}\n`);
		}
	});

	it("renders the trigger and level lines exactly as the section renderer does", () => {
		const rule = ruleWith({ id: "deploy", description: "Deploy", content: "Deploy body.", enforcement: "enforce" });
		const target = entry(rule, [{ kind: "always" }, { kind: "model", model: "gpt-test" }]);

		const attachment = renderAttachments([target], 100);

		expect(attachment?.content).toBe(
			`${header}## Deploy\n> Triggered by: always active · model \`gpt-test\`\n> Level: MUST\nDeploy body.\n`,
		);
		expect(attachment?.content).toBe(`${header}${sectionEntryText(target)}\n`);
	});

	it("consumes budget per emitted body and degrades the rest to references", () => {
		const fits = ruleWith({ id: "fits", description: "Fits", content: contentOfTokens(4), relativePath: "fits.md" });
		const tooBig = ruleWith({ id: "too-big", description: "Too big", content: contentOfTokens(10), relativePath: "big.md" });
		const fitsAfter = ruleWith({ id: "fits-after", description: "Fits after", content: contentOfTokens(2), relativePath: "after.md" });

		const attachment = renderAttachments([entry(fits), entry(tooBig), entry(fitsAfter)], 6);

		expect(attachment?.delivered).toEqual([fits.id, tooBig.id, fitsAfter.id]);
		expect(attachment?.content).toBe(
			`${header}${sectionEntryText(entry(fits))}\n\n---\n\n` +
				"- big.md — Too big (fetch with the read_rule tool)\n\n---\n\n" +
				`${sectionEntryText(entry(fitsAfter))}\n`,
		);
	});

	it("counts a degraded reference line as delivered without charging budget", () => {
		const big = ruleWith({ id: "big", description: "Big", content: contentOfTokens(50), relativePath: "big.md" });
		const small = ruleWith({ id: "small", description: "Small", content: contentOfTokens(2), relativePath: "small.md" });

		const attachment = renderAttachments([entry(big), entry(small)], 2);

		expect(attachment?.delivered).toEqual([big.id, small.id]);
		expect(attachment?.content).toBe(
			`${header}- big.md — Big (fetch with the read_rule tool)\n\n---\n\n${sectionEntryText(entry(small))}\n`,
		);
	});

	it("emits the reference line in the exact on-demand index format", () => {
		const rule = ruleWith({ id: "big", description: "Big", content: contentOfTokens(10), relativePath: "guides/big.md" });
		const indexLine = renderSection([], [rule])?.content.split("\n").find((line) => line.startsWith("- "));

		const attachment = renderAttachments([entry(rule)], 0);

		expect(indexLine).toBe("- guides/big.md — Big (fetch with the read_rule tool)");
		expect(attachment?.content).toBe(`${header}${indexLine ?? ""}\n`);
	});

	it("emits nothing and delivers nothing for an unfittable rule without a relativePath", () => {
		const hidden = ruleWith({ id: "hidden", description: "Hidden", content: contentOfTokens(10) });
		const visible = ruleWith({ id: "visible", description: "Visible", content: contentOfTokens(2), relativePath: "v.md" });

		const attachment = renderAttachments([entry(hidden), entry(visible)], 2);

		expect(attachment?.delivered).toEqual([visible.id]);
		expect(attachment?.content).toBe(`${header}${sectionEntryText(entry(visible))}\n`);
	});

	it("emits only the index line for an on-demand rule, charging no budget", () => {
		const reference = ruleWith({
			id: "ref",
			description: "Reference",
			content: contentOfTokens(100),
			relativePath: "guides/ref.md",
			load: "on-demand",
		});
		const pinned = ruleWith({ id: "pinned", description: "Pinned", content: contentOfTokens(3), relativePath: "pinned.md" });

		const attachment = renderAttachments([entry(reference), entry(pinned)], 3);

		expect(attachment?.delivered).toEqual([reference.id, pinned.id]);
		expect(attachment?.content).toBe(
			`${header}- guides/ref.md — Reference (fetch with the read_rule tool)\n\n---\n\n${sectionEntryText(entry(pinned))}\n`,
		);
		expect(attachment?.content).not.toContain(contentOfTokens(100));
	});

	it("emits nothing for an on-demand rule without a relativePath", () => {
		const reference = ruleWith({ id: "ref", description: "Reference", load: "on-demand" });

		expect(renderAttachments([entry(reference)], 100)).toBeUndefined();
	});

	it("adheres to the exact budget boundary", () => {
		const exact = ruleWith({ id: "exact", description: "Exact", content: contentOfTokens(5) });

		expect(renderAttachments([entry(exact)], 5)?.delivered).toEqual([exact.id]);
		expect(renderAttachments([entry(exact)], 4)).toBeUndefined();
	});

	it("degrades every pinned rule to a reference when no budget is left", () => {
		const one = ruleWith({ id: "one", description: "One", content: contentOfTokens(1), relativePath: "one.md" });
		const two = ruleWith({ id: "two", description: "Two", content: contentOfTokens(1), relativePath: "two.md" });

		const attachment = renderAttachments([entry(one), entry(two)], -5);

		expect(attachment?.content).toBe(
			`${header}- one.md — One (fetch with the read_rule tool)\n\n---\n\n- two.md — Two (fetch with the read_rule tool)\n`,
		);
		expect(attachment?.delivered).toEqual([one.id, two.id]);
	});

	it("preserves the batch order in text and delivered ids", () => {
		const a = ruleWith({ id: "a", description: "A", content: contentOfTokens(1) });
		const b = ruleWith({ id: "b", description: "B", content: contentOfTokens(1) });
		const c = ruleWith({ id: "c", description: "C", content: contentOfTokens(1) });

		const attachment = renderAttachments([entry(b), entry(c), entry(a)], 100);

		expect(attachment?.delivered).toEqual([b.id, c.id, a.id]);
		expect(attachment?.content.indexOf("## B")).toBeLessThan(attachment?.content.indexOf("## C") ?? -1);
		expect(attachment?.content.indexOf("## C")).toBeLessThan(attachment?.content.indexOf("## A") ?? -1);
	});

	it("renders a bodyless pinned rule as its heading alone", () => {
		const empty = ruleWith({ id: "empty", description: "Empty", content: "" });

		const attachment = renderAttachments([entry(empty)], 0);

		expect(attachment?.delivered).toEqual([empty.id]);
		expect(attachment?.content).toBe(`${header}## Empty\n\n`);
	});

	it("returns undefined when nothing can be honestly rendered", () => {
		const hidden = ruleWith({ id: "hidden", content: contentOfTokens(10) });

		expect(renderAttachments([entry(hidden)], 0)).toBeUndefined();
	});

	it("is deterministic and returns deep-equal results for equal inputs", () => {
		const pinned = ruleWith({ id: "pinned", description: "Pinned", content: contentOfTokens(3) });
		const reference = ruleWith({ id: "ref", description: "Ref", load: "on-demand", relativePath: "ref.md" });
		const batch = [entry(pinned, [{ kind: "always" }]), entry(reference)];

		const first = renderAttachments(batch, 100);
		const second = renderAttachments(batch, 100);

		expect(first).toEqual(second);
		expect(first?.content).toBe(second?.content ?? "");
	});

	it("ends with exactly one trailing newline and starts separated from tool output", () => {
		const rule = ruleWith({ id: "rule", description: "Rule", content: "body" });

		const content = renderAttachments([entry(rule)], 100)?.content ?? "";

		expect(content.startsWith("\n\n---\n\n")).toBe(true);
		expect(content.endsWith("\n")).toBe(true);
		expect(content.endsWith("\n\n")).toBe(false);
	});
});
