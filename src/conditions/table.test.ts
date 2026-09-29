import { describe, expect, it } from "vitest";
import { parseRule } from "../frontmatter.ts";
import type { RuleMeta } from "../frontmatter.ts";
import type { Result } from "../result.ts";
import { normalizedPath, ruleId } from "../types.ts";
import type { EvaluationContext, NormalizedPath, Rule, RuleError } from "../types.ts";
import type { Predicate } from "./predicates.ts";
import { CONDITION_KEYS, CONDITION_SPECS, conditionSpec } from "./table.ts";
import type { ConditionName, ConditionValueOf } from "./table.ts";

/** Unwraps an err result for assertion; fails the test on ok. */
const errOf = <T>(result: Result<T, RuleError>): RuleError => {
	if (result.ok) {
		throw new Error(`expected err, got ok: ${JSON.stringify(result.value)}`);
	}
	return result.error;
};

/** Unwraps an ok result for assertion; fails the test on err. */
const okOf = <T>(result: Result<T, RuleError>): T => {
	if (!result.ok) {
		throw new Error(`expected ok, got err: ${result.error.code} — ${result.error.message}`);
	}
	return result.value;
};

/** Returns the error code of a failed parse; fails the test on ok. */
const codeOf = (result: Result<Rule, RuleError>): RuleError["code"] => errOf(result).code;

/** Wraps a YAML body into a full frontmatter block. */
const fm = (yamlBody: string, content = ""): string => `---\n${yamlBody}\n---\n${content}`;

const meta: RuleMeta = { path: normalizedPath(".pi/rules/t.md"), source: "project" };

/**
 * Builds an EvaluationContext with only the interesting fields set; optional
 * fields stay truly absent (exactOptionalPropertyTypes-safe).
 */
const contextWith = (fields: {
	readonly toolNames?: readonly string[];
	readonly model?: string;
	readonly branch?: string;
}): EvaluationContext => ({
	now: 0,
	cwd: normalizedPath("/proj"),
	isProjectTrusted: true,
	touchedPaths: [],
	existingPaths: [],
	toolNames: fields.toolNames ?? [],
	...(fields.model === undefined ? {} : { model: fields.model }),
	...(fields.branch === undefined ? {} : { branch: fields.branch }),
});

/**
 * Builds and applies the ctx predicate for one condition key. The kind
 * discriminant narrows the spec union without any cast; a non-ctx kind is a
 * test failure, not silent misuse.
 */
const ctxPredicateFor = <N extends ConditionName>(
	name: N,
	value: ConditionValueOf<N>,
): Predicate<EvaluationContext> => {
	const spec = conditionSpec(name);
	if (spec.kind !== "ctx") {
		throw new Error(`condition "${name}" must build an EvaluationContext predicate`);
	}
	return spec.buildPredicate(value);
};

/** Same narrowing for the globs path-level matcher. */
const pathPredicateFor = (globs: readonly string[]): Predicate<NormalizedPath> => {
	const spec = conditionSpec("globs");
	if (spec.kind !== "path") {
		throw new Error('condition "globs" must build a path predicate');
	}
	return spec.buildPredicate(globs);
};

describe("CONDITION_SPECS — registry shape", () => {
	it("exposes exactly the six condition keys in stable table order", () => {
		expect(CONDITION_KEYS).toEqual(["globs", "match", "tools", "branch", "model", "alwaysApply"]);
	});

	it("gives every entry callable parse and describe functions", () => {
		for (const name of CONDITION_KEYS) {
			const spec = CONDITION_SPECS[name];
			expect(typeof spec.parse).toBe("function");
			expect(typeof spec.describe).toBe("function");
		}
	});

	it("builds predicates for every key except match (the mode selector)", () => {
		for (const name of CONDITION_KEYS) {
			expect(CONDITION_SPECS[name].kind === "mode").toBe(name === "match");
		}
	});
});

describe("globs spec", () => {
	it("parses a string into a one-element array", () => {
		expect(okOf(conditionSpec("globs").parse("src/**/*.ts"))).toEqual(["src/**/*.ts"]);
	});

	it("parses an array of strings verbatim", () => {
		expect(okOf(conditionSpec("globs").parse(["a", "!b"]))).toEqual(["a", "!b"]);
	});

	it("rejects a non-string non-array value", () => {
		const error = errOf(conditionSpec("globs").parse(5));
		expect(error.code).toBe("invalid-value");
		expect(error.message).toContain("globs");
		expect(error.message).toContain("string");
	});

	it("rejects an array with a non-string element", () => {
		const error = errOf(conditionSpec("globs").parse([1, 2]));
		expect(error.code).toBe("invalid-value");
		expect(error.message).toContain("globs");
	});

	it("rejects an empty array (never a valid trigger)", () => {
		const error = errOf(conditionSpec("globs").parse([]));
		expect(error.code).toBe("invalid-value");
		expect(error.message).toContain("non-empty");
	});

	it("describes the patterns comma-joined", () => {
		expect(conditionSpec("globs").describe(["**/*.ts", "!**/*.test.ts"])).toBe(
			"files matching: **/*.ts, !**/*.test.ts",
		);
	});

	it("builds a path matcher honoring positive and negated patterns", () => {
		const matches = pathPredicateFor(["src/**/*.ts", "!src/**/*.test.ts"]);
		expect(matches(normalizedPath("src/a.ts"))).toBe(true);
		expect(matches(normalizedPath("src/a.test.ts"))).toBe(false);
		expect(matches(normalizedPath("docs/readme.md"))).toBe(false);
	});
});

describe("match spec", () => {
	it("parses every mode", () => {
		expect(okOf(conditionSpec("match").parse("touched"))).toBe("touched");
		expect(okOf(conditionSpec("match").parse("exists"))).toBe("exists");
		expect(okOf(conditionSpec("match").parse("both"))).toBe("both");
	});

	it("rejects an unknown mode", () => {
		const error = errOf(conditionSpec("match").parse("sometimes"));
		expect(error.code).toBe("invalid-value");
		expect(error.message).toContain("match");
	});

	it("describes the mode", () => {
		expect(conditionSpec("match").describe("both")).toBe("activation paths: both");
	});

	it("exposes no buildPredicate (path-set traversal is match.ts's job)", () => {
		expect(conditionSpec("match").kind).toBe("mode");
	});
});

describe("tools spec", () => {
	it("parses a string into a one-element array", () => {
		expect(okOf(conditionSpec("tools").parse("edit"))).toEqual(["edit"]);
	});

	it("parses an array of strings verbatim", () => {
		expect(okOf(conditionSpec("tools").parse(["read", "edit"]))).toEqual(["read", "edit"]);
	});

	it("accepts an empty array (pinned: only globs rejects emptiness)", () => {
		expect(okOf(conditionSpec("tools").parse([]))).toEqual([]);
	});

	it("rejects a non-string non-array value", () => {
		const error = errOf(conditionSpec("tools").parse(true));
		expect(error.code).toBe("invalid-value");
		expect(error.message).toContain("tools");
	});

	it("describes the tools comma-joined", () => {
		expect(conditionSpec("tools").describe(["read", "bash"])).toBe("tools: read, bash");
	});

	it("builds a ctx predicate matching any declared tool", () => {
		const matches = ctxPredicateFor("tools", ["edit", "bash"]);
		expect(matches(contextWith({ toolNames: ["read", "edit"] }))).toBe(true);
		expect(matches(contextWith({ toolNames: ["read"] }))).toBe(false);
		expect(matches(contextWith({}))).toBe(false);
	});
});

describe("model spec", () => {
	it("parses a string model id", () => {
		expect(okOf(conditionSpec("model").parse("claude"))).toBe("claude");
	});

	it("rejects a non-string model", () => {
		const error = errOf(conditionSpec("model").parse(["claude"]));
		expect(error.code).toBe("invalid-value");
		expect(error.message).toContain("model");
	});

	it("describes the model", () => {
		expect(conditionSpec("model").describe("claude-opus-4")).toBe("model: claude-opus-4");
	});

	it("builds an exact-match ctx predicate", () => {
		const matches = ctxPredicateFor("model", "claude");
		expect(matches(contextWith({ model: "claude" }))).toBe(true);
		expect(matches(contextWith({ model: "gpt" }))).toBe(false);
		expect(matches(contextWith({}))).toBe(false);
	});
});

describe("branch spec", () => {
	it("parses a branch name", () => {
		expect(okOf(conditionSpec("branch").parse("main"))).toBe("main");
	});

	it("rejects a non-string branch", () => {
		const error = errOf(conditionSpec("branch").parse(7));
		expect(error.code).toBe("invalid-value");
		expect(error.message).toContain("branch");
	});

	it("describes the branch", () => {
		expect(conditionSpec("branch").describe("main")).toBe("branch: main");
	});

	it("builds an exact-match ctx predicate", () => {
		const matches = ctxPredicateFor("branch", "main");
		expect(matches(contextWith({ branch: "main" }))).toBe(true);
		expect(matches(contextWith({ branch: "develop" }))).toBe(false);
		expect(matches(contextWith({}))).toBe(false);
	});
});

describe("alwaysApply spec", () => {
	it("parses booleans", () => {
		expect(okOf(conditionSpec("alwaysApply").parse(true))).toBe(true);
		expect(okOf(conditionSpec("alwaysApply").parse(false))).toBe(false);
	});

	it("rejects a non-boolean (string stays a string under the strict schema)", () => {
		const error = errOf(conditionSpec("alwaysApply").parse("yes"));
		expect(error.code).toBe("invalid-value");
		expect(error.message).toContain("alwaysApply");
		expect(error.message).toContain("boolean");
	});

	it("describes true as always applied", () => {
		expect(conditionSpec("alwaysApply").describe(true)).toBe("always applied");
	});

	it("describes false as conditional", () => {
		expect(conditionSpec("alwaysApply").describe(false)).toBe("conditional");
	});

	it("builds a constantly-true ctx predicate", () => {
		const matches = ctxPredicateFor("alwaysApply", false);
		expect(matches(contextWith({}))).toBe(true);
	});
});

describe("table — frontmatter round-trip", () => {
	it("accepts a rule using every condition key, parsed through the table", () => {
		const raw = fm(
			[
				"description: x",
				"version: 1",
				'globs: "src/**/*.ts"',
				"match: touched",
				"tools: [read]",
				"branch: main",
				"model: claude",
				"alwaysApply: false",
			].join("\n"),
		);
		const rule = okOf(parseRule(raw, meta));
		expect(rule.id).toBe(ruleId("project:.pi/rules/t.md"));
		expect(rule.globs).toEqual(["src/**/*.ts"]);
		expect(rule.match).toBe("touched");
		expect(rule.tools).toEqual(["read"]);
		expect(rule.branch).toBe("main");
		expect(rule.model).toBe("claude");
		expect(rule.alwaysApply).toBe(false);
	});

	it("accepts every condition key that can activate a rule on its own", () => {
		const bodies: readonly (readonly [ConditionName, string])[] = [
			["globs", "globs: a"],
			["tools", "tools: [edit]"],
			["model", "model: m"],
			["branch", "branch: b"],
			["alwaysApply", "alwaysApply: true"],
		];
		for (const [name, body] of bodies) {
			const rule = okOf(parseRule(fm(`description: x\nversion: 1\n${body}`), meta));
			expect(rule.id).toBe(ruleId("project:.pi/rules/t.md"));
		}
	});

	it("routes a lone match key to match-without-globs, not unknown-key", () => {
		expect(codeOf(parseRule(fm("description: x\nversion: 1\nmatch: touched"), meta))).toBe("match-without-globs");
	});

	it("still rejects an unregistered key as unknown-key", () => {
		const error = errOf(parseRule(fm("description: x\nversion: 1\nalwaysApply: true\nbanana: yes"), meta));
		expect(error.code).toBe("unknown-key");
		expect(error.message).toContain("banana");
	});
});
