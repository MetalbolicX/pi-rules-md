/**
 * Tests for the evaluation pipeline (src/engine.ts): trust gate → exists-scan
 * enrichment → path matching → non-path condition AND → selection → render.
 *
 * Everything is injected and deterministic: scanners are fake async functions
 * over fixtures (no disk I/O), time comes from `ctx.now`, and the
 * immutability tests deep-freeze their inputs so any mutation would throw.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { evaluate } from "./engine.ts";
import { normalizedPath, ruleId } from "./types.ts";
import type { EvaluationContext, EvaluationTrace, MatchMode, MatchResult, Rule, RuleSource } from "./types.ts";

/** One recorded scanner invocation: what was scanned, from where. */
interface ScanCall {
	readonly patterns: readonly string[];
	readonly cwd: ReturnType<typeof normalizedPath>;
}

/** Builds a scanner returning `results` (frozen — mutation would throw) and recording every call. */
const scannerReturning = (results: readonly string[]): {
	readonly scanner: (patterns: readonly string[], cwd: ReturnType<typeof normalizedPath>) => Promise<readonly string[]>;
	readonly calls: ScanCall[];
} => {
	const calls: ScanCall[] = [];
	const frozen = Object.freeze([...results]);
	const scanner = async (patterns: readonly string[], cwd: ReturnType<typeof normalizedPath>): Promise<readonly string[]> => {
		calls.push({ patterns: [...patterns], cwd });
		return frozen;
	};
	return { scanner, calls };
};

/** Builds a scanner whose every call rejects, for failure propagation tests. */
const scannerFailing = (): {
	readonly scanner: (patterns: readonly string[], cwd: ReturnType<typeof normalizedPath>) => Promise<readonly string[]>;
	readonly calls: ScanCall[];
} => {
	const calls: ScanCall[] = [];
	const scanner = async (patterns: readonly string[], cwd: ReturnType<typeof normalizedPath>): Promise<readonly string[]> => {
		calls.push({ patterns: [...patterns], cwd });
		throw new Error("scan failed");
	};
	return { scanner, calls };
};

/**
 * Builds a Rule with only the interesting fields set; the rest mirror the
 * parser's materialized defaults. Absent optional fields stay truly absent
 * (exactOptionalPropertyTypes-safe), like a rule parsed without the key.
 */
const ruleWith = (fields: {
	readonly id?: string;
	readonly source?: RuleSource;
	readonly globs?: readonly string[];
	readonly match?: MatchMode;
	readonly tools?: readonly string[];
	readonly branch?: string;
	readonly model?: string;
	readonly priority?: number;
	readonly alwaysApply?: boolean;
	readonly content?: string;
	readonly load?: "pinned" | "on-demand";
	readonly relativePath?: string;
	readonly keywords?: readonly string[];
}): Rule => ({
	...(fields.load === undefined ? {} : { load: fields.load }),
	...(fields.keywords === undefined ? {} : { keywords: [...fields.keywords] }),
	...(fields.relativePath === undefined ? {} : { relativePath: normalizedPath(fields.relativePath) }),
	id: ruleId(fields.id ?? "test-rule"),
	path: normalizedPath(fields.source === "global" ? `~/.pi/agent/rules/${fields.id ?? "test-rule"}.md` : `.pi/rules/${fields.id ?? "test-rule"}.md`),
	source: fields.source ?? "project",
	description: "test rule",
	...(fields.globs === undefined ? {} : { globs: fields.globs }),
	match: fields.match ?? "both",
	...(fields.tools === undefined ? {} : { tools: fields.tools }),
	...(fields.branch === undefined ? {} : { branch: fields.branch }),
	...(fields.model === undefined ? {} : { model: fields.model }),
	priority: fields.priority ?? 0,
	enforcement: "inform",
	alwaysApply: fields.alwaysApply ?? false,
	version: 1,
	content: fields.content ?? "body",
});

/**
 * Builds an EvaluationContext with only the interesting fields set; the rest
 * mirror the shapes used by the match/predicate tests.
 */
const contextWith = (fields: {
	readonly now?: number;
	readonly isProjectTrusted?: boolean;
	readonly touchedPaths?: readonly string[];
	readonly existingPaths?: readonly string[];
	readonly toolNames?: readonly string[];
	readonly model?: string;
	readonly branch?: string;
}): EvaluationContext => ({
	now: fields.now ?? 1_700_000_000_000,
	cwd: normalizedPath("/proj"),
	isProjectTrusted: fields.isProjectTrusted ?? true,
	touchedPaths: (fields.touchedPaths ?? []).map(normalizedPath),
	existingPaths: (fields.existingPaths ?? []).map(normalizedPath),
	toolNames: fields.toolNames ?? [],
	...(fields.model === undefined ? {} : { model: fields.model }),
	...(fields.branch === undefined ? {} : { branch: fields.branch }),
});

const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex");

/** Asserts the result is unmatched and returns its reason (typecheck-safe indexing). */
const reasonOf = (result: MatchResult | undefined): string => {
	expect(result?.matched).toBe(false);
	return result !== undefined && !result.matched ? result.reason : "";
};

/** Recursively freezes a fixture so any mutation attempt throws in strict mode. */
const deepFreeze = <T>(value: T): T => {
	if (value !== null && typeof value === "object") {
		for (const key of Object.keys(value as Record<string, unknown>)) {
			deepFreeze((value as Record<string, unknown>)[key]);
		}
		Object.freeze(value);
	}
	return value;
};

describe("evaluate — intent", () => {
	it("match reason records intent satisfaction", async () => {
		const trace = await evaluate([ruleWith({ globs: ["**/*.py"] })], contextWith({}), {
			scan: async () => [], budget: 2000, prompt: "Please use Python",
		});
		expect(trace.results[0]).toMatchObject({ matched: true, reasons: [{ kind: "glob", pattern: "intent: *.py" }] });
	});
});

describe("evaluate — exists-scan enrichment", () => {
	it("scans once with only the positive globs of exists/both rules; touched-only rules never widen the scan", async () => {
		const { scanner, calls } = scannerReturning(["src/found.ts"]);
		const trace = await evaluate(
			[
				ruleWith({ id: "touched-only", globs: ["docs/*.md"], match: "touched" }),
				ruleWith({ id: "exists-rule", globs: ["src/**/*.ts", "!**/*.test.ts"], match: "exists" }),
			],
			contextWith({}),
			{ scan: scanner, budget: 100 },
		);
		expect(calls).toEqual([{ patterns: ["src/**/*.ts"], cwd: normalizedPath("/proj") }]);
		// The scan result feeds exists matching even with an empty ctx set.
		expect(trace.results).toContainEqual({
			matched: true,
			ruleId: ruleId("exists-rule"),
			reasons: [{ kind: "glob", pattern: "src/**/*.ts" }],
		});
	});

	it("never invokes the scan when no exists/both rule contributes a positive glob", async () => {
		const { scanner, calls } = scannerReturning(["src/found.ts"]);
		await evaluate(
			[
				ruleWith({ id: "touched-only", globs: ["docs/*.md"], match: "touched" }),
				ruleWith({ id: "negation-only", globs: ["!**/*.test.ts"], match: "exists" }),
				ruleWith({ id: "tool-only", tools: ["edit"] }),
			],
			contextWith({ toolNames: ["edit"] }),
			{ scan: scanner, budget: 100 },
		);
		expect(calls).toEqual([]);
	});
});

describe("evaluate — non-path condition AND semantics", () => {
	it("matches only when ALL declared conditions hold (tools + model + branch)", async () => {
		const trace = await evaluate(
			[ruleWith({ id: "combo", globs: ["src/**/*.ts"], tools: ["edit", "bash"], model: "m1", branch: "main" })],
			contextWith({ touchedPaths: ["src/a.ts"], toolNames: ["bash"], model: "m1", branch: "main" }),
			{ scan: scannerReturning([]).scanner, budget: 100 },
		);
		expect(trace.results).toEqual([
			{
				matched: true,
				ruleId: ruleId("combo"),
				reasons: [
					{ kind: "glob", pattern: "src/**/*.ts" },
					{ kind: "tool", tool: "bash" },
					{ kind: "model", model: "m1" },
					{ kind: "branch", branch: "main" },
				],
			},
		]);
	});

	it("treats absent conditions as vacuously true", async () => {
		const trace = await evaluate(
			[ruleWith({ id: "globs-only", globs: ["src/**/*.ts"] })],
			contextWith({ touchedPaths: ["src/a.ts"] }),
			{ scan: scannerReturning([]).scanner, budget: 100 },
		);
		expect(trace.results[0]).toEqual({
			matched: true,
			ruleId: ruleId("globs-only"),
			reasons: [{ kind: "glob", pattern: "src/**/*.ts" }],
		});
	});

	it("names the failing condition: tool", async () => {
		const trace = await evaluate(
			[ruleWith({ id: "tool-rule", globs: ["src/**/*.ts"], tools: ["edit"] })],
			contextWith({ touchedPaths: ["src/a.ts"], toolNames: ["bash"] }),
			{ scan: scannerReturning([]).scanner, budget: 100 },
		);
		expect(trace.results[0]).toEqual({ matched: false, ruleId: ruleId("tool-rule"), reason: expect.stringContaining("tool") });
	});

	it("names the failing condition: model", async () => {
		const trace = await evaluate(
			[ruleWith({ id: "model-rule", globs: ["src/**/*.ts"], model: "m1" })],
			contextWith({ touchedPaths: ["src/a.ts"], model: "m2" }),
			{ scan: scannerReturning([]).scanner, budget: 100 },
		);
		expect(trace.results[0]).toEqual({ matched: false, ruleId: ruleId("model-rule"), reason: expect.stringContaining("model") });
	});

	it("names the failing condition: branch", async () => {
		const trace = await evaluate(
			[ruleWith({ id: "branch-rule", globs: ["src/**/*.ts"], branch: "main" })],
			contextWith({ touchedPaths: ["src/a.ts"], branch: "dev" }),
			{ scan: scannerReturning([]).scanner, budget: 100 },
		);
		expect(trace.results[0]).toEqual({ matched: false, ruleId: ruleId("branch-rule"), reason: expect.stringContaining("branch") });
	});

	it("names the branch pattern and the session branch in the mismatch reason", async () => {
		const trace = await evaluate(
			[ruleWith({ id: "branch-rule", globs: ["src/**/*.ts"], branch: "main" })],
			contextWith({ touchedPaths: ["src/a.ts"], branch: "dev" }),
			{ scan: scannerReturning([]).scanner, budget: 100 },
		);
		expect(reasonOf(trace.results[0])).toBe("branch mismatch: session branch dev does not match the rule's branch pattern main");
	});

	it("names an absent session branch in the branch mismatch reason", async () => {
		const trace = await evaluate(
			[ruleWith({ id: "branch-rule", globs: ["src/**/*.ts"], branch: "main" })],
			contextWith({ touchedPaths: ["src/a.ts"] }),
			{ scan: scannerReturning([]).scanner, budget: 100 },
		);
		expect(reasonOf(trace.results[0])).toBe("branch mismatch: session branch absent does not match the rule's branch pattern main");
	});

	it("activates on a branch glob pattern and reports the pattern as the reason", async () => {
		const trace = await evaluate(
			[ruleWith({ id: "release-rule", globs: ["src/**/*.ts"], branch: "release/*" })],
			contextWith({ touchedPaths: ["src/a.ts"], branch: "release/1.0" }),
			{ scan: scannerReturning([]).scanner, budget: 100 },
		);
		expect(trace.results[0]).toEqual({
			matched: true,
			ruleId: ruleId("release-rule"),
			reasons: [
				{ kind: "glob", pattern: "src/**/*.ts" },
				{ kind: "branch", branch: "release/*" },
			],
		});
	});

	it("reports the first failing condition in tools → model → branch order", async () => {
		const trace = await evaluate(
			[ruleWith({ id: "multi-fail", globs: ["src/**/*.ts"], tools: ["edit"], model: "m1", branch: "main" })],
			contextWith({ touchedPaths: ["src/a.ts"], model: "m2", branch: "dev" }),
			{ scan: scannerReturning([]).scanner, budget: 100 },
		);
		expect(reasonOf(trace.results[0])).toContain("tool");
	});

	it("keeps the path reason when the path condition and a non-path condition both fail", async () => {
		const trace = await evaluate(
			[ruleWith({ id: "both-fail", globs: ["src/**/*.ts"], match: "touched", tools: ["edit"] })],
			contextWith({ touchedPaths: [] }),
			{ scan: scannerReturning([]).scanner, budget: 100 },
		);
		expect(trace.results[0]).toEqual({
			matched: false,
			ruleId: ruleId("both-fail"),
			reason: "no touched path matches globs: src/**/*.ts",
		});
	});

	it("never matches a rule whose declared tools array is empty", async () => {
		const trace = await evaluate(
			[ruleWith({ id: "empty-tools", globs: ["src/**/*.ts"], tools: [] })],
			contextWith({ touchedPaths: ["src/a.ts"], toolNames: ["edit", "bash"] }),
			{ scan: scannerReturning([]).scanner, budget: 100 },
		);
		expect(trace.results[0]).toEqual({ matched: false, ruleId: ruleId("empty-tools"), reason: expect.stringContaining("tool") });
	});
});

describe("evaluate — model pattern matching (v1.2)", () => {
	it("activates a rule whose model pattern matches the session model id", async () => {
		const trace = await evaluate(
			[ruleWith({ id: "sonnet-only", globs: ["src/**/*.ts"], model: "*sonnet*" })],
			contextWith({ touchedPaths: ["src/a.ts"], model: "claude-sonnet-4-5" }),
			{ scan: scannerReturning([]).scanner, budget: 100 },
		);
		expect(trace.results).toEqual([
			{
				matched: true,
				ruleId: ruleId("sonnet-only"),
				reasons: [
					{ kind: "glob", pattern: "src/**/*.ts" },
					{ kind: "model", model: "*sonnet*" },
				],
			},
		]);
		// The rule really reaches the injected section, not just the trace.
		expect(trace.selection.active.map((rule) => rule.id)).toEqual([ruleId("sonnet-only")]);
		expect(trace.block?.content).toContain("## test rule");
		expect(trace.block?.content).toContain("model `*sonnet*`");
	});

	it("matches a prefix pattern such as claude-opus-*", async () => {
		const trace = await evaluate(
			[ruleWith({ id: "opus-only", globs: ["src/**/*.ts"], model: "claude-opus-*" })],
			contextWith({ touchedPaths: ["src/a.ts"], model: "claude-opus-4-5" }),
			{ scan: scannerReturning([]).scanner, budget: 100 },
		);
		expect(trace.results[0]).toMatchObject({ matched: true, ruleId: ruleId("opus-only") });
	});

	it("names the model pattern and the session model id in the mismatch reason", async () => {
		const trace = await evaluate(
			[ruleWith({ id: "opus-only", globs: ["src/**/*.ts"], model: "claude-opus-*" })],
			contextWith({ touchedPaths: ["src/a.ts"], model: "claude-sonnet-4-5" }),
			{ scan: scannerReturning([]).scanner, budget: 100 },
		);
		const reason = reasonOf(trace.results[0]);
		expect(reason).toContain("claude-opus-*");
		expect(reason).toContain("claude-sonnet-4-5");
		expect(trace.selection.active).toEqual([]);
		expect(trace.block).toBeUndefined();
	});

	it("names the pattern and an absent session model when the session reports none", async () => {
		const trace = await evaluate(
			[ruleWith({ id: "sonnet-only", globs: ["src/**/*.ts"], model: "*sonnet*" })],
			contextWith({ touchedPaths: ["src/a.ts"] }),
			{ scan: scannerReturning([]).scanner, budget: 100 },
		);
		const reason = reasonOf(trace.results[0]);
		expect(reason).toContain("*sonnet*");
		expect(reason).toContain("absent");
	});

	it("keeps exact model ids matching exactly (success, mismatch, absence)", async () => {
		const rule = ruleWith({ id: "exact-model", globs: ["src/**/*.ts"], model: "claude-opus-4-5" });
		const scan = scannerReturning([]).scanner;
		const hit = await evaluate([rule], contextWith({ touchedPaths: ["src/a.ts"], model: "claude-opus-4-5" }), { scan, budget: 100 });
		expect(hit.results[0]).toEqual({
			matched: true,
			ruleId: ruleId("exact-model"),
			reasons: [
				{ kind: "glob", pattern: "src/**/*.ts" },
				{ kind: "model", model: "claude-opus-4-5" },
			],
		});
		const miss = await evaluate([rule], contextWith({ touchedPaths: ["src/a.ts"], model: "claude-opus-4" }), { scan, budget: 100 });
		expect(miss.results[0]?.matched).toBe(false);
		const absent = await evaluate([rule], contextWith({ touchedPaths: ["src/a.ts"] }), { scan, budget: 100 });
		expect(absent.results[0]?.matched).toBe(false);
	});
});

describe("evaluate — matched reason ordering", () => {
	it("orders path reasons, then tools in declaration order, then model, then branch", async () => {
		const trace = await evaluate(
			[ruleWith({ id: "ordered", globs: ["docs/*.md", "src/**/*.ts"], tools: ["c", "a", "b"], model: "m1", branch: "main" })],
			contextWith({ touchedPaths: ["src/a.ts", "docs/x.md"], toolNames: ["b", "a"], model: "m1", branch: "main" }),
			{ scan: scannerReturning([]).scanner, budget: 100 },
		);
		expect(trace.results).toEqual([
			{
				matched: true,
				ruleId: ruleId("ordered"),
				reasons: [
					{ kind: "glob", pattern: "docs/*.md" },
					{ kind: "glob", pattern: "src/**/*.ts" },
					{ kind: "tool", tool: "a" },
					{ kind: "tool", tool: "b" },
					{ kind: "model", model: "m1" },
					{ kind: "branch", branch: "main" },
				],
			},
		]);
	});
});

describe("evaluate — alwaysApply bypass", () => {
	it("bypasses path AND non-path conditions; only the always reason carries the rule", async () => {
		const trace = await evaluate(
			[ruleWith({ id: "always", globs: ["src/**/*.ts"], tools: ["edit"], model: "m1", branch: "main", alwaysApply: true })],
			contextWith({ touchedPaths: [], toolNames: [], model: "m2", branch: "dev" }),
			{ scan: scannerReturning([]).scanner, budget: 100 },
		);
		expect(trace.results).toEqual([{ matched: true, ruleId: ruleId("always"), reasons: [{ kind: "always" }] }]);
		expect(trace.block?.content).toContain("## test rule");
	});
});

describe("evaluate — trust gate (defense-in-depth)", () => {
	it("skips project rules with a reason naming the untrusted project", async () => {
		const trace = await evaluate(
			[ruleWith({ id: "proj-rule", globs: ["src/**/*.ts"], source: "project" })],
			contextWith({ touchedPaths: ["src/a.ts"], isProjectTrusted: false }),
			{ scan: scannerReturning([]).scanner, budget: 100 },
		);
		const reason = reasonOf(trace.results[0]);
		expect(reason).toContain("not trusted");
		expect(reason).toContain("/proj");
		expect(trace.selection.active).toEqual([]);
		expect(trace.block).toBeUndefined();
	});

	it("keeps global rules when the project is untrusted", async () => {
		const trace = await evaluate(
			[ruleWith({ id: "global-rule", globs: ["src/**/*.ts"], source: "global" })],
			contextWith({ touchedPaths: ["src/a.ts"], isProjectTrusted: false }),
			{ scan: scannerReturning([]).scanner, budget: 100 },
		);
		expect(trace.results[0]).toEqual({
			matched: true,
			ruleId: ruleId("global-rule"),
			reasons: [{ kind: "glob", pattern: "src/**/*.ts" }],
		});
	});

	it("gates alwaysApply project rules too — the bypass never skips the trust gate", async () => {
		const trace = await evaluate(
			[ruleWith({ id: "always-proj", alwaysApply: true, source: "project" })],
			contextWith({ isProjectTrusted: false }),
			{ scan: scannerReturning([]).scanner, budget: 100 },
		);
		expect(trace.results[0]?.matched).toBe(false);
	});

	it("does not scan on behalf of untrusted project rules; global exists-rules still scan", async () => {
		const { scanner, calls } = scannerReturning([]);
		await evaluate(
			[
				ruleWith({ id: "proj-exists", globs: ["proj/**"], match: "exists", source: "project" }),
				ruleWith({ id: "global-exists", globs: ["global/**"], match: "exists", source: "global" }),
			],
			contextWith({ isProjectTrusted: false }),
			{ scan: scanner, budget: 100 },
		);
		expect(calls).toEqual([{ patterns: ["global/**"], cwd: normalizedPath("/proj") }]);
	});
});

describe("evaluate — selection and rendering", () => {
	it("flows selection drops into the trace; results stay complete in rule order", async () => {
		const trace = await evaluate(
			[
				ruleWith({ id: "low", globs: ["a.md"], priority: 0, content: "x".repeat(400) }),
				ruleWith({ id: "high", globs: ["b.md"], priority: 10, content: "y".repeat(400) }),
			],
			contextWith({ touchedPaths: ["a.md", "b.md"] }),
			{ scan: scannerReturning([]).scanner, budget: 100 },
		);
		expect(trace.results.map((r) => r.ruleId)).toEqual([ruleId("low"), ruleId("high")]);
		expect(trace.selection.active.map((r) => r.id)).toEqual([ruleId("high")]);
		expect(trace.selection.dropped).toEqual([{ rule: ruleWith({ id: "low", globs: ["a.md"], priority: 0, content: "x".repeat(400) }), cause: "budget" }]);
		expect(trace.block?.content).toContain("## test rule");
	});

	it("drops the earlier equal-priority content duplicate with cause duplicate", async () => {
		const trace = await evaluate(
			[
				ruleWith({ id: "first", globs: ["a.md"] }),
				ruleWith({ id: "second", globs: ["b.md"] }),
			],
			contextWith({ touchedPaths: ["a.md", "b.md"] }),
			{ scan: scannerReturning([]).scanner, budget: 100 },
		);
		expect(trace.selection.active.map((r) => r.id)).toEqual([ruleId("second")]);
		expect(trace.selection.dropped).toEqual([
			{ rule: ruleWith({ id: "first", globs: ["a.md"] }), cause: "duplicate" },
		]);
	});

	it("matched paths include on-demand rules and the trace records the partition", async () => {
		const pinned = ruleWith({ id: "pinned", globs: ["src/**"], content: "PINNED" });
		const reference = ruleWith({ id: "reference", globs: ["src/**"], load: "on-demand", relativePath: "python/style.md", content: "FULL REFERENCE BODY" });
		const trace = await evaluate([pinned, reference], contextWith({ touchedPaths: ["src/a.ts"] }), { scan: scannerReturning([]).scanner, budget: 0 });
		expect(trace.selection.active.map((rule) => rule.id)).toEqual([ruleId("pinned")]);
		expect(trace.selection.onDemand).toEqual([reference]);
		expect(trace.matchedPaths).toEqual([pinned.path, reference.path]);
		expect(trace.block?.content).toContain("- python/style.md — test rule (fetch with the read_rule tool)");
		expect(trace.block?.content).not.toContain("FULL REFERENCE BODY");
		expect(trace.estimatedTokens).toBe(Math.ceil((trace.block?.content.length ?? 0) / 4));
	});

	it("returns block undefined when nothing is active", async () => {
		const empty = await evaluate([], contextWith({}), { scan: scannerReturning([]).scanner, budget: 100 });
		expect(empty.block).toBeUndefined();
		expect(empty.selection).toEqual({ active: [], onDemand: [], dropped: [] });
		const allUnmatched = await evaluate(
			[ruleWith({ id: "no-hit", globs: ["src/**/*.ts"] })],
			contextWith({ touchedPaths: ["docs/x.md"] }),
			{ scan: scannerReturning([]).scanner, budget: 100 },
		);
		expect(allUnmatched.block).toBeUndefined();
	});

	it("keeps block.contentHash consistent with the rendered content", async () => {
		const trace: EvaluationTrace = await evaluate(
			[ruleWith({ id: "hash-rule", globs: ["src/**/*.ts"] })],
			contextWith({ touchedPaths: ["src/a.ts"] }),
			{ scan: scannerReturning([]).scanner, budget: 100 },
		);
		expect(trace.block).toBeDefined();
		expect(trace.block?.sectionId).toBe("pi-rules-md");
		expect(trace.block?.contentHash).toBe(sha256(trace.block?.content ?? ""));
	});
});

describe("evaluate — trace hygiene", () => {
	it("copies evaluatedAt from ctx.now", async () => {
		const trace = await evaluate([], contextWith({ now: 1_234_567_890_123 }), {
			scan: scannerReturning([]).scanner,
			budget: 100,
		});
		expect(trace.evaluatedAt).toBe(1_234_567_890_123);
	});

	it("never mutates its inputs", async () => {
		const rules = deepFreeze([
			ruleWith({ id: "exists-rule", globs: ["src/**/*.ts"], match: "exists" }),
			ruleWith({ id: "tool-rule", globs: ["docs/*.md"], tools: ["edit"] }),
		]);
		const ctx = deepFreeze(
			contextWith({ touchedPaths: ["docs/x.md"], toolNames: ["edit"], existingPaths: ["keep/me.md"] }),
		);
		const rulesSnapshot = structuredClone(rules);
		const ctxSnapshot = structuredClone(ctx);
		const trace = await evaluate(rules, ctx, { scan: scannerReturning(["src/found.ts"]).scanner, budget: 100 });
		expect(rules).toEqual(rulesSnapshot);
		expect(ctx).toEqual(ctxSnapshot);
		// The scan enriched a COPY: the original existingPaths are untouched…
		expect(ctx.existingPaths).toEqual(["keep/me.md"].map(normalizedPath));
		// …yet the exists rule matched via the enriched set.
		expect(trace.results).toContainEqual({
			matched: true,
			ruleId: ruleId("exists-rule"),
			reasons: [{ kind: "glob", pattern: "src/**/*.ts" }],
		});
	});

	it("is deterministic: two identical runs produce byte-equal traces", async () => {
		const run = (): Promise<EvaluationTrace> =>
			evaluate(
				[
					ruleWith({ id: "a", globs: ["src/**/*.ts"], tools: ["edit"], priority: 5 }),
					ruleWith({ id: "b", globs: ["docs/*.md"] }),
				],
				contextWith({ now: 42, touchedPaths: ["src/a.ts", "docs/x.md"], toolNames: ["edit"] }),
				{ scan: scannerReturning(["src/found.ts"]).scanner, budget: 100 },
			);
		const first = await run();
		const second = await run();
		expect(second).toEqual(first);
		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
	});

	it("propagates scanner failures", async () => {
		const { scanner } = scannerFailing();
		await expect(
			evaluate([ruleWith({ id: "exists-rule", globs: ["src/**/*.ts"], match: "exists" })], contextWith({}), {
				scan: scanner,
				budget: 100,
			}),
		).rejects.toThrow("scan failed");
	});
});
