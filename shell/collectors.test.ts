/**
 * Tests for Pi event-to-StateEvent collection using the installed event shape.
 * No Pi runtime or I/O is involved; typed fakes pin pre-execution capture,
 * normalization, totality, and reducer composition.
 */
import { describe, expect, it } from "vitest";
import { piEventToStateEvents } from "./collectors.ts";
import type { PiEventShape } from "./collectors.ts";
import { initialState, transition } from "../src/state.ts";
import type { SessionState, StateEvent } from "../src/state.ts";
import { normalizedPath } from "../src/types.ts";

const CWD = "/home/u/proj";
const start = (toolName: string, args: unknown): PiEventShape =>
	({ type: "tool_execution_start", toolCallId: "call-1", toolName, args }) as PiEventShape;

/** Recursively freezes an object/array graph in place so mutations become detectable. */
const deepFreeze = <T>(value: T): T => {
	if (Array.isArray(value)) {
		for (const item of value) deepFreeze(item);
		Object.freeze(value);
	} else if (value !== null && typeof value === "object") {
		for (const item of Object.values(value)) deepFreeze(item);
		Object.freeze(value);
	}
	return value;
};

/** Folds a sequence of fake Pi events through the collector into session state. */
const fold = (events: readonly PiEventShape[], cwd: string): SessionState =>
	events.flatMap((event) => piEventToStateEvents(event, { cwd })).reduce(transition, initialState);

describe("piEventToStateEvents — session event mapping", () => {
	it("maps compact to session_compact", () => {
		expect(piEventToStateEvents({ type: "session_compact" }, { cwd: CWD })).toEqual([{ type: "session_compact" }]);
	});

	it("maps before-switch and before-fork to session_reset", () => {
		expect(piEventToStateEvents({ type: "session_before_switch" }, { cwd: CWD })).toEqual([{ type: "session_reset" }]);
		expect(piEventToStateEvents({ type: "session_before_fork" }, { cwd: CWD })).toEqual([{ type: "session_reset" }]);
	});
});

describe("piEventToStateEvents — tool_execution_start path extraction", () => {
	it("captures the path arg from read/edit/write at execution start", () => {
		for (const toolName of ["read", "edit", "write"]) {
			const path = `${CWD}/src/${toolName}.ts`;
			expect(piEventToStateEvents(start(toolName, { path }), { cwd: CWD })).toEqual([
				{ type: "paths_touched", paths: [normalizedPath(`src/${toolName}.ts`)] },
			]);
		}
	});

	it("captures path from grep and find at execution start", () => {
		for (const toolName of ["grep", "find"]) {
			expect(piEventToStateEvents(start(toolName, { path: `${CWD}/src` }), { cwd: CWD })).toEqual([
				{ type: "paths_touched", paths: [normalizedPath("src")] },
			]);
		}
	});

	it("bash tool capture is a no-op (no workdir arg)", () => {
		expect(piEventToStateEvents(start("bash", { command: "cd /tmp/project && npm test", timeout: 5 }), { cwd: CWD })).toEqual([]);
	});

	it("unknown tools and args without the mapped path are no-ops", () => {
		expect(piEventToStateEvents(start("custom", { path: `${CWD}/src/a.ts` }), { cwd: CWD })).toEqual([]);
		expect(piEventToStateEvents(start("grep", { pattern: "needle" }), { cwd: CWD })).toEqual([]);
		expect(piEventToStateEvents(start("find", { pattern: "**/*.ts" }), { cwd: CWD })).toEqual([]);
	});

	it("ignores malformed args without throwing", () => {
		for (const args of [undefined, null, "path", 3, [], { path: 42 }, { path: null }, { path: undefined }]) {
			expect(() => piEventToStateEvents(start("read", args), { cwd: CWD })).not.toThrow();
			expect(piEventToStateEvents(start("read", args), { cwd: CWD })).toEqual([]);
		}
	});

	it("does not capture legacy tool_result paths after switching to pre-execution events", () => {
		const legacy = { type: "tool_result", toolName: "read", input: { path: `${CWD}/src/late.ts` } } as unknown as PiEventShape;
		expect(piEventToStateEvents(legacy, { cwd: CWD })).toEqual([]);
	});
});

describe("piEventToStateEvents — path handling", () => {
	it("strips the cwd prefix from an absolute path under cwd", () => {
		expect(piEventToStateEvents(start("read", { path: `${CWD}/src/deep/a.ts` }), { cwd: CWD })).toEqual([
			{ type: "paths_touched", paths: [normalizedPath("src/deep/a.ts")] },
		]);
	});

	it("keeps a relative path unchanged", () => {
		expect(piEventToStateEvents(start("edit", { path: "src/a.ts" }), { cwd: CWD })).toEqual([
			{ type: "paths_touched", paths: [normalizedPath("src/a.ts")] },
		]);
	});

	it("keeps an absolute path outside cwd as-is", () => {
		expect(piEventToStateEvents(start("read", { path: "/etc/hosts" }), { cwd: CWD })).toEqual([
			{ type: "paths_touched", paths: [normalizedPath("/etc/hosts")] },
		]);
	});

	it("does not strip a sibling directory that merely textually extends cwd", () => {
		expect(piEventToStateEvents(start("read", { path: "/home/urban/x.ts" }), { cwd: "/home/u" })).toEqual([
			{ type: "paths_touched", paths: [normalizedPath("/home/urban/x.ts")] },
		]);
	});

	it("normalizes backslashes before relativization (Windows-style absolute)", () => {
		expect(piEventToStateEvents(start("write", { path: "C:\\work\\src\\a.ts" }), { cwd: "C:\\work" })).toEqual([
			{ type: "paths_touched", paths: [normalizedPath("src/a.ts")] },
		]);
	});

	it("normalizes backslashes in a relative path without relativization", () => {
		expect(piEventToStateEvents(start("edit", { path: "src\\a.ts" }), { cwd: CWD })).toEqual([
			{ type: "paths_touched", paths: [normalizedPath("src/a.ts")] },
		]);
	});
});

describe("piEventToStateEvents — totality and purity", () => {
	it("maps null, undefined, primitive, and unknown foreign events to no events", () => {
		for (const event of [null, undefined, 42, { type: "model_select", model: "unknown" }]) {
			expect(piEventToStateEvents(event as unknown as PiEventShape, { cwd: CWD })).toEqual([]);
		}
	});

	it("is deterministic: the same input maps to the same output", () => {
		const event = start("edit", { path: `${CWD}/src/a.ts` });
		expect(piEventToStateEvents(event, { cwd: CWD })).toEqual(piEventToStateEvents(event, { cwd: CWD }));
	});

	it("never mutates its input args", () => {
		const args = deepFreeze({ path: `${CWD}/src/a.ts`, other: `${CWD}/src/untouched.ts` });
		const event = deepFreeze({ type: "tool_execution_start", toolCallId: "call-1", toolName: "edit", args }) as PiEventShape;
		expect(() => piEventToStateEvents(event, { cwd: CWD })).not.toThrow();
		expect(args).toEqual({ path: `${CWD}/src/a.ts`, other: `${CWD}/src/untouched.ts` });
	});
});

describe("collector wiring through the reducer", () => {
	it("accumulates paths with dedupe, resets on switch, and preserves compact semantics", () => {
		const state = fold([
			start("edit", { path: "/w/src/a.ts" }),
			start("write", { path: "/w/src/b.ts" }),
			start("edit", { path: "/w/src/a.ts" }),
		], "/w");
		expect(state.touchedPaths).toEqual([normalizedPath("src/a.ts"), normalizedPath("src/b.ts")]);
		expect(state.lastInjectedHash).toBeUndefined();

		const afterSwitch = piEventToStateEvents({ type: "session_before_switch" }, { cwd: "/w" }).reduce(transition, state);
		expect(afterSwitch).toEqual(initialState);
	});

	it("fork resets after accumulation too", () => {
		const state = fold([start("read", { path: "/w/src/a.ts" })], "/w");
		expect(state.touchedPaths).toEqual([normalizedPath("src/a.ts")]);
		expect(piEventToStateEvents({ type: "session_before_fork" }, { cwd: "/w" }).reduce(transition, state)).toEqual(initialState);
	});

	it("compact clears the injected hash only, keeping touched paths", () => {
		const state = fold([start("edit", { path: "/w/src/a.ts" })], "/w");
		const injected: SessionState = transition(state, { type: "block_injected", contentHash: "h1" } satisfies StateEvent);
		expect(injected.lastInjectedHash).toBe("h1");

		const compacted = piEventToStateEvents({ type: "session_compact" }, { cwd: "/w" }).reduce(transition, injected);
		expect(compacted.touchedPaths).toEqual([normalizedPath("src/a.ts")]);
		expect(compacted.lastInjectedHash).toBeUndefined();
	});
});
