/**
 * Exists-scan cache (S8): a memoizing closure over the injected
 * {@link GlobScanner} seam.
 *
 * `exists` matching asks the project scanner for every rule's positive globs on
 * each evaluation, and the same (cwd, pattern set) is typically asked again
 * unchanged for many consecutive turns. This module wraps that seam so a
 * repeated question is answered from memory; the wrapped scanner stays the
 * only code that touches the filesystem.
 *
 * Contract notes pinned by tests:
 * - Key = cwd + the EXACT pattern sequence. The engine passes the deduplicated
 *   first-seen-order patterns from `deriveScanPatterns`, so the sequence is a
 *   faithful identity for the pattern set: a widened rule set, a narrowed one,
 *   or a reordering is a different key and therefore a fresh scan. Order
 *   sensitivity is deliberate — it never returns a result computed for a
 *   different question, and it needs no canonicalization to stay honest.
 * - The cached value is a frozen copy of the scan result, so neither the
 *   wrapped scanner (holding its own array) nor a caller can mutate what later
 *   hits observe. Hits return the same frozen array (identity stable).
 * - A scan that REJECTS is not cached: the rejection propagates to the caller
 *   exactly as without this wrapper (`withExistingPaths` documents that scanner
 *   failures propagate) and the store stays empty, so the next call retries.
 * - `invalidate()` clears the WHOLE store — the wiring calls it after any tool
 *   result that can have changed the filesystem (`write`/`edit`/`bash`), where
 *   naming which keys are affected would require re-deriving every rule set.
 *   A pattern-set change needs no explicit invalidation: it misses by key and
 *   leaves the stale entry unreachable until `invalidate()` or eviction.
 * - No `.gitignore` semantics live here (D1): the cache stores only what the
 *   wrapped scanner returned, so which files are hidden is still decided solely
 *   by the scanner's own ignore configuration.
 * - Staleness is bounded by those signals: a filesystem change that no
 *   write/edit/bash tool performed (an external editor, another process) is
 *   invisible until an invalidating result or a pattern-set change arrives.
 *   That is the accepted tradeoff of a signal-driven cache, and it is pinned by
 *   a test.
 */
import type { GlobScanner } from "../src/match.ts";
import type { NormalizedPath } from "../src/types.ts";

/** A wrapped scanner plus the two cache controls the wiring needs. */
export interface CachedScanner {
	/** Drop-in replacement for the wrapped scanner. */
	readonly scanner: GlobScanner;
	/** Clears every cached scan; the next call for any key scans again. */
	readonly invalidate: () => void;
	/** Number of cached (cwd, pattern set) entries — observability for tests. */
	readonly size: () => number;
}

/**
 * Cache key: cwd plus the exact pattern sequence. `JSON.stringify` of the
 * tuple is unambiguous for arbitrary pattern text (unlike separator joining)
 * and keeps the comparison exact, including order.
 */
const cacheKey = (patterns: readonly string[], cwd: NormalizedPath): string => JSON.stringify([cwd, ...patterns]);

/**
 * Wraps `scan` with a (cwd, pattern set) memo. Pure closure over a Map — no
 * timers, no I/O of its own, no concurrency hazard beyond the awaiting replay
 * of simultaneous misses (each miss runs the wrapped scan; last write wins with
 * an equal value).
 */
export const createCachedScanner = (scan: GlobScanner): CachedScanner => {
	const entries = new Map<string, readonly string[]>();

	const scanner: GlobScanner = async (patterns, cwd) => {
		const key = cacheKey(patterns, cwd);
		const hit = entries.get(key);
		if (hit !== undefined) {
			return hit;
		}
		// A rejection here leaves the store untouched: the error flows to the
		// caller unchanged and the next call retries.
		const found = await scan(patterns, cwd);
		const snapshot: readonly string[] = Object.freeze([...found]);
		entries.set(key, snapshot);
		return snapshot;
	};

	return {
		scanner,
		invalidate: () => entries.clear(),
		size: () => entries.size,
	};
};
