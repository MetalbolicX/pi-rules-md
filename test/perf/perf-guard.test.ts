/**
 * Performance regression guard for the evaluation pipeline (NOT a benchmark).
 *
 * Runs a deterministic 300-rule × 300-path workload through the production
 * stages — deriveScanPatterns → picomatch-driven fake scan → matchRule →
 * selectRules → renderSection — and asserts the total wall time stays under
 * a GENEROUS 2000 ms ceiling. The point is to fail loudly on accidental
 * complexity blowups (quadratic scans, matcher rebuild storms), not to
 * measure absolute speed: absolute numbers vary by machine, the ceiling is
 * intentionally far above observed times, and the measured milliseconds are
 * logged so a failure shows the regression delta.
 *
 * Deterministic and CI-tolerant: fixed seed, no filesystem, no network — the
 * "exists" scan seam is satisfied by a picomatch matcher over an in-memory
 * path universe. `performance.now()` is used for measurement only; it never
 * flows into any output.
 */
import * as picomatchModule from "picomatch";
import { describe, expect, it } from "vitest";
import { deriveScanPatterns, matchRule } from "../../src/match.ts";
import { renderSection } from "../../src/render.ts";
import type { RenderEntry } from "../../src/render.ts";
import { selectRules } from "../../src/select.ts";
import { normalizedPath } from "../../src/types.ts";
import type { EvaluationContext, MatchReason, NormalizedPath, Rule } from "../../src/types.ts";
import { CONTENT_POOL, randomRule, times } from "../property/support/generators.ts";
import { createSeeded } from "../property/support/seeded.ts";

// picomatch ships CJS with `export =` typings and this repo keeps
// `esModuleInterop` off — single sanctioned default unwrap, same as
// src/conditions/predicates.ts.
type Matcher = (path: string) => boolean;
type PicomatchFactory = (patterns: readonly string[]) => Matcher;
const picomatch = (picomatchModule as unknown as { readonly default: PicomatchFactory }).default;

const RULE_COUNT = 300;
const PATH_COUNT = 300;
/** Generous hard ceiling in milliseconds — regression guard, not a target. */
const CEILING_MS = 2000;
/** Token budget small enough that the budget fold actually drops rules. */
const BUDGET_TOKENS = 600;

describe("perf guard — 300 rules × 300 paths (regression guard, not a benchmark)", () => {
	it("deriveScanPatterns → matchRule → selectRules → renderSection finishes under 2000ms", () => {
		const rng = createSeeded(0x50455246);

		// Path universe aligned with the shared glob pools so scans produce a
		// realistic mix of matching and non-matching paths.
		const FAMILIES: readonly string[] = ["src", "lib", "docs", "tests", "scripts", "config"];
		const EXTENSIONS: readonly string[] = [".ts", ".md", ".json", ".test.ts", ".sh"];
		const universe: readonly NormalizedPath[] = times(PATH_COUNT, (index) =>
			normalizedPath(`${rng.pick(FAMILIES)}/mod${index % 25}/file${index}${rng.pick(EXTENSIONS)}`),
		);

		const rules: readonly Rule[] = times(RULE_COUNT, (index) =>
			randomRule(rng, index, `Rule ${index}: ${rng.pick(CONTENT_POOL)}`),
		);
		expect(rules.length).toBe(RULE_COUNT);

		const ctx: EvaluationContext = {
			now: 1700000000000,
			cwd: normalizedPath("/perf/project"),
			isProjectTrusted: true,
			touchedPaths: universe.slice(0, 60),
			existingPaths: [],
			toolNames: ["bash", "edit", "read"],
		};

		const start = performance.now();

		const scanPatterns = deriveScanPatterns(rules);
		// Fake scanner over the path universe — same shape as the injected
		// GlobScanner seam, picomatch-driven, no FS access.
		const matchesAnyPattern = picomatch(scanPatterns);
		const existingPaths = universe.filter((path) => matchesAnyPattern(path));
		const enriched: EvaluationContext = { ...ctx, existingPaths };

		const results = rules.map((rule) => matchRule(rule, enriched));
		const reasonsByRuleId = new Map<string, readonly MatchReason[]>();
		for (let index = 0; index < rules.length; index += 1) {
			const rule = rules[index];
			const result = results[index];
			if (rule !== undefined && result !== undefined && result.matched) {
				reasonsByRuleId.set(rule.id, result.reasons);
			}
		}
		const candidates = rules.filter((rule) => reasonsByRuleId.has(rule.id));

		const selection = selectRules(candidates, BUDGET_TOKENS);
		const entries: readonly RenderEntry[] = selection.active.map((rule) => ({
			rule,
			reasons: reasonsByRuleId.get(rule.id) ?? [],
		}));
		const block = renderSection(entries);

		const elapsedMs = performance.now() - start;

		// Measured milliseconds go to the log so failures show the delta.
		console.info(`[perf-guard] ${RULE_COUNT} rules × ${PATH_COUNT} paths: ${elapsedMs.toFixed(1)}ms (ceiling ${CEILING_MS}ms)`);

		// Sanity: the guard times real work, not an empty pipeline.
		expect(scanPatterns.length).toBeGreaterThan(0);
		expect(existingPaths.length).toBeGreaterThan(0);
		expect(candidates.length).toBeGreaterThan(0);
		expect(block).toBeDefined();

		expect(elapsedMs).toBeLessThan(CEILING_MS);
	});
});
