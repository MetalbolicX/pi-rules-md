import { isAbsolute, win32 } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Rule } from "../src/types.ts";

const readRuleParameters = Type.Object({ name: Type.String() });

/**
 * The Pi SDK tool shape, with the prompt snippet required for discovery.
 * Its execute contract mirrors the installed SDK declaration at
 * `node_modules/.store/@earendil-works+pi-coding-agent@0.87.1_ws@8.21.3/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:345-373`:
 * `(toolCallId: string, params: Static<TParams>, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<TDetails> | undefined, ctx: ExtensionContext) => Promise<AgentToolResult<TDetails>>`.
 */
export type ReadRuleToolDefinition = ToolDefinition<typeof readRuleParameters, undefined> & {
	readonly promptSnippet: string;
};

const unknownRule = (name: string): string => `Unknown rule: ${name}`;

/** Exact rules-relative lookup; path guards keep the public contract stable. */
export const readRuleContent = (name: string, rules: readonly Rule[]): string => {
	if (isAbsolute(name) || win32.isAbsolute(name) || name.split(/[\\/]/).includes("..")) {
		return unknownRule(name);
	}
	// No containment re-check or file read: discovery owns path safety (W2 skips symlinks and out-of-root entries).
	const rule = rules.find((candidate) => candidate.relativePath === name);
	return rule?.content ?? unknownRule(name);
};

const description =
	'Fetch the full content of a reference rule by its rules-relative path. Use when a "Reference rules available on demand" index entry is relevant to the current task.';

/** Build a total read_rule tool over the latest discovered Rule.content bodies. */
export const createReadRuleTool = (getRules: () => readonly Rule[]): ReadRuleToolDefinition => ({
	name: "read_rule",
	label: "Read rule",
	description,
	promptSnippet: 'Fetch a full reference rule by its rules-relative path from the "Reference rules available on demand" index.',
	parameters: readRuleParameters,
	execute: async (_toolCallId, params) => {
		let name = "";
		try {
			name = typeof params?.name === "string" ? params.name : "";
			return { content: [{ type: "text", text: readRuleContent(name, getRules()) }], details: undefined };
		} catch {
			return { content: [{ type: "text", text: unknownRule(name) }], details: undefined };
		}
	},
});
