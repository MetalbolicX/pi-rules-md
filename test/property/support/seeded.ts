/**
 * Vendored seeded property-testing harness (dependency-free).
 *
 * fast-check is deliberately NOT used: it is not installed and dependency
 * installs are out of scope for this repository state, so this module
 * provides the minimal primitives the property tests need — a tiny
 * deterministic PRNG (mulberry32) plus int/pick/oneof/shuffle helpers.
 *
 * No shrink support, on purpose: every generator consumes a fixed-seed PRNG,
 * so a failing case is reproduced exactly by re-running the same test — the
 * literal seed in the test file IS the minimized failing program. Swapping
 * this harness for fast-check (which adds shrinking) stays a future option
 * once dependency installs are unblocked; the generators in
 * `./generators.ts` consume this rng via small closures, so their plumbing
 * maps 1:1 onto fast-check arbiters.
 *
 * Pure and deterministic: no dependencies, no module state, no Math.random,
 * no clocks. All helpers are exported for reuse across test files.
 */

/**
 * mulberry32: 32-bit PRNG returning floats in [0, 1). Tiny, fast, and good
 * enough for property generation; the seed is scrambled on first use.
 */
export const mulberry32 = (seed: number): (() => number) => {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

/** The seeded helper surface shared by every generator and property test. */
export interface Seeded {
	/** Next float in [0, 1). */
	readonly next: () => number;
	/** Fair boolean. */
	readonly bool: () => boolean;
	/** Integer in [min, max], both ends inclusive. Requires max >= min. */
	readonly int: (min: number, max: number) => number;
	/** One element of a non-empty array, uniformly. */
	readonly pick: <T>(items: readonly T[]) => T;
	/** Picks one generator from a non-empty array and runs it. */
	readonly oneof: <T>(generators: readonly (() => T)[]) => T;
	/** Seeded Fisher–Yates shuffle; returns a fresh array, input untouched. */
	readonly shuffle: <T>(items: readonly T[]) => readonly T[];
}

/** Bounds-checked read used by pick/shuffle; unreachable in valid usage. */
const at = <T>(items: readonly T[], index: number): T => {
	const item = items[index];
	if (item === undefined) {
		throw new Error(`seeded: index ${index} out of bounds for length ${items.length}`);
	}
	return item;
};

/** Builds one seeded helper bundle; same seed always yields the same sequence. */
export const createSeeded = (seed: number): Seeded => {
	const next = mulberry32(seed);
	const int = (min: number, max: number): number => {
		if (max < min) {
			throw new Error(`seeded.int: max (${max}) must be >= min (${min})`);
		}
		return min + Math.floor(next() * (max - min + 1));
	};
	const bool = (): boolean => next() < 0.5;
	const pick = <T>(items: readonly T[]): T => {
		if (items.length === 0) {
			throw new Error("seeded.pick: items must not be empty");
		}
		return at(items, int(0, items.length - 1));
	};
	const oneof = <T>(generators: readonly (() => T)[]): T => pick(generators)();
	const shuffle = <T>(items: readonly T[]): readonly T[] => {
		const out = [...items];
		for (let i = out.length - 1; i > 0; i -= 1) {
			const j = int(0, i);
			const tmp = at(out, i);
			out[i] = at(out, j);
			out[j] = tmp;
		}
		return out;
	};
	return { next, bool, int, pick, oneof, shuffle };
};
