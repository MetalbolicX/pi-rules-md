/**
 * Predicate factories for rule activation conditions (rule format v1).
 *
 * Each factory closes over the rule's field value and returns a pure
 * predicate — no classes, no mutation, no I/O. Predicates never throw: an
 * absent optional context field (model, branch) simply never matches.
 *
 * `globMatcher` is path-level: it answers "does this one normalized path
 * match the rule globs?". Composing it across the touched/existing path sets
 * (and deciding touched-vs-exists per rule `match` mode) is match.ts's job
 * (task 5), not this module's.
 */
import * as picomatchModule from "picomatch";
import type { EvaluationContext, NormalizedPath } from "../types.ts";

/** picomatch matcher for a single path. */
type Matcher = (path: string) => boolean;

/** picomatch pattern-list factory producing a matcher. */
type PicomatchFactory = (patterns: readonly string[]) => Matcher;

// picomatch ships CJS with `export =` typings and this repo keeps
// `esModuleInterop` off, so under Node's ESM-CJS interop the callable factory
// lands on the namespace `default` export. Unwrapped exactly once, here.
const picomatch = (picomatchModule as unknown as { readonly default: PicomatchFactory }).default;

/**
 * Builds a path-level glob matcher for rule `globs`.
 *
 * Observed picomatch 4.x behavior (pinned by tests): passing the array
 * verbatim ORs across ALL entries INCLUDING `!`-negated ones, so
 * `["**\/*.ts", "!**\/*.test.ts"]` would still match `*.test.ts` paths. To
 * get rule semantics — OR across positive patterns, then EXCLUDE any path
 * matching a `!` pattern — positives and negatives are split here and
 * composed as `positive(path) && !negative(path)`.
 *
 * With no positive patterns (only negations, or none at all) the matcher
 * matches nothing: the OR over an empty positive set is false.
 */
export const globMatcher = (globs: readonly string[]): ((path: NormalizedPath) => boolean) => {
	const positives: string[] = [];
	const negatives: string[] = [];
	for (const glob of globs) {
		if (glob.startsWith("!")) {
			negatives.push(glob.slice(1));
		} else {
			positives.push(glob);
		}
	}
	const matchesPositive = picomatch(positives);
	const matchesNegative = picomatch(negatives);
	return (path) => matchesPositive(path) && !matchesNegative(path);
};

/**
 * Matches when at least one of the rule's tools appears in the session's
 * tool names. Empty `ruleTools` never matches: a rule must declare a trigger.
 */
export const toolsPredicate = (ruleTools: readonly string[]): ((ctx: EvaluationContext) => boolean) => {
	const wanted = new Set(ruleTools);
	return (ctx) => ctx.toolNames.some((tool) => wanted.has(tool));
};

/** Exact, case-sensitive model-name equality; an absent session model never matches. */
export const modelPredicate = (model: string): ((ctx: EvaluationContext) => boolean) => (ctx) => ctx.model === model;

/**
 * Exact branch-name equality (v1: no branch globs — pattern support would
 * need a rule-format decision; revisit only if a format version adds them).
 * An absent session branch never matches.
 */
export const branchPredicate = (branch: string): ((ctx: EvaluationContext) => boolean) => (ctx) =>
	ctx.branch === branch;

/** Constant true — backs rules with `alwaysApply: true`. */
export const alwaysPredicate = (): ((ctx: EvaluationContext) => boolean) => () => true;
