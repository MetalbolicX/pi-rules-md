/**
 * Pi-event collectors (imperative shell): distill real pi extension events
 * into the session `StateEvent`s the reducer (src/state.ts) consumes. Pure
 * mapper only — subscribing and folding happen in the index wiring (task 13).
 *
 * The `PiEventShape` union is a LOCAL, minimal structural mirror of the REAL
 * pi event surface (pi 0.87.x, `dist/core/extensions/types.d.ts`): members
 * carry only the discriminant plus the fields this module consumes, so real
 * pi events (which carry extra fields) remain assignable by structural
 * typing. Real names mirrored verbatim:
 * - `SessionCompactEvent`      → `session_compact`
 * - `SessionBeforeSwitchEvent` → `session_before_switch`
 * - `SessionBeforeForkEvent`   → `session_before_fork`
 * - `ToolResultEvent`          → `tool_result` (carries `toolName` + `input`
 *   args; `tool_execution_end` carries only a `result` payload, not args)
 *
 * NO runtime import of pi or any other package — the union is structural so
 * the collector can be tested against typed fakes and survives pi upgrades
 * that only add fields.
 *
 * Mapping (v1 contract):
 * - `session_compact`      → `[session_compact]` (hash hysteresis reset)
 * - `session_before_switch` and `session_before_fork` → `[session_reset]`
 * - `tool_result` whose args carry a path-like string — first of
 *   `input.file_path ?? input.path ?? input.filePath` that is present, kept
 *   only when it is a string — → one `paths_touched` with that single path
 *   (dedupe/accumulation is the reducer's job). No tool-name allowlist:
 *   generic structural extraction is the disclosed v1 simplification. No
 *   path extraction from bash stdout (v1).
 *
 * Paths are normalized (backslashes → slashes via `normalizedPath`) and
 * relativized against `cwd`: an absolute path starting with `cwd + "/"`
 * loses that prefix; relative paths pass through unchanged; absolute paths
 * outside cwd are kept as-is.
 *
 * Totality: any event outside the known kinds (foreign runtime shape) maps
 * to `[]` — never a throw, because extension runtime errors are fatal in pi.
 */
import type { StateEvent } from "../src/state.ts";
import { normalizedPath } from "../src/types.ts";
import type { NormalizedPath } from "../src/types.ts";

/**
 * Minimal structural mirror of the pi extension events this collector
 * consumes. Field shapes stay loose on purpose: `input` is what real pi
 * types as `Record<string, unknown>`, widened to allow `undefined` so
 * defensive handling of absent args is part of the contract.
 */
export type PiEventShape =
	| { readonly type: "session_compact" }
	| { readonly type: "session_before_switch" }
	| { readonly type: "session_before_fork" }
	| {
			readonly type: "tool_result";
			/** Carried for event identity; the v1 mapper applies no tool-name allowlist. */
			readonly toolName: string;
			/** Tool arguments, plain object or absent. */
			readonly input: Record<string, unknown> | undefined;
	  };

/** Relativizes a raw path against `cwd`: strip a `cwd + "/"` prefix, else keep. */
const toStatePath = (raw: string, cwd: string): NormalizedPath => {
	const path = normalizedPath(raw);
	const prefix = `${normalizedPath(cwd)}/`;
	return path.startsWith(prefix) ? normalizedPath(path.slice(prefix.length)) : path;
};

/** First path-like string in a tool_result's args, or none. */
const extractPathArg = (input: Record<string, unknown> | undefined): string | undefined => {
	const raw = input?.file_path ?? input?.path ?? input?.filePath;
	return typeof raw === "string" ? raw : undefined;
};

/**
 * Pure, total mapper: one pi event → 0..n state events. Never throws, never
 * mutates `event`; deterministic for equal inputs.
 */
export const piEventToStateEvents = (event: PiEventShape, opts: { readonly cwd: string }): readonly StateEvent[] => {
	switch (event.type) {
		case "session_compact":
			return [{ type: "session_compact" }];
		case "session_before_switch":
		case "session_before_fork":
			return [{ type: "session_reset" }];
		case "tool_result": {
			const raw = extractPathArg(event.input);
			return raw === undefined ? [] : [{ type: "paths_touched", paths: [toStatePath(raw, opts.cwd)] }];
		}
		default:
			// Foreign runtime shape: no events, never an error.
			return [];
	}
};
