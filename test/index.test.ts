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
import type { ExecLike, ExecResultLike } from "../shell/git-branch.ts";
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
	readonly branch?: string;
}): Rule => ({
	load: fields.load ?? "pinned",
	relativePath: normalizedPath(`${fields.id ?? "always-on"}.md`),
	id: ruleId(fields.id ?? "always-on"),
	path: normalizedPath(`/work/.pi/rules/${fields.id ?? "always-on"}.md`),
	source: "project",
	description: `test rule ${fields.id ?? "always-on"}`,
	...(fields.globs === undefined ? {} : { globs: fields.globs }),
	...(fields.branch === undefined ? {} : { branch: fields.branch }),
	match: fields.match ?? "touched",
	priority: 0,
	enforcement: "inform",
	alwaysApply: fields.alwaysApply ?? true,
	version: 1,
	content: fields.content ?? `body of ${fields.id ?? "always-on"}\n`,
});

/** Fake handler context: cwd + trust + model id + ui surface + an empty session branch. */
const handlerCtx = (cwd: string, trusted = true, model?: string): ExtensionContextLike => ({
	cwd,
	isProjectTrusted: () => trusted,
	model: model === undefined ? undefined : { id: model },
	hasUI: false,
	ui: { setStatus: () => undefined },
	sessionManager: { getBranch: () => [] },
});

/** A session custom entry as `pi` returns it on the branch for `appendEntry`. */
const touchedEntry = (paths: readonly string[]): { readonly type: "custom"; readonly customType: string; readonly data: unknown } => ({
	type: "custom",
	customType: "pi-rules-md/touched",
	data: { paths },
});

/**
 * Fake session manager: `getBranch` reports whatever branch the test sets last,
 * so a test can model tree navigation between branches.
 */
const fakeSession = (
	initial: readonly unknown[] = [],
): {
	readonly sessionManager: ExtensionContextLike["sessionManager"];
	readonly setBranch: (next: readonly unknown[]) => void;
	readonly branchCalls: () => number;
} => {
	let branch = initial;
	let calls = 0;
	return {
		sessionManager: {
			getBranch: () => {
				calls += 1;
				return branch;
			},
		},
		setBranch: (next) => {
			branch = next;
		},
		branchCalls: () => calls,
	};
};

/** Fake handler context carrying an explicit session branch. */
const ctxWithSession = (sessionManager: ExtensionContextLike["sessionManager"], cwd = "/work"): ExtensionContextLike => ({
	...handlerCtx(cwd),
	sessionManager,
});

/** Fake handler context that records every ui.setStatus call, with hasUI switchable. */
const ctxWithStatus = (
	cwd: string,
	hasUI: boolean,
): { readonly ctx: ExtensionContextLike; readonly statuses: Array<readonly [string, string | undefined]> } => {
	const statuses: Array<readonly [string, string | undefined]> = [];
	const ctx: ExtensionContextLike = {
		cwd,
		isProjectTrusted: () => true,
		model: undefined,
		hasUI,
		ui: { setStatus: (key, text) => { statuses.push([key, text]); } },
		sessionManager: { getBranch: () => [] },
	};
	return { ctx, statuses };
};

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

/** One recorded fake exec invocation. */
interface ExecCall {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string | undefined;
}

/**
 * Fake pi `exec`: records every call and answers with one fixed result, or
 * rejects with `answer` when it is an Error. Default answers code 128 with no
 * output ("not a git repository"), so a test that does not care about the
 * branch sees it absent.
 */
const fakeExec = (answer: ExecResultLike | Error = { stdout: "", code: 128 }): {
	readonly exec: ExecLike;
	readonly calls: ExecCall[];
} => {
	const calls: ExecCall[] = [];
	const exec: ExecLike = async (command, args, options) => {
		calls.push({ command, args: [...args], cwd: options?.cwd });
		if (answer instanceof Error) {
			throw answer;
		}
		return answer;
	};
	return { exec, calls };
};

/** One recorded fake `appendEntry` call (session persistence surface). */
interface AppendedEntry {
	readonly customType: string;
	readonly data: unknown;
}

/** Typed fake pi api: records subscriptions per event name plus commands and session entries. */
const fakeApi = (exec: ExecLike = fakeExec().exec): {
	readonly api: PiExtensionApiLike;
	readonly signals: Map<string, Array<(event: PiEventShape, ctx: ExtensionContextLike) => unknown>>;
	readonly starts: Array<(event: BeforeAgentStartLike, ctx: ExtensionContextLike) => unknown>;
	readonly commands: Map<string, RulesCommandOptions>;
	readonly tools: Map<string, ReadRuleToolDefinition>;
	readonly entries: AppendedEntry[];
} => {
	const signals = new Map<string, Array<(event: PiEventShape, ctx: ExtensionContextLike) => unknown>>();
	const starts: Array<(event: BeforeAgentStartLike, ctx: ExtensionContextLike) => unknown> = [];
	const commands = new Map<string, RulesCommandOptions>();
	const tools = new Map<string, ReadRuleToolDefinition>();
	const entries: AppendedEntry[] = [];
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
		exec,
		appendEntry(customType: string, data?: unknown): void {
			entries.push({ customType, data });
		},
		registerCommand(name: string, options: RulesCommandOptions): void {
			commands.set(name, options);
		},
		registerTool(tool: ReadRuleToolDefinition): void {
			tools.set(tool.name, tool);
		},
	};
	return { api: api as PiExtensionApiLike, signals, starts, commands, tools, entries };
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

/** Invokes the /rules command handler with optional args and returns the joined notification. */
const invokeRules = async (api: ReturnType<typeof fakeApi>, args = ""): Promise<string> => {
	const handler = api.commands.get("rules")?.handler;
	const { ctx, notifications } = commandCtx();
	await handler?.(args, ctx);
	return notifications.join("\n");
};

describe("createRulesExtension registration", () => {
	it("subscribes exactly the six signal events plus before_agent_start and registers /rules", () => {
		const { deps } = depsWith({ rules: [] });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);

		expect([...api.signals.keys()].sort()).toEqual([
			"session_before_fork",
			"session_before_switch",
			"session_compact",
			"session_start",
			"session_tree",
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

describe("/rules subcommands", () => {
	it("shows a discovered rule with its metadata and verbatim body", async () => {
		const rule = ruleWith({ id: "ts-rule", globs: ["src/**/*.ts"], alwaysApply: false });
		const { deps } = depsWith({ rules: [rule] });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);
		await emitStart(api, handlerCtx("/work"));

		const out = await invokeRules(api, "show ts-rule");
		expect(out).toContain("ts-rule");
		expect(out).toContain("path: /work/.pi/rules/ts-rule.md");
		expect(out).toContain("source: project");
		expect(out).toContain("configured: files matching: src/**/*.ts");
		expect(out).toContain("load: pinned");
		expect(out).toContain("enforcement: inform");
		expect(out).toContain("body of ts-rule");
	});

	it("answers Unknown rule for an id that is not discovered", async () => {
		const { deps } = depsWith({ rules: [] });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);
		await emitStart(api, handlerCtx("/work"));
		expect(await invokeRules(api, "show nope")).toBe("Unknown rule: nope");
	});

	it("explains why a path would activate rules without changing session state", async () => {
		const rule = ruleWith({ id: "ts-rule", globs: ["src/**/*.ts"], alwaysApply: false });
		const { deps } = depsWith({ rules: [rule] });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);
		const ctx = handlerCtx("/work");
		await emitSignal(api, toolExecutionStart("read", "/work/src/a.ts"), ctx);
		const before: Record<string, string> = {};
		await emitStart(api, ctx, before);

		const out = await invokeRules(api, "why src/a.ts");
		expect(out).toContain("ts-rule: would activate — glob `src/**/*.ts`");

		// Read-only: the next cycle renders the identical section as before.
		const after: Record<string, string> = {};
		await emitStart(api, ctx, after);
		expect(after["pi-rules-md"]).toBe(before["pi-rules-md"]);
	});

	it("explains a muted rule as excluded in why output", async () => {
		const rule = ruleWith({ id: "ts-rule", globs: ["src/**/*.ts"], alwaysApply: false });
		const { deps } = depsWith({ rules: [rule] });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);
		const ctx = handlerCtx("/work");
		await emitSignal(api, toolExecutionStart("read", "/work/src/a.ts"), ctx);
		await emitStart(api, ctx);

		expect(await invokeRules(api, "mute ts-rule")).toContain("muted: ts-rule");
		const out = await invokeRules(api, "why src/a.ts");
		expect(out).toContain("ts-rule: muted for this session (excluded from activation)");
		expect(out).not.toContain("would activate");
	});

	it("prints a usage line for unknown subcommands and malformed arguments", async () => {
		const { deps } = depsWith({ rules: [] });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);
		for (const args of ["frobnicate", "show", "why"]) {
			const out = await invokeRules(api, args);
			expect(out).toContain("usage:");
			expect(out).toContain("show");
			expect(out).toContain("why");
		}
	});
});

describe("session mute", () => {
	it("mutes a discovered rule for the session: confirmation, then inactive and removed on the next cycle", async () => {
		const rule = ruleWith({ id: "always-on" });
		const { deps } = depsWith({ rules: [rule] });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);
		const ctx = handlerCtx("/work");

		const sections: Record<string, string> = {};
		await emitStart(api, ctx, sections);
		expect(sections["pi-rules-md"]).toContain("test rule always-on");

		expect(await invokeRules(api, "mute always-on")).toBe("muted: always-on");

		await emitStart(api, ctx, sections);
		expect(sections).not.toHaveProperty("pi-rules-md");
		expect(await invokeRules(api)).toContain("inactive: always-on (muted for this session)");
	});

	it("unmutes: the rule is active again on the next cycle", async () => {
		const rule = ruleWith({ id: "always-on" });
		const { deps } = depsWith({ rules: [rule] });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);
		const ctx = handlerCtx("/work");

		await emitStart(api, ctx);
		await invokeRules(api, "mute always-on");
		await emitStart(api, ctx);
		expect(await invokeRules(api)).toContain("inactive: always-on (muted for this session)");

		expect(await invokeRules(api, "unmute always-on")).toBe("unmuted: always-on");
		const sections: Record<string, string> = {};
		await emitStart(api, ctx, sections);
		expect(sections["pi-rules-md"]).toContain("test rule always-on");
		expect(await invokeRules(api)).toContain("active: always-on (always active)");
	});

	it("keeps a rule muted across re-discovery and across a second mute", async () => {
		const rule = ruleWith({ id: "always-on" });
		const { deps } = depsWith({ rules: [rule] });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);
		const ctx = handlerCtx("/work");

		await emitStart(api, ctx);
		await invokeRules(api, "mute always-on");
		await emitStart(api, ctx);
		expect(await invokeRules(api, "mute always-on")).toBe("muted: always-on");
		await emitStart(api, ctx);
		expect(await invokeRules(api)).toContain("inactive: always-on (muted for this session)");

		await invokeRules(api, "unmute always-on");
		await emitStart(api, ctx);
		expect(await invokeRules(api)).toContain("active: always-on (always active)");
	});

	it("answers Unknown rule for an unknown id and leaves the rule active", async () => {
		const rule = ruleWith({ id: "always-on" });
		const { deps } = depsWith({ rules: [rule] });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);
		const ctx = handlerCtx("/work");

		expect(await invokeRules(api, "mute nope")).toBe("Unknown rule: nope");
		expect(await invokeRules(api, "unmute nope")).toBe("Unknown rule: nope");

		const sections: Record<string, string> = {};
		await emitStart(api, ctx, sections);
		expect(sections["pi-rules-md"]).toContain("test rule always-on");
		expect(await invokeRules(api)).toContain("active: always-on (always active)");
	});

	it("prints a usage line listing show, why, mute and unmute for a malformed mute/unmute", async () => {
		const { deps } = depsWith({ rules: [ruleWith({})] });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);
		await emitStart(api, handlerCtx("/work"));

		for (const args of ["mute", "unmute", "mute always-on extra", "unmute always-on extra"]) {
			const out = await invokeRules(api, args);
			expect(out).toContain("usage:");
			expect(out).toContain("show <id>");
			expect(out).toContain("why <path>");
			expect(out).toContain("mute <id>");
			expect(out).toContain("unmute <id>");
		}
	});

	it("session switch and fork reset mutes with the rest of the session", async () => {
		for (const resetEvent of [{ type: "session_before_switch" }, { type: "session_before_fork" }] as const) {
			const rule = ruleWith({ id: "always-on" });
			const { deps } = depsWith({ rules: [rule] });
			const api = fakeApi();
			createRulesExtension(deps)(api.api);
			const ctx = handlerCtx("/work");

			await emitStart(api, ctx);
			await invokeRules(api, "mute always-on");
			await emitStart(api, ctx);
			expect(await invokeRules(api)).toContain("inactive: always-on (muted for this session)");

			await emitSignal(api, resetEvent, ctx);
			const sections: Record<string, string> = {};
			await emitStart(api, ctx, sections);
			expect(sections["pi-rules-md"]).toContain("test rule always-on");
			expect(await invokeRules(api)).toContain("active: always-on (always active)");
		}
	});

	it("does not touch the /rules report for rules that are not muted", async () => {
		const rules = [ruleWith({ id: "a-rule" }), ruleWith({ id: "b-rule" })];
		const { deps } = depsWith({ rules });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);
		const ctx = handlerCtx("/work");

		await emitStart(api, ctx);
		await invokeRules(api, "mute a-rule");
		await emitStart(api, ctx);
		const report = await invokeRules(api);
		const lines = report.split("\n");
		expect(lines).toContain("inactive: a-rule (muted for this session)");
		expect(lines).toContain("active: b-rule (always active)");
		expect(lines).not.toContain("active: a-rule (always active)");
		expect(lines.some((line) => line.startsWith("dropped: a-rule"))).toBe(false);
		// A mute is a session action, not a condition outcome: no `configured:` noise.
		expect(report).not.toContain("configured:");
	});
});

describe("status bar", () => {
	it("sets the pi-rules-md status line after a cycle when UI is available", async () => {
		const { deps } = depsWith({ rules: [ruleWith({})] });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);
		const { ctx, statuses } = ctxWithStatus("/work", true);

		await emitStart(api, ctx);

		expect(statuses).toHaveLength(1);
		const [key, text] = statuses[0] ?? ["", ""];
		expect(key).toBe("pi-rules-md");
		expect(text).toMatch(/^rules: 1 · ~\d+ tok$/);
	});

	it("clears the status when a later cycle has nothing active", async () => {
		const rule = ruleWith({ id: "touched-rule", globs: ["src/**/*.ts"], match: "touched", alwaysApply: false });
		const { deps } = depsWith({ rules: [rule] });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);
		const { ctx, statuses } = ctxWithStatus("/work", true);

		await emitSignal(api, toolExecutionStart("read", "/work/src/a.ts"), ctx);
		await emitStart(api, ctx);
		expect(statuses.at(-1)?.[1]).toMatch(/^rules: 1 · ~\d+ tok$/);

		// Switch resets touched paths: nothing active on the next cycle, so the
		// status key is explicitly cleared with undefined.
		await emitSignal(api, { type: "session_before_switch" }, ctx);
		await emitStart(api, ctx);
		expect(statuses.at(-1)).toEqual(["pi-rules-md", undefined]);
	});

	it("never touches the status bar when hasUI is false", async () => {
		const { deps } = depsWith({ rules: [ruleWith({})] });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);
		const { ctx, statuses } = ctxWithStatus("/work", false);

		await emitStart(api, ctx);

		expect(statuses).toHaveLength(0);
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
		// The report carries the resolved budget: used pinned tokens over the budget,
		// plus the whole-section estimate line while a block exists.
		expect(report).toContain("budget: 10/15 estimated tokens");
		expect(report).toContain("section: ~");
		expect(report).toContain(" tokens");
	});
});

describe("createRulesExtension branch resolution", () => {
	/** The pinned argv: one ref query per before_agent_start. */
	const BRANCH_ARGS = ["rev-parse", "--abbrev-ref", "HEAD"];

	it("resolves the session branch from git once per cycle and activates a branch rule", async () => {
		const rule = ruleWith({ id: "on-main", globs: ["src/**/*.ts"], match: "touched", alwaysApply: false, branch: "main" });
		const { deps } = depsWith({ rules: [rule] });
		const git = fakeExec({ stdout: "main\n", code: 0 });
		const api = fakeApi(git.exec);
		createRulesExtension(deps)(api.api);
		const ctx = handlerCtx("/work");

		await emitSignal(api, toolExecutionStart("edit", "/work/src/a.ts"), ctx);
		const sections = await emitStart(api, ctx);

		expect(sections["pi-rules-md"]).toContain("test rule on-main");
		expect(git.calls).toEqual([{ command: "git", args: BRANCH_ARGS, cwd: "/work" }]);
		expect(await invokeRules(api)).toContain("active: on-main (glob `src/**/*.ts` · branch `main`)");
	});

	it("treats a detached HEAD as an absent branch and still completes the cycle", async () => {
		const rules = [
			ruleWith({ id: "always-on" }),
			ruleWith({ id: "on-main", globs: ["src/**/*.ts"], match: "touched", alwaysApply: false, branch: "main" }),
		];
		const { deps } = depsWith({ rules });
		const git = fakeExec({ stdout: "HEAD\n", code: 0 });
		const api = fakeApi(git.exec);
		createRulesExtension(deps)(api.api);
		const ctx = handlerCtx("/work");

		await emitSignal(api, toolExecutionStart("edit", "/work/src/a.ts"), ctx);
		const sections = await emitStart(api, ctx);

		expect(sections["pi-rules-md"]).toContain("test rule always-on");
		expect(await invokeRules(api)).toContain(
			"inactive: on-main (branch mismatch: session branch absent does not match the rule's branch pattern main)",
		);
	});

	it("completes the cycle with an absent branch when exec rejects", async () => {
		const rules = [
			ruleWith({ id: "always-on" }),
			ruleWith({ id: "on-main", globs: ["src/**/*.ts"], match: "touched", alwaysApply: false, branch: "main" }),
		];
		const { deps } = depsWith({ rules });
		const git = fakeExec(new Error("spawn git ENOENT"));
		const api = fakeApi(git.exec);
		createRulesExtension(deps)(api.api);
		const ctx = handlerCtx("/work");

		await emitSignal(api, toolExecutionStart("edit", "/work/src/a.ts"), ctx);
		const sections = await emitStart(api, ctx);

		expect(sections["pi-rules-md"]).toContain("test rule always-on");
		expect(await invokeRules(api)).toContain("inactive: on-main (branch mismatch: session branch absent");
	});

	it("queries git at most once per before_agent_start", async () => {
		const { deps } = depsWith({ rules: [ruleWith({})] });
		const git = fakeExec({ stdout: "main\n", code: 0 });
		const api = fakeApi(git.exec);
		createRulesExtension(deps)(api.api);
		const ctx = handlerCtx("/work");

		await emitStart(api, ctx);
		await emitStart(api, ctx);

		expect(git.calls).toEqual([
			{ command: "git", args: BRANCH_ARGS, cwd: "/work" },
			{ command: "git", args: BRANCH_ARGS, cwd: "/work" },
		]);
	});
});

describe("session persistence (S7)", () => {
	it("appends a custom session entry for each newly touched path batch", async () => {
		const { deps } = depsWith({ rules: [] });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);
		const ctx = handlerCtx("/work");

		await emitSignal(api, toolExecutionStart("read", "/work/src/a.ts"), ctx);
		await emitSignal(api, toolExecutionStart("edit", "/work/src/b.ts"), ctx);

		expect(api.entries).toEqual([
			{ customType: "pi-rules-md/touched", data: { paths: [normalizedPath("src/a.ts")] } },
			{ customType: "pi-rules-md/touched", data: { paths: [normalizedPath("src/b.ts")] } },
		]);
	});

	it("appends nothing when the touched path is already in the session set", async () => {
		const { deps } = depsWith({ rules: [] });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);
		const ctx = handlerCtx("/work");

		for (const toolName of ["read", "edit", "write"]) {
			await emitSignal(api, toolExecutionStart(toolName, "/work/src/a.ts"), ctx);
		}

		expect(api.entries).toEqual([{ customType: "pi-rules-md/touched", data: { paths: [normalizedPath("src/a.ts")] } }]);
	});

	it("appends nothing for lifecycle events and tools that touch no path", async () => {
		const { deps } = depsWith({ rules: [] });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);
		const ctx = handlerCtx("/work");

		await emitSignal(api, toolExecutionStart("bash", "/work/src/a.ts"), ctx);
		await emitSignal(api, { type: "session_compact" }, ctx);
		await emitSignal(api, { type: "session_before_switch" }, ctx);
		await emitSignal(api, { type: "session_before_fork" }, ctx);

		expect(api.entries).toEqual([]);
	});

	it("restores touched paths from the branch on session_start and never re-writes them", async () => {
		const rules = [
			ruleWith({ id: "a-rule", globs: ["src/a.ts"], match: "touched", alwaysApply: false }),
			ruleWith({ id: "c-rule", globs: ["src/c.ts"], match: "touched", alwaysApply: false }),
		];
		const { deps } = depsWith({ rules });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);
		const session = fakeSession([touchedEntry(["src/a.ts"]), { type: "message" }]);
		const ctx = ctxWithSession(session.sessionManager);

		await emitSignal(api, { type: "session_start" }, ctx);

		const sections: Record<string, string> = {};
		await emitStart(api, ctx, sections);
		expect(sections["pi-rules-md"]).toContain("test rule a-rule");
		expect(sections["pi-rules-md"]).not.toContain("test rule c-rule");
		expect(await invokeRules(api)).toContain("inactive: c-rule");
		expect(session.branchCalls()).toBe(1);
		// Rebuild restores state; it is not a new touch batch, so it writes nothing.
		expect(api.entries).toEqual([]);

		// A restored path is already known: touching it again appends nothing,
		// while a genuinely new path appends exactly that path.
		await emitSignal(api, toolExecutionStart("read", "/work/src/a.ts"), ctx);
		expect(api.entries).toEqual([]);
		await emitSignal(api, toolExecutionStart("read", "/work/src/c.ts"), ctx);
		expect(api.entries).toEqual([{ customType: "pi-rules-md/touched", data: { paths: [normalizedPath("src/c.ts")] } }]);
	});

	it("rebuilds on every session_start reason", async () => {
		for (const reason of ["startup", "reload", "new", "resume", "fork"] as const) {
			const rule = ruleWith({ id: "touched-rule", globs: ["src/**/*.ts"], match: "touched", alwaysApply: false });
			const { deps } = depsWith({ rules: [rule] });
			const api = fakeApi();
			createRulesExtension(deps)(api.api);
			const session = fakeSession([touchedEntry(["src/a.ts"])]);
			const ctx = ctxWithSession(session.sessionManager);

			await emitSignal(api, { type: "session_start", reason }, ctx);
			const sections: Record<string, string> = {};
			await emitStart(api, ctx, sections);
			expect(sections["pi-rules-md"]).toContain("test rule touched-rule");
		}
	});

	it("empties the touched set when session_start lands on an entry-free branch", async () => {
		const rule = ruleWith({ id: "touched-rule", globs: ["src/**/*.ts"], match: "touched", alwaysApply: false });
		const { deps } = depsWith({ rules: [rule] });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);
		const session = fakeSession([]);
		const ctx = ctxWithSession(session.sessionManager);

		await emitSignal(api, toolExecutionStart("read", "/work/src/a.ts"), ctx);
		await emitSignal(api, { type: "session_start" }, ctx);

		const sections: Record<string, string> = {};
		await emitStart(api, ctx, sections);
		expect(sections).not.toHaveProperty("pi-rules-md");
		expect(await invokeRules(api)).toContain("inactive: touched-rule");
	});

	it("drops paths from an abandoned branch on session_tree", async () => {
		const rule = ruleWith({ id: "touched-rule", globs: ["src/**/*.ts"], match: "touched", alwaysApply: false });
		const { deps } = depsWith({ rules: [rule] });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);
		const session = fakeSession([]);
		const ctx = ctxWithSession(session.sessionManager);

		await emitSignal(api, toolExecutionStart("read", "/work/src/a.ts"), ctx);
		const before: Record<string, string> = {};
		await emitStart(api, ctx, before);
		expect(before["pi-rules-md"]).toContain("test rule touched-rule");

		// Navigate to a branch that carries none of this extension's entries.
		session.setBranch([{ type: "message" }]);
		await emitSignal(api, { type: "session_tree", newLeafId: "entry-2", oldLeafId: "entry-1" }, ctx);

		const after: Record<string, string> = {};
		await emitStart(api, ctx, after);
		expect(after).not.toHaveProperty("pi-rules-md");
		expect(await invokeRules(api)).toContain("inactive: touched-rule");
	});

	it("keeps session mutes across a rebuild", async () => {
		const { deps } = depsWith({ rules: [ruleWith({ id: "always-on" })] });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);
		const session = fakeSession([touchedEntry(["src/a.ts"])]);
		const ctx = ctxWithSession(session.sessionManager);

		await emitStart(api, ctx);
		expect(await invokeRules(api, "mute always-on")).toBe("muted: always-on");

		await emitSignal(api, { type: "session_start" }, ctx);
		const sections: Record<string, string> = {};
		await emitStart(api, ctx, sections);
		expect(sections).not.toHaveProperty("pi-rules-md");
		expect(await invokeRules(api)).toContain("inactive: always-on (muted for this session)");
	});

	it("keeps the injected-block hash across a rebuild (the removal path still fires)", async () => {
		const rule = ruleWith({ id: "touched-rule", globs: ["src/**/*.ts"], match: "touched", alwaysApply: false });
		const { deps } = depsWith({ rules: [rule] });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);
		const session = fakeSession([]);
		const ctx = ctxWithSession(session.sessionManager);

		await emitSignal(api, toolExecutionStart("read", "/work/src/a.ts"), ctx);
		const sections: Record<string, string> = {};
		await emitStart(api, ctx, sections);
		expect(sections["pi-rules-md"]).toContain("test rule touched-rule");

		// The rebuild lands on a branch without our entries, so nothing is active.
		// A retained hash makes the decision `remove` (stale section deleted); a
		// cleared hash would decide `none` and leave the stale section in place.
		sections["pi-rules-md"] = "SENTINEL";
		await emitSignal(api, { type: "session_start" }, ctx);
		await emitStart(api, ctx, sections);
		expect(sections).not.toHaveProperty("pi-rules-md");
	});

	it("leaves the folded state untouched when the branch cannot be read, never throwing", async () => {
		const rule = ruleWith({ id: "touched-rule", globs: ["src/**/*.ts"], match: "touched", alwaysApply: false });
		const { deps } = depsWith({ rules: [rule] });
		const api = fakeApi();
		createRulesExtension(deps)(api.api);
		const ctx: ExtensionContextLike = {
			...handlerCtx("/work"),
			sessionManager: {
				getBranch: () => {
					throw new Error("session unreadable");
				},
			},
		};

		await emitSignal(api, toolExecutionStart("read", "/work/src/a.ts"), ctx);
		await expect(emitSignal(api, { type: "session_start" }, ctx)).resolves.toBeUndefined();
		await expect(emitSignal(api, { type: "session_tree" }, ctx)).resolves.toBeUndefined();

		// An unreadable branch is not evidence of an empty one: the touched path survives.
		const sections: Record<string, string> = {};
		await emitStart(api, ctx, sections);
		expect(sections["pi-rules-md"]).toContain("test rule touched-rule");
	});
});
