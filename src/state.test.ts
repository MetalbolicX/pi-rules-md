/**
 * Tests for the pure session-state reducer: touched-path accumulation
 * (first-seen order, exact-string dedupe), injection-hash hysteresis,
 * session mute/unmute, compact/reset semantics, and forward-compat totality.
 *
 * Pure behavior only: no I/O, no time, no randomness. Mutation tests
 * deep-freeze their inputs so any attempt to mutate state or events is
 * caught by the frozen-object assertions.
 */
import { describe, expect, it } from "vitest";
import { addedPaths, initialState, touchedPathsFromEntries, transition } from "./state.ts";
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
	it("starts with no touched paths, no injected hash, no muted rules and nothing delivered", () => {
		expect(initialState).toEqual({ touchedPaths: [], lastInjectedHash: undefined, mutedRuleIds: [], deliveredRuleIds: [] });
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
		const state: SessionState = { touchedPaths: [normalizedPath("src/a.ts")], lastInjectedHash: "hash", mutedRuleIds: [], deliveredRuleIds: [] };
		const next = transition(state, { type: "paths_touched", paths: [] });
		expect(next).toEqual(state);
	});

	it("keeps the last injected hash when merging paths", () => {
		const injected: SessionState = { touchedPaths: [], lastInjectedHash: "hash-1", mutedRuleIds: [], deliveredRuleIds: [] };
		const next = transition(injected, { type: "paths_touched", paths: [normalizedPath("src/a.ts")] });
		expect(next.lastInjectedHash).toBe("hash-1");
	});
});

describe("transition — touched_paths_rebuilt", () => {
	it("replaces the touched set wholesale, keeping mutes and the injected hash", () => {
		const state: SessionState = {
			touchedPaths: [normalizedPath("src/old.ts")],
			lastInjectedHash: "abc123",
			mutedRuleIds: ["noisy-rule"],
			deliveredRuleIds: [],
		};
		const next = transition(state, { type: "touched_paths_rebuilt", paths: [normalizedPath("src/new.ts")] });
		expect(next).toEqual({
			touchedPaths: [normalizedPath("src/new.ts")],
			lastInjectedHash: "abc123",
			mutedRuleIds: ["noisy-rule"],
			deliveredRuleIds: [],
		});
	});

	it("dedupes the rebuilt set in first-seen order", () => {
		const next = transition(initialState, {
			type: "touched_paths_rebuilt",
			paths: [normalizedPath("src/b.ts"), normalizedPath("src/a.ts"), normalizedPath("src/b.ts")],
		});
		expect(next.touchedPaths).toEqual([normalizedPath("src/b.ts"), normalizedPath("src/a.ts")]);
	});

	it("empties the touched set when the branch has no entries, keeping hash and mutes", () => {
		const state: SessionState = {
			touchedPaths: [normalizedPath("src/a.ts")],
			lastInjectedHash: "abc123",
			mutedRuleIds: ["a-rule"],
			deliveredRuleIds: [],
		};
		const next = transition(state, { type: "touched_paths_rebuilt", paths: [] });
		expect(next.touchedPaths).toEqual([]);
		expect(next.lastInjectedHash).toBe("abc123");
		expect(next.mutedRuleIds).toEqual(["a-rule"]);
	});

	it("is a value-level no-op when the rebuilt set equals the current set (same reference)", () => {
		const state: SessionState = {
			touchedPaths: [normalizedPath("src/a.ts"), normalizedPath("src/b.ts")],
			lastInjectedHash: undefined,
			mutedRuleIds: ["a-rule"],
			deliveredRuleIds: [],
		};
		const event: StateEvent = {
			type: "touched_paths_rebuilt",
			paths: [normalizedPath("src/a.ts"), normalizedPath("src/b.ts")],
		};
		expect(transition(state, event)).toBe(state);
		expect(transition(initialState, { type: "touched_paths_rebuilt", paths: [] })).toBe(initialState);
	});

	it("never mutates deep-frozen state or event inputs", () => {
		const state: SessionState = {
			touchedPaths: [normalizedPath("src/a.ts")],
			lastInjectedHash: "abc123",
			mutedRuleIds: [],
			deliveredRuleIds: [],
		};
		const event: StateEvent = { type: "touched_paths_rebuilt", paths: [normalizedPath("src/b.ts")] };
		deepFreeze(state);
		deepFreeze(event);

		const next = transition(state, event);

		expect(Object.isFrozen(state.touchedPaths)).toBe(true);
		expect(Object.isFrozen(event.paths)).toBe(true);
		expect(state.touchedPaths).toEqual([normalizedPath("src/a.ts")]);
		expect(next.touchedPaths).toEqual([normalizedPath("src/b.ts")]);
		expect(next.touchedPaths).not.toBe(event.paths);
	});
});

describe("addedPaths", () => {
	it("returns every path of a fresh two-path batch, in order", () => {
		expect(addedPaths([], [normalizedPath("src/a.ts"), normalizedPath("src/b.ts")])).toEqual([
			normalizedPath("src/a.ts"),
			normalizedPath("src/b.ts"),
		]);
	});

	it("returns nothing for a batch that only repeats already-touched paths", () => {
		expect(addedPaths([normalizedPath("src/a.ts")], [normalizedPath("src/a.ts")])).toEqual([]);
	});

	it("keeps only the new paths of a mixed batch, in accumulation order", () => {
		expect(
			addedPaths(
				[normalizedPath("src/a.ts")],
				[normalizedPath("src/a.ts"), normalizedPath("src/c.ts"), normalizedPath("src/b.ts")],
			),
		).toEqual([normalizedPath("src/c.ts"), normalizedPath("src/b.ts")]);
	});

	it("dedupes a batch that repeats the same new path", () => {
		expect(addedPaths([], [normalizedPath("src/a.ts"), normalizedPath("src/a.ts")])).toEqual([normalizedPath("src/a.ts")]);
	});
});

describe("touchedPathsFromEntries", () => {
	/** One `pi-rules-md/touched` custom entry, as `appendEntry` writes it. */
	const touchedEntry = (paths: unknown): unknown => ({ type: "custom", customType: "pi-rules-md/touched", data: { paths } });

	it("survives an entry whose data getter throws", () => {
		const hostile: unknown = { type: "custom", customType: "pi-rules-md/touched" };
		Object.defineProperty(hostile, "data", { get() { throw new Error("boom"); } });
		const entries = [hostile, { type: "custom", customType: "pi-rules-md/touched", data: { paths: ["src/ok.ts"] } }];
		expect(() => touchedPathsFromEntries(entries)).not.toThrow();
		expect(touchedPathsFromEntries(entries)).toEqual([normalizedPath("src/ok.ts")]);
	});

	it("collects this extension's entries in branch order, deduped first-seen", () => {
		const entries = [touchedEntry(["src/a.ts"]), { type: "message" }, touchedEntry(["src/b.ts", "src/a.ts"])];
		expect(touchedPathsFromEntries(entries)).toEqual([normalizedPath("src/a.ts"), normalizedPath("src/b.ts")]);
	});

	it("normalizes separators while collecting", () => {
		expect(touchedPathsFromEntries([touchedEntry(["src\\win\\a.ts"])])).toEqual([normalizedPath("src/win/a.ts")]);
	});

	it("ignores other custom types, custom messages, and non-custom entries", () => {
		const entries = [
			{ type: "custom", customType: "pi.virtual-model-state", data: { paths: ["src/other.ts"] } },
			{ type: "custom_message", customType: "pi-rules-md/touched", content: "hello" },
			{ type: "model_change", provider: "openai", modelId: "m" },
			touchedEntry(["src/a.ts"]),
		];
		expect(touchedPathsFromEntries(entries)).toEqual([normalizedPath("src/a.ts")]);
	});

	it("ignores malformed entries and members without throwing", () => {
		const entries = [
			null,
			undefined,
			42,
			"custom",
			[],
			{},
			{ type: "custom" },
			{ type: "custom", customType: "pi-rules-md/touched" },
			{ type: "custom", customType: "pi-rules-md/touched", data: null },
			{ type: "custom", customType: "pi-rules-md/touched", data: "src/a.ts" },
			{ type: "custom", customType: "pi-rules-md/touched", data: { paths: "src/a.ts" } },
			touchedEntry([1, null, undefined, "src/b.ts", {}]),
		];

		expect(() => touchedPathsFromEntries(entries)).not.toThrow();
		expect(touchedPathsFromEntries(entries)).toEqual([normalizedPath("src/b.ts")]);
	});

	it("returns no paths when the branch itself is not an array", () => {
		for (const entries of [null, undefined, "entries", 42, { length: 0 }]) {
			expect(touchedPathsFromEntries(entries as unknown as readonly unknown[])).toEqual([]);
		}
	});

	it("is deterministic for equal inputs", () => {
		const entries = [touchedEntry(["src/a.ts", "src/b.ts"])];
		expect(touchedPathsFromEntries(entries)).toEqual(touchedPathsFromEntries(entries));
	});
});

describe("transition — block_injected", () => {
	it("sets the last injected hash and keeps touched paths", () => {
		const touched: SessionState = { touchedPaths: [normalizedPath("src/a.ts")], lastInjectedHash: undefined, mutedRuleIds: [], deliveredRuleIds: [] };
		const next = transition(touched, { type: "block_injected", contentHash: "abc123" });
		expect(next).toEqual({ touchedPaths: [normalizedPath("src/a.ts")], lastInjectedHash: "abc123", mutedRuleIds: [], deliveredRuleIds: [] });
	});

	it("overwrites a previous hash", () => {
		const injected: SessionState = { touchedPaths: [], lastInjectedHash: "old", mutedRuleIds: [], deliveredRuleIds: [] };
		const next = transition(injected, { type: "block_injected", contentHash: "new" });
		expect(next.lastInjectedHash).toBe("new");
	});
});

describe("transition — block_removed", () => {
	it("clears the injected hash but keeps touched paths", () => {
		const state: SessionState = { touchedPaths: [normalizedPath("src/a.ts")], lastInjectedHash: "abc123", mutedRuleIds: [], deliveredRuleIds: [] };
		const next = transition(state, { type: "block_removed" });
		expect(next).toEqual({ touchedPaths: [normalizedPath("src/a.ts")], lastInjectedHash: undefined, mutedRuleIds: [], deliveredRuleIds: [] });
	});

	it("returns the value-equal, shared state when the hash is already undefined", () => {
		const state: SessionState = { touchedPaths: [normalizedPath("src/a.ts")], lastInjectedHash: undefined, mutedRuleIds: [], deliveredRuleIds: [] };
		const next = transition(state, { type: "block_removed" });
		expect(next).toBe(state);
		expect(next).toEqual(state);
	});

	it("never mutates deep-frozen state or event inputs", () => {
		const state: SessionState = { touchedPaths: [normalizedPath("src/a.ts")], lastInjectedHash: "abc123", mutedRuleIds: [], deliveredRuleIds: [] };
		const event: StateEvent = { type: "block_removed" };
		deepFreeze(state);
		deepFreeze(event);

		const next = transition(state, event);

		expect(Object.isFrozen(state)).toBe(true);
		expect(Object.isFrozen(event)).toBe(true);
		expect(state.lastInjectedHash).toBe("abc123");
		expect(next.lastInjectedHash).toBeUndefined();
		expect(next.touchedPaths).toEqual([normalizedPath("src/a.ts")]);
	});
});

describe("transition — session_compact", () => {
	it("clears the hash but keeps touched paths for post-compact re-injection", () => {
		const state: SessionState = { touchedPaths: [normalizedPath("src/a.ts")], lastInjectedHash: "abc123", mutedRuleIds: [], deliveredRuleIds: [] };
		const next = transition(state, { type: "session_compact" });
		expect(next).toEqual({ touchedPaths: [normalizedPath("src/a.ts")], lastInjectedHash: undefined, mutedRuleIds: [], deliveredRuleIds: [] });
	});

	it("keeps session mutes: compaction is not a session switch", () => {
		const state: SessionState = {
			touchedPaths: [],
			lastInjectedHash: "abc123",
			mutedRuleIds: ["muted-rule"],
			deliveredRuleIds: [],
		};
		const next = transition(state, { type: "session_compact" });
		expect(next.mutedRuleIds).toEqual(["muted-rule"]);
	});

	it("clears the delivered set so rules can reach the model again after compaction", () => {
		// S9: compaction drops the transcript the LLM carries, so what was already
		// delivered is no longer in context; the set must restart empty. Touched paths
		// and session mutes survive, because they are still the session's truth.
		const state: SessionState = {
			touchedPaths: [normalizedPath("src/a.ts")],
			lastInjectedHash: "abc123",
			mutedRuleIds: ["muted-rule"],
			deliveredRuleIds: ["rule-a", "rule-b"],
		};
		const next = transition(state, { type: "session_compact" });
		expect(next.deliveredRuleIds).toEqual([]);
		expect(next.touchedPaths).toEqual([normalizedPath("src/a.ts")]);
		expect(next.mutedRuleIds).toEqual(["muted-rule"]);
		expect(next.lastInjectedHash).toBeUndefined();
	});
});

describe("transition — session_reset", () => {
	it("returns a value-equal initialState (session switch/fork)", () => {
		const state: SessionState = { touchedPaths: [normalizedPath("src/a.ts")], lastInjectedHash: "abc123", mutedRuleIds: [], deliveredRuleIds: [] };
		const next = transition(state, { type: "session_reset" });
		expect(next).toEqual(initialState);
	});

	it("drops session mutes with everything else (switch/fork start unmuted)", () => {
		const muted: SessionState = {
			touchedPaths: [normalizedPath("src/a.ts")],
			lastInjectedHash: "abc123",
			mutedRuleIds: ["a-rule", "b-rule"],
			deliveredRuleIds: ["rule-a"],
		};
		const next = transition(muted, { type: "session_reset" });
		expect(next.mutedRuleIds).toEqual([]);
	});

	it("drops the delivered set with everything else (switch/fork start undelivered)", () => {
		const state: SessionState = {
			touchedPaths: [],
			lastInjectedHash: undefined,
			mutedRuleIds: [],
			deliveredRuleIds: ["rule-a", "rule-b"],
		};
		expect(transition(state, { type: "session_reset" }).deliveredRuleIds).toEqual([]);
	});
});

describe("transition — rules_delivered", () => {
	it("appends the rule ids, keeping touched paths, hash and mutes", () => {
		const state: SessionState = {
			touchedPaths: [normalizedPath("src/a.ts")],
			lastInjectedHash: "abc123",
			mutedRuleIds: ["muted-rule"],
			deliveredRuleIds: [],
		};
		const next = transition(state, { type: "rules_delivered", ruleIds: ["rule-a"] });
		expect(next).toEqual({
			touchedPaths: [normalizedPath("src/a.ts")],
			lastInjectedHash: "abc123",
			mutedRuleIds: ["muted-rule"],
			deliveredRuleIds: ["rule-a"],
		});
	});

	it("keeps first-delivery order and dedupes across events", () => {
		const once = transition(initialState, { type: "rules_delivered", ruleIds: ["rule-b", "rule-a"] });
		const twice = transition(once, { type: "rules_delivered", ruleIds: ["rule-a", "rule-c"] });
		expect(twice.deliveredRuleIds).toEqual(["rule-b", "rule-a", "rule-c"]);
	});

	it("dedupes ids repeated inside one event", () => {
		const next = transition(initialState, { type: "rules_delivered", ruleIds: ["rule-a", "rule-a", "rule-b"] });
		expect(next.deliveredRuleIds).toEqual(["rule-a", "rule-b"]);
	});

	it("is a value-level no-op when every id is already delivered (same reference)", () => {
		const delivered = transition(initialState, { type: "rules_delivered", ruleIds: ["rule-a"] });
		expect(transition(delivered, { type: "rules_delivered", ruleIds: ["rule-a"] })).toBe(delivered);
		expect(transition(delivered, { type: "rules_delivered", ruleIds: [] })).toBe(delivered);
		expect(transition(initialState, { type: "rules_delivered", ruleIds: [] })).toBe(initialState);
	});

	it("never mutates deep-frozen state or event inputs", () => {
		const state: SessionState = { touchedPaths: [], lastInjectedHash: undefined, mutedRuleIds: [], deliveredRuleIds: ["rule-a"] };
		const event: StateEvent = { type: "rules_delivered", ruleIds: ["rule-b"] };
		deepFreeze(state);
		deepFreeze(event);

		const next = transition(state, event);

		expect(Object.isFrozen(state.deliveredRuleIds)).toBe(true);
		expect(Object.isFrozen(event.ruleIds)).toBe(true);
		expect(state.deliveredRuleIds).toEqual(["rule-a"]);
		expect(event).toEqual({ type: "rules_delivered", ruleIds: ["rule-b"] });
		expect(next.deliveredRuleIds).toEqual(["rule-a", "rule-b"]);
		expect(state.deliveredRuleIds).not.toBe(next.deliveredRuleIds);
	});
});

describe("transition — rules_muted", () => {
	it("appends the rule id, keeping touched paths and the injected hash", () => {
		const state: SessionState = { touchedPaths: [normalizedPath("src/a.ts")], lastInjectedHash: "abc123", mutedRuleIds: [], deliveredRuleIds: [] };
		const next = transition(state, { type: "rules_muted", ruleId: "noisy-rule" });
		expect(next).toEqual({
			touchedPaths: [normalizedPath("src/a.ts")],
			lastInjectedHash: "abc123",
			mutedRuleIds: ["noisy-rule"],
			deliveredRuleIds: [],
		});
	});

	it("appends in first-mute order and keeps the set deduped", () => {
		const once = transition(initialState, { type: "rules_muted", ruleId: "b-rule" });
		const twice = transition(once, { type: "rules_muted", ruleId: "a-rule" });
		expect(twice.mutedRuleIds).toEqual(["b-rule", "a-rule"]);
	});

	it("is a value-level no-op for an already muted rule (same reference)", () => {
		const muted = transition(initialState, { type: "rules_muted", ruleId: "noisy-rule" });
		const again = transition(muted, { type: "rules_muted", ruleId: "noisy-rule" });
		expect(again).toBe(muted);
		expect(again.mutedRuleIds).toEqual(["noisy-rule"]);
	});

	it("never mutates deep-frozen state or event inputs", () => {
		const state: SessionState = { touchedPaths: [], lastInjectedHash: undefined, mutedRuleIds: ["first"], deliveredRuleIds: [] };
		const event: StateEvent = { type: "rules_muted", ruleId: "second" };
		deepFreeze(state);
		deepFreeze(event);

		const next = transition(state, event);

		expect(Object.isFrozen(state.mutedRuleIds)).toBe(true);
		expect(state.mutedRuleIds).toEqual(["first"]);
		expect(event).toEqual({ type: "rules_muted", ruleId: "second" });
		expect(next.mutedRuleIds).toEqual(["first", "second"]);
		expect(state.mutedRuleIds).not.toBe(next.mutedRuleIds);
	});
});

describe("transition — rules_unmuted", () => {
	it("removes the rule id, keeping the muted order of the rest", () => {
		const state: SessionState = { touchedPaths: [], lastInjectedHash: undefined, mutedRuleIds: ["a-rule", "b-rule", "c-rule"], deliveredRuleIds: [] };
		const next = transition(state, { type: "rules_unmuted", ruleId: "b-rule" });
		expect(next.mutedRuleIds).toEqual(["a-rule", "c-rule"]);
		expect(next.touchedPaths).toEqual([]);
		expect(next.lastInjectedHash).toBeUndefined();
	});

	it("is a value-level no-op for a rule that is not muted (same reference)", () => {
		const state: SessionState = { touchedPaths: [], lastInjectedHash: "abc123", mutedRuleIds: ["a-rule"], deliveredRuleIds: [] };
		expect(transition(state, { type: "rules_unmuted", ruleId: "other-rule" })).toBe(state);
		expect(transition(initialState, { type: "rules_unmuted", ruleId: "a-rule" })).toBe(initialState);
	});

	it("round-trips mute → unmute back to the same muted set", () => {
		const muted = transition(initialState, { type: "rules_muted", ruleId: "a-rule" });
		const unmuted = transition(muted, { type: "rules_unmuted", ruleId: "a-rule" });
		expect(unmuted.mutedRuleIds).toEqual([]);
		const remuted = transition(unmuted, { type: "rules_muted", ruleId: "a-rule" });
		expect(remuted.mutedRuleIds).toEqual(["a-rule"]);
	});
});

describe("transition — unknown event (forward compatibility)", () => {
	it("returns the same state for a foreign event kind, never throwing", () => {
		const state: SessionState = { touchedPaths: [normalizedPath("src/a.ts")], lastInjectedHash: "abc123", mutedRuleIds: [], deliveredRuleIds: [] };
		const foreign = { type: "session_hologram", payload: 42 } as unknown as StateEvent;
		expect(transition(state, foreign)).toBe(state);
	});
});

describe("transition — purity", () => {
	it("never mutates deep-frozen state or event inputs", () => {
		const state: SessionState = { touchedPaths: [normalizedPath("src/a.ts")], lastInjectedHash: undefined, mutedRuleIds: [], deliveredRuleIds: [] };
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
		expect(afterHash).toEqual({ touchedPaths: [normalizedPath("src/a.ts")], lastInjectedHash: "hash", mutedRuleIds: [], deliveredRuleIds: [] });
	});

	it("folding a sequence of events equals stepping through them one by one", () => {
		const events: readonly StateEvent[] = [
			{ type: "paths_touched", paths: [normalizedPath("src/a.ts")] },
			{ type: "block_injected", contentHash: "hash-1" },
			{ type: "rules_delivered", ruleIds: ["rule-a"] },
			{ type: "rules_muted", ruleId: "muted-rule" },
			{ type: "paths_touched", paths: [normalizedPath("src/b.ts"), normalizedPath("src/a.ts")] },
			{ type: "rules_delivered", ruleIds: ["rule-b", "rule-a"] },
			{ type: "session_compact" },
			{ type: "rules_unmuted", ruleId: "muted-rule" },
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
		expect(folded).toEqual({ touchedPaths: [normalizedPath("src/c.ts")], lastInjectedHash: undefined, mutedRuleIds: [], deliveredRuleIds: [] });
	});
});
