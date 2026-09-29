/**
 * Declarative registry of rule-format-v1 activation conditions.
 *
 * CONDITION_SPECS is the single source of truth for the six condition keys.
 * Each entry is a pure spec that knows how to:
 * - `parse` its raw frontmatter value (strict: a wrong type — or, for globs,
 *   an explicitly empty value — becomes a typed RuleError with code
 *   "invalid-value" naming the key; never a throw),
 * - `describe` its parsed value in a stable English phrase (feeds the /rules
 *   report),
 * - `buildPredicate` — only where the condition is a predicate: the ctx specs
 *   evaluate an EvaluationContext, and the globs spec evaluates one
 *   normalized path (path-SET traversal by `match` mode is match.ts's job).
 *
 * `match` is a mode selector with no predicate, modeled as its own `mode`
 * spec variant so the union stays honest: only ctx/path variants carry
 * `buildPredicate`, and the `kind` discriminant lets consumers narrow
 * without casts.
 *
 * Heterogeneity: specs are generic over their value type, so the table is
 * typed with a per-key literal union (`AnyConditionSpec`) instead of a
 * blanket widening. The single sanctioned cast lives in `conditionSpec`,
 * which hands callers a spec typed for one specific key.
 *
 * Spec `parse` is file-agnostic: produced errors carry no `file`; the
 * frontmatter parser attaches it when propagating. Codes and messages are
 * final here and byte-compatible with the pre-table parser.
 */
import { err, ok } from "../result.ts";
import type { Result } from "../result.ts";
import type { EvaluationContext, MatchMode, NormalizedPath, RuleError } from "../types.ts";
import { alwaysPredicate, branchPredicate, globMatcher, modelPredicate, toolsPredicate } from "./predicates.ts";
import type { Predicate } from "./predicates.ts";

/** Names of every condition key in rule format v1. */
export type ConditionName = "globs" | "match" | "tools" | "model" | "branch" | "alwaysApply";

/** Parsed value type of each condition key. */
export interface ConditionValues {
	readonly globs: readonly string[];
	readonly match: MatchMode;
	readonly tools: readonly string[];
	readonly model: string;
	readonly branch: string;
	readonly alwaysApply: boolean;
}

/** Resolves the parsed value type for one condition name. */
export type ConditionValueOf<N extends ConditionName> = ConditionValues[N];

/** Mode-selector spec: parses and describes, but builds no predicate. */
export interface ModeConditionSpec<T> {
	readonly kind: "mode";
	readonly parse: (raw: unknown) => Result<T, RuleError>;
	readonly describe: (value: T) => string;
}

/** Spec whose predicate evaluates an {@link EvaluationContext}. */
export interface CtxConditionSpec<T> {
	readonly kind: "ctx";
	readonly parse: (raw: unknown) => Result<T, RuleError>;
	readonly describe: (value: T) => string;
	readonly buildPredicate: (value: T) => Predicate<EvaluationContext>;
}

/** Spec whose predicate evaluates a single normalized path (globs). */
export interface PathConditionSpec<T> {
	readonly kind: "path";
	readonly parse: (raw: unknown) => Result<T, RuleError>;
	readonly describe: (value: T) => string;
	readonly buildPredicate: (value: T) => Predicate<NormalizedPath>;
}

/** A condition spec at one concrete value type. */
export type ConditionSpec<T> = ModeConditionSpec<T> | CtxConditionSpec<T> | PathConditionSpec<T>;

/** The per-key spec union actually stored in the table (no widening). */
export type AnyConditionSpec =
	| PathConditionSpec<readonly string[]>
	| ModeConditionSpec<MatchMode>
	| CtxConditionSpec<readonly string[]>
	| CtxConditionSpec<string>
	| CtxConditionSpec<boolean>;

const invalidValue = (key: string, expected: string): RuleError => ({
	code: "invalid-value",
	message: `frontmatter key "${key}" is invalid: expected ${expected}`,
});

/** Accepts a string (normalized to a one-element array) or an array of strings. */
const asStringArray = (value: unknown): readonly string[] | null => {
	if (typeof value === "string") {
		return [value];
	}
	if (Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string")) {
		return [...value];
	}
	return null;
};

const MATCH_MODES: readonly MatchMode[] = ["touched", "exists", "both"];

/** Type guard for {@link MatchMode}: true only for an exact known mode string. */
const isMatchMode = (value: unknown): value is MatchMode => MATCH_MODES.some((mode) => mode === value);

const parseGlobs = (raw: unknown): Result<readonly string[], RuleError> => {
	const value = asStringArray(raw);
	if (value === null) {
		return err(invalidValue("globs", "a string or an array of strings"));
	}
	// An explicitly empty array is never a valid trigger, and must not slip
	// past `match-without-globs` (which only checks absence). Parsing runs in
	// the field-types stage, which precedes that cross-field check.
	if (value.length === 0) {
		return err(invalidValue("globs", "a non-empty string or a non-empty array of strings"));
	}
	return ok(value);
};

const parseMatch = (raw: unknown): Result<MatchMode, RuleError> =>
	isMatchMode(raw) ? ok(raw) : err(invalidValue("match", `"touched", "exists", or "both"`));

const parseTools = (raw: unknown): Result<readonly string[], RuleError> => {
	const value = asStringArray(raw);
	// Unlike globs, an empty tools array is accepted (pinned behavior): it
	// simply never activates a rule on its own.
	return value === null ? err(invalidValue("tools", "a string or an array of strings")) : ok(value);
};

const parseBranch = (raw: unknown): Result<string, RuleError> =>
	typeof raw === "string" ? ok(raw) : err(invalidValue("branch", "a string"));

const parseModel = (raw: unknown): Result<string, RuleError> =>
	typeof raw === "string" ? ok(raw) : err(invalidValue("model", "a string"));

const parseAlwaysApply = (raw: unknown): Result<boolean, RuleError> =>
	typeof raw === "boolean" ? ok(raw) : err(invalidValue("alwaysApply", "a boolean"));

const describeGlobs = (value: readonly string[]): string => `files matching: ${value.join(", ")}`;
const describeMatch = (value: MatchMode): string => `activation paths: ${value}`;
const describeTools = (value: readonly string[]): string => `tools: ${value.join(", ")}`;
const describeModel = (value: string): string => `model: ${value}`;
const describeBranch = (value: string): string => `branch: ${value}`;
const describeAlwaysApply = (value: boolean): string => (value ? "always applied" : "conditional");

const globsSpec: PathConditionSpec<readonly string[]> = {
	kind: "path",
	parse: parseGlobs,
	describe: describeGlobs,
	buildPredicate: globMatcher,
};

const matchSpec: ModeConditionSpec<MatchMode> = { kind: "mode", parse: parseMatch, describe: describeMatch };

const toolsSpec: CtxConditionSpec<readonly string[]> = {
	kind: "ctx",
	parse: parseTools,
	describe: describeTools,
	buildPredicate: toolsPredicate,
};

const branchSpec: CtxConditionSpec<string> = {
	kind: "ctx",
	parse: parseBranch,
	describe: describeBranch,
	buildPredicate: branchPredicate,
};

const modelSpec: CtxConditionSpec<string> = {
	kind: "ctx",
	parse: parseModel,
	describe: describeModel,
	buildPredicate: modelPredicate,
};

const alwaysApplySpec: CtxConditionSpec<boolean> = {
	kind: "ctx",
	parse: parseAlwaysApply,
	describe: describeAlwaysApply,
	buildPredicate: alwaysPredicate,
};

/**
 * Single source of truth for condition keys. Literal order mirrors the
 * frontmatter validation order, so any keyed iteration keeps today's error
 * precedence (globs → match → tools → branch → model → alwaysApply).
 */
export const CONDITION_SPECS: Readonly<Record<ConditionName, AnyConditionSpec>> = {
	globs: globsSpec,
	match: matchSpec,
	tools: toolsSpec,
	branch: branchSpec,
	model: modelSpec,
	alwaysApply: alwaysApplySpec,
};

/** All condition keys, in stable table order. */
export const CONDITION_KEYS = ["globs", "match", "tools", "branch", "model", "alwaysApply"] as const;

// Compile-time binding: the tuple must name exactly the table's keys — every
// entry a real key, and no key missing. Drift in either direction fails here.
type ConditionKeysMatchTable = (typeof CONDITION_KEYS)[number] extends keyof typeof CONDITION_SPECS
	? keyof typeof CONDITION_SPECS extends (typeof CONDITION_KEYS)[number]
		? true
		: never
	: never;
const _conditionKeysMatchTable: ConditionKeysMatchTable = true;

/**
 * Typed lookup: the spec for one key, with its exact parsed-value type.
 * This is the single sanctioned cast that undoes the record's per-key union
 * for a caller that already knows the key.
 */
export const conditionSpec = <N extends ConditionName>(name: N): ConditionSpec<ConditionValueOf<N>> =>
	CONDITION_SPECS[name] as ConditionSpec<ConditionValueOf<N>>;
