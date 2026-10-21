/**
 * Pure session-state reducer for injection hysteresis.
 *
 * The reducer is total and side-effect free: every state event maps to a new
 * (or value-identical) state, and unknown event kinds degrade to a no-op —
 * never a throw — because extension runtime errors are fatal in pi. Path
 * normalization happens upstream in the collectors; this layer only dedupes
 * exact strings and tracks the hash of the last injected block.
 */
import type { NormalizedPath } from "./types.ts";

/**
 * Everything the injection layer needs to remember between turns: which
 * paths the agent touched (deduped, first-seen order), the content hash of
 * the last injected section (records that a section was injected; an
 * unchanged active set re-applies byte-identical content, producing no
 * system-prompt diff), and the rule ids the user muted for this session.
 */
export interface SessionState {
	/** Paths touched so far this session, first-seen order, exact-string deduped. */
	readonly touchedPaths: readonly NormalizedPath[];
	/** Content hash of the last injected section, or none since start/compact/reset. */
	readonly lastInjectedHash: string | undefined;
	/** Rule ids muted for this session, first-mute order, exact-string deduped. */
	readonly mutedRuleIds: readonly string[];
}

/**
 * Session-relevant state events, distilled from pi lifecycle and tool events
 * by the collectors (paths_touched, session_*) plus outcomes emitted by the
 * shell wiring (block_injected, block_removed, and the `/rules mute`/`unmute`
 * command folding rules_muted/rules_unmuted). The union is open at runtime:
 * unknown kinds (a future pi version) must fall through to a no-op, not an
 * error.
 */
export type StateEvent =
	| { readonly type: "paths_touched"; readonly paths: readonly NormalizedPath[] }
	| { readonly type: "block_injected"; readonly contentHash: string }
	| { readonly type: "block_removed" }
	| { readonly type: "rules_muted"; readonly ruleId: string }
	| { readonly type: "rules_unmuted"; readonly ruleId: string }
	| { readonly type: "session_compact" }
	| { readonly type: "session_reset" };

/** The state a session starts (and restarts, after switch/fork) in. */
export const initialState: SessionState = { touchedPaths: [], lastInjectedHash: undefined, mutedRuleIds: [] };

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
