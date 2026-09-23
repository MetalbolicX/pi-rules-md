/**
 * Property tests for pi-event collectors (imperative shell).
 *
 * Invariants over generated events, 200 cases, fixed seeds:
 * - piEventToStateEvents is pure: the same event maps to the same state
 *   events on every call;
 * - the mapping matches the pinned contract exactly: known lifecycle kinds,
 *   first-string path extraction (file_path → path → filePath),
 *   cwd-relativization (strip a `cwd + "/"` prefix, normalize backslashes,
 *   keep relative and outside-cwd paths), and totality — null, undefined,
 *   non-objects, and foreign kinds all map to [].
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
		case "tool_result": {
			const raw = event.input?.file_path ?? event.input?.path ?? event.input?.filePath;
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

	it(`relativizes generated paths against cwd stably (${CASES} cases)`, () => {
		const rng = createSeeded(0x434f4c32);
		for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
			const cwd = rng.pick(CWD_POOL);
			const underCwd = `${cwd}/src/f${caseIndex}.ts`;
			const relative = `docs/d${caseIndex}.md`;
			const outside = "/etc/hosts";
			const backslashed = "nested\\f0.ts";

			const under = piEventToStateEvents(
				{ type: "tool_result", toolName: "edit", input: { file_path: underCwd } },
				{ cwd },
			);
			const keptRelative = piEventToStateEvents(
				{ type: "tool_result", toolName: "edit", input: { path: relative } },
				{ cwd },
			);
			const keptOutside = piEventToStateEvents(
				{ type: "tool_result", toolName: "edit", input: { filePath: outside } },
				{ cwd },
			);
			const normalizedBackslashes = piEventToStateEvents(
				{ type: "tool_result", toolName: "edit", input: { file_path: backslashed } },
				{ cwd },
			);
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
