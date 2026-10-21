/**
 * Injection-cycle orchestrator (imperative shell): one full rules pass, from
 * discovery to a folded session state, as one async, deterministic call.
 *
 * This is the seam between the engine's functional core and the pi wiring
 * (index.ts): it composes discovery → evaluate → render → injection decision
 * → state fold, so the entry point stays a thin translator between pi events
 * and this pipeline. Design contract:
 *
 * - Determinism: no `Date.now`, no filesystem, no crypto here — the clock
 *   arrives as `now: Date`, discovery and scanning arrive as `deps`, and
 *   hashing/rendering happen inside the injected pure stages. Equal inputs
 *   produce deep-equal outputs.
 * - Evaluation and decision are separate steps. `evaluateCurrent` discovers,
 *   enriches, and evaluates — data out, no state fold — so a second caller (the
 *   mid-run attachment handler) can evaluate the session at a tool result without
 *   ever touching the section lifecycle. `runInjectionCycle` adds the decision
 *   and its fold on top of it.
 * - Totality of the fold: the decision is applied to the state, never to pi:
 *   `patch` folds `block_injected(block.contentHash)` (a repeated identical
 *   hash is an idempotent same-value overwrite — pi rebuilds sections every
 *   turn, so every patch re-records it), `remove` folds `block_removed`, and
 *   `none` leaves the state object untouched (the very same reference flows
 *   out — only possible when nothing is active and nothing was injected).
 * - Section mutation is NOT done here: the pipeline never touches a sections
 *   object. `index.ts` applies `decision` to pi's
 *   `systemPromptOptions.sections` via `applyInjection`/`removeInjection`,
 *   keeping the only pi mutation at the boundary that owns the object.
 * - Trust semantics: `trusted` is forwarded to discovery (the untrusted
 *   project directory is never listed — shell/discovery.ts) and the engine
 *   re-gates project rules as defense-in-depth.
 * - The discovery seam mirrors shell/discovery.ts's outcome shape (rules +
 *   parse errors) minus the mtime cache: the cache lives in the composition
 *   root, which closes over it when building `deps.discover`.
 */
import { homedir } from "node:os";
import { conditionSpec, CONDITION_KEYS } from "../src/conditions/table.ts";
import { evaluate, MUTED_REASON } from "../src/engine.ts";
import { triggerPhrase } from "../src/render.ts";
import type { GlobScanner } from "../src/match.ts";
import { estimateTokens } from "../src/select.ts";
import { transition } from "../src/state.ts";
import type { SessionState } from "../src/state.ts";
import { injectionDecision } from "./injection.ts";
import type { InjectionDecision } from "./injection.ts";
import { normalizedPath } from "../src/types.ts";
import { globalRulesDir, projectRulesDir } from "./rules-paths.ts";
import type { EvaluationContext, EvaluationTrace, InjectionBlock, Rule, RuleError } from "../src/types.ts";

/** Default selection budget: 2000 estimated tokens (~8000 characters). */
export const DEFAULT_BUDGET_TOKENS = 2000;

/** Options the pipeline hands to the discovery seam each cycle. */
export interface DiscoverOptions {
	/** Current working directory (normalized); scopes the project rules dir. */
	readonly cwd: ReturnType<typeof normalizedPath>;
	/** Whether the project is trusted; discovery never lists an untrusted project dir. */
	readonly isProjectTrusted: boolean;
}

/** Outcome of the injected discovery seam, mirroring shell/discovery.ts. */
export interface DiscoveredRules {
	/** Parsed rules, in discovery order (project first, then global). */
	readonly rules: readonly Rule[];
	/** Parse errors collected during discovery (feed the /rules report). */
	readonly errors: readonly RuleError[];
}

/** Injected effects for one pipeline: discovery, the project scanner, budget. */
export interface PipelineDeps {
	/** Rule discovery over the mtime cache owned by the composition root. */
	readonly discover: (opts: DiscoverOptions) => Promise<DiscoveredRules>;
	/** Scanner resolving the rules' positive globs (exists matching). */
	readonly scan: GlobScanner;
	/** Token budget handed to the selection pipeline. */
	readonly budget: number;
}

/** Everything one injection cycle consumes. */
export interface PipelineInput {
	/** Session state so far (touched paths, last injected hash, session mutes). */
	readonly state: SessionState;
	/** Current working directory. */
	readonly cwd: string;
	/** Current turn prompt; intent detection never adds paths to the context pools. */
	readonly prompt: string;
	/** Evaluation time — injected for determinism. */
	readonly now: Date;
	/** Whether the project is trusted (gates project rules). */
	readonly trusted: boolean;
	/** Session facts the evaluation context needs. */
	readonly session: {
		readonly toolNames: readonly string[];
		readonly model: string | undefined;
		readonly branch: string | undefined;
	};
	/** Injected effects. */
	readonly deps: PipelineDeps;
}

/** Everything one injection cycle produces; `nextState` is fresh, never the mutated input. */
export interface PipelineResult {
	/** The state after folding the decision (same reference when the decision is `none`). */
	readonly nextState: SessionState;
	/** Immutable evaluation trace (feeds the /rules report). */
	readonly trace: EvaluationTrace;
	/** What pi's sections must do this turn. */
	readonly decision: InjectionDecision;
	/** The rendered section, when something is active. */
	readonly block: InjectionBlock | undefined;
	/**
	 * The ENRICHED rules this cycle evaluated: discovery order (project first),
	 * with `index` and the rules-root-relative `relativePath` materialized, and
	 * including rules that did not match. This is the only honest list for
	 * consumers that resolve a rule by its reference path (`read_rule`, `/rules
	 * show`, mid-run attachment): `shell/discovery.ts` returns raw rules without
	 * `relativePath`, so reading the discovery seam directly would answer "Unknown
	 * rule" in production while fixture-based tests pass (L7).
	 */
	readonly rules: readonly Rule[];
	/** Parse errors the cycle's discovery collected (reported by /rules). */
	readonly errors: readonly RuleError[];
}

/** One evaluation's outcome: the trace plus the rules it evaluated and discovery's errors. */
export interface CycleEvaluation {
	readonly trace: EvaluationTrace;
	readonly rules: readonly Rule[];
	readonly errors: readonly RuleError[];
}

/**
 * One evaluation over CURRENT session state, with NO decision and NO state fold.
 *
 * This is the shared evaluation path: `runInjectionCycle` uses it and then owns
 * the injection decision, and the mid-run attachment handler (S9) uses it to
 * evaluate the session as the tool result leaves it. Keeping the two on one
 * function is what makes the duplicate-materialization path impossible: the
 * rules are sorted and enriched exactly once here.
 *
 * Splitting it this way matters because a second caller must NOT fold
 * injection state. `before_agent_start` owns `lastInjectedHash`, which drives the
 * patch/remove lifecycle; an evaluation that also folded `block_injected` could
 * record a hash for a block pi never received and leave a stale section in place.
 * So this function returns data only: it never calls `transition`, never touches
 * the input state object, and never mutates a section.
 */
export const evaluateCurrent = async (input: PipelineInput): Promise<CycleEvaluation> => {
	const ctx: EvaluationContext = {
		now: input.now.getTime(),
		cwd: normalizedPath(input.cwd),
		isProjectTrusted: input.trusted,
		touchedPaths: input.state.touchedPaths,
		existingPaths: [],
		toolNames: input.session.toolNames,
		...(input.session.model === undefined ? {} : { model: input.session.model }),
		...(input.session.branch === undefined ? {} : { branch: input.session.branch }),
	};

	const discovered = await input.deps.discover({ cwd: ctx.cwd, isProjectTrusted: input.trusted });
	const rules = [...discovered.rules]
		.sort((a, b) => (a.source === b.source ? 0 : a.source === "project" ? -1 : 1))
		.map((rule, index) => {
			const rulesRoot = rule.source === "project" ? projectRulesDir(ctx.cwd) : globalRulesDir(homedir());
			const prefix = `${rulesRoot}/`;
			const relativePath = rule.relativePath ?? (rule.path.startsWith(prefix) ? normalizedPath(rule.path.slice(prefix.length)) : undefined);
			return { ...rule, index, ...(relativePath === undefined ? {} : { relativePath }) };
		});
	const trace = await evaluate(rules, ctx, {
		scan: input.deps.scan,
		budget: input.deps.budget,
		prompt: input.prompt,
		mutedRuleIds: input.state.mutedRuleIds,
	});

	return { trace, rules, errors: discovered.errors };
};

/**
 * Runs one full injection cycle: evaluates current state through
 * `evaluateCurrent`, then decides what pi's sections must do and folds that
 * decision into the state. Pure with respect to its inputs: equal inputs give
 * deep-equal outputs and the input `state` is never mutated.
 */
export const runInjectionCycle = async (input: PipelineInput): Promise<PipelineResult> => {
	const { trace, rules, errors } = await evaluateCurrent(input);
	const { block } = trace;
	const decision = injectionDecision(block, input.state.lastInjectedHash);
	const nextState =
		decision.action === "patch" && block !== undefined
			? transition(input.state, { type: "block_injected", contentHash: block.contentHash })
			: decision.action === "remove"
				? transition(input.state, { type: "block_removed" })
				: input.state;

	return { nextState, trace, decision, block, rules, errors };
};

/** Lines for one rule outcome: active rules name their reasons, inactive ones their failure. */
const configuredLines = (rule: Rule | undefined): string[] => {
	if (rule === undefined) {
		return [];
	}
	return CONDITION_KEYS.flatMap((name) => {
		const value = rule[name];
		if (value === undefined || (name === "alwaysApply" && value !== true)) {
			return [];
		}
		return [`  configured: ${conditionSpec(name).describe(value)}`];
	});
};

/**
 * Lines for one rule outcome: active rules name their reasons, inactive ones
 * their failure. A session-muted rule is excluded by an explicit user action,
 * not by a failed condition, so its `configured:` detail lines are omitted:
 * the report line reads exactly `inactive: <id> (muted for this session)`.
 */
const resultLines = (results: EvaluationTrace["results"], rules: readonly Rule[] = []): string[] =>
	results.flatMap((result) =>
		result.matched
			? [`active: ${result.ruleId} (${result.reasons.map(triggerPhrase).join(" · ")})`]
			: [
					`inactive: ${result.ruleId} (${result.reason})`,
					...(result.reason === MUTED_REASON ? [] : configuredLines(rules.find((rule) => rule.id === result.ruleId))),
				],
	);

/** Lines for the selection outcome: every dropped rule with its cause. */
const droppedLines = (trace: EvaluationTrace): string[] =>
	trace.selection.dropped.map((dropped) => `dropped: ${dropped.rule.id} (${dropped.cause})`);

/** Lines for discovery parse errors. */
const errorLines = (errors: readonly RuleError[]): string[] =>
	errors.map((error) => `parse error: ${error.file ?? "unknown file"} (${error.code}): ${error.message}`);

/**
 * Renders the last evaluation as markdown lines for the /rules command:
 * per-rule active/inactive with reasons (a session-muted rule shows exactly
 * its mute reason, with no `configured:` detail lines), dropped rules with
 * causes, parse errors, and a footer naming the injected section and its
 * content hash (only when a block was rendered). When `budget` is supplied
 * (the resolved selection budget), a `budget: <used>/<budget> estimated
 * tokens` line is added — `used` sums `estimateTokens` over the PINNED active
 * bodies only, never the on-demand index — plus a
 * `section: ~<estimatedTokens> tokens` line while a block exists, covering the
 * whole rendered section including the on-demand index. Omitting `budget`
 * yields the historical report shape.
 * Pure and deterministic — no trace means exactly one "No evaluation yet." line.
 */
export const renderTraceReport = (
	trace: EvaluationTrace | undefined,
	errors: readonly RuleError[] = [],
	rules?: readonly Rule[],
	budget?: number,
): readonly string[] => {
	if (trace === undefined) {
		return ["No evaluation yet."];
	}
	const lines: string[] = [
		"Rules evaluation report",
		`Evaluated at: ${new Date(trace.evaluatedAt).toISOString()}`,
	];
	lines.push(...resultLines(trace.results, rules));
	lines.push(...droppedLines(trace));
	lines.push(...errorLines(errors));
	if (budget !== undefined) {
		const used = trace.selection.active.reduce((sum, rule) => sum + estimateTokens(rule), 0);
		lines.push(`budget: ${used}/${budget} estimated tokens`);
		if (trace.block !== undefined) {
			lines.push(`section: ~${trace.estimatedTokens} tokens`);
		}
	}
	if (trace.block !== undefined) {
		lines.push(`injected: section ${trace.block.sectionId} (hash ${trace.block.contentHash})`);
	}
	return lines;
};
