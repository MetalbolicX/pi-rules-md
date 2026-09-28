/**
 * pi-rules-md — conditional markdown rules injected into the pi system prompt.
 *
 * Composition root (imperative shell): pi events fold into session state and
 * one injection cycle runs per turn. Load safety: pi load errors are FATAL in
 * non-interactive mode, so registration never throws and the cycle is
 * designed-total (no defensive try/catch). NO runtime import of pi: every pi
 * surface is a local structural mirror (verified against pi 0.87.1), so typed
 * fakes drive `createRulesExtension` and add-only upgrades stay assignable.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { piEventToStateEvents } from "./shell/collectors.ts";
import type { PiEventShape } from "./shell/collectors.ts";
import { discover as discoverRules, nodeDiscoveryDeps, tinyglobbyScanner } from "./shell/discovery.ts";
import type { DiscoveryCacheEntry, DiscoveryDeps } from "./shell/discovery.ts";
import { applyInjection, removeInjection } from "./shell/injection.ts";
import { createReadRuleTool } from "./shell/read-rule.ts";
import type { ReadRuleToolDefinition } from "./shell/read-rule.ts";
import { DEFAULT_BUDGET_TOKENS, renderTraceReport, runInjectionCycle } from "./shell/pipeline.ts";
import type { PipelineDeps } from "./shell/pipeline.ts";
import { initialState, transition } from "./src/state.ts";
import type { SessionState } from "./src/state.ts";
import { normalizedPath } from "./src/types.ts";
import type { EvaluationTrace, NormalizedPath, Rule, RuleError } from "./src/types.ts";

/** Handler context fields the wiring consumes (mirror of pi ExtensionContext). */
export interface ExtensionContextLike {
	readonly cwd: string;
	readonly isProjectTrusted: () => boolean;
	/** Mirror of pi's `Model` — only the id is consumed. */
	readonly model: { readonly id: string } | undefined;
}

/** Mirror of pi `BeforeAgentStartEvent` limited to the wiring's mutation surface. */
export interface BeforeAgentStartLike {
	readonly type: "before_agent_start";
	readonly prompt: string;
	readonly systemPromptOptions: {
		readonly sections: Record<string, string>;
		/** Real source for the evaluation context's tool names (normalized options). */
		readonly selectedTools: readonly string[];
	};
}

/** Mirror of the command context surface the /rules handler consumes. */
export interface RulesCommandContext {
	readonly ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
}

/** Mirror of pi `registerCommand` options. */
export interface RulesCommandOptions {
	readonly description?: string;
	readonly handler: (args: string, ctx: RulesCommandContext) => Promise<void>;
}

/** Local structural subset of pi's ExtensionAPI — narrow enough for typed fakes. */
export interface PiExtensionApiLike {
	on(event: "tool_execution_start", handler: (event: PiEventShape, ctx: ExtensionContextLike) => unknown): unknown;
	on(
		event: "session_compact" | "session_before_switch" | "session_before_fork",
		handler: (event: PiEventShape, ctx: ExtensionContextLike) => unknown,
	): unknown;
	on(event: "before_agent_start", handler: (event: BeforeAgentStartLike, ctx: ExtensionContextLike) => unknown): unknown;
	registerCommand(name: string, options: RulesCommandOptions): void;
	/** Structural mirror of the installed Pi registerTool definition. */
	registerTool(tool: ReadRuleToolDefinition): void;
}

/** Injected effects of the extension: pipeline deps (testability seam) plus the clock. */
export interface ExtensionDeps {
	readonly pipeline: PipelineDeps;
	readonly now: () => Date;
}

/**
 * Builds the extension registrar: closures hold the session state, the last
 * evaluation trace and the last discovery parse errors (for /rules). The
 * returned function performs only registrations, so it cannot throw.
 */
export const createRulesExtension = (deps: ExtensionDeps): ((api: PiExtensionApiLike) => void) => {
	let state: SessionState = initialState;
	let lastTrace: EvaluationTrace | undefined;
	let lastErrors: readonly RuleError[] = [];
	let lastDiscoveredRules: readonly Rule[] = [];
	// Discovery seam wrapper: keep the parse errors of the last cycle for /rules.
	const pipeline: PipelineDeps = {
		...deps.pipeline,
		discover: async (opts) => {
			const outcome = await deps.pipeline.discover(opts);
			lastErrors = outcome.errors;
			lastDiscoveredRules = outcome.rules;
			return outcome;
		},
	};

	return (api: PiExtensionApiLike): void => {
		api.registerTool(createReadRuleTool(() => lastDiscoveredRules));

		// Signal events fold into state through the collector + reducer.
		const foldSignal = (event: PiEventShape, ctx: ExtensionContextLike): void => {
			for (const stateEvent of piEventToStateEvents(event, { cwd: ctx.cwd })) {
				state = transition(state, stateEvent);
			}
		};
		api.on("tool_execution_start", foldSignal);
		api.on("session_compact", foldSignal);
		api.on("session_before_switch", foldSignal);
		api.on("session_before_fork", foldSignal);

		api.on("before_agent_start", async (event, ctx) => {
			const result = await runInjectionCycle({
				state,
				cwd: ctx.cwd,
				prompt: event.prompt,
				now: deps.now(),
				trusted: ctx.isProjectTrusted(),
				session: {
					toolNames: event.systemPromptOptions.selectedTools,
					model: ctx.model?.id,
					branch: undefined, // v1 gap: pi exposes no git branch on the handler context.
				},
				deps: pipeline,
			});
			state = result.nextState;
			lastTrace = result.trace;
			// The only pi mutation this extension performs (sections, never systemPrompt).
			if (result.decision.action === "patch" && result.block !== undefined) {
				applyInjection(event.systemPromptOptions.sections, result.block);
			} else if (result.decision.action === "remove") {
				removeInjection(event.systemPromptOptions.sections);
			}
		});

		api.registerCommand("rules", {
			description: "Show why each pi-rules-md rule is active or inactive",
			handler: async (_args, ctx) => {
				ctx.ui.notify(renderTraceReport(lastTrace, lastErrors).join("\n"), "info");
			},
		});
	};
};

/** The real extension factory: production discovery, scanner, budget, clock. */
export default function piRulesMd(pi: ExtensionAPI): void {
	const discoveryDeps: DiscoveryDeps = nodeDiscoveryDeps();
	const cache: Map<NormalizedPath, DiscoveryCacheEntry> = new Map();
	const deps: ExtensionDeps = {
		pipeline: {
			discover: async (opts) => {
				// Adjudicated dirs (parent-pinned, T13): global `~/.pi/agent/rules`, project `<cwd>/.pi/rules`.
				const result = await discoverRules(discoveryDeps, cache, {
					globalDir: join(homedir(), ".pi", "agent", "rules"),
					projectDir: join(opts.cwd, ".pi", "rules"),
					isProjectTrusted: opts.isProjectTrusted,
				});
				return { rules: result.rules, errors: result.errors };
			},
			scan: tinyglobbyScanner,
			budget: DEFAULT_BUDGET_TOKENS,
		},
		now: () => new Date(),
	};
	createRulesExtension(deps)(pi);
}
