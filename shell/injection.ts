/**
 * Injection layer (imperative shell): decide whether pi's system-prompt
 * sections must change, then apply that decision in place. The decision core
 * is pure and functional; the two application helpers are deliberately
 * imperative — mutating the caller's sections object IS the pi mutation, the
 * only one this extension performs (invariant: inject exclusively via
 * `systemPromptOptions.sections` on `before_agent_start`, never via
 * `systemPrompt` or transcript messages).
 *
 * LOCAL structural mirror (verified against pi 1.3.0): `PromptSections`
 * mirrors the REAL `systemPromptOptions.sections` type —
 * `SystemPromptSections = Record<string, string>` in
 * `node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.d.ts:56`
 * ("Ordered system prompt sections, keyed by name"), reached via
 * `BeforeAgentStartEvent.systemPromptOptions: NormalizedBuildSystemPromptOptions`
 * in `dist/core/extensions/types.d.ts:725`. Sections are keyed by id, not an
 * array of `{ id, content }` entries. There is NO runtime import of pi: the
 * mirror is structural, so typed fakes can test it and pi upgrades that only
 * add fields stay assignable.
 *
 * Hash hysteresis means content STABILITY, not write skipping (T14 dogfood
 * defect fix, verified against pi 1.3.0 source): `emitBeforeAgentStart` calls
 * `normalizeBuildSystemPromptOptions(...)` on every run
 * (`dist/core/extensions/runner.js:1121-1123`), so pi hands each turn a fresh
 * normalized options object and extension mutations do not persist; the
 * section must therefore be re-applied while a block exists. An identical
 * re-apply makes pi's section diff emit nothing — the hash still buys zero
 * prompt churn, just never at the cost of a dropped section.
 *
 * T13 wiring protocol (contract for `index.ts`, not implemented here):
 * - `{ action: "patch" }`  → `applyInjection(sections, block)`, then fold
 *   `{ type: "block_injected", contentHash: block.contentHash }` into state
 *   (folding an identical hash is an idempotent same-value overwrite).
 * - `{ action: "remove" }` → `removeInjection(sections)`, then fold
 *   `{ type: "block_removed" }` into state.
 * - `{ action: "none" }`   → touch nothing, emit no event (nothing is active
 *   and nothing was ever injected).
 */
import { sectionId } from "../src/render.ts";
import type { InjectionBlock } from "../src/types.ts";

/**
 * Minimal structural mirror of pi's `systemPromptOptions.sections` (pi
 * 1.3.0): section id → section content, insertion-ordered.
 */
export type PromptSections = Record<string, string>;

/** What the injection layer should do to pi's sections this turn. */
export type InjectionDecision = { readonly action: "none" } | { readonly action: "patch" } | { readonly action: "remove" };

/**
 * Pure, total decision function: `(block, lastInjectedHash) -> decision`.
 * Deterministic for equal inputs, never throws, never mutates.
 *
 * - block defined                → patch (ALWAYS re-apply: pi rebuilds the
 *   sections record every turn, so skipping the write on hash equality would
 *   drop the section; an identical re-apply yields an empty section diff.
 *   `lastInjectedHash` only feeds the remove quadrant.)
 * - block undefined + hash set   → remove (section no longer wanted)
 * - both undefined               → none  (nothing injected, nothing to do)
 */
export const injectionDecision = (
	block: InjectionBlock | undefined,
	lastInjectedHash: string | undefined,
): InjectionDecision => {
	if (block === undefined) {
		return lastInjectedHash === undefined ? { action: "none" } : { action: "remove" };
	}
	return { action: "patch" };
};

/**
 * Imperative application of a patch: set (or replace) the section keyed by
 * `sectionId` (from src/render.ts) with the block's content. Assigning an
 * existing key replaces its value while keeping the key and its position;
 * assigning a missing key appends it. Total: never throws for any
 * `PromptSections` value.
 */
export const applyInjection = (sections: PromptSections, block: InjectionBlock): void => {
	sections[sectionId] = block.content;
};

/**
 * Imperative application of a removal: delete the section keyed by
 * `sectionId`. A missing key is a no-op. Total: never throws.
 */
export const removeInjection = (sections: PromptSections): void => {
	delete sections[sectionId];
};
