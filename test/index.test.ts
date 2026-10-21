/**
 * Tests for the extension wiring entry point (index.ts).
 *
 * The real pi runtime is never imported: the extension factory is exercised
 * through the structural `PiExtensionApiLike` subset, implemented here as a
 * typed fake that records every subscription (per event name), every
 * registered command, and lets tests invoke the captured handlers. The
 * pipeline behind the wiring is faked too (injected `ExtensionDeps`), so the
 * tests observe how state folds and how decisions mutate the sections
 * Record — exactly the mutation pi would see on `before_agent_start`.
 */
import { describe, expect, it } from "vitest";
import { createRulesExtension } from "../index.ts";
import type {
	BeforeAgentStartLike,
	ExtensionContextLike,
	ExtensionDeps,
	PiExtensionApiLike,
	RulesCommandContext,
	RulesCommandOptions,
} from "../index.ts";
import type { PiEventShape } from "../shell/collectors.ts";
import type { ReadRuleToolDefinition } from "../shell/read-rule.ts";
import { DEFAULT_BUDGET_TOKENS } from "../shell/pipeline.ts";
import type { DiscoverOptions } from "../shell/pipeline.ts";
import { normalizedPath, ruleId } from "../src/types.ts";
import type { Rule, RuleError } from "../src/types.ts";

/** Fixed clock for every cycle the wiring runs. */
const NOW = new Date("2026-07-14T12:00:00.000Z");

/** Builds a minimal Rule; defaults make it active everywhere with no scan. */
const ruleWith = (fields: {
	readonly id?: string;
	readonly globs?: readonly string[];
	readonly match?: "touched" | "exists" | "both";
	readonly alwaysApply?: boolean;
	readonly content?: string;
	readonly load?: "pinned" | "on-demand";
}): Rule => ({
	load: fields.load ?? "pinned",
	relativePath: normalizedPath(`${fields.id ?? "always-on"}.md`),
	id: ruleId(fields.id ?? "always-on"),
	path: normalizedPath(`/work/.pi/rules/${fields.id ?? "always-on"}.md`),
	source: "project",
	description: `test rule ${fields.id ?? "always-on"}`,
	...(fields.globs === undefined ? {} : { globs: fields.globs }),
	match: fields.match ?? "touched",
	priority: 0,
	enforcement: "inform",
	alwaysApply: fields.alwaysApply ?? true,
	version: 1,
	content: fields.content ?? `body of ${fields.id ?? "always-on"}\n`,
});

/** Fake handler context: cwd + trust + model id, nothing else. */
const handlerCtx = (cwd: string, trusted = true, model?: string): ExtensionContextLike => ({
	cwd,
	isProjectTrusted: () => trusted,
	model: model === undefined ? undefined : { id: model },
});

/** Fake command context recording every ui.notify call. */
const commandCtx = (): { readonly ctx: RulesCommandContext; readonly notifications: string[] } => {
	const notifications: string[] = [];
	const ctx: RulesCommandContext = {
		ui: {
			notify: (message) => {
				notifications.push(message);
			},
		},
	};
	return { ctx, notifications };
};

/** Pre-execution event fixture carrying a built-in tool's path arg. */
const toolExecutionStart = (toolName: string, path: string): PiEventShape => ({
	type: "tool_execution_start",
	toolCallId: "call-1",
	toolName,
	args: { path },
} as PiEventShape);

/** Faked ExtensionDeps: discover yields the given rules/errors, scan nothing. */
const depsWith = (opts: { readonly rules: readonly Rule[]; readonly errors?: readonly RuleError[]; readonly budget?: number }): {
	readonly deps: ExtensionDeps;
	readonly discoverCalls: DiscoverOptions[];
} => {
	const discoverCalls: DiscoverOptions[] = [];
	const deps: ExtensionDeps = {
		pipeline: {
			discover: async (discoverOpts) => {
				discoverCalls.push(discoverOpts);
				return { rules: opts.rules, errors: opts.errors ?? [] };
			},
			scan: async () => [],
			budget: opts.budget ?? DEFAULT_BUDGET_TOKENS,
		},
		now: () => NOW,
	};
	return { deps, discoverCalls };
};

/** Typed fake pi api: records subscriptions per event name plus commands. */
const fakeApi = (): {
	readonly api: PiExtensionApiLike;
	readonly signals: Map<string, Array<(event: PiEventShape, ctx: ExtensionContextLike) => unknown>>;
	readonly starts: Array<(event: BeforeAgentStartLike, ctx: ExtensionContextLike) => unknown>;
	readonly commands: Map<string, RulesCommandOptions>;
	readonly tools: Map<string, ReadRuleToolDefinition>;
} => {
	const signals = new Map<string, Array<(event: PiEventShape, ctx: ExtensionContextLike) => unknown>>();
	const starts: Array<(event: BeforeAgentStartLike, ctx: ExtensionContextLike) => unknown> = [];
	const commands = new Map<string, RulesCommandOptions>();
	const tools = new Map<string, ReadRuleToolDefinition>();
	const api = {
		on(event: string, handler: (event: PiEventShape | BeforeAgentStartLike, ctx: ExtensionContextLike) => unknown): unknown {
			if (event === "before_agent_start") {
				starts.push(handler as (event: BeforeAgentStartLike, ctx: ExtensionContextLike) => unknown);
				return () => undefined;
			}
			const list = signals.get(event) ?? [];
			list.push(handler as (event: PiEventShape, ctx: ExtensionContextLike) => unknown);
			signals.set(event, list);
			return () => undefined;
		},
		registerCommand(name: string, options: RulesCommandOptions): void {
			commands.set(name, options);
		},
		registerTool(tool: ReadRuleToolDefinition): void {
			tools.set(tool.name, tool);
		},
	};
	return { api: api as PiExtensionApiLike, signals, starts, commands, tools };
};

/** Invokes every captured handler for one pi signal event. */
const emitSignal = async (
	api: ReturnType<typeof fakeApi>,
	event: PiEventShape,
	ctx: ExtensionContextLike,
): Promise<void> => {
	for (const handler of api.signals.get(event.type) ?? []) {
		await handler(event, ctx);
	}
};

/** Invokes the before_agent_start handler; reuses a provided sections Record so tests can observe mutation. */
const emitStart = async (
	api: ReturnType<typeof fakeApi>,
	ctx: ExtensionContextLike,
	sections: Record<string, string> = {},
	selectedTools: readonly string[] = ["read", "edit"],
	prompt = "",
): Promise<Record<string, string>> => {
	const event: BeforeAgentStartLike = { type: "before_agent_start", prompt, systemPromptOptions: { sections, selectedTools } };
	for (const handler of api.starts) {
		await handler(event, ctx);
	}
	return event.systemPromptOptions.sections;
};

/**
 * Invokes the before_agent_start handler for a run started by
 * `pi.sendMessage(..., { triggerTurn: true })`: pi 1.3.0's `BeforeAgentStartEvent`
 * is a union, and only the `user` variant carries a prompt, so a custom run
 * arrives with `messageType: "custom"` and no `prompt` at all.
 */
const emitCustomStart = async (
	api: ReturnType<typeof fakeApi>,
	ctx: ExtensionContextLike,
	sections: Record<string, string> = {},
): Promise<Record<string, string>> => {
	const event: BeforeAgentStartLike = {
		type: "before_agent_start",
		messageType: "custom",
		systemPromptOptions: { sections, selectedTools: ["read", "edit"] },
	};
	for (const handler of api.starts) {
		await handler(event, ctx);
	}
	return event.systemPromptOptions.sections;
};

/** Invokes the /rules command handler and returns the joined notification. */
const invokeRules = async (api: ReturnType<typeof fakeApi>): Promise<string> => {
	const handler = api.commands.get("rules")?.handler;
	const { ctx, notifications } = commandCtx();
	await handler?.("", ctx);
	return notifications.join("\n");
};

describe("createRulesExtension registration", () => {
	it("subscribes exactly the four signal events plus before_agent_start and registers /rules", () => {
		const { deps } = depsWith({ rules: [] });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);

		expect([...api.signals.keys()].sort()).toEqual([
			"session_before_fork",
			"session_before_switch",
			"session_compact",
			"tool_execution_start",
		]);
		for (const handlers of api.signals.values()) {
			expect(handlers).toHaveLength(1);
		}
		expect(api.starts).toHaveLength(1);
		expect(api.commands.get("rules")?.description).toBeTruthy();
		expect(api.commands.get("rules")?.handler).toBeDefined();
	});

	it("registers read_rule with a prompt snippet and retrieves the discovered body", async () => {
		const reference = ruleWith({ id: "python/style", load: "on-demand", content: "Use explicit names." });
		const { deps } = depsWith({ rules: [reference] });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);
		const tool = api.tools.get("read_rule");
		expect(tool?.description).toBe(
			'Fetch the full content of a reference rule by its rules-relative path. Use when a "Reference rules available on demand" index entry is relevant to the current task.',
		);
		expect(tool?.promptSnippet).toBeTruthy();

		await emitStart(api, handlerCtx("/work"));
		const result = await tool?.execute("tool-call", { name: "python/style.md" }, undefined, undefined, {} as never);
		expect(result?.content).toEqual([{ type: "text", text: "Use explicit names." }]);
	});

	it("never throws during registration for the fake api", () => {
		const { deps } = depsWith({ rules: [] });
		const api = fakeApi();
		expect(() => createRulesExtension(deps)(api.api)).not.toThrow();
	});
});

describe("createRulesExtension event folding", () => {
	it("folds pre-execution tool paths into state, visible as a patched section on the next cycle", async () => {
		const rule = ruleWith({ id: "touched-rule", globs: ["src/**/*.ts"], match: "touched", alwaysApply: false });
		const { deps, discoverCalls } = depsWith({ rules: [rule] });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);
		const ctx = handlerCtx("/work", true, "test-model");

		await emitSignal(api, toolExecutionStart("read", "/work/src/a.ts"), ctx);
		const sections: Record<string, string> = {};
		await emitStart(api, ctx, sections);

		expect(sections["pi-rules-md"]).toContain("test rule touched-rule");
		expect(discoverCalls[0]).toEqual({ cwd: normalizedPath("/work"), isProjectTrusted: true });
	});

	it("re-applies the identical set every turn and patches again after a compact", async () => {
		const { deps } = depsWith({ rules: [ruleWith({})] });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);
		const ctx = handlerCtx("/work");

		const sections: Record<string, string> = {};
		await emitStart(api, ctx, sections);
		expect(sections["pi-rules-md"]).toContain("# Rules");
		sections["pi-rules-md"] = "SENTINEL";

		// Unchanged set: still applied — pi rebuilds sections every turn, so the
		// identical re-apply is what keeps the section live (sentinel overwritten).
		await emitStart(api, ctx, sections);
		expect(sections["pi-rules-md"]).toContain("# Rules");

		// Compaction resets the last-injected hash: the same set patches again.
		await emitSignal(api, { type: "session_compact" }, ctx);
		await emitStart(api, ctx, sections);
		expect(sections["pi-rules-md"]).toContain("# Rules");
	});

	it("session_before_switch and session_before_fork reset state: touched paths are forgotten", async () => {
		for (const resetEvent of [{ type: "session_before_switch" }, { type: "session_before_fork" }] as const) {
			const rule = ruleWith({ id: "touched-rule", globs: ["src/**/*.ts"], match: "touched", alwaysApply: false });
			const { deps } = depsWith({ rules: [rule] });
			const api = fakeApi();
			createRulesExtension(deps)(api.api);
			const ctx = handlerCtx("/work");

			await emitSignal(api, toolExecutionStart("read", "/work/src/a.ts"), ctx);
			const sections: Record<string, string> = {};
			await emitStart(api, ctx, sections);
			expect(sections["pi-rules-md"]).toContain("test rule touched-rule");
			sections["pi-rules-md"] = "SENTINEL";

			// After the reset the touched path is gone: the rule deactivates,
			// the decision is `none`, and the sections Record is not touched.
			await emitSignal(api, resetEvent, ctx);
			await emitStart(api, ctx, sections);
			expect(sections["pi-rules-md"]).toBe("SENTINEL");
			expect(await invokeRules(api)).toContain("inactive: touched-rule");
		}
	});
});

describe("createRulesExtension before_agent_start cycle", () => {
	it("threads prompt from the before_agent_start event into evaluation", async () => {
		const { deps } = depsWith({ rules: [ruleWith({ id: "python", globs: ["**/*.py"], alwaysApply: false })] });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);
		const sections = await emitStart(api, handlerCtx("/work"), {}, ["read"], "Please help with Python");
		expect(sections).toHaveProperty("pi-rules-md");
	});
	it("patches sections per applyInjection semantics and stores the last trace for /rules", async () => {
		const rules = [ruleWith({ id: "always-on" }), ruleWith({ id: "never", globs: ["nope/**/*.md"], alwaysApply: false })];
		const { deps, discoverCalls } = depsWith({ rules });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);
		const ctx = handlerCtx("/work", true, "test-model");

		const sections: Record<string, string> = {};
		await emitStart(api, ctx, sections);
		expect(sections["pi-rules-md"]?.startsWith("# Rules")).toBe(true);
		expect(discoverCalls[0]).toEqual({ cwd: normalizedPath("/work"), isProjectTrusted: true });

		const report = await invokeRules(api);
		expect(report).toContain("active: always-on (always active)");
		expect(report).toContain("inactive: never (");
		expect(report).toContain(`injected: section pi-rules-md (hash `);
	});

	it("patches sections for a run started by a custom message, which carries no user prompt", async () => {
		const rule = ruleWith({ id: "touched-rule", globs: ["src/**/*.ts"], match: "touched", alwaysApply: false });
		const { deps } = depsWith({ rules: [rule] });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);
		const ctx = handlerCtx("/work");

		await emitSignal(api, toolExecutionStart("edit", "/work/src/a.ts"), ctx);
		const sections = await emitCustomStart(api, ctx);

		// The cycle still runs on the folded state; the absent prompt simply
		// contributes no intent signals instead of throwing.
		expect(sections["pi-rules-md"]).toContain("test rule touched-rule");
	});

	it("re-applies an unchanged set with identical content so the section stays live", async () => {
		const { deps } = depsWith({ rules: [ruleWith({})] });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);
		const ctx = handlerCtx("/work");

		const sections: Record<string, string> = {};
		await emitStart(api, ctx, sections);
		const firstContent: string = sections["pi-rules-md"] ?? "";
		expect(firstContent).toContain("# Rules");

		// Turn 2, same set: the section is re-written with identical content
		// (pi's diff then emits nothing), not skipped and not dropped.
		await emitStart(api, ctx, sections);
		expect(sections["pi-rules-md"]).toBe(firstContent);
	});
});

describe("/rules command", () => {
	it("reports No evaluation yet before the first cycle", async () => {
		const { deps } = depsWith({ rules: [] });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);
		expect(await invokeRules(api)).toBe("No evaluation yet.");
	});

	it("renders dropped rules and discovery parse errors from the last cycle", async () => {
		const error: RuleError = { code: "unknown-key", message: "unknown key: owners", file: "/work/.pi/rules/bad.md" };
		const rules = [ruleWith({ id: "big", content: "x".repeat(40) }), ruleWith({ id: "over", content: "y".repeat(40) })];
		const { deps } = depsWith({ rules, errors: [error], budget: 15 });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);
		await emitStart(api, handlerCtx("/work"));

		const report = await invokeRules(api);
		expect(report).toContain("active: big (always active)");
		expect(report).toContain("dropped: over (budget)");
		expect(report).toContain("parse error: /work/.pi/rules/bad.md (unknown-key): unknown key: owners");
	});
});
