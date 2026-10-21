/**
 * Pure session-state reducer for injection hysteresis.
 *
 * The reducer is total and side-effect free: every state event maps to a new
 * (or value-identical) state, and unknown event kinds degrade to a no-op —
 * never a throw — because extension runtime errors are fatal in pi. Path
 * normalization happens upstream in the collectors; this layer only dedupes
 * exact strings and tracks the hash of the last injected block.
 *
 * Session persistence lives here too, as pure functions: `touchedPathsFromEntries`
 * reads the touched paths back out of a session branch (the entries the shell
 * appends with `pi.appendEntry`), and `addedPaths` extracts the freshly touched
 * subset of an accumulation so only that subset is written back.
 */
import { normalizedPath } from "./types.ts";
import type { NormalizedPath } from "./types.ts";

/**
 * Everything the injection layer needs to remember between turns: which
 * paths the agent touched (deduped, first-seen order), the content hash of
 * the last injected section (records that a section was injected; an
 * unchanged active set re-applies byte-identical content, producing no
 * system-prompt diff), and the rule ids the user muted for this session.
 */
export interface SessionState {
	/** Paths touched so far this session, first-seen order, exact-string deduped; replaced by a session-branch rebuild. */
	readonly touchedPaths: readonly NormalizedPath[];
	/** Content hash of the last injected section, or none since start/compact/reset. */
	readonly lastInjectedHash: string | undefined;
	/** Rule ids muted for this session, first-mute order, exact-string deduped. */
	readonly mutedRuleIds: readonly string[];
}

/**
 * Session-relevant state events, distilled from pi lifecycle and tool events
 * by the collectors (paths_touched, session_*) plus outcomes emitted by the
 * shell wiring (`touched_paths_rebuilt` from the session-branch rebuild,
 * block_injected, block_removed, and the `/rules mute`/`unmute` command folding
 * rules_muted/rules_unmuted). The union is open at runtime: unknown kinds (a
 * future pi version) must fall through to a no-op, not an error.
 */
export type StateEvent =
	| { readonly type: "paths_touched"; readonly paths: readonly NormalizedPath[] }
	/** Wholesale replacement of the touched set, rebuilt from the session branch. */
	| { readonly type: "touched_paths_rebuilt"; readonly paths: readonly NormalizedPath[] }
	| { readonly type: "block_injected"; readonly contentHash: string }
	| { readonly type: "block_removed" }
	| { readonly type: "rules_muted"; readonly ruleId: string }
	| { readonly type: "rules_unmuted"; readonly ruleId: string }
	| { readonly type: "session_compact" }
	| { readonly type: "session_reset" };

/** The state a session starts (and restarts, after switch/fork) in. */
export const initialState: SessionState = { touchedPaths: [], lastInjectedHash: undefined, mutedRuleIds: [] };

/**
 * `customType` of the session entries this extension appends for touched paths.
 * Entries are never rendered and never reach the LLM: they exist so a resumed
 * session can rebuild its touched set from the branch.
 */
export const TOUCHED_ENTRY_TYPE = "pi-rules-md/touched";

/** Deduplicates exact path strings, keeping first-seen order. */
const dedupePaths = (paths: readonly NormalizedPath[]): NormalizedPath[] => {
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

const samePaths = (left: readonly NormalizedPath[], right: readonly NormalizedPath[]): boolean =>
	left.length === right.length && left.every((path, index) => path === right[index]);

/**
 * Paths of `after` that `before` does not contain, in `after` order and deduped:
 * the newly touched subset of an accumulation. Empty means a value-level no-op,
 * so the shell writes no session entry for a repeated touch.
 */
export const addedPaths = (
	before: readonly NormalizedPath[],
	after: readonly NormalizedPath[],
): readonly NormalizedPath[] => {
	const known = new Set<string>(before);
	const added: NormalizedPath[] = [];
	for (const path of after) {
		if (!known.has(path)) {
			known.add(path);
			added.push(path);
		}
	}
	return added;
};

/**
 * Rebuilds the touched set from a session branch (`ctx.sessionManager.getBranch()`).
 *
 * Only this extension's own custom entries count: `type: "custom"` plus
 * `customType: TOUCHED_ENTRY_TYPE`, whose `data.paths` is a string array.
 * Paths are normalized and deduped first-seen across entries in branch order, so
 * the result is exactly the order the touched set accumulated in.
 *
 * Total by contract: a non-array branch, foreign entry kinds, and malformed
 * entry data (missing `data`, non-array `paths`, non-string members) contribute
 * nothing and never throw — session reads happen inside pi's event dispatch,
 * where a throw is fatal.
 */
export const touchedPathsFromEntries = (entries: readonly unknown[] | null | undefined): readonly NormalizedPath[] => {
	if (!Array.isArray(entries)) {
		return [];
	}
	const seen = new Set<string>();
	const paths: NormalizedPath[] = [];
	for (const entry of entries as readonly unknown[]) {
		try {
			if (entry === null || typeof entry !== "object") {
				continue;
			}
			const candidate = entry as { readonly type?: unknown; readonly customType?: unknown; readonly data?: unknown };
			if (candidate.type !== "custom" || candidate.customType !== TOUCHED_ENTRY_TYPE) {
				continue;
			}
			const { data } = candidate;
			if (data === null || typeof data !== "object") {
				continue;
			}
			const { paths: raw } = data as { readonly paths?: unknown };
			if (!Array.isArray(raw)) {
				continue;
			}
			for (const item of raw as readonly unknown[]) {
				if (typeof item !== "string") {
					continue;
				}
				const path = normalizedPath(item);
				if (!seen.has(path)) {
					seen.add(path);
					paths.push(path);
				}
			}
		} catch {
			// A hostile or exotic entry object contributes nothing; extension
			// runtime errors are fatal in pi, so the read is guarded per entry.
		}
	}
	return paths;
};

/**
 * Pure, total transition function: `(state, event) -> state`. Never mutates
 * `state` or `event`; returns fresh objects when the value changes and may
 * share the input when the event is a value-level no-op.
 */
export const transition = (state: SessionState, event: StateEvent): SessionState => {
	switch (event.type) {
		case "paths_touched": {
			const seen = new Set<string>(state.touchedPaths);
			const fresh: NormalizedPath[] = [];
			for (const path of event.paths) {
				if (!seen.has(path)) {
					seen.add(path);
					fresh.push(path);
				}
			}
			return fresh.length === 0 ? state : { ...state, touchedPaths: [...state.touchedPaths, ...fresh] };
		}
		case "touched_paths_rebuilt": {
			// Session resume/reload/tree navigation: the branch is the source of truth
			// for touched paths, so the rebuilt set REPLACES the accumulated one. The
			// injected-block hash and the session mutes are untouched (a rebuild is not
			// a new injection and not a mute action).
			const rebuilt = dedupePaths(event.paths);
			return samePaths(state.touchedPaths, rebuilt) ? state : { ...state, touchedPaths: rebuilt };
		}
		case "block_injected":
			return { ...state, lastInjectedHash: event.contentHash };
		case "block_removed":
			// Section removed from pi: clear the hash (touched paths stay) so the
			// same block patches again after a re-activation.
			return state.lastInjectedHash === undefined ? state : { ...state, lastInjectedHash: undefined };
		case "rules_muted":
			// Session-level exclusion of one rule id: value-level no-op when already muted.
			return state.mutedRuleIds.includes(event.ruleId)
				? state
				: { ...state, mutedRuleIds: [...state.mutedRuleIds, event.ruleId] };
		case "rules_unmuted": {
			// Re-include one rule id: no-op (same reference) when it is not muted.
			const remaining = state.mutedRuleIds.filter((id) => id !== event.ruleId);
			return remaining.length === state.mutedRuleIds.length ? state : { ...state, mutedRuleIds: remaining };
		}
		case "session_compact":
			// Keep touched paths and session mutes: post-compact re-injection is the
			// point, and compaction is not a session switch.
			return { ...state, lastInjectedHash: undefined };
		case "session_reset":
			// Session switch/fork: drop everything (touched paths, hash, mutes),
			// back to the initial state.
			return initialState;
		default:
			// Forward compatibility: unknown event kinds are a no-op, never an
			// error (extension runtime errors are fatal in pi).
			return state;
	}
};
