/**
 * pi-rules-md — conditional markdown rules injected into the pi system prompt.
 *
 * Composition root (imperative shell): pi events fold into session state and
 * one injection cycle runs per turn. Load safety: pi load errors are FATAL in
 * non-interactive mode, so registration never throws and the cycle is
 * designed-total (no defensive try/catch). NO runtime import of pi: every pi
 * surface is a local structural mirror (re-verified against pi 1.3.0,
 * `dist/core/extensions/types.d.ts` + `dist/core/system-prompt.d.ts`), so
 * typed fakes drive `createRulesExtension` and add-only upgrades stay
 * assignable.
 *
 * pi 1.3.0 contract notes that this wiring depends on:
 * - `before_agent_start` is a UNION (`BeforeAgentStartUserEvent` |
 *   `BeforeAgentStartCustomEvent`): only the `user` variant carries `prompt`,
 *   so a custom-message run contributes no intent text.
 * - `systemPromptOptions.sections` is still a mutable `Record<string, string>`
 *   on `NormalizedBuildSystemPromptOptions`, and the SDK documents mutating it
 *   (rather than replacing `systemPrompt`) as the preferred delivery, so the
 *   injection invariant is unchanged.
 * - `ExtensionContext.isProjectTrusted()` still exists; trust gating is
 *   unchanged.
 * - `exec(command, args, options)` is still on `ExtensionAPI`, resolving to
 *   `{ stdout, stderr, code, killed }` (`dist/core/exec.d.ts`). The branch seam
 *   consumes only `stdout` and `code`, and resolves the session branch once per
 *   `before_agent_start`; every git failure degrades to "no branch".
 */
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { piEventToStateEvents } from "./shell/collectors.ts";
import type { PiEventShape } from "./shell/collectors.ts";
import { discover as discoverRules, nodeDiscoveryDeps, tinyglobbyScanner } from "./shell/discovery.ts";
import type { DiscoveryCacheEntry, DiscoveryDeps } from "./shell/discovery.ts";
import { applyInjection, removeInjection } from "./shell/injection.ts";
import { resolveBranch } from "./shell/git-branch.ts";
import type { ExecLike } from "./shell/git-branch.ts";
import { createReadRuleTool } from "./shell/read-rule.ts";
import type { ReadRuleToolDefinition } from "./shell/read-rule.ts";
import { DEFAULT_BUDGET_TOKENS, renderTraceReport, runInjectionCycle } from "./shell/pipeline.ts";
import { globalRulesDir, projectRulesDir, resolveBudget } from "./shell/rules-paths.ts";
import type { PipelineDeps } from "./shell/pipeline.ts";
import { initialState, transition } from "./src/state.ts";
import type { SessionState } from "./src/state.ts";
import { sectionId } from "./src/render.ts";
import { explainPath, renderRuleDetail } from "./src/explain.ts";
import type { EvaluationTrace, NormalizedPath, Rule, RuleError } from "./src/types.ts";

/** Handler context fields the wiring consumes (mirror of pi ExtensionContext). */
export interface ExtensionContextLike {
	readonly cwd: string;
	readonly isProjectTrusted: () => boolean;
	/** Mirror of pi's `Model` — only the id is consumed. */
	readonly model: { readonly id: string } | undefined;
	/** Mirror of pi 1.3.0 `ExtensionContext.hasUI` (`dist/core/extensions/types.d.ts:219`): status-bar UI exists only in TUI/RPC modes. */
	readonly hasUI: boolean;
	/** Mirror of pi 1.3.0 `ExtensionUIContext.setStatus` (`dist/core/extensions/types.d.ts:81`): the only ui method the wiring consumes. */
	readonly ui: { readonly setStatus: (key: string, text: string | undefined) => void };
}

/** Mirror of pi `BeforeAgentStartEvent` limited to the wiring's mutation surface. */
export interface BeforeAgentStartLike {
	readonly type: "before_agent_start";
	/** What started the run; pi 1.3.0 sends `"custom"` for `sendMessage(..., { triggerTurn: true })`. */
	readonly messageType?: "user" | "custom";
	/** Raw user prompt — present only on `user` runs, hence optional in this union mirror. */
	readonly prompt?: string;
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

/** Handler for the session-lifecycle / tool signals the collector folds. */
export type SignalHandler = (event: PiEventShape, ctx: ExtensionContextLike) => unknown;

/**
 * Local structural subset of pi's ExtensionAPI — narrow enough for typed fakes.
 *
 * Every signature is declared per EVENT NAME, exactly as pi declares them:
 * pi's `on` is an overload per event, so a single overload accepting a union of
 * event names is not satisfied by it ("Type '"before_agent_start"' is not
 * assignable to type '"project_trust"'"). The handler parameters keep the local
 * `PiEventShape` / `BeforeAgentStartLike` mirrors — narrow, structural, and
 * assignable in both directions — so fakes need no pi types.
 */
export interface PiExtensionApiLike {
	on(event: "tool_execution_start", handler: SignalHandler): unknown;
	on(event: "session_compact", handler: SignalHandler): unknown;
	on(event: "session_before_switch", handler: SignalHandler): unknown;
	on(event: "session_before_fork", handler: SignalHandler): unknown;
	on(event: "before_agent_start", handler: (event: BeforeAgentStartLike, ctx: ExtensionContextLike) => unknown): unknown;
	registerCommand(name: string, options: RulesCommandOptions): void;
	/** Structural mirror of the installed Pi registerTool definition. */
	registerTool(tool: ReadRuleToolDefinition): void;
	/**
	 * Structural mirror of pi's `exec` (installed 1.3.0 `dist/core/exec.d.ts`),
	 * limited to the fields the branch seam consumes. Production passes the real
	 * `ExtensionAPI` — assignable without a cast — and tests inject a stub.
	 */
	exec: ExecLike;
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
			// One git ref query per turn: total by contract (shell/git-branch.ts),
			// so an exec failure yields an absent branch instead of breaking the cycle.
			const branch = await resolveBranch(ctx.cwd, (command, args, options) => api.exec(command, args, options));
			const result = await runInjectionCycle({
				state,
				cwd: ctx.cwd,
				// pi 1.3.0: custom-message runs carry no prompt; an empty prompt contributes
				// no intent signals (src/intent.ts returns [] for empty text), matching the
				// engine's existing undefined-prompt semantics.
				prompt: event.prompt ?? "",
				now: deps.now(),
				trusted: ctx.isProjectTrusted(),
				session: {
					toolNames: event.systemPromptOptions.selectedTools,
					model: ctx.model?.id,
					branch,
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
			// Status bar (pi TUI/RPC only): one visibility line per cycle, keyed by the
			// section id; explicitly cleared when nothing is active. `<active>` counts
			// the pinned active rules; the estimate covers the whole rendered section.
			if (ctx.hasUI) {
				const active = result.trace.selection.active.length;
				ctx.ui.setStatus(
					sectionId,
					result.trace.block === undefined ? undefined : `rules: ${active} · ~${result.trace.estimatedTokens} tok`,
				);
			}
		});

		api.registerCommand("rules", {
			description: "Show why each pi-rules-md rule is active or inactive",
			handler: async (args, ctx) => {
				const trimmed = args.trim();
				if (trimmed === "") {
					ctx.ui.notify(renderTraceReport(lastTrace, lastErrors, lastDiscoveredRules, deps.pipeline.budget).join("\n"), "info");
					return;
				}
				const tokens = trimmed.split(/\s+/);
				const sub = tokens[0] ?? "";
				const rest = tokens.slice(1);
				if (sub === "show" && rest.length === 1) {
					const id = rest[0] ?? "";
					const rule = lastDiscoveredRules.find((candidate) => candidate.id === id);
					ctx.ui.notify(rule === undefined ? `Unknown rule: ${id}` : renderRuleDetail(rule).join("\n"), "info");
					return;
				}
				if (sub === "why" && rest.length >= 1) {
					ctx.ui.notify(explainPath(lastDiscoveredRules, rest.join(" ")).join("\n"), "info");
					return;
				}
				ctx.ui.notify("usage: /rules [show <id> | why <path>] — bare /rules prints the full evaluation report", "info");
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
					globalDir: globalRulesDir(homedir()),
					projectDir: projectRulesDir(opts.cwd),
					isProjectTrusted: opts.isProjectTrusted,
				});
				return { rules: result.rules, errors: result.errors };
			},
			scan: tinyglobbyScanner,
			budget: resolveBudget(process.env.PI_RULES_MAX_TOKENS, DEFAULT_BUDGET_TOKENS),
		},
		now: () => new Date(),
	};
	createRulesExtension(deps)(pi);
}
