/**
 * Property tests for the session-state reducer (rule format v1).
 *
 * Invariants over generated events and path pools, 200 cases each, fixed
 * seeds:
 * - folding the same paths_touched event twice equals folding it once (set
 *   semantics, first-seen order), including duplicate paths within one event;
 * - every known event kind is idempotent, and transitions never mutate their
 *   input state (purity check via deep snapshots);
 * - session_compact clears the hash but keeps touched paths;
 * - block_removed clears the hash but keeps touched paths;
 * - session_reset returns the initial state;
 * - an unknown event kind is a no-op returning an equal state value.
 *
 * Deterministic via the seeded harness; no I/O, no clocks.
 */
import { describe, expect, it } from "vitest";
import { initialState, transition } from "../../src/state.ts";
import type { SessionState, StateEvent } from "../../src/state.ts";
import { normalizedPath } from "../../src/types.ts";
import type { NormalizedPath } from "../../src/types.ts";
import { randomStateEvent, someOf, times } from "./support/generators.ts";
import { createSeeded } from "./support/seeded.ts";

const CASES = 200;
const PATH_POOL: readonly string[] = ["src/a.ts", "src/lib/b.ts", "docs/x.md", "tests/a.test.ts", "README.md", "shell/c.ts"];

/** Expected first-seen dedupe of a path list — the reducer's merge contract. */
const dedupeFirstSeen = (paths: readonly NormalizedPath[]): readonly NormalizedPath[] => {
	const seen = new Set<string>();
	const unique: NormalizedPath[] = [];
	for (const path of paths) {
		if (!seen.has(path)) {
			seen.add(path);
			unique.push(path);
		}
	}
	return unique;
};

/** Builds a state carrying paths plus an injected hash. */
const stateWithPathsAndHash = (rng: ReturnType<typeof createSeeded>): { readonly state: SessionState; readonly paths: readonly NormalizedPath[] } => {
	const paths = dedupeFirstSeen(someOf(rng, PATH_POOL, 0, 4).map(normalizedPath));
	const state = transition(transition(initialState, { type: "paths_touched", paths }), {
		type: "block_injected",
		contentHash: `hash-${rng.int(0, 999)}`,
	});
	return { state, paths };
};

describe("transition — paths_touched set semantics (property)", () => {
	it(`folds the same paths_touched event to the same state, twice or once (${CASES} cases)`, () => {
		const rng = createSeeded(0x53543131);
		for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
			const paths = times(rng.int(0, 5), () => normalizedPath(rng.pick(PATH_POOL)));
			const event = { type: "paths_touched", paths } as const;
			const once = transition(initialState, event);
			const twice = transition(transition(initialState, event), event);
			const context = `case ${caseIndex}`;
			expect(twice, context).toEqual(once);
			expect(once.touchedPaths, `${context}: first-seen order`).toEqual(dedupeFirstSeen(paths));

			// Duplicates inside ONE event collapse the same way.
			const withInternalDupes = transition(initialState, { type: "paths_touched", paths: [...paths, ...paths] });
			expect(withInternalDupes, context).toEqual(once);
		}
	});
});

describe("transition — idempotence and purity (property)", () => {
	it(`every generated event folds idempotently without mutating its input (${CASES} cases)`, () => {
		const rng = createSeeded(0x53543232);
		for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
			const { state } = stateWithPathsAndHash(rng);
			const before = structuredClone(state);
			const event = randomStateEvent(rng);
			const once = transition(state, event);
			const twice = transition(once, event);
			const context = `case ${caseIndex}`;
			expect(twice, `${context}: idempotent`).toEqual(once);
			expect(state, `${context}: input state untouched`).toEqual(before);
		}
	});
});

describe("transition — hash hysteresis events (property)", () => {
	it(`session_compact clears the hash and keeps touched paths (${CASES} cases)`, () => {
		const rng = createSeeded(0x53543333);
		for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
			const { state, paths } = stateWithPathsAndHash(rng);
			const compacted = transition(state, { type: "session_compact" });
			const context = `case ${caseIndex}`;
			expect(compacted.touchedPaths, `${context}: paths kept`).toEqual(paths);
			expect(compacted.lastInjectedHash, `${context}: hash cleared`).toBeUndefined();
		}
	});

	it(`block_removed clears the hash and keeps touched paths (${CASES} cases)`, () => {
		const rng = createSeeded(0x53543434);
		for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
			const { state, paths } = stateWithPathsAndHash(rng);
			const removed = transition(state, { type: "block_removed" });
			const context = `case ${caseIndex}`;
			expect(removed.touchedPaths, `${context}: paths kept`).toEqual(paths);
			expect(removed.lastInjectedHash, `${context}: hash cleared`).toBeUndefined();
		}
	});

	it(`session_reset returns the initial state (${CASES} cases)`, () => {
		const rng = createSeeded(0x53543535);
		for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
			const { state } = stateWithPathsAndHash(rng);
			const reset = transition(state, { type: "session_reset" });
			expect(reset, `case ${caseIndex}`).toEqual(initialState);
		}
	});

	it(`an unknown event kind is a value-level no-op (${CASES} cases)`, () => {
		const rng = createSeeded(0x53543636);
		for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
			const { state } = stateWithPathsAndHash(rng);
			const before = structuredClone(state);
			const foreign = { type: `event_${caseIndex}`, payload: caseIndex } as unknown as StateEvent;
			const next = transition(state, foreign);
			const context = `case ${caseIndex}`;
			expect(next, `${context}: same state value`).toEqual(state);
			expect(state, `${context}: input state untouched`).toEqual(before);
		}
	});
});
