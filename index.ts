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
 * - `appendEntry(customType, data)` is still on `ExtensionAPI`
 *   (`dist/core/extensions/types.d.ts:1272`): it appends a custom session entry
 *   that never reaches the LLM. It is the touched-path persistence channel.
 * - `ExtensionContext.sessionManager` is still a `ReadonlySessionManager`
 *   (`dist/core/extensions/types.d.ts:223`), whose `getBranch(fromId?)`
 *   (`dist/core/session-manager.d.ts:311`) walks root → leaf. The rebuild seam
 *   consumes only `getBranch`.
 * - `on("tool_result", …)` is an `ExtensionHandler<ToolResultEvent, …>`
 *   (`dist/core/extensions/types.d.ts:1225` for the subscription;
 *   `ToolResultEventBase` at `:985-1005`, union at `:1037`). Two effects ride on
 *   it: a `write`/`edit`/`bash` result can change the filesystem, so it
 *   invalidates the exists-scan cache (S8); and a `read`/`edit`/`write` result
 *   carries the rules that only became active because of it, appended as one
 *   extra text part (S9). The SDK documents `tool_result` as a transform event
 *   ("Fired after a tool executes. Can modify result.") and its result type
 *   `ToolResultEventResult` (`:1114`) replaces `content`, which
 *   `runner.js emitToolResult` applies only when a handler RETURNS it — so this
 *   wiring returns `{ content: [...existing, attachment] }` and never mutates
 *   the event's array in place. A result flagged `isError` is left untouched.
 */
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { piEventToStateEvents } from "./shell/collectors.ts";
import type { PiEventShape } from "./shell/collectors.ts";
import { discover as discoverRules, nodeDiscoveryDeps, projectRuleDirs, tinyglobbyScanner } from "./shell/discovery.ts";
import type { DiscoveryCacheEntry, DiscoveryDeps, ProjectRuleDir } from "./shell/discovery.ts";
import { CLAUDE_IMPORTER } from "./shell/importers/claude.ts";
import { COPILOT_IMPORTER } from "./shell/importers/copilot.ts";
import type { Importer } from "./shell/importers/seam.ts";
import { applyInjection, removeInjection } from "./shell/injection.ts";
import { resolveBranch, resolveGitRoot } from "./shell/git-branch.ts";
import type { ExecLike } from "./shell/git-branch.ts";
import { createScopedScanner } from "./shell/match.ts";
import { createReadRuleTool } from "./shell/read-rule.ts";
import type { ReadRuleToolDefinition } from "./shell/read-rule.ts";
import { createCachedScanner } from "./shell/scan-cache.ts";
import { DEFAULT_BUDGET_TOKENS, evaluateCurrent, renderTraceReport, runInjectionCycle } from "./shell/pipeline.ts";
import { globalRulesDir, resolveAttach, resolveBudget, resolveImport } from "./shell/rules-paths.ts";
import type { PipelineDeps } from "./shell/pipeline.ts";
import { newlyActivated, remainingBudget, renderAttachments } from "./src/attach.ts";
import { TOUCHED_ENTRY_TYPE, addedPaths, initialState, touchedPathsFromEntries, transition } from "./src/state.ts";
import type { SessionState } from "./src/state.ts";
import { sectionId } from "./src/render.ts";
import { explainPath, renderRuleDetail } from "./src/explain.ts";
import { ruleId } from "./src/types.ts";
import type { EvaluationTrace, NormalizedPath, Rule, RuleError } from "./src/types.ts";

/**
 * Mirror of pi 1.3.0 `ReadonlySessionManager` (`dist/core/extensions/types.d.ts:223`,
 * `dist/core/session-manager.d.ts:178`), limited to the branch read this wiring
 * performs: `SessionManager.getBranch(fromId?)` at
 * `dist/core/session-manager.d.ts:311`, returning the entries root → leaf.
 */
export interface SessionManagerLike {
	readonly getBranch: (fromId?: string) => readonly unknown[];
}

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
	/** Mirror of pi 1.3.0 `ExtensionContext.sessionManager` (`dist/core/extensions/types.d.ts:223`): touched paths are rebuilt from the branch. */
	readonly sessionManager: SessionManagerLike;
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
	on(event: "tool_result", handler: SignalHandler): unknown;
	on(event: "session_compact", handler: SignalHandler): unknown;
	on(event: "session_before_switch", handler: SignalHandler): unknown;
	on(event: "session_before_fork", handler: SignalHandler): unknown;
	on(event: "session_start", handler: SignalHandler): unknown;
	on(event: "session_tree", handler: SignalHandler): unknown;
	on(event: "before_agent_start", handler: (event: BeforeAgentStartLike, ctx: ExtensionContextLike) => unknown): unknown;
	registerCommand(name: string, options: RulesCommandOptions): void;
	/** Structural mirror of the installed Pi registerTool definition. */
	registerTool(tool: ReadRuleToolDefinition): void;
	/**
	 * Structural mirror of pi 1.3.0 `ExtensionAPI.appendEntry`
	 * (`dist/core/extensions/types.d.ts:1272`): appends a custom session entry for
	 * state persistence (`customType` plus JSON data); never sent to the LLM.
	 */
	appendEntry(customType: string, data?: unknown): void;
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
	/**
	 * Drops every cached exists-scan result (S8). The wiring calls it after a
	 * `write`/`edit`/`bash` tool result — the only events that can have changed
	 * which paths exist — and never for read-only tools. Production passes the
	 * `invalidate` of the cache wrapping `pipeline.scan`; a deployment with an
	 * uncached scanner passes a no-op.
	 */
	readonly invalidateScan: () => void;
	/**
	 * Whether mid-run attachment is enabled (S9/D3): production resolves
	 * `PI_RULES_ATTACH` once at the composition root, where only `off` disables it.
	 * A disabled deployment still invalidates the exists-scan cache; it only stops
	 * appending rule bodies to tool results.
	 */
	readonly attach: boolean;
}

/**
 * The `tool_result` return value this wiring produces: pi 1.3.0
 * `ToolResultEventResult.content` (`dist/core/extensions/types.d.ts:1114-1120`).
 * Returning it REPLACES the result content (`runner.js emitToolResult`), so the
 * value always carries every pre-existing part plus the appended attachment.
 */
export interface ToolResultPatch {
	readonly content: readonly unknown[];
}

/**
 * Tools whose RESULT can change the project's matching path set. `bash` counts
 * because an arbitrary command can create, move, or delete files; `read`,
 * `grep`, `find`, and `ls` cannot, and an unknown/custom tool is not assumed to
 * have mutated the disk (conservative invalidation would defeat the cache).
 */
const INVALIDATING_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "bash"]);

/**
 * Tools whose RESULT may carry a mid-run attachment (S9). The specification
 * restricts attachment to `read`/`edit`/`write`; `grep`/`find`/`ls` also carry a
 * path argument, but every one of their results stays byte-identical.
 */
const ATTACHING_TOOLS: ReadonlySet<string> = new Set(["read", "edit", "write"]);

/**
 * Session facts the evaluation context needs, captured at each
 * `before_agent_start`: tool names, model id, git branch. A tool result has no
 * event of its own for these, so the mid-run attachment evaluation reuses the
 * last captured set.
 */
export interface SessionFacts {
	readonly toolNames: readonly string[];
	readonly model: string | undefined;
	readonly branch: string | undefined;
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
	// The ENRICHED rules of the last cycle (see PipelineResult.rules): `read_rule`,
	// `/rules show` and mid-run attachment all resolve rules by their reference
	// path, and only the pipeline materializes `relativePath` (L7).
	let lastDiscoveredRules: readonly Rule[] = [];
	// Session facts of the last `before_agent_start` (see SessionFacts). `undefined`
	// until the first cycle runs, which is also why no attachment can happen
	// before then: there is no run whose session to evaluate.
	let lastSession: SessionFacts | undefined;

	return (api: PiExtensionApiLike): void => {
		api.registerTool(createReadRuleTool(() => lastDiscoveredRules));

		// Signal events fold into state through the collector + reducer.
		const foldSignal = (event: PiEventShape, ctx: ExtensionContextLike): void => {
			for (const stateEvent of piEventToStateEvents(event, { cwd: ctx.cwd })) {
				const next = transition(state, stateEvent);
				// Persistence (S7): a touched path batch is written to the session as one
				// custom entry carrying only the NEWLY added paths. A repeat is a
				// value-level no-op in the reducer, so it writes nothing.
				const added = addedPaths(state.touchedPaths, next.touchedPaths);
				if (added.length > 0) {
					api.appendEntry(TOUCHED_ENTRY_TYPE, { paths: [...added] });
				}
				state = next;
			}
		};
		api.on("tool_execution_start", foldSignal);
		api.on("session_compact", foldSignal);
		api.on("session_before_switch", foldSignal);
		api.on("session_before_fork", foldSignal);

		// Persistence (S7): resume/reload and tree navigation rebuild the touched set
		// from the CURRENT branch, so a resumed session restores exactly what its
		// branch recorded, and navigating away drops paths from an abandoned branch.
		// Guarded like the collectors: this runs inside pi's event dispatch, where a
		// throw is fatal, and an unreadable branch is not evidence of an empty one —
		// so the fold degrades to leaving the session state untouched. The event kind
		// and its reason are irrelevant: only the branch matters.
		const rebuildTouchedPaths = (_event: PiEventShape, ctx: ExtensionContextLike): void => {
			try {
				state = transition(state, { type: "touched_paths_rebuilt", paths: touchedPathsFromEntries(ctx.sessionManager.getBranch()) });
			} catch {
				// Session history unavailable: keep the state this session already folded.
			}
		};
		api.on("session_start", rebuildTouchedPaths);
		api.on("session_tree", rebuildTouchedPaths);

		// Tool results carry two effects, both wiring-owned and total, mapping to NO
		// state event: a result is a completion signal, never a touch batch.
		//
		// S8 — exists-scan cache: the scan memo only knows about the filesystem as of
		// its last run, so a tool result that could have changed the filesystem drops
		// every entry; a changed pattern set misses by key on its own. Pre-execution
		// `tool_execution_start` deliberately does not invalidate — the write has not
		// happened yet, and a scan run between the two events would cache a
		// pre-mutation result.
		//
		// S9 — mid-run attachment: the rules that are active NOW and that the model has
		// not been given yet are appended to the tool result, once per rule per
		// session. `before_agent_start` fires once per run, so its trace predates the
		// path this tool call folded — the handler therefore re-evaluates current
		// session state through the pipeline's non-folding seam (`evaluateCurrent`).
		// That evaluation must never patch or remove a section: `before_agent_start`
		// owns the injected-block hash, and a second fold could record a hash for a
		// block pi never received. It also does not touch `lastTrace`/`lastErrors`/
		// `lastDiscoveredRules`, so `/rules` keeps reporting the last real cycle.
		// `content` is never mutated in place: the returned patch carries the original
		// parts plus one text part, because pi applies a handler RESULT
		// (`runner.js emitToolResult`) and ignores an in-place edit.
		const onToolResult = async (
			event: PiEventShape | null | undefined,
			ctx: ExtensionContextLike,
		): Promise<ToolResultPatch | undefined> => {
			try {
				if (event === null || event === undefined || typeof event !== "object" || event.type !== "tool_result") {
					return undefined;
				}
				if (INVALIDATING_TOOLS.has(event.toolName)) {
					deps.invalidateScan();
				}
				if (!deps.attach || !ATTACHING_TOOLS.has(event.toolName)) {
					return undefined;
				}
				// `isError` is the installed SDK's own error marker
				// (`ToolResultEventBase.isError`, types.d.ts:999), so no content heuristic is
				// needed. No session facts yet means no cycle ran: nothing to evaluate.
				if (event.isError === true || !Array.isArray(event.content)) {
					return undefined;
				}
				const session = lastSession;
				if (session === undefined) {
					return undefined;
				}
				// Current state, current session facts, empty prompt: a tool result has no
				// user prompt of its own, so turn-prompt intent keywords do not apply here.
				// Both injected effects make this cheap by construction: discovery is
				// mtime-cached and the exists scan is cached (S8, invalidated just above for
				// the tools that can change it).
				const { trace } = await evaluateCurrent({
					state,
					cwd: ctx.cwd,
					prompt: "",
					now: deps.now(),
					trusted: ctx.isProjectTrusted(),
					session,
					deps: deps.pipeline,
				});
				// The delivered set is plain string data from the session state; `ruleId` is
				// the sanctioned constructor for the branded id the pure core matches on.
				const batch = newlyActivated(trace, new Set(state.deliveredRuleIds.map((id) => ruleId(id))));
				const attachment = renderAttachments(batch, remainingBudget(trace, deps.pipeline.budget));
				if (attachment === undefined) {
					return undefined;
				}
				state = transition(state, { type: "rules_delivered", ruleIds: [...attachment.delivered] });
				return { content: [...event.content, { type: "text", text: attachment.content }] };
			} catch {
				// A hostile result object, or a failing evaluation, must not break the tool
				// call: this runs inside pi's event dispatch, where an extension throw is
				// reported as an error. Leaving the result untouched is always safe.
				return undefined;
			}
		};
		api.on("tool_result", onToolResult);

		api.on("before_agent_start", async (event, ctx) => {
			// One git ref query per turn: total by contract (shell/git-branch.ts),
			// so an exec failure yields an absent branch instead of breaking the cycle.
			const branch = await resolveBranch(ctx.cwd, (command, args, options) => api.exec(command, args, options));
			// Session facts for this run: the cycle consumes them now, and the mid-run
			// attachment evaluation reuses them at each tool result.
			const session: SessionFacts = {
				toolNames: event.systemPromptOptions.selectedTools,
				model: ctx.model?.id,
				branch,
			};
			lastSession = session;
			const result = await runInjectionCycle({
				state,
				cwd: ctx.cwd,
				// pi 1.3.0: custom-message runs carry no prompt; an empty prompt contributes
				// no intent signals (src/intent.ts returns [] for empty text), matching the
				// engine's existing undefined-prompt semantics.
				prompt: event.prompt ?? "",
				now: deps.now(),
				trusted: ctx.isProjectTrusted(),
				session,
				deps: deps.pipeline,
			});
			state = result.nextState;
			lastTrace = result.trace;
			lastErrors = result.errors;
			// The enriched rules of this cycle (L7): `read_rule`, `/rules show` and the
			// attachment renderer all resolve rules by the derived `relativePath`.
			lastDiscoveredRules = result.rules;
			// The only pi mutation this extension performs (sections, never systemPrompt).
			if (result.decision.action === "patch" && result.block !== undefined) {
				applyInjection(event.systemPromptOptions.sections, result.block);
				// Mid-run attachment seeding (S9, mandatory): the rules this section just
				// delivered count as delivered, so a later tool result never re-sends a rule
				// the model already has in its system prompt.
				state = transition(state, {
					type: "rules_delivered",
					ruleIds: result.trace.selection.active.map((rule) => rule.id),
				});
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
					ctx.ui.notify(explainPath(lastDiscoveredRules, rest.join(" "), { mutedRuleIds: state.mutedRuleIds }).join("\n"), "info");
					return;
				}
				// Session mute (S5): validate the id like `show` does, then fold the
				// state event. The exclusion applies from the next cycle on, and
				// session switch/fork clears it with the rest of the session state.
				if ((sub === "mute" || sub === "unmute") && rest.length === 1) {
					const id = rest[0] ?? "";
					if (!lastDiscoveredRules.some((candidate) => candidate.id === id)) {
						ctx.ui.notify(`Unknown rule: ${id}`, "info");
						return;
					}
					const muted = sub === "mute";
					state = transition(state, muted ? { type: "rules_muted", ruleId: id } : { type: "rules_unmuted", ruleId: id });
					ctx.ui.notify(`${muted ? "muted" : "unmuted"}: ${id}`, "info");
					return;
				}
				ctx.ui.notify(
					"usage: /rules [show <id> | why <path> | mute <id> | unmute <id>] — bare /rules prints the full evaluation report",
					"info",
				);
			},
		});
	};
};

/**
 * Per-cwd memo around `resolveGitRoot` (S10). The root of a directory does not
 * change while a session runs, and the discovery seam is called once per cycle
 * (twice when a tool result attaches rules), so the git query must not repeat:
 * one exec per cwd for the life of the extension, negative answers included.
 * The memo is keyed by the cwd string exactly as pi reports it.
 */
export const createGitRootMemo = (exec: ExecLike): ((cwd: string) => Promise<string | undefined>) => {
	const resolved = new Map<string, string | undefined>();
	return async (cwd) => {
		if (resolved.has(cwd)) {
			return resolved.get(cwd);
		}
		const root = await resolveGitRoot(cwd, exec);
		resolved.set(cwd, root);
		return root;
	};
};

/**
 * The project rules directories one cycle may read (S10), built at the
 * composition root:
 *
 * - Trust gate first: an untrusted project yields NO directories and never
 *   reaches git — an untrusted tree is not stat-ed, listed OR queried, which
 *   matches discovery's own gate.
 * - Trusted: the cwd-first walk-up list to the enclosing git root (inclusive),
 *   or exactly today's single `<cwd>/.pi/rules` when git reports no root.
 *   Nothing above that root can be produced, so nothing above it can be read.
 */
export const projectDirsForCycle = async (
	cwd: string,
	trusted: boolean,
	gitRootOf: (cwd: string) => Promise<string | undefined>,
): Promise<readonly ProjectRuleDir[]> => (trusted ? projectRuleDirs(cwd, await gitRootOf(cwd)) : []);

/**
 * Builds the production discovery step with injected I/O (S10). The dirs are
 * adjudicated here: the global `~/.pi/agent/rules`, plus — for a trusted project
 * only — every `.pi/rules` from cwd up to the git root (walk-up) and every
 * `.pi/rules` below cwd (the nested enumeration discovery performs itself behind
 * the same trust gate). The mtime cache lives here, so one instance per
 * deployment shares it across cycles (exactly what `piRulesMd` does).
 *
 * Importers (S11) arrive as an explicit list: the composition root resolves
 * `PI_RULES_IMPORT` once and passes an EMPTY list when importers are disabled,
 * so a disabled deployment never lists an importer root (no glob, no read) —
 * the same shape discovery uses for any absent importer list.
 *
 * Exported because it is the seam the wiring tests drive: it is the same object
 * the production factory installs, so an end-to-end test exercises the real
 * walk-up + nested enumeration + importer + rebasing path without a second
 * composition.
 */
export const createProjectDiscovery = (
	discoveryDeps: DiscoveryDeps,
	gitRootOf: (cwd: string) => Promise<string | undefined>,
	globalDir: string,
	importers: readonly Importer[] = [],
): PipelineDeps["discover"] => {
	const cache: Map<NormalizedPath, DiscoveryCacheEntry> = new Map();
	return async (opts) => {
		// Walk-up dirs come from the composition root; nested dirs are enumerated
		// inside discovery, behind the same trust gate (which also keeps an
		// untrusted project from being globbed at all).
		const projectDirs = await projectDirsForCycle(opts.cwd, opts.isProjectTrusted, gitRootOf);
		const result = await discoverRules(discoveryDeps, cache, {
			globalDir,
			projectDirs,
			isProjectTrusted: opts.isProjectTrusted,
			cwd: opts.cwd,
			importers,
		});
		return { rules: result.rules, errors: result.errors };
	};
};

/** The real extension factory: production discovery, exists-scan cache, budget, clock. */
export default function piRulesMd(pi: ExtensionAPI): void {
	// Exists-scan cache (S8) around the rebasing scanner (S10): rebased globs are
	// ABSOLUTE, so they must be scanned at their own root and returned absolute;
	// the memo stays OUTERMOST so its (cwd, pattern set) key includes the rebased
	// patterns themselves — a rule base change is a different question, never a
	// stale hit.
	const scanCache = createCachedScanner(createScopedScanner(tinyglobbyScanner));
	// One git-root query per cwd (see createGitRootMemo), shared by every cycle.
	const gitRootOf = createGitRootMemo((command, args, options) => pi.exec(command, args, options));
	// Importers (S11/D2): on for trusted projects unless `PI_RULES_IMPORT=none`.
	// The disabled shape is an EMPTY importer list, so discovery lists no importer
	// root and the pre-importer behavior is byte-identical even when the files
	// exist. Ordering is the list order: Copilot's `.github/instructions` is read
	// before Claude's `.claude/rules`, both after the nested `.pi/rules` dirs and
	// before the global dir. Imported ids share ONE namespace with every other
	// source (stem first, then `-2`, `-3`, …), so a `typescript.md` in
	// `.pi/rules`, `.github/instructions` and `.claude/rules` resolves to
	// `typescript`, `typescript-2`, `typescript-3` in that order.
	const importers: readonly Importer[] = resolveImport(process.env.PI_RULES_IMPORT)
		? [COPILOT_IMPORTER, CLAUDE_IMPORTER]
		: [];
	const deps: ExtensionDeps = {
		pipeline: {
			discover: createProjectDiscovery(nodeDiscoveryDeps(), gitRootOf, globalRulesDir(homedir()), importers),
			scan: scanCache.scanner,
			budget: resolveBudget(process.env.PI_RULES_MAX_TOKENS, DEFAULT_BUDGET_TOKENS),
		},
		now: () => new Date(),
		invalidateScan: scanCache.invalidate,
		// Mid-run attachment (S9/D3): on unless `PI_RULES_ATTACH` is `off`.
		attach: resolveAttach(process.env.PI_RULES_ATTACH),
	};
	createRulesExtension(deps)(pi);
}
