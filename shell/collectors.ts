/**
 * Pi-event collectors (imperative shell): distill real pi extension events
 * into the session `StateEvent`s the reducer (src/state.ts) consumes. Pure
 * mapper only — subscribing and folding happen in the index wiring (task 13).
 *
 * The `PiEventShape` union is a LOCAL, minimal structural mirror of the REAL
 * pi event surface (pi 1.3.0, `dist/core/extensions/types.d.ts`): members
 * carry only the discriminant plus the fields this module consumes, so real
 * pi events (which carry extra fields) remain assignable by structural
 * typing. Real names mirrored verbatim:
 * - `SessionCompactEvent`      → `session_compact` (types.d.ts:613-621)
 * - `SessionBeforeSwitchEvent` → `session_before_switch` (types.d.ts:589-593)
 * - `SessionBeforeForkEvent`   → `session_before_fork` (types.d.ts:595-599)
 * - `ToolExecutionStartEvent` → `tool_execution_start` (carries
 *   `toolCallId`, `toolName`, and pre-execution `args`) — exact SDK declaration
 *   is in `dist/core/extensions/types.d.ts:853-860`.
 *
 * NO runtime import of pi or any other package — the union is structural so
 * the collector can be tested against typed fakes and survives pi upgrades
 * that only add fields.
 *
 * Mapping:
 * - `session_compact`      → `[session_compact]` (hash hysteresis reset)
 * - `session_before_switch` and `session_before_fork` → `[session_reset]`
 * - pre-execution read/edit/write/grep/find events use their built-in `args.path`
 *   to produce one `paths_touched`; bash and unknown tools produce no path event.
 *
 * Paths are normalized (backslashes → slashes via `normalizedPath`) and
 * relativized against `cwd`: an absolute path starting with `cwd + "/"`
 * loses that prefix; relative paths pass through unchanged; absolute paths
 * outside cwd are kept as-is.
 *
 * Totality: any event outside the known kinds (foreign runtime shape), as
 * well as a null/undefined or non-object input, maps to `[]` — never a
 * throw, because extension runtime errors are fatal in pi.
 */
import type { StateEvent } from "../src/state.ts";
import { normalizedPath } from "../src/types.ts";
import type { NormalizedPath } from "../src/types.ts";

/**
 * Minimal structural mirror of the pi extension events this collector
 * consumes. `args: unknown` matches Pi's installed ToolExecutionStartEvent
 * declaration (SDK types it `any`); the mapper treats it as untrusted and
 * guards every access.
 */
export type PiEventShape =
	| { readonly type: "session_compact" }
	| { readonly type: "session_before_switch" }
	| { readonly type: "session_before_fork" }
	| {
			readonly type: "tool_execution_start";
			readonly toolCallId: string;
			readonly toolName: string;
			/** Pi SDK types.d.ts:853-860 declares args as any; widened to unknown. */
			readonly args: unknown;
	  };

/** Relativizes a raw path against `cwd`: strip a `cwd + "/"` prefix, else keep. */
const toStatePath = (raw: string, cwd: string): NormalizedPath => {
	const path = normalizedPath(raw);
	const prefix = `${normalizedPath(cwd)}/`;
	return path.startsWith(prefix) ? normalizedPath(path.slice(prefix.length)) : path;
};

const PATH_ARG_TOOLS = new Set(["read", "edit", "write", "grep", "find"]);

/** The installed built-ins all use `path` for their file/search scope. */
const extractPathArg = (toolName: string, args: unknown): string | undefined => {
	if (!PATH_ARG_TOOLS.has(toolName) || args === null || typeof args !== "object" || Array.isArray(args)) {
		return undefined;
	}
	const raw = (args as Record<string, unknown>).path;
	return typeof raw === "string" ? raw : undefined;
};

/**
 * Pure, total mapper: one pi event → 0..n state events. Never throws, never
 * mutates `event`; deterministic for equal inputs. Defensive runtime inputs
 * (null, undefined, non-object primitives) map to `[]` — extension runtime
 * errors are fatal in pi, so the `.type` deref is guarded.
 */
export const piEventToStateEvents = (
	event: PiEventShape | null | undefined,
	opts: { readonly cwd: string },
): readonly StateEvent[] => {
	if (event === null || typeof event !== "object") {
		return [];
	}
	try {
		switch (event.type) {
			case "session_compact":
				return [{ type: "session_compact" }];
			case "session_before_switch":
			case "session_before_fork":
				return [{ type: "session_reset" }];
			case "tool_execution_start": {
				const raw = extractPathArg(event.toolName, event.args);
				return raw === undefined ? [] : [{ type: "paths_touched", paths: [toStatePath(raw, opts.cwd)] }];
			}
			default:
				// Foreign runtime shape: no events, never an error.
				return [];
		}
	} catch {
		// Malformed event objects and args are ignored; extension errors are fatal in Pi.
		return [];
	}
};
