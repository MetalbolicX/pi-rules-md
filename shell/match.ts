/**
 * Rule-base rebasing (imperative shell seam, S10 walk-up half).
 *
 * Monorepo discovery finds project rules in every `.pi/rules` between cwd and
 * the enclosing git root. A rule's globs are authored relative to the directory
 * that owns its `.pi/` folder — its **rule base** — so a rule found at
 * `/repo/.pi/rules` means `/repo/src/**`, while the evaluation path pools are
 * expressed differently:
 *
 * - `shell/collectors.ts` relativizes a touched path against cwd and keeps a
 *   path OUTSIDE cwd absolute (`/repo/src/x.ts`).
 * - The exists scan runs relative to cwd, so its results are cwd-relative.
 *
 * Neither scale alone can answer "does this ancestor rule match?" — and the
 * matching core (`src/match.ts`, `src/engine.ts`) takes ONE shared context per
 * pass, so the honest place to reconcile the scales is here, by re-expressing
 * the rule's authored globs onto both scales before evaluation:
 *
 * 1. an ABSOLUTE form anchored at the rule base (`/repo/src/**\/*.ts`), which
 *    matches the absolute touched paths of files outside cwd;
 * 2. CWD-RELATIVE forms for paths INSIDE cwd, obtained by consuming the
 *    base→cwd segment prefix from the pattern (`packages/a/src/**` →
 *    `src/**`), including the `**` backtracking that lets a root rule such as
 *    `**\/*.ts` keep matching inner files.
 *
 * Cwd rules are untouched, and are untouched *by identity*: `rebaseGlobs`
 * returns the very array it was given whenever no rebase applies, so rules from
 * `<cwd>/.pi/rules` keep today's semantics and today's bytes exactly.
 *
 * Contract notes pinned by tests:
 * - `!`-negated patterns rebase exactly like positives (the prefix goes after
 *   the `!`), so exclusions stay on the same scale as their inclusions.
 * - Authored absolute globs (`/etc/**`) and parent-escaping globs (`../x/**`)
 *   are left as authored: re-anchoring them would invent a mapping the author
 *   never wrote, and silently rewriting an escape attempt is worse than
 *   leaving today's semantics for that pattern alone.
 * - Variants are deduplicated; a rule's declaration order is preserved.
 * - `createScopedScanner` is the scan-side half: absolute (rebased) patterns
 *   are scanned at their own static root and returned in absolute form, so they
 *   land in the same scale as the absolute touched paths. A pass whose patterns
 *   are all relative — every single-directory project — delegates to exactly
 *   one cwd scan with the identical pattern array, so today's scan is
 *   byte-identical. Nothing above a pattern's static root is ever scanned; for
 *   REBASED patterns that root is inside the git root by walk-up construction,
 *   while an authored ABSOLUTE glob keeps its own root wherever the author
 *   pointed it (RULE-SPEC §1: globs are evaluated exactly as authored).
 * - Cost: an ancestor rule adds one scan per distinct static root per cycle
 *   (the S8 cache keys by cwd + the exact pattern sequence, so the rebased
 *   patterns are part of the key and a changed rule base is a fresh key).
 */
import { globMatcher } from "../src/conditions/predicates.ts";
import type { GlobScanner } from "../src/match.ts";
import { normalizedPath } from "../src/types.ts";

/** Glob magic that ends a scan pattern's static path prefix. */
const MAGIC = /[*?[\]{}()!+@]/;

/** Absolute POSIX path or a Windows drive path, as globs and paths arrive here. */
const isAbsolutePattern = (pattern: string): boolean => pattern.startsWith("/") || /^[A-Za-z]:\//.test(pattern);

/** Paths split into non-empty segments (a leading `/` or `C:` survives as a segment). */
const segmentsOf = (value: string): readonly string[] => value.split("/").filter((segment) => segment !== "");

/** Strips trailing separators, keeping a bare filesystem root intact. */
const stripTrailingSlash = (value: string): string => (value.length > 1 ? value.replace(/\/+$/, "") : value);

/** Joins a directory and a relative result, never doubling the separator. */
const joinPath = (root: string, rest: string): string => (root.endsWith("/") ? `${root}${rest}` : `${root}/${rest}`);

/**
 * Segments of `cwd` relative to `base`, or `undefined` when no rebase applies
 * (cwd IS the base, or cwd is not inside it). Comparison is exact and
 * separator-normalized; a Windows drive letter is compared as-is, which is what
 * git reports for a repository root.
 */
const descendantSegments = (base: string, cwd: string): readonly string[] | undefined => {
	const from = segmentsOf(normalizedPath(base));
	const to = segmentsOf(normalizedPath(cwd));
	if (to.length <= from.length) {
		return undefined;
	}
	for (const [index, segment] of from.entries()) {
		if (to[index] !== segment) {
			return undefined;
		}
	}
	return to.slice(from.length);
};

/** Single-segment match used while consuming the known base→cwd prefix. */
const segmentMatches = (pattern: string, segment: string): boolean => {
	try {
		return globMatcher([pattern])(normalizedPath(segment));
	} catch {
		// An uncompilable segment is not a match; predicates never throw.
		return false;
	}
};

/**
 * Cwd-relative variants of one positive pattern body, given the known
 * base→cwd segments. The walk consumes the literal prefix of the pattern that
 * the known prefix can satisfy (segment-wise picomatch, so `*` or `{a,b}` may
 * consume a known segment), and backtracks over `**`, which may absorb any
 * number of segments — including none, which is what keeps a root rule such as
 * `**\/*.ts` matching an inner `src/x.ts`.
 */
const cwdScaleVariants = (body: string, rel: readonly string[]): readonly string[] => {
	const variants: string[] = [];
	const walk = (patternSegments: readonly string[], prefix: readonly string[]): void => {
		if (patternSegments.length === 0) {
			return;
		}
		if (prefix.length === 0) {
			variants.push(patternSegments.join("/"));
			return;
		}
		const head = patternSegments[0] ?? "";
		const rest = patternSegments.slice(1);
		if (head === "**") {
			for (let consumed = 0; consumed <= prefix.length; consumed += 1) {
				walk(rest, prefix.slice(consumed));
			}
			// `**` may also absorb part of the cwd-relative remainder, so keep it.
			variants.push(rest.length === 0 ? "**" : ["**", ...rest].join("/"));
			return;
		}
		if (segmentMatches(head, prefix[0] ?? "")) {
			walk(rest, prefix.slice(1));
		}
	};
	walk(body.split("/"), rel);
	return variants;
};

/**
 * Re-expresses `globs` (authored relative to the rule base) onto the two scales
 * the evaluation path pools carry. Returns the INPUT array unchanged — same
 * identity, no copy — when there is nothing to rebase, which is the exact
 * single-directory behavior: `base === cwd` (a `<cwd>/.pi/rules` rule) or a cwd
 * that is not inside the base.
 */
export const rebaseGlobs = (globs: readonly string[], base: string, cwd: string): readonly string[] => {
	const rel = descendantSegments(base, cwd);
	if (rel === undefined) {
		return globs;
	}
	const anchor = stripTrailingSlash(normalizedPath(base));
	const out: string[] = [];
	const seen = new Set<string>();
	const push = (pattern: string): void => {
		if (!seen.has(pattern)) {
			seen.add(pattern);
			out.push(pattern);
		}
	};
	for (const glob of globs) {
		const negated = glob.startsWith("!");
		const body = negated ? glob.slice(1) : glob;
		const parts = body.split("/");
		if (body === "" || isAbsolutePattern(body) || parts.includes("..")) {
			push(glob);
			continue;
		}
		const variants = [`${anchor}/${body}`, ...cwdScaleVariants(body, rel)];
		for (const variant of variants) {
			push(negated ? `!${variant}` : variant);
		}
	}
	return out;
};

/** One scan pattern's static root and the glob remainder to run there. */
export interface ScanPatternRoot {
	/** Absolute directory the scan runs in (inside the git root for rebased patterns; authored absolute globs keep their own root). */
	readonly root: string;
	/** Pattern remainder, relative to `root`. */
	readonly remainder: string;
}

/**
 * Splits an absolute pattern into the directory it can be scanned in and the
 * glob remainder. `undefined` for a relative pattern (today's cwd scan) and for
 * an absolute pattern with no filename/glob segment left (a bare directory
 * path, which contributes no scan target).
 */
export const scanPatternRoot = (pattern: string): ScanPatternRoot | undefined => {
	if (!isAbsolutePattern(pattern)) {
		return undefined;
	}
	const parts = stripTrailingSlash(pattern).split("/");
	const firstMagic = parts.findIndex((segment, index) => index > 0 && MAGIC.test(segment));
	const split = firstMagic === -1 ? parts.length - 1 : firstMagic;
	const root = parts.slice(0, split).join("/");
	const remainder = parts.slice(split).join("/");
	if (root === "" || remainder === "") {
		return undefined;
	}
	return { root, remainder };
};

/**
 * Wraps a scanner so rebased absolute patterns are scanned at their own static
 * root and returned in absolute form, while relative patterns keep today's
 * single cwd scan (identical array, identical call). Results keep first-seen
 * pattern order — callers (`withExistingPaths`) sort and dedupe anyway.
 */
export const createScopedScanner = (scan: GlobScanner): GlobScanner => async (patterns, cwd) => {
	const relative: string[] = [];
	// First-seen root order keeps the scan sequence deterministic.
	const byRoot = new Map<string, { readonly remainders: string[] }>();
	for (const pattern of patterns) {
		const split = scanPatternRoot(pattern);
		if (split === undefined) {
			relative.push(pattern);
			continue;
		}
		const group = byRoot.get(split.root);
		if (group === undefined) {
			byRoot.set(split.root, { remainders: [split.remainder] });
		} else {
			group.remainders.push(split.remainder);
		}
	}
	if (byRoot.size === 0) {
		// Byte-identical single-directory path: one cwd scan, same pattern array.
		return scan(patterns, cwd);
	}
	const found: string[] = [];
	if (relative.length > 0) {
		found.push(...(await scan(relative, cwd)));
	}
	for (const [root, group] of byRoot) {
		const hits = await scan(group.remainders, normalizedPath(root));
		for (const hit of hits) {
			found.push(joinPath(root, normalizedPath(hit)));
		}
	}
	return found;
};
