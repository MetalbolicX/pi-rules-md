import { describe, expect, it } from "vitest";
import { normalizedPath } from "../types.ts";
import type { EvaluationContext } from "../types.ts";
import { alwaysPredicate, branchPredicate, globMatcher, modelPredicate, toolsPredicate } from "./predicates.ts";

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

describe("globMatcher", () => {
	it("ORs across positive patterns", () => {
		const matches = globMatcher(["src/**/*.ts", "docs/*.md"]);
		expect(matches(normalizedPath("src/a.ts"))).toBe(true);
		expect(matches(normalizedPath("docs/readme.md"))).toBe(true);
		expect(matches(normalizedPath("src/a.js"))).toBe(false);
	});

	it("excludes paths matching a `!` negation pattern", () => {
		const matches = globMatcher(["**/*.ts", "!**/*.test.ts"]);
		expect(matches(normalizedPath("src/a.ts"))).toBe(true);
		expect(matches(normalizedPath("src/a.test.ts"))).toBe(false);
	});

	it("returns false when no pattern matches", () => {
		const matches = globMatcher(["src/**/*.ts"]);
		expect(matches(normalizedPath("docs/readme.md"))).toBe(false);
	});

	it("matches nothing when only negation patterns are given (OR over an empty positive set)", () => {
		const matches = globMatcher(["!**/*.test.ts"]);
		expect(matches(normalizedPath("src/a.ts"))).toBe(false);
		expect(matches(normalizedPath("src/a.test.ts"))).toBe(false);
	});
});

describe("toolsPredicate", () => {
	it("is true when at least one rule tool appears in ctx.toolNames", () => {
		const matches = toolsPredicate(["edit", "bash"]);
		expect(matches(contextWith({ toolNames: ["read", "edit"] }))).toBe(true);
	});

	it("is false when no rule tool appears in ctx.toolNames", () => {
		const matches = toolsPredicate(["edit"]);
		expect(matches(contextWith({ toolNames: ["read"] }))).toBe(false);
	});

	it("is false for empty rule tools (no trigger)", () => {
		const matches = toolsPredicate([]);
		expect(matches(contextWith({ toolNames: ["read", "edit"] }))).toBe(false);
	});

	it("is false when the session reports no tools", () => {
		const matches = toolsPredicate(["edit"]);
		expect(matches(contextWith({}))).toBe(false);
	});
});

describe("modelPredicate", () => {
	it("is true on exact model equality", () => {
		const matches = modelPredicate("claude-opus-4");
		expect(matches(contextWith({ model: "claude-opus-4" }))).toBe(true);
	});

	it("is false for a different model", () => {
		const matches = modelPredicate("claude");
		expect(matches(contextWith({ model: "gpt" }))).toBe(false);
	});

	it("is false when ctx.model is undefined", () => {
		const matches = modelPredicate("claude");
		expect(matches(contextWith({}))).toBe(false);
	});

	it("is case-sensitive (exact equality, no normalization)", () => {
		const matches = modelPredicate("Claude");
		expect(matches(contextWith({ model: "claude" }))).toBe(false);
	});

	it("matches a middle-wildcard family pattern", () => {
		const matches = modelPredicate("*sonnet*");
		expect(matches(contextWith({ model: "claude-sonnet-4-5" }))).toBe(true);
		expect(matches(contextWith({ model: "claude-opus-4-5" }))).toBe(false);
	});

	it("matches a trailing-wildcard prefix pattern", () => {
		const matches = modelPredicate("claude-opus-*");
		expect(matches(contextWith({ model: "claude-opus-4-5" }))).toBe(true);
		expect(matches(contextWith({ model: "claude-sonnet-4-5" }))).toBe(false);
	});

	it("keeps an exact id as the degenerate pattern (match, mismatch, absence)", () => {
		const matches = modelPredicate("claude-opus-4-5");
		expect(matches(contextWith({ model: "claude-opus-4-5" }))).toBe(true);
		expect(matches(contextWith({ model: "claude-opus-4" }))).toBe(false);
		expect(matches(contextWith({}))).toBe(false);
	});

	it("keeps pattern matching case-sensitive", () => {
		const matches = modelPredicate("*Sonnet*");
		expect(matches(contextWith({ model: "claude-sonnet-4-5" }))).toBe(false);
	});

	it("matches nothing for an empty pattern and never throws", () => {
		const matches = modelPredicate("");
		expect(matches(contextWith({ model: "claude-opus-4-5" }))).toBe(false);
	});

	it("keeps picomatch's own `!` negation for a negated model pattern", () => {
		const matches = modelPredicate("!gpt-*");
		expect(matches(contextWith({ model: "claude-opus-4-5" }))).toBe(true);
		expect(matches(contextWith({ model: "gpt-5" }))).toBe(false);
	});

	it("keeps `*` from crossing a `/` in the model id", () => {
		expect(modelPredicate("*sonnet*")(contextWith({ model: "anthropic/claude-sonnet-4-5" }))).toBe(false);
		expect(modelPredicate("**/*sonnet*")(contextWith({ model: "anthropic/claude-sonnet-4-5" }))).toBe(true);
	});
});

describe("branchPredicate", () => {
	it("is true on exact branch equality", () => {
		const matches = branchPredicate("main");
		expect(matches(contextWith({ branch: "main" }))).toBe(true);
	});

	it("is false for a different branch", () => {
		const matches = branchPredicate("main");
		expect(matches(contextWith({ branch: "develop" }))).toBe(false);
	});

	it("is false when ctx.branch is undefined", () => {
		const matches = branchPredicate("main");
		expect(matches(contextWith({}))).toBe(false);
	});
});

describe("alwaysPredicate", () => {
	it("is constantly true regardless of context", () => {
		const matches = alwaysPredicate();
		expect(matches(contextWith({}))).toBe(true);
		expect(matches(contextWith({ toolNames: ["edit"], model: "m", branch: "b" }))).toBe(true);
	});
});
