/**
 * Tests for the pure session-state reducer: touched-path accumulation
 * (first-seen order, exact-string dedupe), injection-hash hysteresis,
 * compact/reset semantics, and forward-compat totality.
 *
 * Pure behavior only: no I/O, no time, no randomness. Mutation tests
 * deep-freeze their inputs so any attempt to mutate state or events is
 * caught by the frozen-object assertions.
 */
import { describe, expect, it } from "vitest";
import { initialState, transition } from "./state.ts";
import type { SessionState, StateEvent } from "./state.ts";
import { normalizedPath } from "./types.ts";

/** Recursively freezes an object/array graph in place so mutations become detectable. */
const deepFreeze = <T>(value: T): T => {
	if (Array.isArray(value)) {
		for (const item of value) {
			deepFreeze(item);
		}
		Object.freeze(value);
	} else if (value !== null && typeof value === "object") {
		for (const item of Object.values(value)) {
			deepFreeze(item);
		}
		Object.freeze(value);
	}
	return value;
};

describe("initialState", () => {
	it("starts with no touched paths and no injected hash", () => {
		expect(initialState).toEqual({ touchedPaths: [], lastInjectedHash: undefined });
	});
});

describe("transition — paths_touched", () => {
	it("accumulates a single path, leaving the hash untouched", () => {
		const next = transition(initialState, { type: "paths_touched", paths: [normalizedPath("src/a.ts")] });
		expect(next.touchedPaths).toEqual([normalizedPath("src/a.ts")]);
		expect(next.lastInjectedHash).toBeUndefined();
	});

	it("accumulates multiple events preserving first-seen order", () => {
		const afterFirst = transition(initialState, {
			type: "paths_touched",
			paths: [normalizedPath("src/b.ts"), normalizedPath("src/a.ts")],
		});
		const afterSecond = transition(afterFirst, {
			type: "paths_touched",
			paths: [normalizedPath("src/c.ts"), normalizedPath("src/b.ts")],
		});
		expect(afterSecond.touchedPaths).toEqual([
			normalizedPath("src/b.ts"),
			normalizedPath("src/a.ts"),
			normalizedPath("src/c.ts"),
		]);
	});

	it("dedupes duplicate paths within one event", () => {
		const next = transition(initialState, {
			type: "paths_touched",
			paths: [normalizedPath("src/a.ts"), normalizedPath("src/a.ts"), normalizedPath("src/b.ts")],
		});
		expect(next.touchedPaths).toEqual([normalizedPath("src/a.ts"), normalizedPath("src/b.ts")]);
	});

	it("dedupes paths already seen in earlier events", () => {
		const touched = transition(initialState, { type: "paths_touched", paths: [normalizedPath("src/a.ts")] });
		const next = transition(touched, { type: "paths_touched", paths: [normalizedPath("src/a.ts")] });
		expect(next).toEqual(touched);
		expect(next.touchedPaths).toEqual([normalizedPath("src/a.ts")]);
	});

	it("returns a value-equal state for an empty paths array", () => {
		const state: SessionState = { touchedPaths: [normalizedPath("src/a.ts")], lastInjectedHash: "hash" };
		const next = transition(state, { type: "paths_touched", paths: [] });
		expect(next).toEqual(state);
	});

	it("keeps the last injected hash when merging paths", () => {
		const injected: SessionState = { touchedPaths: [], lastInjectedHash: "hash-1" };
		const next = transition(injected, { type: "paths_touched", paths: [normalizedPath("src/a.ts")] });
		expect(next.lastInjectedHash).toBe("hash-1");
	});
});

describe("transition — block_injected", () => {
	it("sets the last injected hash and keeps touched paths", () => {
		const touched: SessionState = { touchedPaths: [normalizedPath("src/a.ts")], lastInjectedHash: undefined };
		const next = transition(touched, { type: "block_injected", contentHash: "abc123" });
		expect(next).toEqual({ touchedPaths: [normalizedPath("src/a.ts")], lastInjectedHash: "abc123" });
	});

	it("overwrites a previous hash", () => {
		const injected: SessionState = { touchedPaths: [], lastInjectedHash: "old" };
		const next = transition(injected, { type: "block_injected", contentHash: "new" });
		expect(next.lastInjectedHash).toBe("new");
	});
});

describe("transition — session_compact", () => {
	it("clears the hash but keeps touched paths for post-compact re-injection", () => {
		const state: SessionState = { touchedPaths: [normalizedPath("src/a.ts")], lastInjectedHash: "abc123" };
		const next = transition(state, { type: "session_compact" });
		expect(next).toEqual({ touchedPaths: [normalizedPath("src/a.ts")], lastInjectedHash: undefined });
	});
});

describe("transition — session_reset", () => {
	it("returns a value-equal initialState (session switch/fork)", () => {
		const state: SessionState = { touchedPaths: [normalizedPath("src/a.ts")], lastInjectedHash: "abc123" };
		const next = transition(state, { type: "session_reset" });
		expect(next).toEqual(initialState);
	});
});

describe("transition — unknown event (forward compatibility)", () => {
	it("returns the same state for a foreign event kind, never throwing", () => {
		const state: SessionState = { touchedPaths: [normalizedPath("src/a.ts")], lastInjectedHash: "abc123" };
		const foreign = { type: "session_hologram", payload: 42 } as unknown as StateEvent;
		expect(transition(state, foreign)).toBe(state);
	});
});

describe("transition — purity", () => {
	it("never mutates deep-frozen state or event inputs", () => {
		const state: SessionState = { touchedPaths: [normalizedPath("src/a.ts")], lastInjectedHash: undefined };
		const pathsEvent: StateEvent = {
			type: "paths_touched",
			paths: [normalizedPath("src/b.ts"), normalizedPath("src/a.ts")],
		};
		const hashEvent: StateEvent = { type: "block_injected", contentHash: "hash" };
		deepFreeze(state);
		deepFreeze(pathsEvent);
		deepFreeze(hashEvent);

		const afterPaths = transition(state, pathsEvent);
		const afterHash = transition(state, hashEvent);

		expect(Object.isFrozen(state)).toBe(true);
		expect(Object.isFrozen(state.touchedPaths)).toBe(true);
		expect(state.touchedPaths).toEqual([normalizedPath("src/a.ts")]);
		expect(state.lastInjectedHash).toBeUndefined();

		expect(Object.isFrozen(pathsEvent)).toBe(true);
		expect(Object.isFrozen(pathsEvent.paths)).toBe(true);
		expect(Object.isFrozen(hashEvent)).toBe(true);

		expect(afterPaths.touchedPaths).toEqual([normalizedPath("src/a.ts"), normalizedPath("src/b.ts")]);
		expect(afterPaths).not.toBe(state);
		expect(afterHash).toEqual({ touchedPaths: [normalizedPath("src/a.ts")], lastInjectedHash: "hash" });
	});

	it("folding a sequence of events equals stepping through them one by one", () => {
		const events: readonly StateEvent[] = [
			{ type: "paths_touched", paths: [normalizedPath("src/a.ts")] },
			{ type: "block_injected", contentHash: "hash-1" },
			{ type: "paths_touched", paths: [normalizedPath("src/b.ts"), normalizedPath("src/a.ts")] },
			{ type: "session_compact" },
			{ type: "block_injected", contentHash: "hash-2" },
			{ type: "session_reset" },
			{ type: "paths_touched", paths: [normalizedPath("src/c.ts")] },
		];

		const folded = events.reduce((state, event) => transition(state, event), initialState);
		let stepped = initialState;
		for (const event of events) {
			stepped = transition(stepped, event);
		}

		expect(folded).toEqual(stepped);
		expect(folded).toEqual({ touchedPaths: [normalizedPath("src/c.ts")], lastInjectedHash: undefined });
	});
});
