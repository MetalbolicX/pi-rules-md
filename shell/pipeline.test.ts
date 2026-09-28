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
import { describe, expect, it, vi } from "vitest";
import { initialState } from "../src/state.ts";
import type { SessionState } from "../src/state.ts";
import { normalizedPath, ruleId } from "../src/types.ts";
import type { EvaluationTrace, Rule, RuleError } from "../src/types.ts";
import { DEFAULT_BUDGET_TOKENS, runInjectionCycle } from "./pipeline.ts";
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
		expect(result.trace.selection.active).toEqual([{ ...rule, index: 0 }]);
		expect(result.trace.block).toBe(result.block);
		// The cycle drove discovery through the injected seam with the trust gate.
		expect(recorded.discoverCalls).toEqual([{ cwd: normalizedPath("/work"), isProjectTrusted: true }]);
		// Touched-only rules never widen the exists-scan.
		expect(recorded.scanCalls).toEqual([]);
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
			inputWith({ touchedPaths: [normalizedPath("src/a.ts")], lastInjectedHash: first.block?.contentHash }, empty.deps),
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

	it("PI_RULES_MAX_TOKENS overrides the default budget", async () => {
		const large = ruleWith({ id: "large", content: "x".repeat(8400) });
		const small = ruleWith({ id: "small", content: "y".repeat(400) });
		const { deps } = depsWith([large, small]);
		vi.stubEnv("PI_RULES_MAX_TOKENS", "3000");
		try {
			const result = await runInjectionCycle(inputWith(initialState, deps));
			expect(result.trace.selection.active.map((rule) => rule.id)).toEqual(["large", "small"]);
		} finally { vi.unstubAllEnvs(); }
	});

	it("invalid and non-positive PI_RULES_MAX_TOKENS values fall back to the default", async () => {
		const large = ruleWith({ id: "large", content: "x".repeat(8400) });
		const small = ruleWith({ id: "small", content: "y".repeat(400) });
		const { deps } = depsWith([large, small]);
		for (const value of ["invalid", "0", "-2"]) {
			vi.stubEnv("PI_RULES_MAX_TOKENS", value);
			try {
				const result = await runInjectionCycle(inputWith(initialState, deps));
				expect(result.trace.selection.active.map((rule) => rule.id)).toEqual(["large"]);
			} finally { vi.unstubAllEnvs(); }
		}
	});

	it("records budget drops in the trace while patching what fits", async () => {
		const big = ruleWith({ id: "big", content: "x".repeat(40) }); // ~10 tokens
		const other = ruleWith({ id: "other", content: "y".repeat(40) }); // ~10 tokens
		const { deps } = depsWith([big, other]);
		const input = { ...inputWith(initialState, deps) };
		const result = await runInjectionCycle({ ...input, deps: { ...deps, budget: 15 } });

		expect(result.trace.selection.active).toEqual([{ ...big, index: 0 }]);
		expect(result.trace.selection.dropped).toEqual([{ rule: { ...other, index: 1 }, cause: "budget" }]);
		expect(result.decision).toEqual({ action: "patch" });
		expect(result.block).toBeDefined();
	});

	it("is deterministic: equal inputs give deep-equal outputs and never mutate the input state", async () => {
		const state: SessionState = { touchedPaths: [normalizedPath("src/a.ts")], lastInjectedHash: undefined };
		const snapshot: SessionState = { touchedPaths: [normalizedPath("src/a.ts")], lastInjectedHash: undefined };
		const { deps } = depsWith([ruleWith({ id: "always-on" })]);
		const input = inputWith(state, deps);

		const first = await runInjectionCycle(input);
		const second = await runInjectionCycle(input);

		expect(first).toEqual(second);
		expect(first.nextState).not.toBe(state);
		// The input state object is untouched by either run.
		expect(state).toEqual(snapshot);
	});
});
