/**
 * Tests for the injection-cycle orchestrator (shell/pipeline.ts).
 *
 * Everything is injected and deterministic: `discover` is a fake returning
 * frozen rule fixtures (recording the options it received), the scanner is
 * a fake async function (recording calls), and time is a fixed `Date` —
 * the module under test must contain no clock, filesystem, or crypto of
 * its own. All cycles run against in-memory `SessionState` values; the
 * orchestrator must return fresh state and never mutate its input.
 */
import { homedir } from "node:os";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:os", () => ({ homedir: () => "C:/Users/x" }));
import { initialState, transition } from "../src/state.ts";
import type { SessionState } from "../src/state.ts";
import { normalizedPath, ruleId } from "../src/types.ts";
import type { Rule, RuleError } from "../src/types.ts";
import { DEFAULT_BUDGET_TOKENS, evaluateCurrent, renderTraceReport, runInjectionCycle } from "./pipeline.ts";
import type { DiscoverOptions, PipelineDeps, PipelineInput } from "./pipeline.ts";

/** Fixed wall-clock input: every cycle in this suite evaluates at this instant. */
const NOW = new Date("2026-07-14T12:00:00.000Z");

/** Builds a minimal Rule; defaults make it active everywhere with no scan. */
const ruleWith = (fields: {
	readonly id?: string;
	readonly globs?: readonly string[];
	readonly match?: "touched" | "exists" | "both";
	readonly priority?: number;
	readonly alwaysApply?: boolean;
	readonly content?: string;
}): Rule => ({
	id: ruleId(fields.id ?? "rule-a"),
	path: normalizedPath(`/work/.pi/rules/${fields.id ?? "rule-a"}.md`),
	source: "project",
	description: `test rule ${fields.id ?? "rule-a"}`,
	...(fields.globs === undefined ? {} : { globs: fields.globs }),
	match: fields.match ?? "touched",
	priority: fields.priority ?? 0,
	enforcement: "inform",
	alwaysApply: fields.alwaysApply ?? true,
	version: 1,
	content: fields.content ?? `body of ${fields.id ?? "rule-a"}\n`,
});

interface RecordedCycle {
	/** Options the fake discover received, in call order. */
	readonly discoverCalls: DiscoverOptions[];
	/** Patterns the fake scanner received, in call order. */
	readonly scanCalls: string[][];
}

/**
 * Fake PipelineDeps: discover always yields the given rules and errors,
 * scan always yields no files; both record their inputs.
 */
const depsWith = (rules: readonly Rule[], errors: readonly RuleError[] = []): { readonly deps: PipelineDeps; readonly recorded: RecordedCycle } => {
	const recorded: RecordedCycle = { discoverCalls: [], scanCalls: [] };
	const deps: PipelineDeps = {
		discover: async (opts) => {
			recorded.discoverCalls.push(opts);
			return { rules, errors };
		},
		scan: async (patterns) => {
			recorded.scanCalls.push([...patterns]);
			return [];
		},
		budget: DEFAULT_BUDGET_TOKENS,
	};
	return { deps, recorded };
};

/** Builds a cycle input over the given state with a fixed cwd/clock/session. */
const inputWith = (state: SessionState, deps: PipelineDeps): PipelineInput => ({
	state,
	cwd: "/work",
	prompt: "",
	now: NOW,
	trusted: true,
	session: { toolNames: ["read", "edit"], model: "test-model", branch: undefined },
	deps,
});

describe("DEFAULT_BUDGET_TOKENS", () => {
	it("is the pinned 2000-token budget", () => {
		expect(DEFAULT_BUDGET_TOKENS).toBe(2000);
	});
});

describe("runInjectionCycle", () => {
	it("patches when a trusted rule matches: decision patch, hash folded, trace consistent", async () => {
		const rule = ruleWith({ id: "always-on" });
		const { deps, recorded } = depsWith([rule]);
		const result = await runInjectionCycle(inputWith(initialState, deps));

		expect(result.decision).toEqual({ action: "patch" });
		expect(result.block).toBeDefined();
		expect(result.nextState.lastInjectedHash).toBe(result.block?.contentHash);
		expect(result.nextState).not.toBe(initialState);
		// Trace consistency: the active rule is matched, selection carries it,
		// and the block exists exactly because something is active.
		expect(result.trace.results).toHaveLength(1);
		expect(result.trace.results[0]).toMatchObject({ matched: true, ruleId: rule.id });
		expect(result.trace.selection.active).toEqual([{ ...rule, index: 0, relativePath: "always-on.md" }]);
		expect(result.trace.block).toBe(result.block);
		// The cycle drove discovery through the injected seam with the trust gate.
		expect(recorded.discoverCalls).toEqual([{ cwd: normalizedPath("/work"), isProjectTrusted: true }]);
		// Touched-only rules never widen the exists-scan.
		expect(recorded.scanCalls).toEqual([]);
	});

	it("materializes project-first indexes and source-root-relative paths", async () => {
		const global = {
			...ruleWith({ id: "global" }),
			source: "global" as const,
			path: normalizedPath(`${homedir()}/.pi/agent/rules/python/style.md`),
		};
		const project = ruleWith({ id: "project" });
		const { deps } = depsWith([global, project]);
		const result = await runInjectionCycle(inputWith(initialState, deps));
		expect(result.trace.selection.active.map(({ id, index, relativePath }) => ({ id, index, relativePath }))).toEqual([
			{ id: project.id, index: 0, relativePath: "project.md" },
			{ id: global.id, index: 1, relativePath: "python/style.md" },
		]);
	});

	it("re-applies on an identical second cycle: still patch, state folds to the same value", async () => {
		const { deps } = depsWith([ruleWith({ id: "always-on" })]);
		const first = await runInjectionCycle(inputWith(initialState, deps));
		expect(first.decision).toEqual({ action: "patch" });

		// pi rebuilds sections every turn, so the identical set must still patch
		// (the write is what keeps the section live); folding the same hash is an
		// idempotent same-value overwrite, so the new state is value-identical.
		const second = await runInjectionCycle(inputWith(first.nextState, deps));
		expect(second.decision).toEqual({ action: "patch" });
		expect(second.nextState).not.toBe(first.nextState);
		expect(second.nextState).toEqual(first.nextState);
		// Each run renders a fresh block object; identity is the content hash.
		expect(second.block).toEqual(first.block);
		expect(second.block?.contentHash).toBe(first.block?.contentHash);
		expect(second.trace.block).toEqual(first.trace.block);
	});

	it("removes when nothing is active after a prior inject, folding block_removed", async () => {
		const active = ruleWith({ id: "always-on" });
		const { deps } = depsWith([active]);
		const first = await runInjectionCycle(inputWith(initialState, deps));
		expect(first.decision).toEqual({ action: "patch" });

		const empty = depsWith([]);
		const second = await runInjectionCycle(
			inputWith(
				{
					touchedPaths: [normalizedPath("src/a.ts")],
					lastInjectedHash: first.block?.contentHash,
					mutedRuleIds: [],
					deliveredRuleIds: [],
				},
				empty.deps,
			),
		);
		expect(second.decision).toEqual({ action: "remove" });
		expect(second.block).toBeUndefined();
		expect(second.nextState.lastInjectedHash).toBeUndefined();
		// Removal clears the hash but keeps touched paths.
		expect(second.nextState.touchedPaths).toEqual([normalizedPath("src/a.ts")]);
	});

	it("excludes an untrusted project rule: defense-in-depth gate, no block, discover told the truth", async () => {
		const rule = ruleWith({ id: "project-only" });
		const { deps, recorded } = depsWith([rule]);
		const untrusted = { ...inputWith(initialState, deps), trusted: false };
		const result = await runInjectionCycle(untrusted);

		expect(recorded.discoverCalls[0]?.isProjectTrusted).toBe(false);
		expect(result.trace.results[0]).toMatchObject({
			matched: false,
			reason: expect.stringContaining("not trusted"),
		});
		expect(result.trace.block).toBeUndefined();
		expect(result.decision).toEqual({ action: "none" });
		expect(result.nextState).toBe(initialState);
	});

	it("resolves a Windows-style global rules relative path", async () => {
		const rule: Rule = {
			...ruleWith({ id: "windows-global" }),
			source: "global",
			path: normalizedPath("C:/Users/x/.pi/agent/rules/ts.md"),
		};
		const { deps } = depsWith([rule]);
		const result = await runInjectionCycle(inputWith(initialState, deps));
		expect(result.trace.selection.active[0]?.relativePath).toBe("ts.md");
	});

	it("records budget drops in the trace while patching what fits", async () => {
		const big = ruleWith({ id: "big", content: "x".repeat(40) }); // ~10 tokens
		const other = ruleWith({ id: "other", content: "y".repeat(40) }); // ~10 tokens
		const { deps } = depsWith([big, other]);
		const input = { ...inputWith(initialState, deps) };
		const result = await runInjectionCycle({ ...input, deps: { ...deps, budget: 15 } });

		expect(result.trace.selection.active).toEqual([{ ...big, index: 0, relativePath: "big.md" }]);
		expect(result.trace.selection.dropped).toEqual([{ rule: { ...other, index: 1, relativePath: "other.md" }, cause: "budget" }]);
		expect(result.decision).toEqual({ action: "patch" });
		expect(result.block).toBeDefined();
	});

	it("is deterministic: equal inputs give deep-equal outputs and never mutate the input state", async () => {
		const state: SessionState = { touchedPaths: [normalizedPath("src/a.ts")], lastInjectedHash: undefined, mutedRuleIds: [], deliveredRuleIds: [] };
		const snapshot: SessionState = { touchedPaths: [normalizedPath("src/a.ts")], lastInjectedHash: undefined, mutedRuleIds: [], deliveredRuleIds: [] };
		const { deps } = depsWith([ruleWith({ id: "always-on" })]);
		const input = inputWith(state, deps);

		const first = await runInjectionCycle(input);
		const second = await runInjectionCycle(input);

		expect(first).toEqual(second);
		expect(first.nextState).not.toBe(state);
		// The input state object is untouched by either run.
		expect(state).toEqual(snapshot);
	});

	describe("enriched rules exposure (L7 fix)", () => {
		it("exposes the enriched rules of the cycle, with index and rules-root-relative path", async () => {
			// Production-shaped discovery: shell/discovery.ts returns rules WITHOUT
			// `relativePath`/`index`; only the pipeline derives them. Exposing the
			// enriched list is what lets the wiring's `read_rule` and `/rules show`
			// resolve a body instead of answering "Unknown rule" (L7).
			const global = {
				...ruleWith({ id: "global" }),
				source: "global" as const,
				path: normalizedPath(`${homedir()}/.pi/agent/rules/python/style.md`),
			};
			const project = ruleWith({ id: "project" });
			const { deps } = depsWith([global, project]);
			const result = await runInjectionCycle(inputWith(initialState, deps));

			expect(result.rules.map(({ id, index, relativePath }) => ({ id, index, relativePath }))).toEqual([
				{ id: project.id, index: 0, relativePath: "project.md" },
				{ id: global.id, index: 1, relativePath: "python/style.md" },
			]);
			expect(result.rules[0]).toEqual(result.trace.selection.active[0]);
		});

		it("exposes rules that were not selected, so an inactive rule still resolves", async () => {
			const inactive = ruleWith({ id: "inactive", globs: ["nope/**"], alwaysApply: false });
			const { deps } = depsWith([inactive]);
			const result = await runInjectionCycle(inputWith(initialState, deps));

			expect(result.trace.selection.active).toEqual([]);
			expect(result.rules.map((rule) => rule.id)).toEqual([inactive.id]);
			expect(result.rules[0]?.relativePath).toBe("inactive.md");
		});

		it("keeps an already-present relativePath and never mutates the discovered rule objects", async () => {
			const rule = Object.freeze({ ...ruleWith({ id: "preset" }), relativePath: normalizedPath("custom/preset.md") });
			const { deps } = depsWith([rule]);
			const result = await runInjectionCycle(inputWith(initialState, deps));

			expect(result.rules[0]?.relativePath).toBe("custom/preset.md");
			expect(result.rules[0]?.index).toBe(0);
			expect(rule.relativePath).toBe("custom/preset.md");
		});
	});

	describe("evaluateCurrent (non-folding evaluation seam)", () => {
		it("evaluates current state without folding any injection decision", async () => {
			const { deps } = depsWith([ruleWith({ id: "always-on" })]);
			const state: SessionState = { touchedPaths: [], lastInjectedHash: "hash-from-a-real-cycle", mutedRuleIds: [], deliveredRuleIds: [] };
			const outcome = await evaluateCurrent(inputWith(state, deps));

			// A trace and the enriched rules, exactly like a cycle, but NO decision and
			// no next state: folding here would corrupt the last-injected hash of the
			// section the real cycle owns.
			expect(outcome.trace.selection.active.map((rule) => rule.id)).toEqual(["always-on"]);
			expect(outcome.rules.map((rule) => rule.id)).toEqual(["always-on"]);
			expect(outcome).not.toHaveProperty("decision");
			expect(outcome).not.toHaveProperty("nextState");
			expect(state.lastInjectedHash).toBe("hash-from-a-real-cycle");
		});

		it("matches the trace runInjectionCycle produces for equal inputs", async () => {
			const rule = ruleWith({ id: "touched-rule", globs: ["src/**/*.ts"], alwaysApply: false });
			const { deps } = depsWith([rule]);
			const state = transition(initialState, { type: "paths_touched", paths: [normalizedPath("src/a.ts")] });
			const outcome = await evaluateCurrent(inputWith(state, deps));
			const cycle = await runInjectionCycle(inputWith(state, deps));

			expect(outcome.trace).toEqual(cycle.trace);
			expect(outcome.rules).toEqual(cycle.rules);
		});

		it("sees touched paths folded after the last cycle and carries the reason", async () => {
			const rule = ruleWith({ id: "touched-rule", globs: ["src/**/*.ts"], alwaysApply: false });
			const { deps } = depsWith([rule]);
			const cold = await evaluateCurrent(inputWith(initialState, deps));
			expect(cold.trace.selection.active).toEqual([]);

			const touched = transition(initialState, { type: "paths_touched", paths: [normalizedPath("src/a.ts")] });
			const warm = await evaluateCurrent(inputWith(touched, deps));
			expect(warm.trace.selection.active.map((active) => active.id)).toEqual([rule.id]);
			expect(warm.trace.results[0]?.matched).toBe(true);
		});

		it("never mutates the input state and reports discovery errors instead of folding them", async () => {
			const error: RuleError = { code: "unknown-key", message: "unknown key: owners", file: "/work/.pi/rules/bad.md" };
			const state: SessionState = { touchedPaths: [], lastInjectedHash: undefined, mutedRuleIds: [], deliveredRuleIds: ["rule-a"] };
			const snapshot: SessionState = { ...state };
			const { deps } = depsWith([ruleWith({ id: "always-on" })], [error]);

			const outcome = await evaluateCurrent(inputWith(state, deps));

			expect(state).toEqual(snapshot);
			expect(outcome.errors).toEqual([error]);
			expect(outcome.trace.selection.active.map((rule) => rule.id)).toEqual(["always-on"]);
		});
	});

	describe("session mute (v1.2)", () => {
		it("threads mutes from the input state: the muted rule is inactive and its section is removed", async () => {
			const rule = ruleWith({ id: "always-on" });
			const { deps } = depsWith([rule]);
			const first = await runInjectionCycle(inputWith(initialState, deps));
			expect(first.decision).toEqual({ action: "patch" });

			const mutedState = transition(first.nextState, { type: "rules_muted", ruleId: "always-on" });
			const second = await runInjectionCycle(inputWith(mutedState, deps));

			expect(second.trace.results).toEqual([{ matched: false, ruleId: rule.id, reason: "muted for this session" }]);
			expect(second.trace.selection.active).toEqual([]);
			expect(second.block).toBeUndefined();
			expect(second.decision).toEqual({ action: "remove" });
			// The mute survives the cycle: only the injection decision is folded.
			expect(second.nextState.mutedRuleIds).toEqual(["always-on"]);
			expect(second.nextState.lastInjectedHash).toBeUndefined();
			const report = renderTraceReport(second.trace, [], [rule]);
			expect(report).toContain("inactive: always-on (muted for this session)");
			// The mute reason stands alone: no `configured:` detail lines follow.
			expect(report).not.toContain("  configured:");
		});

		it("re-includes the rule on the cycle after an unmute", async () => {
			const rule = ruleWith({ id: "always-on", content: "BODY TEXT\n" });
			const { deps } = depsWith([rule]);
			const muted = transition(initialState, { type: "rules_muted", ruleId: "always-on" });
			const mutedRun = await runInjectionCycle(inputWith(muted, deps));
			expect(mutedRun.block).toBeUndefined();

			const unmuted = transition(mutedRun.nextState, { type: "rules_unmuted", ruleId: "always-on" });
			const run = await runInjectionCycle(inputWith(unmuted, deps));
			expect(run.decision).toEqual({ action: "patch" });
			expect(run.trace.selection.active.map((active) => active.id)).toEqual([rule.id]);
			expect(run.nextState.mutedRuleIds).toEqual([]);
			expect(renderTraceReport(run.trace, [], [rule])).toContain("active: always-on (always active)");
		});

		it("keeps the mute across re-discovery: a re-discovered unchanged rule stays muted", async () => {
			const rule = ruleWith({ id: "always-on" });
			const { deps, recorded } = depsWith([rule]);
			const muted = transition(initialState, { type: "rules_muted", ruleId: "always-on" });
			const first = await runInjectionCycle(inputWith(muted, deps));
			const second = await runInjectionCycle(inputWith(first.nextState, deps));

			// Muting is by id, so a fresh discovery result for the same id keeps it off.
			expect(recorded.discoverCalls).toHaveLength(2);
			expect(second.trace.results[0]?.matched).toBe(false);
			expect(second.block).toBeUndefined();
			expect(second.nextState.mutedRuleIds).toEqual(["always-on"]);
		});
	});

	describe("renderTraceReport", () => {
		it("includes configured condition descriptions for unmatched rules found in rules", async () => {
			const rule: Rule = {
				...ruleWith({ id: "configured", globs: ["**/*.ts"], alwaysApply: false }),
				model: "other-model",
			};
			const { deps } = depsWith([rule]);
			const result = await runInjectionCycle({ ...inputWith(initialState, deps), trusted: false });
			const report = renderTraceReport(result.trace, [], [rule]);

			expect(report).toContain("  configured: files matching: **/*.ts");
			expect(report).toContain("  configured: model: other-model");
		});

		it("preserves the existing report output when rules are omitted", async () => {
			const { deps } = depsWith([ruleWith({ id: "always-on" })]);
			const result = await runInjectionCycle(inputWith(initialState, deps));
			expect(renderTraceReport(result.trace, [])).toEqual([
				"Rules evaluation report",
				"Evaluated at: 2026-07-14T12:00:00.000Z",
				"active: always-on (always active)",
				`injected: section pi-rules-md (hash ${result.block?.contentHash})`,
			]);
		});

		it("reports pinned budget usage and the whole-section estimate when a budget is supplied", async () => {
			const pinned = ruleWith({ id: "pinned", content: "x".repeat(40) }); // ceil(40/4) = 10 tokens
			const { deps } = depsWith([pinned]);
			const result = await runInjectionCycle({ ...inputWith(initialState, deps), deps: { ...deps, budget: 15 } });
			const report = renderTraceReport(result.trace, [], [pinned], 15);
			expect(report).toContain("budget: 10/15 estimated tokens");
			expect(report).toContain(`section: ~${result.trace.estimatedTokens} tokens`);
			expect(report.findIndex((line) => line.startsWith("budget: 10/15"))).toBeLessThan(
				report.findIndex((line) => line.startsWith("injected:")),
			);
		});

		it("counts only pinned bodies as used: an on-demand rule adds index estimate but no used tokens", async () => {
			const pinned = ruleWith({ id: "pinned", content: "x".repeat(40) }); // 10 tokens
			const reference: Rule = { ...ruleWith({ id: "reference", content: "y".repeat(400) }), load: "on-demand" };
			const { deps } = depsWith([pinned, reference]);
			const result = await runInjectionCycle(inputWith(initialState, deps));
			const report = renderTraceReport(result.trace, [], undefined, DEFAULT_BUDGET_TOKENS);
			expect(report).toContain(`budget: 10/${DEFAULT_BUDGET_TOKENS} estimated tokens`);
			expect(report).toContain(`section: ~${result.trace.estimatedTokens} tokens`);
			// The section estimate covers the rendered on-demand index line too.
			expect(result.trace.estimatedTokens).toBeGreaterThan(10);
		});

		it("keeps the budget line but drops the section line when nothing is active", async () => {
			const { deps } = depsWith([ruleWith({ id: "never", globs: ["nope/**"], alwaysApply: false })]);
			const result = await runInjectionCycle(inputWith(initialState, deps));
			const report = renderTraceReport(result.trace, [], undefined, DEFAULT_BUDGET_TOKENS);
			expect(report).toContain(`budget: 0/${DEFAULT_BUDGET_TOKENS} estimated tokens`);
			expect(report.some((line) => line.startsWith("section:"))).toBe(false);
			expect(report.some((line) => line.startsWith("injected:"))).toBe(false);
		});

		it("omits the budget and section lines when no budget is supplied", async () => {
			const { deps } = depsWith([ruleWith({ id: "always-on" })]);
			const result = await runInjectionCycle(inputWith(initialState, deps));
			const report = renderTraceReport(result.trace, []);
			expect(report.some((line) => line.startsWith("budget:"))).toBe(false);
			expect(report.some((line) => line.startsWith("section:"))).toBe(false);
		});
	});
});
