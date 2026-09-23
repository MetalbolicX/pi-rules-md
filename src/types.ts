/**
 * Domain data for pi-rules-md (rule format v1).
 *
 * Pure readonly data plus tiny branded constructors — no classes, no methods.
 * Everything the matching/selection/rendering pipeline consumes is defined
 * here so later tasks share one vocabulary.
 *
 * Branding: `Brand<T, B>` intersects the base type with a unique-symbol marker,
 * so e.g. a plain `string` is NOT assignable to `RuleId` while `RuleId` still
 * behaves as a string. Constructors are the only sanctioned cast points.
 */

declare const brand: unique symbol;

/** Nominal marker over a base type (unique-symbol intersection). */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Identifier of a rule (its file stem or explicit id). Branded string. */
export type RuleId = Brand<string, "RuleId">;

/** Filesystem path already normalized to forward slashes. Branded string. */
export type NormalizedPath = Brand<string, "NormalizedPath">;

/** Constructs a RuleId. Pure: no validation here, parsing (task 2) owns that. */
export const ruleId = (value: string): RuleId => value as RuleId;

/**
 * Constructs a NormalizedPath, converting backslashes to forward slashes so
 * glob matching and reporting stay platform-consistent. Minimal by design:
 * only separator normalization happens here.
 */
export const normalizedPath = (value: string): NormalizedPath => value.replaceAll("\\", "/") as NormalizedPath;

/** Where a rule was discovered. */
export type RuleSource = "global" | "project";

/** How the rule is activated: match on touched files, existing files, or both. */
export type MatchMode = "touched" | "exists" | "both";

/** How an active rule is presented in the injected section. */
export type Enforcement = "enforce" | "recommend" | "inform";

/**
 * A discovered rule file (format v1): frontmatter metadata plus markdown body.
 * All fields are readonly; rules are immutable data.
 *
 * Default-field decision: `match` defaults to `"both"` and `priority` to `0`.
 * Those defaults are applied exactly once, at parse/normalization time
 * (frontmatter task), so every `Rule` in memory holds concrete values and
 * downstream code never re-checks for defaults. That is why both fields are
 * required here rather than optional.
 */
export interface Rule {
	/** Stable rule identifier. */
	readonly id: RuleId;
	/** Source file this rule was loaded from (normalized). */
	readonly path: NormalizedPath;
	/** Whether the rule came from the global or the project rules directory. */
	readonly source: RuleSource;
	/** Short human-readable description from frontmatter. */
	readonly description: string;
	/**
	 * Glob patterns the rule reacts to. Patterns OR across; a leading `!`
	 * negates a pattern. Absent means "no glob trigger".
	 */
	readonly globs?: readonly string[];
	/**
	 * Activation mode. Defaults to `"both"` (touched OR existing paths match);
	 * the default is materialized at parse time, never re-derived downstream.
	 */
	readonly match: MatchMode;
	/** Tool names that trigger the rule. Absent means "no tool trigger". */
	readonly tools?: readonly string[];
	/** Git branch that triggers the rule. Absent means "any branch". */
	readonly branch?: string;
	/** Model name that triggers the rule. Absent means "any model". */
	readonly model?: string;
	/** Sort weight for selection; higher wins. Defaults to 0 at parse time. */
	readonly priority: number;
	/** Presentation strength once active. */
	readonly enforcement: Enforcement;
	/** When true the rule is always active, bypassing condition matching. */
	readonly alwaysApply: boolean;
	/** Rule format version; only 1 exists. */
	readonly version: 1;
	/** Markdown body after the frontmatter block. */
	readonly content: string;
}

/** Machine-readable error codes for rule parsing failures. */
export type RuleErrorCode =
	| "missing-frontmatter"
	| "yaml-syntax"
	| "unknown-key"
	| "invalid-value"
	| "missing-description"
	| "no-activation-condition"
	| "match-without-globs"
	| "invalid-version"
	| "read-failure";

/**
 * Why a rule file could not be parsed into a Rule. Discriminated by `code`;
 * `message` is human-readable and `file` optionally names the source file.
 * Parsing is total: every failure is one of these values, never a throw.
 */
export type RuleError =
	| { readonly code: "missing-frontmatter"; readonly message: string; readonly file?: string }
	| { readonly code: "yaml-syntax"; readonly message: string; readonly file?: string }
	| { readonly code: "unknown-key"; readonly message: string; readonly file?: string }
	| { readonly code: "invalid-value"; readonly message: string; readonly file?: string }
	| { readonly code: "missing-description"; readonly message: string; readonly file?: string }
	| { readonly code: "no-activation-condition"; readonly message: string; readonly file?: string }
	| { readonly code: "match-without-globs"; readonly message: string; readonly file?: string }
	| { readonly code: "invalid-version"; readonly message: string; readonly file?: string }
	| { readonly code: "read-failure"; readonly message: string; readonly file?: string };

/** Snapshot of everything conditions may look at during an evaluation. */
export interface EvaluationContext {
	/** Evaluation time as epoch milliseconds. */
	readonly now: number;
	/** Current working directory (normalized). */
	readonly cwd: NormalizedPath;
	/** Whether the project is trusted; gates project rules. */
	readonly isProjectTrusted: boolean;
	/** Paths touched by the agent in this session (normalized). */
	readonly touchedPaths: readonly NormalizedPath[];
	/** Paths confirmed to exist in the project (normalized). */
	readonly existingPaths: readonly NormalizedPath[];
	/** Tool names available/active in this session. */
	readonly toolNames: readonly string[];
	/** Active model name, when known. */
	readonly model?: string;
	/** Active git branch, when known. */
	readonly branch?: string;
}

/** Why a rule matched, tagged by trigger kind. */
export type MatchReason =
	| { readonly kind: "always" }
	| { readonly kind: "glob"; readonly pattern: string }
	| { readonly kind: "tool"; readonly tool: string }
	| { readonly kind: "model"; readonly model: string }
	| { readonly kind: "branch"; readonly branch: string };

/** Per-rule outcome of condition evaluation. Discriminated by `matched`. */
export type MatchResult =
	| {
			/** The rule activated. */
			readonly matched: true;
			readonly ruleId: RuleId;
			/** Every trigger that fired for this rule. */
			readonly reasons: readonly MatchReason[];
	  }
	| {
			/** The rule did not activate. */
			readonly matched: false;
			readonly ruleId: RuleId;
			/** Human-readable explanation, feeds the /rules report. */
			readonly reason: string;
	  };

/** Why a discovered rule was dropped before injection. */
export type DropCause = "duplicate" | "budget";

/** A rule removed during selection, with the reason. */
export interface DroppedRule {
	readonly rule: Rule;
	readonly cause: DropCause;
}

/** Final selection output: rules to inject plus those dropped, with causes. */
export interface Selection {
	readonly active: readonly Rule[];
	readonly dropped: readonly DroppedRule[];
}

/** One renderable section for `systemPromptOptions.sections`. */
export interface InjectionBlock {
	/** Section id used for the sections mutation. */
	readonly sectionId: string;
	/** Rendered markdown to inject. */
	readonly content: string;
	/** Hash of the content; drives hash hysteresis (skip identical patches). */
	readonly contentHash: string;
}

/**
 * Immutable outcome of one full evaluation run: everything the state and
 * injection layers (later shell tasks) consume, plus the per-rule results
 * that feed the `/rules` report. Pure readonly data — no methods.
 */
export interface EvaluationTrace {
	/** Evaluation time, copied from `ctx.now` (keeps traces deterministic). */
	readonly evaluatedAt: number;
	/**
	 * Final merged outcome for every rule, in rule order: the path condition
	 * AND all declared non-path conditions. Skipped (trust-gated) rules appear
	 * as unmatched with their skip reason.
	 */
	readonly results: readonly MatchResult[];
	/** Selection outcome over the matched rules (dedupe, priority, budget). */
	readonly selection: Selection;
	/** The rendered section; `undefined` when nothing is active. */
	readonly block: InjectionBlock | undefined;
}
