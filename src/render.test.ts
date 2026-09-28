/**
 * Tests for section rendering (rule format v1): an ordered list of selected
 * rules plus their trigger reasons in, one InjectionBlock out, byte-stable.
 *
 * Golden files under src/render.golden/ are deliberate, checked-in expected
 * outputs; tests compare renderSection output byte-exactly and never
 * regenerate them. No I/O beyond reading those goldens happens here.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderSection, sectionId } from "./render.ts";
import type { RenderEntry } from "./render.ts";
import { normalizedPath, ruleId } from "./types.ts";
import type { MatchReason, Rule } from "./types.ts";

/**
 * Builds a Rule with only the interesting fields set; the rest mirror the
 * parser's materialized defaults (same fixture policy as match.test.ts).
 */
const ruleWith = (fields: { readonly id?: string; readonly description?: string; readonly content?: string }): Rule => ({
	id: ruleId(fields.id ?? "test-rule"),
	path: normalizedPath(".pi/rules/test.md"),
	source: "project",
	description: fields.description ?? "test rule",
	match: "both",
	priority: 0,
	enforcement: "inform",
	alwaysApply: false,
	version: 1,
	content: fields.content ?? "body",
});

/** Wraps a rule and the trigger reasons that selected it into an entry. */
const entry = (rule: Rule, reasons: readonly MatchReason[] = []): RenderEntry => ({ rule, reasons });

/** Reads a checked-in golden file byte-exactly (the only I/O these tests do). */
const golden = (name: string): string => readFileSync(new URL(`./render.golden/${name}`, import.meta.url), "utf8");

describe("sectionId", () => {
	it("is the fixed pi-rules-md constant", () => {
		expect(sectionId).toBe("pi-rules-md");
	});
});

describe("renderSection — block shape", () => {
	it("returns undefined when there is nothing to inject", () => {
		expect(renderSection([])).toBeUndefined();
	});

	it("renders description as rule heading", () => {
		const block = renderSection([entry(ruleWith({ id: "heading-id", description: "Description heading" }))]);
		expect(block?.content).toContain("## Description heading");
		expect(block?.content).not.toContain("## heading-id");
	});

	it("labels every block with the fixed section id", () => {
		const block = renderSection([entry(ruleWith({}))]);
		expect(block?.sectionId).toBe("pi-rules-md");
	});

	it("hashes the rendered content with sha-256", () => {
		const block = renderSection([entry(ruleWith({ content: "body" }))]);
		expect(block?.contentHash).toBe(createHash("sha256").update(block?.content ?? "").digest("hex"));
	});

	it("produces identical bytes for identical input — deterministic re-render", () => {
		const entries = [
			entry(ruleWith({ id: "a", description: "first", content: "alpha body" }), [{ kind: "always" }]),
			entry(ruleWith({ id: "b", description: "second", content: "beta body" }), [{ kind: "tool", tool: "bash" }]),
		];
		expect(renderSection(entries)).toEqual(renderSection([...entries]));
	});

	it("changes the hash when the active set changes", () => {
		const one = renderSection([entry(ruleWith({ id: "one", content: "one body" }))]);
		const two = renderSection([entry(ruleWith({ id: "two", content: "two body" }))]);
		expect(one?.contentHash).not.toBe(two?.contentHash);
	});

	it("normalizes trailing blank lines in a body so separators never double-blank-line (R3-001)", () => {
		const block = renderSection([
			entry(ruleWith({ id: "a", description: "padded", content: "Body line.\n\n\n" }), [{ kind: "always" }]),
			entry(ruleWith({ id: "b", description: "next", content: "Second body." })),
		]);
		// Entry region: padding collapsed, single blank line around the separator.
		expect(block?.content.endsWith("## padded\n> Triggered by: always active\nBody line.\n\n---\n\n## next\nSecond body.\n")).toBe(true);
		expect(block?.content.includes("\n\n\n")).toBe(false);
	});

	it("keeps exactly one trailing newline when the last body is padded", () => {
		const block = renderSection([entry(ruleWith({ id: "a", description: "padded", content: "Body line.\n\n\n" }))]);
		expect(block?.content.endsWith("Body line.\n")).toBe(true);
		expect(block?.content.includes("\n\n\n")).toBe(false);
	});
});

describe("renderSection — golden files", () => {
	it("renders a single rule with one trigger exactly as the golden", () => {
		const block = renderSection([
			entry(ruleWith({ id: "ts-conventions", description: "TypeScript conventions", content: "Use strict TypeScript with explicit types at module boundaries." }), [{ kind: "glob", pattern: "src/**/*.ts" }]),
		]);
		expect(block?.content).toBe(golden("single-rule.md"));
	});

	it("renders mixed trigger kinds and separators exactly as the golden, preserving reason order", () => {
		const block = renderSection([
			entry(ruleWith({ id: "safety", description: "Safety gates", content: "Never force-push shared branches. Confirm before any destructive git operation." }), [
				{ kind: "always" },
				{ kind: "glob", pattern: "**/*.md" },
				{ kind: "tool", tool: "bash" },
			]),
			entry(ruleWith({ id: "branch-hygiene", description: "Branch hygiene", content: "Keep one logical change per commit and write Conventional Commit messages." }), [
				{ kind: "branch", branch: "feat/pi-rules-md" },
				{ kind: "model", model: "gpt-6-luna" },
			]),
			entry(ruleWith({ id: "docs-style", description: "Docs style", content: "Write documentation in English with one idea per paragraph." })),
		]);
		expect(block?.content).toBe(golden("multi-rule-mixed-reasons.md"));
	});

	it("omits the trigger line entirely when a rule has no reasons", () => {
		const block = renderSection([
			entry(ruleWith({ id: "session-defaults", description: "Session defaults", content: "Prefer small, focused diffs and keep tests alongside the code they cover." })),
		]);
		expect(block?.content).toBe(golden("no-reasons.md"));
	});
});
