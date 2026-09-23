/**
 * Renderer (rule format v1): selected rules → one InjectionBlock.
 *
 * Consumes the selection pipeline's output as ordered entries — each a rule
 * plus the trigger reasons that selected it, already in selection order —
 * and renders one deterministic markdown section for the `sections`
 * mutation. `renderSection` returns `undefined` for an empty entry list so
 * the injection layer (task 12) can skip the mutation entirely.
 *
 * Byte-stability contract:
 * - `# Rules` header, then one imperative framing paragraph, then a blank
 *   line before the first rule.
 * - Per rule: `## <description>`, then a `> Triggered by:` blockquote line
 *   ONLY when reasons exist (the whole line is omitted otherwise), then the
 *   rule content verbatim — never trimmed or reflowed — except that its
 *   trailing whitespace is stripped so body padding can never add blank
 *   lines around the `---` separators (R3-001 normalization).
 * - Rules are separated by a horizontal rule (`---`) with a blank line on
 *   each side.
 * - Trigger phrases per reason kind: `always active`, `` glob `<pattern>` ``,
 *   `` tool `<tool>` ``, `` model `<model>` ``, `` branch `<branch>` `` —
 *   joined with ` · ` in reason order.
 * - The content ends with exactly one renderer-added trailing newline.
 *
 * `contentHash` is the sha-256 hex digest of the full rendered content
 * (node:crypto, no dependencies) and drives content stability: an
 * unchanged active set renders byte-identically, so re-applying it each
 * turn produces no system-prompt diff (pi rebuilds sections per turn).
 * All functions are pure and deterministic: no I/O, no module state.
 */
import { createHash } from "node:crypto";
import type { InjectionBlock, MatchReason, Rule } from "./types.ts";

/** One rule to render plus the trigger reasons that selected it, in selection order. */
export interface RenderEntry {
	readonly rule: Rule;
	readonly reasons: readonly MatchReason[];
}

/** Fixed section id for the injected rules section. */
export const sectionId = "pi-rules-md";

/** Imperative framing paragraph shown once, under the `# Rules` header. */
const framing =
	"The following rules are active for this session. Follow every rule exactly as written, in every response, without exception — they are binding instructions, not suggestions. A `Triggered by` note under a rule explains why that rule is active; it does not weaken the obligation to comply.";

/** Trigger phrase for one match reason, in the reason's own words. */
const triggerPhrase = (reason: MatchReason): string => {
	switch (reason.kind) {
		case "always":
			return "always active";
		case "glob":
			return `glob \`${reason.pattern}\``;
		case "tool":
			return `tool \`${reason.tool}\``;
		case "model":
			return `model \`${reason.model}\``;
		case "branch":
			return `branch \`${reason.branch}\``;
	}
};

/** The `> Triggered by:` line, empty exactly when there are no reasons. */
const triggerLine = (reasons: readonly MatchReason[]): string =>
	reasons.length === 0 ? "" : `> Triggered by: ${reasons.map(triggerPhrase).join(" · ")}\n`;

/**
 * One entry rendered as heading, optional trigger line, content verbatim
 * except for its trailing whitespace, which is stripped so the `---`
 * separator region never receives body padding as extra blank lines
 * (R3-001); the join and the renderer's final newline supply the only
 * surrounding blank lines. Deterministic, so equal inputs stay byte-identical.
 */
const renderEntry = ({ rule, reasons }: RenderEntry): string =>
	`## ${rule.description}\n${triggerLine(reasons)}${rule.content.replace(/\s+$/, "")}`;

/** sha-256 hex digest of a full rendered section content. */
const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex");

/**
 * Renders the selected entries, in the given order, into one section.
 * Returns `undefined` iff `entries` is empty — nothing to inject.
 */
export const renderSection = (entries: readonly RenderEntry[]): InjectionBlock | undefined => {
	if (entries.length === 0) {
		return undefined;
	}
	const content = `# Rules\n\n${framing}\n\n${entries.map(renderEntry).join("\n\n---\n\n")}\n`;
	return { sectionId, content, contentHash: sha256(content) };
};
