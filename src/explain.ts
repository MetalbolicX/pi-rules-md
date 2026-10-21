/**
 * Pure explanation core (rule format v1.2): powers `/rules why <path>` and
 * `/rules show <id>` (and, later, the CLI `explain` command).
 *
 * Both helpers are pure and total: no I/O, no session state, deterministic
 * for equal inputs. `explainPath` evaluates ONE cwd-relative path treated as
 * touched against every discovered rule's path condition — through the same
 * `matchRule` the engine uses, so explanations can never drift from real
 * matching — and surfaces declared non-path conditions (tools/model/branch)
 * as caveats rather than silently ignoring them. `renderRuleDetail` renders
 * one rule's metadata and verbatim body for the `show` subcommand.
 */
import { conditionSpec, CONDITION_KEYS } from "./conditions/table.ts";
import { matchRule } from "./match.ts";
import { triggerPhrase } from "./render.ts";
import { normalizedPath } from "./types.ts";
import type { EvaluationContext, MatchResult, NormalizedPath, Rule } from "./types.ts";

/** The non-path condition keys that can appear as caveats, in table order. */
const CAVEAT_KEYS = ["tools", "model", "branch"] as const;

/** Indented caveat lines for a rule's declared non-path conditions. */
const caveatLines = (rule: Rule, prefix: string): readonly string[] =>
	CAVEAT_KEYS.flatMap((name) => {
		const value = rule[name];
		return value === undefined ? [] : [`  ${prefix}${conditionSpec(name).describe(value)}`];
	});

/**
 * Explains, for one cwd-relative path treated as touched this session, what
 * each discovered rule would do and why — in discovery order. Always-active
 * rules and non-path rules (tools/model/branch triggers, no globs) are called
 * out as path-independent instead of pretending the path activated them.
 * Muted rules (opts.mutedRuleIds) are reported as session-excluded: mute wins
 * over every condition, so "would activate" would be false.
 */
export const explainPath = (
	rules: readonly Rule[],
	rawPath: string,
	opts?: { readonly mutedRuleIds?: readonly string[] },
): readonly string[] => {
	const path: NormalizedPath = normalizedPath(rawPath);
	const muted = new Set(opts?.mutedRuleIds ?? []);
	const ctx: EvaluationContext = {
		now: 0,
		cwd: normalizedPath("/"),
		isProjectTrusted: true,
		touchedPaths: [path],
		existingPaths: [],
		toolNames: [],
	};
	const lines: string[] = [`why ${path} (treated as touched this session):`];
	for (const rule of rules) {
		if (muted.has(rule.id)) {
			lines.push(`${rule.id}: muted for this session (excluded from activation)`);
			continue;
		}
		if (rule.alwaysApply) {
			lines.push(`${rule.id}: always active (path-independent)`);
			continue;
		}
		if (rule.globs === undefined) {
			lines.push(`${rule.id}: path-independent (activated by its non-path conditions, not by this path)`);
			lines.push(...caveatLines(rule, "trigger "));
			continue;
		}
		const result: MatchResult = matchRule(rule, ctx);
		if (result.matched) {
			lines.push(`${rule.id}: would activate — ${result.reasons.map(triggerPhrase).join(" · ")}`);
			lines.push(...caveatLines(rule, "also requires "));
		} else {
			lines.push(`${rule.id}: not activated by this path (${result.reason})`);
		}
	}
	return lines;
};

/**
 * Renders one rule for `/rules show <id>`: id, path, source, every declared
 * condition in table order, load and enforcement policies, then the body
 * verbatim. Unknown ids are the caller's concern (`Unknown rule: <id>`).
 */
export const renderRuleDetail = (rule: Rule): readonly string[] => {
	const lines: string[] = [rule.id, `path: ${rule.path}`, `source: ${rule.source}`];
	for (const name of CONDITION_KEYS) {
		const value = rule[name];
		if (value === undefined || (name === "alwaysApply" && value !== true)) {
			continue;
		}
		lines.push(`configured: ${conditionSpec(name).describe(value)}`);
	}
	lines.push(`load: ${rule.load ?? "pinned"}`, `enforcement: ${rule.enforcement ?? "inform"}`, "body:", rule.content);
	return lines;
};
