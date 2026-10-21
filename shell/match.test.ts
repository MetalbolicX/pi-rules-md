/**
 * Tests for the rule-base rebasing seam (shell/match.ts), the walk-up half of
 * S10 monorepo discovery.
 *
 * `rebaseGlobs` is pure: it re-expresses one rule's authored globs (relative to
 * the directory owning its `.pi/` folder — its rule base) onto the two scales
 * the evaluation path pools actually carry:
 * - ABSOLUTE paths, because `shell/collectors.ts` keeps paths outside cwd
 *   absolute (`/repo/src/x.ts`);
 * - CWD-RELATIVE paths, because paths inside cwd are relativized (`src/x.ts`).
 *
 * The pins here are semantic, not textual: variants are asserted through the
 * SAME `globMatcher` the engine uses, so a rebase that produced a pretty but
 * non-matching pattern fails. The byte-identity pin for cwd rules (they must
 * behave exactly as today) is asserted through the constant-identity contract:
 * with `base === cwd` the function returns the very array it was given.
 *
 * `createScopedScanner` is the matching scan-side seam: patterns that were
 * rebased absolute are scanned at their own static root and their results are
 * returned in absolute form (so they land in the same coordinate system as the
 * touched pool), while relative patterns keep today's single cwd scan.
 */
import { describe, expect, it } from "vitest";
import { globMatcher } from "../src/conditions/predicates.ts";
import { normalizedPath } from "../src/types.ts";
import type { GlobScanner } from "../src/match.ts";
import { createScopedScanner, rebaseGlobs, scanPatternRoot } from "./match.ts";

const REPO = "/repo";
const PKG = "/repo/packages/a";

/** Matches one path against a glob list exactly like the engine's path slice. */
const matches = (globs: readonly string[], path: string): boolean => globMatcher(globs)(normalizedPath(path));

describe("rebaseGlobs — cwd rules stay byte-identical", () => {
	it("returns the same array when the rule base IS cwd (no rebase, no copy)", () => {
		const authored = ["src/**/*.ts", "!src/**/*.test.ts"];
		expect(rebaseGlobs(authored, PKG, PKG)).toBe(authored);
	});

	it("returns the same array when cwd is not inside the rule base (nothing to rebase)", () => {
		const authored = ["src/**/*.ts"];
		expect(rebaseGlobs(authored, REPO, "/elsewhere/pkg")).toBe(authored);
	});

	it("keeps cwd-rule semantics unchanged: relative globs match cwd-relative paths only", () => {
		const authored = ["src/**/*.ts"];
		const globs = rebaseGlobs(authored, PKG, PKG);
		expect(matches(globs, "src/x.ts")).toBe(true);
		expect(matches(globs, "/repo/packages/a/src/x.ts")).toBe(false);
	});
});

describe("rebaseGlobs — ancestor rules match paths outside cwd", () => {
	it("anchors an authored glob at the rule base, so an outside-cwd absolute path matches", () => {
		const globs = rebaseGlobs(["src/**/*.ts"], REPO, PKG);
		expect(globs).toContain("/repo/src/**/*.ts");
		expect(matches(globs, "/repo/src/x.ts")).toBe(true);
		expect(matches(globs, "/repo/src/deep/x.ts")).toBe(true);
		// A same-named path inside the package is a DIFFERENT file: the root rule
		// cannot claim it through this pattern.
		expect(matches(globs, "src/x.ts")).toBe(false);
	});

	it("does not treat a cwd-relative path as if it were rooted at the rule base", () => {
		const globs = rebaseGlobs(["packages/b/**/*.ts"], REPO, PKG);
		expect(matches(globs, "packages/b/x.ts")).toBe(false);
		expect(matches(globs, "/repo/packages/b/x.ts")).toBe(true);
	});
});

describe("rebaseGlobs — ancestor rules match the cwd subtree on the cwd scale", () => {
	it("strips the rule-base→cwd literal prefix so package rules can target files inside cwd", () => {
		const globs = rebaseGlobs(["packages/a/src/**/*.ts"], REPO, PKG);
		// Both coordinate systems the pools can carry.
		expect(matches(globs, "src/x.ts")).toBe(true);
		expect(matches(globs, "/repo/packages/a/src/x.ts")).toBe(true);
		// The absolute form still only covers this package.
		expect(matches(globs, "/repo/packages/b/src/x.ts")).toBe(false);
	});

	it("keeps a leading `**` reachable for inside-cwd paths", () => {
		const globs = rebaseGlobs(["**/*.ts"], REPO, PKG);
		expect(matches(globs, "/repo/src/x.ts")).toBe(true);
		expect(matches(globs, "src/x.ts")).toBe(true);
		expect(matches(globs, "x.ts")).toBe(true);
		expect(matches(globs, "src/x.md")).toBe(false);
	});

	it("does not strip a literal prefix the rule base does not actually have", () => {
		const globs = rebaseGlobs(["packages/b/src/**"], REPO, PKG);
		expect(matches(globs, "src/x.ts")).toBe(false);
		expect(matches(globs, "/repo/packages/b/src/x.ts")).toBe(true);
	});
});

describe("rebaseGlobs — negation and structural safety", () => {
	it("rebases negations identically, so exclusions follow the same scale", () => {
		const globs = rebaseGlobs(["**/*.ts", "!**/*.test.ts"], REPO, PKG);
		expect(matches(globs, "src/x.ts")).toBe(true);
		expect(matches(globs, "src/x.test.ts")).toBe(false);
		expect(matches(globs, "/repo/src/x.ts")).toBe(true);
		expect(matches(globs, "/repo/src/x.test.ts")).toBe(false);
	});

	it("rebases a literal-prefix negation and keeps it excluding only its own subtree", () => {
		const globs = rebaseGlobs(["packages/a/**", "!packages/a/build/**"], REPO, PKG);
		expect(matches(globs, "src/x.ts")).toBe(true);
		expect(matches(globs, "build/x.ts")).toBe(false);
	});

	it("leaves authored absolute and parent-escaping globs untouched (no invented anchor)", () => {
		const authored = ["/etc/**", "../outside/**"];
		expect(rebaseGlobs(authored, REPO, PKG)).toEqual(["/etc/**", "../outside/**"]);
	});

	it("produces no duplicate variants", () => {
		const globs = rebaseGlobs(["**", "**/*.ts", "**/*.ts"], REPO, PKG);
		expect(new Set(globs).size).toBe(globs.length);
	});
});

describe("scanPatternRoot", () => {
	it("splits an absolute pattern into its static root and the remaining glob", () => {
		expect(scanPatternRoot("/repo/src/**/*.ts")).toEqual({ root: "/repo/src", remainder: "**/*.ts" });
		expect(scanPatternRoot("/repo/**")).toEqual({ root: "/repo", remainder: "**" });
	});

	it("treats a magic-free absolute pattern as a filename under its parent", () => {
		expect(scanPatternRoot("/repo/README.md")).toEqual({ root: "/repo", remainder: "README.md" });
	});

	it("returns undefined for a relative pattern (today's cwd scan)", () => {
		expect(scanPatternRoot("**/*.ts")).toBeUndefined();
		expect(scanPatternRoot("src/**/*.ts")).toBeUndefined();
	});
});

describe("createScopedScanner", () => {
	it("forwards relative-only patterns to ONE cwd scan with the identical array", async () => {
		const calls: Array<{ readonly patterns: readonly string[]; readonly cwd: string }> = [];
		const inner: GlobScanner = async (patterns, cwd) => {
			calls.push({ patterns, cwd });
			return ["src/x.ts"];
		};
		const authored = ["src/**/*.ts", "!src/**/*.test.ts"];
		const scoped = createScopedScanner(inner);
		const found = await scoped(authored, normalizedPath(PKG));
		expect(found).toEqual(["src/x.ts"]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.patterns).toBe(authored);
		expect(calls[0]?.cwd).toBe(PKG);
	});

	it("scans an absolute pattern at its own root and returns absolute results", async () => {
		const calls: Array<{ readonly patterns: readonly string[]; readonly cwd: string }> = [];
		const inner: GlobScanner = async (patterns, cwd) => {
			calls.push({ patterns, cwd });
			return ["a/b.ts"];
		};
		const scoped = createScopedScanner(inner);
		const found = await scoped(["/repo/src/**/*.ts"], normalizedPath(PKG));
		expect(found).toEqual(["/repo/src/a/b.ts"]);
		expect(calls).toEqual([{ patterns: ["**/*.ts"], cwd: "/repo/src" }]);
	});

	it("mixes both scales: cwd-relative results stay relative, absolute ones stay absolute", async () => {
		const calls: Array<{ readonly patterns: readonly string[]; readonly cwd: string }> = [];
		const inner: GlobScanner = async (patterns, cwd) => {
			calls.push({ patterns: [...patterns], cwd });
			return cwd === PKG ? ["src/x.ts"] : ["a/b.ts"];
		};
		const scoped = createScopedScanner(inner);
		const found = await scoped(["src/**/*.ts", "/repo/src/**/*.ts"], normalizedPath(PKG));
		expect(found).toEqual(["src/x.ts", "/repo/src/a/b.ts"]);
		expect(calls).toEqual([
			{ patterns: ["src/**/*.ts"], cwd: PKG },
			{ patterns: ["**/*.ts"], cwd: "/repo/src" },
		]);
	});

	it("groups absolute patterns by root: one scan per distinct root, in first-seen order", async () => {
		const calls: Array<{ readonly patterns: readonly string[]; readonly cwd: string }> = [];
		const inner: GlobScanner = async (patterns, cwd) => {
			calls.push({ patterns: [...patterns], cwd });
			return cwd === "/repo/src" ? ["x.ts", "y.ts"] : ["z.ts"];
		};
		const scoped = createScopedScanner(inner);
		const found = await scoped(["/repo/src/**", "/repo/lib/**", "/repo/src/*.ts"], normalizedPath(PKG));
		expect(calls).toEqual([
			{ patterns: ["**", "*.ts"], cwd: "/repo/src" },
			{ patterns: ["**"], cwd: "/repo/lib" },
		]);
		expect(found).toEqual(["/repo/src/x.ts", "/repo/src/y.ts", "/repo/lib/z.ts"]);
	});

	it("never scans above the pattern's static root (nothing outside the git root is read)", async () => {
		const roots: string[] = [];
		const inner: GlobScanner = async (_patterns, cwd) => {
			roots.push(cwd);
			return [];
		};
		const scoped = createScopedScanner(inner);
		await scoped(["/repo/packages/a/src/**/*.ts"], normalizedPath(PKG));
		expect(roots).toEqual(["/repo/packages/a/src"]);
	});
});
