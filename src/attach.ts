/**
 * Mid-run attachment core (S9, pure half): what to attach, how much budget is
 * left, and how one batch renders.
 *
 * The extension normally delivers rules through the `pi-rules-md` system-prompt
 * section rebuilt at `before_agent_start`. A rule that only becomes active
 * because of a tool result (`read`/`edit`/`write` touching new paths) would
 * otherwise wait for the next turn. These three functions are the pure core of
 * delivering it immediately; the `tool_result` handler, the delivered-set
 * state, and the `PI_RULES_ATTACH` toggle belong to the shell (T10).
 *
 * Contract:
 * - `newlyActivated(trace, delivered)` — the matched rules of `trace` whose id
 *   is not in `delivered`, as section-renderer entries (rule + reasons), in
 *   selection order: pinned `active` first, then `onDemand`, exactly like the
 *   section composes them. A rule in the delivered set is NEVER re-attached:
 *   the caller seeds `delivered` with the ids of the current section's actives
 *   plus every id attached by an earlier batch, so the section's rules and the
 *   attached rules are excluded. Budget-dropped rules are not candidates (the
 *   section budget already refused them) and muted rules cannot appear at all
 *   (mute is decided in matching, before selection).
 * - `remainingBudget(trace, budget)` — `budget` minus the estimated tokens of
 *   the pinned bodies already in the section (`trace.selection.active`). It is
 *   plain arithmetic and may be zero or negative when the section itself
 *   overran the budget; nothing fits then. On-demand index lines never consume
 *   budget, so no on-demand rule is subtracted here.
 * - `renderAttachments(batch, remaining)` — one self-contained markdown block
 *   for the batch, plus the ids this batch counts as delivered. Pinned rules
 *   whose estimated tokens fit the running remaining budget emit their full
 *   body, rendered through the section renderer's own entry shape so the two
 *   can never drift; a rule that does not fit degrades to the same one-line
 *   `<relativePath> — <description>` reference the on-demand index uses. A
 *   reference line is still delivery (re-sending a pointer is useless), and it
 *   charges no budget, so a later small rule can still fit. A rule without a
 *   `relativePath` has nothing honest to render: it is skipped and NOT counted
 *   as delivered (the wiring fix that enriches discovered rules with
 *   `relativePath` belongs to T10). An on-demand rule emits only its reference
 *   line, never its body.
 *
 * Byte stability: equal inputs produce byte-identical output. The block starts
 * with `\n\n---\n\n` so it is clearly separate from the tool output it is
 * appended to, and ends with exactly one newline. An empty batch — or a batch
 * in which nothing could be honestly rendered — produces `undefined` rather
 * than an empty block, so the shell appends nothing at all.
 *
 * All functions are pure and total: no I/O, no module state, no throws.
 */
import type { RenderEntry } from "./render.ts";
import { renderSection } from "./render.ts";
import { estimateTokens } from "./select.ts";
import type { EvaluationTrace, MatchReason, Rule, RuleId } from "./types.ts";

/**
 * One attachment batch's output: the appendable markdown block and the rule
 * ids this batch delivered. `delivered` grows the shell's delivered set, so
 * those ids are never attached again in the session.
 */
export interface Attachment {
	/** Self-contained markdown block, separated from the tool output it follows. */
	readonly content: string;
	/** Ids this batch delivered, in render order. */
	readonly delivered: readonly RuleId[];
}

/** Heading line that opens every attachment block. */
const attachmentHeading = "## Rules newly activated by this tool result";

/**
 * Separator between the tool output and the block, and between block parts:
 * a blank line, a horizontal rule, and a blank line. The block therefore
 * renders as its own section no matter how the tool output ends.
 */
const separator = "\n\n---\n\n";

/**
 * Trigger reasons per rule id, first matched result wins. A rule that reached
 * the selection always has one; an absent entry degrades to "no reasons" so
 * the renderer stays total.
 */
const reasonsById = (trace: EvaluationTrace): ReadonlyMap<RuleId, readonly MatchReason[]> => {
	const map = new Map<RuleId, readonly MatchReason[]>();
	for (const result of trace.results) {
		if (result.matched && !map.has(result.ruleId)) {
			map.set(result.ruleId, result.reasons);
		}
	}
	return map;
};

/**
 * The matched rules of `trace` that are not in `delivered`, as section entries
 * in selection order (pinned `active`, then `onDemand`). Candidates come from
 * the selection only, so dropped and muted rules can never appear.
 */
export const newlyActivated = (
	trace: EvaluationTrace,
	delivered: ReadonlySet<RuleId>,
): readonly RenderEntry[] => {
	const reasons = reasonsById(trace);
	return [...trace.selection.active, ...trace.selection.onDemand]
		.filter((rule) => !delivered.has(rule.id))
		.map((rule) => ({ rule, reasons: reasons.get(rule.id) ?? [] }));
};

/**
 * Attachment budget left after the pinned bodies already in the section:
 * `budget` minus `estimateTokens` over `trace.selection.active`. Deliberately
 * plain arithmetic — a section that overran its budget leaves zero or negative
 * room, and then every pinned attachment degrades to a reference line.
 * On-demand index lines consume no budget, so `onDemand` is not subtracted.
 */
export const remainingBudget = (trace: EvaluationTrace, budget: number): number =>
	budget - trace.selection.active.reduce((sum, rule) => sum + estimateTokens(rule), 0);

/**
 * One pinned entry's text, rendered through the exported section renderer so
 * the attachment body can never drift from the section's entry shape (heading,
 * optional trigger line, optional level line, body verbatim with trailing
 * whitespace stripped). `renderSection` wraps one entry as
 * `# Rules\n\n<framing>\n\n<entry>\n`; the fixed framing paragraph contains no
 * `## `, so the first occurrence of `## ` starts the entry itself.
 *
 * The two empty-string branches are unreachable for a non-empty entry list —
 * kept so the function stays total rather than throwing inside a tool result.
 */
const renderPinnedEntry = (entry: RenderEntry): string => {
	const block = renderSection([entry]);
	if (block === undefined) {
		return "";
	}
	const start = block.content.indexOf("## ");
	return start === -1 ? "" : block.content.slice(start, -1);
};

/**
 * The one-line reference for a rule: the on-demand index format. `undefined`
 * when the rule has no `relativePath`, because a reference without a path is
 * not fetchable with `read_rule` — see the module notes on honesty.
 */
const referenceLine = (rule: Rule): string | undefined =>
	rule.relativePath === undefined
		? undefined
		: `- ${rule.relativePath} — ${rule.description} (fetch with the read_rule tool)`;

/**
 * Renders one attachment batch (in the given order) against the remaining
 * budget. Pinned rules emit their body while `estimateTokens(rule)` fits the
 * running remaining budget and decrement it; otherwise they degrade to a
 * reference line, which is delivered but charges no budget. On-demand rules
 * emit their reference line and never charge budget. Returns `undefined` when
 * the batch is empty or nothing in it could be honestly rendered.
 */
export const renderAttachments = (
	batch: readonly RenderEntry[],
	remaining: number,
): Attachment | undefined => {
	const parts: string[] = [];
	const delivered: RuleId[] = [];
	let budget = remaining;
	for (const entry of batch) {
		const { rule } = entry;
		const fits = rule.load !== "on-demand" && estimateTokens(rule) <= budget;
		if (fits) {
			const body = renderPinnedEntry(entry);
			if (body.length === 0) {
				continue;
			}
			parts.push(body);
			delivered.push(rule.id);
			budget -= estimateTokens(rule);
			continue;
		}
		const line = referenceLine(rule);
		if (line === undefined) {
			continue;
		}
		parts.push(line);
		delivered.push(rule.id);
	}
	if (parts.length === 0) {
		return undefined;
	}
	const content = `${separator}${attachmentHeading}\n\n${parts.join(separator)}\n`;
	return { content, delivered };
};
