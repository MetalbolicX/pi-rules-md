/**
 * Tests for the exists-scan cache (S8).
 *
 * The cache is a closure around the injected `GlobScanner` seam: it memoizes a
 * scan result per (cwd, pattern set) and serves repeats until `invalidate()`
 * clears the store. Everything here is injected — a recording fake scanner over
 * a mutable in-memory file set stands in for the tinyglobby adapter — so
 * hit/miss/eviction behavior and the cached-vs-uncached differential are
 * observed without touching disk.
 *
 * The differential test is the S8 pin: the same evaluation sequence runs twice,
 * once through the cached scanner and once through the raw scanner, over a file
 * set that mutates between steps, and every step must produce a deep-equal
 * trace, an identical rendered section, and identical existing paths. Caching is
 * therefore invisible to matching; only the number of underlying scan calls
 * differs.
 */
import { describe, expect, it } from "vitest";
import { createCachedScanner } from "./scan-cache.ts";
import { globMatcher } from "../src/conditions/predicates.ts";
import { evaluate } from "../src/engine.ts";
import { withExistingPaths } from "../src/match.ts";
import type { GlobScanner } from "../src/match.ts";
import { normalizedPath, ruleId } from "../src/types.ts";
import type { EvaluationContext, MatchMode, NormalizedPath, Rule } from "../src/types.ts";

/** One recorded scanner invocation: what was scanned, from where. */
interface ScanCall {
	readonly patterns: readonly string[];
	readonly cwd: NormalizedPath;
}

/**
 * Recording scanner over a mutable file set. Matching runs through the real
 * `globMatcher` (the same predicate `matchRule`/`deriveScanPatterns` feed), so
 * the fake behaves like the tinyglobby adapter minus the disk: results follow
 * the file set at call time, which is what makes staleness observable.
 */
const fakeScanner = (files: Set<string>): { readonly scan: GlobScanner; readonly calls: ScanCall[] } => {
	const calls: ScanCall[] = [];
	const scan: GlobScanner = async (patterns, cwd) => {
		calls.push({ patterns: [...patterns], cwd });
		return [...files].filter((path) => globMatcher(patterns)(normalizedPath(path)));
	};
	return { scan, calls };
};

/** Builds a Rule with the interesting fields set; the rest mirror parser defaults. */
const existsRule = (id: string, globs: readonly string[], match: MatchMode = "exists"): Rule => ({
	load: "pinned",
	relativePath: normalizedPath(`${id}.md`),
	id: ruleId(id),
	path: normalizedPath(`/work/.pi/rules/${id}.md`),
	source: "project",
	description: `test rule ${id}`,
	globs,
	match,
	priority: 0,
	enforcement: "inform",
	alwaysApply: false,
	version: 1,
	content: `body of ${id}\n`,
});

/** A trusted project context with no touched paths: only the scan contributes. */
const context = (): EvaluationContext => ({
	now: 1_700_000_000_000,
	cwd: normalizedPath("/work"),
	isProjectTrusted: true,
	touchedPaths: [],
	existingPaths: [],
	toolNames: ["read", "edit"],
});

describe("createCachedScanner — memoization", () => {
	it("serves a repeated (cwd, pattern set) without scanning again", async () => {
		const fs = new Set(["src/a.ts"]);
		const underlying = fakeScanner(fs);
		const cached = createCachedScanner(underlying.scan);

		const first = await cached.scanner(["src/**/*.ts"], normalizedPath("/work"));
		const second = await cached.scanner(["src/**/*.ts"], normalizedPath("/work"));

		expect(first).toEqual(["src/a.ts"]);
		expect(underlying.calls).toHaveLength(1);
		// Hits hand back the very same frozen result, not a copy.
		expect(second).toBe(first);
		expect(cached.size()).toBe(1);
	});

	it("keys on the exact pattern sequence, so a changed, reordered, or relocated scan re-scans", async () => {
		const fs = new Set(["src/a.ts", "docs/readme.md", "lib/b.ts"]);
		const underlying = fakeScanner(fs);
		const cached = createCachedScanner(underlying.scan);

		await cached.scanner(["src/**/*.ts"], normalizedPath("/work"));
		// A different pattern set: different key.
		await cached.scanner(["src/**/*.ts", "**/*.md"], normalizedPath("/work"));
		// The same patterns in a different order are a different set (the engine
		// passes deduplicated first-seen order, so sequence is the identity).
		await cached.scanner(["**/*.md", "src/**/*.ts"], normalizedPath("/work"));
		// The same pattern set in another cwd: different key.
		await cached.scanner(["src/**/*.ts"], normalizedPath("/other"));

		expect(underlying.calls).toHaveLength(4);
		expect(cached.size()).toBe(4);

		// Every key is now warm: repeating any of them costs no scan.
		await cached.scanner(["**/*.md", "src/**/*.ts"], normalizedPath("/work"));
		await cached.scanner(["src/**/*.ts"], normalizedPath("/work"));
		expect(underlying.calls).toHaveLength(4);
	});

	it("invalidate() clears every entry so the next call scans again", async () => {
		const fs = new Set(["src/a.ts"]);
		const underlying = fakeScanner(fs);
		const cached = createCachedScanner(underlying.scan);

		await cached.scanner(["src/**/*.ts"], normalizedPath("/work"));
		expect(cached.size()).toBe(1);

		cached.invalidate();
		expect(cached.size()).toBe(0);

		// The filesystem changed while the cache was cleared: the next scan sees it.
		fs.add("src/b.ts");
		const rescanned = await cached.scanner(["src/**/*.ts"], normalizedPath("/work"));
		expect(rescanned).toEqual(["src/a.ts", "src/b.ts"]);
		expect(underlying.calls).toHaveLength(2);
	});

	it("keeps serving a cached result after an unannounced filesystem change (documented staleness)", async () => {
		// S8 invalidates on write/edit/bash tool results and pattern-set changes,
		// never on a timer or a stat probe: a change nobody announced is invisible
		// until one of those signals arrives. Pinned so the tradeoff stays explicit.
		const fs = new Set(["src/a.ts"]);
		const underlying = fakeScanner(fs);
		const cached = createCachedScanner(underlying.scan);

		expect(await cached.scanner(["src/**/*.ts"], normalizedPath("/work"))).toEqual(["src/a.ts"]);
		fs.add("src/b.ts");
		expect(await cached.scanner(["src/**/*.ts"], normalizedPath("/work"))).toEqual(["src/a.ts"]);
		expect(underlying.calls).toHaveLength(1);

		cached.invalidate();
		expect(await cached.scanner(["src/**/*.ts"], normalizedPath("/work"))).toEqual(["src/a.ts", "src/b.ts"]);
	});
});

describe("createCachedScanner — failure and identity discipline", () => {
	it("propagates a scan rejection unchanged and caches nothing", async () => {
		const failure = new Error("scan failed");
		let attempt = 0;
		const scan: GlobScanner = async () => {
			attempt += 1;
			if (attempt === 1) {
				throw failure;
			}
			return ["src/a.ts"];
		};
		const cached = createCachedScanner(scan);

		// Scanner failures propagate to the caller exactly as without a cache...
		await expect(cached.scanner(["src/**/*.ts"], normalizedPath("/work"))).rejects.toBe(failure);
		// ...and a rejection leaves the store empty, so the failure is not memoized.
		expect(cached.size()).toBe(0);

		await expect(cached.scanner(["src/**/*.ts"], normalizedPath("/work"))).resolves.toEqual(["src/a.ts"]);
		expect(attempt).toBe(2);
		expect(cached.size()).toBe(1);
	});

	it("freezes the cached result and never aliases the scanner's own array", async () => {
		const produced = ["src/a.ts"];
		const scan: GlobScanner = async () => produced;
		const cached = createCachedScanner(scan);

		const first = await cached.scanner(["src/**/*.ts"], normalizedPath("/work"));
		expect(Object.isFrozen(first)).toBe(true);
		// The underlying scanner keeps its own array: mutating it cannot corrupt
		// the cached copy (the cache stores a frozen snapshot).
		produced.push("src/b.ts");
		expect(await cached.scanner(["src/**/*.ts"], normalizedPath("/work"))).toEqual(["src/a.ts"]);
		// A caller cannot mutate the cached result in place either.
		expect(() => (first as string[]).push("src/c.ts")).toThrow(TypeError);
	});

	it("starts empty for every new cache", () => {
		const underlying = fakeScanner(new Set<string>());
		expect(createCachedScanner(underlying.scan).size()).toBe(0);
	});
});

describe("differential — cached and uncached scans agree at every step (S8 pin)", () => {
	/** One step of the sequence: mutate the fake filesystem, then evaluate. */
	interface Step {
		readonly label: string;
		readonly rules: readonly Rule[];
		readonly apply: () => void;
		readonly invalidate: boolean;
	}

	it("yields identical traces, sections, and existing paths while the scan-call count differs", async () => {
		const files = new Set<string>();
		const raw = fakeScanner(files);
		const cachedUnderlying = fakeScanner(files);
		const cached = createCachedScanner(cachedUnderlying.scan);

		const tsOnly = [existsRule("ts", ["src/**/*.ts"])];
		const tsAndDocs = [existsRule("ts", ["src/**/*.ts"]), existsRule("docs", ["**/*.md"], "both")];

		const steps: readonly Step[] = [
			{ label: "first ts file", rules: tsOnly, apply: () => files.add("src/a.ts"), invalidate: false },
			{ label: "markdown added, invalidated", rules: tsOnly, apply: () => files.add("docs/readme.md"), invalidate: true },
			{ label: "nothing changed (cache hit)", rules: tsOnly, apply: () => undefined, invalidate: false },
			{ label: "pattern set grew", rules: tsAndDocs, apply: () => files.add("src/b.ts"), invalidate: false },
			{ label: "ts file removed, invalidated", rules: tsAndDocs, apply: () => files.delete("src/b.ts"), invalidate: true },
		];

		const cachedDeltas: number[] = [];
		const rawDeltas: number[] = [];
		const sections: string[] = [];

		for (const step of steps) {
			step.apply();
			if (step.invalidate) {
				cached.invalidate();
			}
			const before = { cached: cachedUnderlying.calls.length, raw: raw.calls.length };

			const cachedTrace = await evaluate(step.rules, context(), { scan: cached.scanner, budget: 2000 });
			const rawTrace = await evaluate(step.rules, context(), { scan: raw.scan, budget: 2000 });
			const cachedExisting = (await withExistingPaths(context(), step.rules, cached.scanner)).existingPaths;
			const rawExisting = (await withExistingPaths(context(), step.rules, raw.scan)).existingPaths;

			// The pin: caching is invisible to evaluation.
			expect(cachedTrace, step.label).toEqual(rawTrace);
			expect(cachedTrace.block, step.label).toEqual(rawTrace.block);
			expect(cachedTrace.block?.content, step.label).toBe(rawTrace.block?.content);
			expect(cachedExisting, step.label).toEqual(rawExisting);
			// Anti-vacuous: the scan really matched something at every step.
			expect(cachedExisting.length, step.label).toBeGreaterThan(0);

			sections.push(cachedTrace.block?.content ?? "");
			cachedDeltas.push(cachedUnderlying.calls.length - before.cached);
			rawDeltas.push(raw.calls.length - before.raw);
		}

		// Sections actually moved with the filesystem (the differential is not
		// comparing two static strings).
		expect(new Set(sections).size).toBeGreaterThan(1);
		// Cached: one underlying scan per miss (2 evaluates per step, the second
		// one a hit), and no scan at all on the pure-hit step. Raw: always 2.
		expect(cachedDeltas).toEqual([1, 1, 0, 1, 1]);
		expect(rawDeltas).toEqual([2, 2, 2, 2, 2]);
	});
});
