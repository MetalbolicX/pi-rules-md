/**
 * Tests for path-based rule matching (touched / exists / both) and the
 * extension-targeted project scan seam.
 *
 * Every filesystem effect is injected: scanners are plain async functions
 * over deterministic fixtures, so these tests never touch the disk. Paths
 * are matched verbatim after separator normalization — producing consistent
 * path shapes is the collectors'/scanner's job (later shell tasks).
 */
import { describe, expect, it } from "vitest";
import { deriveScanPatterns, matchRule, matchRules, withExistingPaths } from "./match.ts";
import { normalizedPath, ruleId } from "./types.ts";
import type { EvaluationContext, MatchMode, NormalizedPath, Rule } from "./types.ts";

/** One recorded scanner invocation: what was scanned, from where. */
interface ScanCall {
	readonly patterns: readonly string[];
	readonly cwd: NormalizedPath;
}

/** Builds a scanner that returns `results` and records every call. */
const scannerReturning = (results: readonly string[]): { readonly scanner: (patterns: readonly string[], cwd: NormalizedPath) => Promise<readonly string[]>; readonly calls: ScanCall[] } => {
	const calls: ScanCall[] = [];
	const scanner = async (patterns: readonly string[], cwd: NormalizedPath): Promise<readonly string[]> => {
		calls.push({ patterns: [...patterns], cwd });
		return results;
	};
	return { scanner, calls };
};

/** Scanner whose every call rejects, for failure propagation tests. */
const scannerFailing = (): { readonly scanner: (patterns: readonly string[], cwd: NormalizedPath) => Promise<readonly string[]>; readonly calls: ScanCall[] } => {
	const calls: ScanCall[] = [];
	const scanner = async (patterns: readonly string[], cwd: NormalizedPath): Promise<readonly string[]> => {
		calls.push({ patterns: [...patterns], cwd });
		throw new Error("scan failed");
	};
	return { scanner, calls };
};

/**
 * Builds a Rule with only the interesting fields set; the rest mirror the
 * parser's materialized defaults. `globs` stays truly absent when undefined
 * (exactOptionalPropertyTypes-safe), like a rule parsed without the key.
 */
const ruleWith = (fields: {
	readonly id?: string;
	readonly globs?: readonly string[];
	readonly match?: MatchMode;
	readonly alwaysApply?: boolean;
	readonly tools?: readonly string[];
}): Rule => ({
	id: ruleId(fields.id ?? "test-rule"),
	path: normalizedPath(".pi/rules/test.md"),
	source: "project",
	description: "test rule",
	...(fields.globs === undefined ? {} : { globs: fields.globs }),
	match: fields.match ?? "both",
	...(fields.tools === undefined ? {} : { tools: fields.tools }),
	priority: 0,
	enforcement: "inform",
	alwaysApply: fields.alwaysApply ?? false,
	version: 1,
	content: "body",
});

/**
 * Builds an EvaluationContext with only the path sets set; other fields
 * mirror the shape used by the predicate tests.
 */
const contextWith = (fields: {
	readonly touchedPaths?: readonly string[];
	readonly existingPaths?: readonly string[];
	readonly intentGlobs?: readonly string[];
}): EvaluationContext => ({
	now: 0,
	cwd: normalizedPath("/proj"),
	isProjectTrusted: true,
	touchedPaths: (fields.touchedPaths ?? []).map(normalizedPath),
	existingPaths: (fields.existingPaths ?? []).map(normalizedPath),
	...(fields.intentGlobs === undefined ? {} : { intentGlobs: fields.intentGlobs }),
	toolNames: [],
});

describe("deriveScanPatterns", () => {
	it("collects positive patterns across rules, deduplicating and keeping first-seen order", () => {
		const rules = [
			ruleWith({ id: "a", globs: ["src/**/*.ts", "docs/*.md"] }),
			ruleWith({ id: "b", globs: ["src/**/*.ts", "!**/*.test.ts"] }),
			ruleWith({ id: "c" }),
		];
		expect(deriveScanPatterns(rules)).toEqual(["src/**/*.ts", "docs/*.md"]);
	});

	it("skips negation patterns and rules without globs", () => {
		const rules = [ruleWith({ id: "a", globs: ["!**/*.test.ts"] }), ruleWith({ id: "b" })];
		expect(deriveScanPatterns(rules)).toEqual([]);
	});

	it("returns no patterns for an empty rule list", () => {
		expect(deriveScanPatterns([])).toEqual([]);
	});
});

describe("intent globs", () => {
	it("intent globs satisfy a globs condition without any path in the pool", () => {
		const result = matchRule(ruleWith({ globs: ["**/*.py"] }), contextWith({ intentGlobs: ["*.py"] }));
		expect(result).toMatchObject({ matched: true, reasons: [{ kind: "glob", pattern: "intent: *.py" }] });
	});

	it("intent globs never enter the context path pool", () => {
		const ctx = contextWith({ intentGlobs: ["*.py"] });
		expect(ctx.touchedPaths).toEqual([]);
		expect(ctx.existingPaths).toEqual([]);
	});

	it("does not let an unrelated intent glob satisfy rule globs", () => {
		expect(matchRule(ruleWith({ globs: ["**/*.rs"] }), contextWith({ intentGlobs: ["*.py"] })).matched).toBe(false);
	});
});

describe("matchRule — touched mode", () => {
	it("matches when a touched path hits a positive glob, with the fired pattern as reason", () => {
		const rule = ruleWith({ globs: ["src/**/*.ts"], match: "touched" });
		const ctx = contextWith({ touchedPaths: ["src/a.ts", "docs/b.md"] });
		expect(matchRule(rule, ctx)).toEqual({
			matched: true,
			ruleId: rule.id,
			reasons: [{ kind: "glob", pattern: "src/**/*.ts" }],
		});
	});

	it("does not match when only existing paths hit the globs", () => {
		const rule = ruleWith({ globs: ["src/**/*.ts"], match: "touched" });
		const ctx = contextWith({ touchedPaths: [], existingPaths: ["src/a.ts"] });
		expect(matchRule(rule, ctx)).toEqual({
			matched: false,
			ruleId: rule.id,
			reason: "no touched path matches globs: src/**/*.ts",
		});
	});

	it("negation excludes a touched path even when a positive pattern matches it", () => {
		const rule = ruleWith({ globs: ["**/*.ts", "!**/*.test.ts"], match: "touched" });
		const onlyExcluded = contextWith({ touchedPaths: ["src/a.test.ts"] });
		expect(matchRule(rule, onlyExcluded).matched).toBe(false);

		const mixed = contextWith({ touchedPaths: ["src/a.ts", "src/a.test.ts"] });
		expect(matchRule(rule, mixed)).toEqual({
			matched: true,
			ruleId: rule.id,
			reasons: [{ kind: "glob", pattern: "**/*.ts" }],
		});
	});

	it("reasons fire only for positive patterns that matched something, in declaration order", () => {
		const rule = ruleWith({ globs: ["src/**/*.ts", "docs/*.md"], match: "touched" });
		const ctx = contextWith({ touchedPaths: ["docs/x.md"] });
		expect(matchRule(rule, ctx)).toEqual({
			matched: true,
			ruleId: rule.id,
			reasons: [{ kind: "glob", pattern: "docs/*.md" }],
		});
	});
});

describe("matchRule — exists mode", () => {
	it("matches when an existing path hits a positive glob", () => {
		const rule = ruleWith({ globs: ["src/**/*.ts"], match: "exists" });
		const ctx = contextWith({ existingPaths: ["src/a.ts"] });
		expect(matchRule(rule, ctx)).toEqual({
			matched: true,
			ruleId: rule.id,
			reasons: [{ kind: "glob", pattern: "src/**/*.ts" }],
		});
	});

	it("ignores touched paths — a touched-only hit does not activate an exists rule", () => {
		const rule = ruleWith({ globs: ["src/**/*.ts"], match: "exists" });
		const ctx = contextWith({ touchedPaths: ["src/a.ts"], existingPaths: [] });
		expect(matchRule(rule, ctx)).toEqual({
			matched: false,
			ruleId: rule.id,
			reason: "no existing path matches globs: src/**/*.ts",
		});
	});

	it("negation applies to existing paths too", () => {
		const rule = ruleWith({ globs: ["**/*.md", "!README.md"], match: "exists" });
		const ctx = contextWith({ existingPaths: ["README.md", "docs/x.md"] });
		expect(matchRule(rule, ctx)).toEqual({
			matched: true,
			ruleId: rule.id,
			reasons: [{ kind: "glob", pattern: "**/*.md" }],
		});
	});
});

describe("matchRule — both mode", () => {
	it("matches when either the touched or the existing set hits", () => {
		const rule = ruleWith({ globs: ["src/**/*.ts"], match: "both" });
		const touchedHit = contextWith({ touchedPaths: ["src/a.ts"], existingPaths: [] });
		expect(matchRule(rule, touchedHit).matched).toBe(true);
		const existingHit = contextWith({ touchedPaths: [], existingPaths: ["src/a.ts"] });
		expect(matchRule(rule, existingHit).matched).toBe(true);
	});

	it("collects reasons from both sets in declaration order", () => {
		const rule = ruleWith({ globs: ["src/**/*.ts", "docs/*.md"], match: "both" });
		const ctx = contextWith({ touchedPaths: ["src/a.ts"], existingPaths: ["docs/b.md"] });
		expect(matchRule(rule, ctx)).toEqual({
			matched: true,
			ruleId: rule.id,
			reasons: [
				{ kind: "glob", pattern: "src/**/*.ts" },
				{ kind: "glob", pattern: "docs/*.md" },
			],
		});
	});

	it("does not match when neither set hits, and the reason names both pools", () => {
		const rule = ruleWith({ globs: ["src/**/*.ts"], match: "both" });
		const ctx = contextWith({ touchedPaths: ["docs/x.md"], existingPaths: ["docs/y.md"] });
		expect(matchRule(rule, ctx)).toEqual({
			matched: false,
			ruleId: rule.id,
			reason: "no touched or existing path matches globs: src/**/*.ts",
		});
	});
});

describe("matchRule — trigger bypass and absent globs", () => {
	it("alwaysApply matches without any path set and reports the always reason", () => {
		const rule = ruleWith({ alwaysApply: true, match: "touched" });
		const ctx = contextWith({});
		expect(matchRule(rule, ctx)).toEqual({
			matched: true,
			ruleId: rule.id,
			reasons: [{ kind: "always" }],
		});
	});

	it("a rule without globs passes the path condition vacuously (other triggers belong to the engine)", () => {
		// The parser rejects match-only rules without globs, so a parsed rule
		// without globs always carries another trigger (tools/branch/model).
		// The path slice must not veto it; the engine ANDs those conditions.
		const rule = ruleWith({ match: "touched", tools: ["edit"] });
		const ctx = contextWith({});
		expect(matchRule(rule, ctx)).toEqual({
			matched: true,
			ruleId: rule.id,
			reasons: [],
		});
	});
});

describe("matchRules", () => {
	it("evaluates each rule in order across mixed modes", () => {
		const touched = ruleWith({ id: "touched-rule", globs: ["src/**/*.ts"], match: "touched" });
		const exists = ruleWith({ id: "exists-rule", globs: ["docs/*.md"], match: "exists" });
		const both = ruleWith({ id: "both-rule", globs: ["**/*.yml"], match: "both" });
		const ctx = contextWith({ touchedPaths: ["src/a.ts"], existingPaths: ["docs/b.md"] });
		expect(matchRules([touched, exists, both], ctx)).toEqual([
			{
				matched: true,
				ruleId: touched.id,
				reasons: [{ kind: "glob", pattern: "src/**/*.ts" }],
			},
			{
				matched: true,
				ruleId: exists.id,
				reasons: [{ kind: "glob", pattern: "docs/*.md" }],
			},
			{
				matched: false,
				ruleId: both.id,
				reason: "no touched or existing path matches globs: **/*.yml",
			},
		]);
	});
});

describe("withExistingPaths", () => {
	it("scans once with the derived patterns from ctx.cwd and fills existingPaths normalized, deduped, sorted", async () => {
		const rules = [
			ruleWith({ id: "a", globs: ["docs/*.md", "src/**/*.ts", "docs/*.md"] }),
			ruleWith({ id: "b", globs: ["src/**/*.ts", "!**/*.test.ts"] }),
		];
		const { scanner, calls } = scannerReturning(["src\\b.ts", "src/a.ts", "src/a.ts"]);
		const ctx = contextWith({ touchedPaths: ["src/a.ts"] });
		const next = await withExistingPaths(ctx, rules, scanner);
		expect(calls).toEqual([{ patterns: ["docs/*.md", "src/**/*.ts"], cwd: normalizedPath("/proj") }]);
		expect(next.existingPaths).toEqual([normalizedPath("src/a.ts"), normalizedPath("src/b.ts")]);
		// Other context fields pass through untouched.
		expect(next.touchedPaths).toEqual(ctx.touchedPaths);
		expect(next.cwd).toBe(ctx.cwd);
	});

	it("does not scan and returns the context unchanged when no rule contributes a positive pattern", async () => {
		const rules = [ruleWith({ id: "a", globs: ["!**/*.test.ts"] }), ruleWith({ id: "b" })];
		const { scanner, calls } = scannerReturning(["src/a.ts"]);
		const ctx = contextWith({});
		const next = await withExistingPaths(ctx, rules, scanner);
		expect(calls).toEqual([]);
		expect(next).toBe(ctx);
	});

	it("propagates scanner failures instead of swallowing them", async () => {
		const rules = [ruleWith({ globs: ["src/**/*.ts"] })];
		const { scanner, calls } = scannerFailing();
		const ctx = contextWith({});
		await expect(withExistingPaths(ctx, rules, scanner)).rejects.toThrow("scan failed");
		expect(calls).toHaveLength(1);
	});
});
