/**
 * Property tests for pi-event collectors (imperative shell).
 *
 * Invariants over generated events, 200 cases, fixed seeds:
 * - piEventToStateEvents is pure: the same event maps to the same state
 *   events on every call;
 * - the mapping matches the pre-execution contract: known lifecycle kinds,
 *   recognized read/edit/write/grep/find `args.path` capture, bash and unknown
 *   tool no-ops, cwd-relativization, and totality for malformed inputs.
 *
 * Deterministic via the seeded harness; no I/O, no clocks.
 */
import { describe, expect, it } from "vitest";
import { piEventToStateEvents } from "../../shell/collectors.ts";
import type { PiEventShape } from "../../shell/collectors.ts";
import type { StateEvent } from "../../src/state.ts";
import { normalizedPath } from "../../src/types.ts";
import { randomPiEvent } from "./support/generators.ts";
import { createSeeded } from "./support/seeded.ts";

const CASES = 200;
const CWD_POOL: readonly string[] = ["/work/proj", "/home/u/api"];

/**
 * Contract mirror used as the expected value: the same relativization rules
 * the collector documents (normalize backslashes, strip a cwd+"/" prefix,
 * otherwise keep the path as-is).
 */
const expectedStateEvents = (event: PiEventShape, cwd: string): readonly StateEvent[] => {
	if (event === null || typeof event !== "object") {
		return [];
	}
	switch (event.type) {
		case "session_compact":
			return [{ type: "session_compact" }];
		case "session_before_switch":
		case "session_before_fork":
			return [{ type: "session_reset" }];
		case "tool_execution_start": {
			if (!["read", "edit", "write", "grep", "find"].includes(event.toolName)) {
				return [];
			}
			if (event.args === null || typeof event.args !== "object" || Array.isArray(event.args)) {
				return [];
			}
			const raw = (event.args as Record<string, unknown>).path;
			if (typeof raw !== "string") {
				return [];
			}
			const normalized = raw.replaceAll("\\", "/");
			const prefix = `${cwd}/`;
			const relative = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
			return [{ type: "paths_touched", paths: [normalizedPath(relative)] }];
		}
		default:
			return [];
	}
};

describe("piEventToStateEvents — purity and contract (property)", () => {
	it(`captures only built-in path args and ignores bash/malformed args (${CASES} cases)`, () => {
		const rng = createSeeded(0x434f4c33);
		const pathTools = ["read", "edit", "write", "grep", "find"] as const;
		for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
			const cwd = rng.pick(CWD_POOL);
			const file = `p${rng.int(0, 999)}.ts`;
			const path = `${cwd}/src/${file}`;
			for (const toolName of pathTools) {
				const result = piEventToStateEvents({
					type: "tool_execution_start",
					toolCallId: `call-${caseIndex}`,
					toolName,
					args: { path },
				}, { cwd });
				expect(result, `case ${caseIndex}, ${toolName}`).toEqual([
					{ type: "paths_touched", paths: [normalizedPath(`src/${file}`)] },
				]);
			}
			expect(piEventToStateEvents({
				type: "tool_execution_start", toolCallId: `bash-${caseIndex}`, toolName: "bash",
				args: { command: `cd ${cwd} && echo ignored`, timeout: 1 },
			}, { cwd })).toEqual([]);
			for (const args of [undefined, null, 42, "bad", [], { path: 42 }]) {
				expect(piEventToStateEvents({
					type: "tool_execution_start", toolCallId: `bad-${caseIndex}`, toolName: "read", args,
				}, { cwd })).toEqual([]);
			}
		}
	});
	it(`maps every generated event identically on repeat calls (${CASES} cases)`, () => {
		const rng = createSeeded(0x434f4c31);
		for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
			const cwd = rng.pick(CWD_POOL);
			const event = randomPiEvent(rng, cwd);
			const first = piEventToStateEvents(event, { cwd });
			const second = piEventToStateEvents(event, { cwd });
			const context = `case ${caseIndex}`;
			expect(first, `${context}: pure (same output twice)`).toEqual(second);
			expect(first, `${context}: matches the pinned mapping`).toEqual(expectedStateEvents(event, cwd));
		}
	});

	it(`captures pre-execution path args and relativizes them against cwd stably (${CASES} cases)`, () => {
		const rng = createSeeded(0x434f4c32);
		for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
			const cwd = rng.pick(CWD_POOL);
			const underCwd = `${cwd}/src/f${caseIndex}.ts`;
			const relative = `docs/d${caseIndex}.md`;
			const outside = "/etc/hosts";
			const backslashed = "nested\\f0.ts";

			const event = (toolName: string, path: string): PiEventShape => ({
				type: "tool_execution_start",
				toolCallId: `case-${caseIndex}`,
				toolName,
				args: { path },
			});
			const under = piEventToStateEvents(event("read", underCwd), { cwd });
			const keptRelative = piEventToStateEvents(event("grep", relative), { cwd });
			const keptOutside = piEventToStateEvents(event("write", outside), { cwd });
			const normalizedBackslashes = piEventToStateEvents(event("find", backslashed), { cwd });
			const context = `case ${caseIndex}`;
			expect(under, `${context}: cwd prefix stripped`).toEqual([
				{ type: "paths_touched", paths: [`src/f${caseIndex}.ts`] },
			]);
			expect(keptRelative, `${context}: relative path unchanged`).toEqual([
				{ type: "paths_touched", paths: [relative] },
			]);
			expect(keptOutside, `${context}: outside-cwd path unchanged`).toEqual([
				{ type: "paths_touched", paths: [outside] },
			]);
			expect(normalizedBackslashes, `${context}: backslashes normalized`).toEqual([
				{ type: "paths_touched", paths: ["nested/f0.ts"] },
			]);
		}
	});
});
