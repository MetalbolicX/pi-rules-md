/**
 * Injection layer (imperative shell): decide whether pi's system-prompt
 * sections must change, then apply that decision in place. The decision core
 * is pure and functional; the two application helpers are deliberately
 * imperative — mutating the caller's sections object IS the pi mutation, the
 * only one this extension performs (invariant: inject exclusively via
 * `systemPromptOptions.sections` on `before_agent_start`, never via
 * `systemPrompt` or transcript messages).
 *
 * LOCAL structural mirror (verified against pi 0.87.1): `PromptSections`
 * mirrors the REAL `systemPromptOptions.sections` type —
 * `SystemPromptSections = Record<string, string>` in
 * `node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.d.ts`
 * ("Ordered system prompt sections, keyed by name"), reached via
 * `BeforeAgentStartEvent.systemPromptOptions: NormalizedBuildSystemPromptOptions`
 * in `dist/core/extensions/types.d.ts`. Sections are keyed by id, not an
 * array of `{ id, content }` entries. There is NO runtime import of pi: the
 * mirror is structural, so typed fakes can test it and pi upgrades that only
 * add fields stay assignable.
 *
 * T13 wiring protocol (contract for `index.ts`, not implemented here):
 * - `{ action: "patch" }`  → `applyInjection(sections, block)`, then fold
 *   `{ type: "block_injected", contentHash: block.contentHash }` into state.
 * - `{ action: "remove" }` → `removeInjection(sections)`, then fold
 *   `{ type: "block_removed" }` into state.
 * - `{ action: "none" }`   → touch nothing, emit no event (zero-cost
 *   hysteresis skip for an unchanged active set).
 */
import { sectionId } from "../src/render.ts";
import type { InjectionBlock } from "../src/types.ts";

/**
 * Minimal structural mirror of pi's `systemPromptOptions.sections` (pi
 * 0.87.1): section id → section content, insertion-ordered.
 */
export type PromptSections = Record<string, string>;

/** What the injection layer should do to pi's sections this turn. */
export type InjectionDecision = { readonly action: "none" } | { readonly action: "patch" } | { readonly action: "remove" };

/**
 * Pure, total decision function: `(block, lastInjectedHash) -> decision`.
 * Deterministic for equal inputs, never throws, never mutates.
 *
 * - block defined + hash differs → patch (content changed since last inject)
 * - block defined + hash equal   → none  (hysteresis: unchanged active set)
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
	return block.contentHash === lastInjectedHash ? { action: "none" } : { action: "patch" };
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
