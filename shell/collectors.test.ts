/**
 * Tests for the pi-event → StateEvent collector.
 *
 * Pure behavior only: every input is a typed fake `PiEventShape` mirroring the
 * real pi extension event names — no pi runtime, no I/O, no disk. The suite
 * pins the collector contract v1: one mapped kind per pi event, structural
 * path extraction from `tool_result` args (`file_path ?? path ?? filePath`),
 * cwd relativization, totality for foreign runtime shapes, purity, and
 * composition with the reducer (`transition` from src/state.ts).
 */
import { describe, expect, it } from "vitest";
import { piEventToStateEvents } from "./collectors.ts";
import type { PiEventShape } from "./collectors.ts";
import { initialState, transition } from "../src/state.ts";
import type { SessionState, StateEvent } from "../src/state.ts";
import { normalizedPath } from "../src/types.ts";

const CWD = "/home/u/proj";

/** Recursively freezes an object/array graph in place so mutations become detectable. */
const deepFreeze = <T>(value: T): T => {
	if (Array.isArray(value)) {
		for (const item of value) {
			deepFreeze(item);
		}
		Object.freeze(value);
	} else if (value !== null && typeof value === "object") {
		for (const item of Object.values(value)) {
			Object.freeze(item);
		}
		Object.freeze(value);
	}
	return value;
};

/** Folds a sequence of fake pi events through the collector into session state. */
const fold = (events: readonly PiEventShape[], cwd: string): SessionState =>
	events.flatMap((event) => piEventToStateEvents(event, { cwd })).reduce(transition, initialState);

describe("piEventToStateEvents — session event mapping", () => {
	it("maps a compact event to one session_compact state event", () => {
		const events: PiEventShape = { type: "session_compact" };
		expect(piEventToStateEvents(events, { cwd: CWD })).toEqual([{ type: "session_compact" }]);
	});

	it("maps before-switch to one session_reset state event", () => {
		const events: PiEventShape = { type: "session_before_switch" };
		expect(piEventToStateEvents(events, { cwd: CWD })).toEqual([{ type: "session_reset" }]);
	});

	it("maps before-fork to one session_reset state event", () => {
		const events: PiEventShape = { type: "session_before_fork" };
		expect(piEventToStateEvents(events, { cwd: CWD })).toEqual([{ type: "session_reset" }]);
	});
});

describe("piEventToStateEvents — tool_result path extraction", () => {
	it("extracts file_path into one paths_touched event, relativized", () => {
		const events: PiEventShape = {
			type: "tool_result",
			toolName: "edit",
			input: { file_path: `${CWD}/src/a.ts` },
		};
		expect(piEventToStateEvents(events, { cwd: CWD })).toEqual([
			{ type: "paths_touched", paths: [normalizedPath("src/a.ts")] },
		]);
	});

	it("falls back to path when file_path is absent", () => {
		const events: PiEventShape = {
			type: "tool_result",
			toolName: "read",
			input: { path: `${CWD}/src/b.ts` },
		};
		expect(piEventToStateEvents(events, { cwd: CWD })).toEqual([
			{ type: "paths_touched", paths: [normalizedPath("src/b.ts")] },
		]);
	});

	it("falls back to filePath when file_path and path are absent", () => {
		const events: PiEventShape = {
			type: "tool_result",
			toolName: "write",
			input: { filePath: `${CWD}/src/c.ts` },
		};
		expect(piEventToStateEvents(events, { cwd: CWD })).toEqual([
			{ type: "paths_touched", paths: [normalizedPath("src/c.ts")] },
		]);
	});

	it("first present key wins: file_path beats path and filePath", () => {
		const events: PiEventShape = {
			type: "tool_result",
			toolName: "edit",
			input: { file_path: `${CWD}/src/first.ts`, path: `${CWD}/src/second.ts`, filePath: `${CWD}/src/third.ts` },
		};
		expect(piEventToStateEvents(events, { cwd: CWD })).toEqual([
			{ type: "paths_touched", paths: [normalizedPath("src/first.ts")] },
		]);
	});

	it("yields no event when args are undefined", () => {
		const events: PiEventShape = { type: "tool_result", toolName: "bash", input: undefined };
		expect(piEventToStateEvents(events, { cwd: CWD })).toEqual([]);
	});

	it("yields no event when args carry none of the path keys", () => {
		const events: PiEventShape = {
			type: "tool_result",
			toolName: "bash",
			input: { command: "ls -la", other: 42 },
		};
		expect(piEventToStateEvents(events, { cwd: CWD })).toEqual([]);
	});

	it("yields no event when the first present key is not a string", () => {
		const events: PiEventShape = {
			type: "tool_result",
			toolName: "custom",
			input: { file_path: 42, path: `${CWD}/src/never.ts` },
		};
		// The ?? chain picks the first non-nullish value; the string gate then
		// rejects it — no event rather than a coerced or skipped-over path.
		expect(piEventToStateEvents(events, { cwd: CWD })).toEqual([]);
	});
});

describe("piEventToStateEvents — path handling", () => {
	it("strips the cwd prefix from an absolute path under cwd", () => {
		const events: PiEventShape = {
			type: "tool_result",
			toolName: "read",
			input: { file_path: "/home/u/proj/src/deep/a.ts" },
		};
		expect(piEventToStateEvents(events, { cwd: "/home/u/proj" })).toEqual([
			{ type: "paths_touched", paths: [normalizedPath("src/deep/a.ts")] },
		]);
	});

	it("keeps a relative path unchanged", () => {
		const events: PiEventShape = { type: "tool_result", toolName: "edit", input: { file_path: "src/a.ts" } };
		expect(piEventToStateEvents(events, { cwd: CWD })).toEqual([
			{ type: "paths_touched", paths: [normalizedPath("src/a.ts")] },
		]);
	});

	it("keeps an absolute path outside cwd as-is", () => {
		const events: PiEventShape = { type: "tool_result", toolName: "read", input: { file_path: "/etc/hosts" } };
		expect(piEventToStateEvents(events, { cwd: CWD })).toEqual([
			{ type: "paths_touched", paths: [normalizedPath("/etc/hosts")] },
		]);
	});

	it("does not strip a sibling directory that merely textually extends cwd", () => {
		const events: PiEventShape = {
			type: "tool_result",
			toolName: "read",
			input: { file_path: "/home/urban/x.ts" },
		};
		expect(piEventToStateEvents(events, { cwd: "/home/u" })).toEqual([
			{ type: "paths_touched", paths: [normalizedPath("/home/urban/x.ts")] },
		]);
	});

	it("normalizes backslashes before relativization (Windows-style absolute)", () => {
		const events: PiEventShape = {
			type: "tool_result",
			toolName: "write",
			input: { file_path: "C:\\work\\src\\a.ts" },
		};
		expect(piEventToStateEvents(events, { cwd: "C:\\work" })).toEqual([
			{ type: "paths_touched", paths: [normalizedPath("src/a.ts")] },
		]);
	});

	it("normalizes backslashes in a relative path without relativization", () => {
		const events: PiEventShape = { type: "tool_result", toolName: "edit", input: { file_path: "src\\a.ts" } };
		expect(piEventToStateEvents(events, { cwd: CWD })).toEqual([
			{ type: "paths_touched", paths: [normalizedPath("src/a.ts")] },
		]);
	});
});

describe("piEventToStateEvents — totality and purity", () => {
	it("maps an unknown foreign event shape to no events", () => {
		// Simulates a foreign/older runtime shape: not part of PiEventShape, so
		// the test cast is the only sanctioned one here. The mapper must stay
		// total — return [], never throw.
		const foreign = { type: "model_select", model: "unknown" } as unknown as PiEventShape;
		expect(piEventToStateEvents(foreign, { cwd: CWD })).toEqual([]);
	});

	it("is deterministic: the same input maps to the same output", () => {
		const events: PiEventShape = {
			type: "tool_result",
			toolName: "edit",
			input: { file_path: `${CWD}/src/a.ts` },
		};
		const first = piEventToStateEvents(events, { cwd: CWD });
		const second = piEventToStateEvents(events, { cwd: CWD });
		expect(first).toEqual(second);
	});

	it("never mutates its input", () => {
		const input = { file_path: `${CWD}/src/a.ts`, path: `${CWD}/src/untouched.ts` };
		const events = deepFreeze({ type: "tool_result", toolName: "edit", input }) as PiEventShape;
		expect(() => piEventToStateEvents(events, { cwd: CWD })).not.toThrow();
		expect(input).toEqual({ file_path: `${CWD}/src/a.ts`, path: `${CWD}/src/untouched.ts` });
	});
});

describe("collector wiring through the reducer", () => {
	it("accumulates touched paths across tool events with dedupe, and switch resets", () => {
		const state = fold(
			[
				{ type: "tool_result", toolName: "edit", input: { file_path: "/w/src/a.ts" } },
				{ type: "tool_result", toolName: "write", input: { filePath: "/w/src/b.ts" } },
				{ type: "tool_result", toolName: "edit", input: { file_path: "/w/src/a.ts" } },
			],
			"/w",
		);
		expect(state.touchedPaths).toEqual([normalizedPath("src/a.ts"), normalizedPath("src/b.ts")]);
		expect(state.lastInjectedHash).toBeUndefined();

		const afterSwitch = piEventToStateEvents({ type: "session_before_switch" }, { cwd: "/w" })
			.reduce(transition, state);
		expect(afterSwitch).toEqual(initialState);
	});

	it("fork resets after accumulation too", () => {
		const state = fold([{ type: "tool_result", toolName: "read", input: { path: "/w/src/a.ts" } }], "/w");
		expect(state.touchedPaths).toEqual([normalizedPath("src/a.ts")]);
		const afterFork = piEventToStateEvents({ type: "session_before_fork" }, { cwd: "/w" })
			.reduce(transition, state);
		expect(afterFork).toEqual(initialState);
	});

	it("compact clears the injected hash only, keeping touched paths", () => {
		const state = fold([{ type: "tool_result", toolName: "edit", input: { file_path: "/w/src/a.ts" } }], "/w");
		const injected: SessionState = transition(state, { type: "block_injected", contentHash: "h1" } satisfies StateEvent);
		expect(injected.lastInjectedHash).toBe("h1");

		const afterCompact = piEventToStateEvents({ type: "session_compact" }, { cwd: "/w" })
			.reduce(transition, injected);
		expect(afterCompact.touchedPaths).toEqual([normalizedPath("src/a.ts")]);
		expect(afterCompact.lastInjectedHash).toBeUndefined();
	});
});
