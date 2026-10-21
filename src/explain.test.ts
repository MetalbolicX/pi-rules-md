/**
 * Tests for the pure path-explanation core (src/explain.ts).
 *
 * `explainPath` answers "/rules why <path>": for one cwd-relative path
 * treated as touched, what each discovered rule would do and why. It is pure
 * and total — no I/O, no session state, deterministic for equal inputs — so
 * these tests drive it directly with in-memory rules.
 */
import { describe, expect, it } from "vitest";
import { explainPath } from "./explain.ts";
import { normalizedPath, ruleId } from "./types.ts";
import type { Rule } from "./types.ts";

describe("explainPath muted rules", () => {
	it("reports a muted rule as excluded instead of would-activate", () => {
		const rule = ruleWith({ id: "ts-rule", globs: ["src/**/*.ts"] });
		const lines = explainPath([rule], "src/a.ts", { mutedRuleIds: ["ts-rule"] });
		expect(lines).toContain("ts-rule: muted for this session (excluded from activation)");
		expect(lines.some((line) => line.includes("would activate"))).toBe(false);
	});

	it("keeps unmuted rules unaffected by the muted list", () => {
		const rules = [ruleWith({ id: "a", globs: ["src/**/*.ts"] }), ruleWith({ id: "b", globs: ["src/**/*.ts"] })];
		const lines = explainPath(rules, "src/a.ts", { mutedRuleIds: ["b"] });
		expect(lines).toContain("a: would activate — glob `src/**/*.ts`");
		expect(lines).toContain("b: muted for this session (excluded from activation)");
	});
});

/** Builds a minimal Rule with explicit trigger fields; defaults to a glob rule. */
const ruleWith = (fields: {
	readonly id?: string;
	readonly globs?: readonly string[] | undefined;
	readonly tools?: readonly string[];
	readonly model?: string;
	readonly branch?: string;
	readonly alwaysApply?: boolean;
}): Rule => ({
	id: ruleId(fields.id ?? "rule-a"),
	path: normalizedPath(`/work/.pi/rules/${fields.id ?? "rule-a"}.md`),
	source: "project",
	description: `test rule ${fields.id ?? "rule-a"}`,
	// Explicit undefined must stay absent so matchRule sees "no globs declared".
	...(fields.globs === undefined ? {} : { globs: fields.globs }),
	match: "touched",
	priority: 0,
	enforcement: "inform",
	...(fields.tools === undefined ? {} : { tools: fields.tools }),
	...(fields.model === undefined ? {} : { model: fields.model }),
	...(fields.branch === undefined ? {} : { branch: fields.branch }),
	alwaysApply: fields.alwaysApply ?? false,
	version: 1,
	content: `body of ${fields.id ?? "rule-a"}\n`,
});

describe("explainPath", () => {
	it("reports a glob rule that would activate, with its trigger reason", () => {
		const rule = ruleWith({ id: "ts-rule", globs: ["src/**/*.ts"] });
		const lines = explainPath([rule], "src/a.ts");
		expect(lines[0]).toBe("why src/a.ts (treated as touched this session):");
		expect(lines).toContain("ts-rule: would activate — glob `src/**/*.ts`");
	});

	it("honors negated globs: an excluded path does not activate the rule", () => {
		const rule = ruleWith({ id: "ts-rule", globs: ["src/**/*.ts", "!src/**/*.test.ts"] });
		const lines = explainPath([rule], "src/a.test.ts");
		expect(lines).toContain("ts-rule: not activated by this path (no touched path matches globs: src/**/*.ts, !src/**/*.test.ts)");
	});

	it("appends non-path declared conditions as caveats on an activating rule", () => {
		const rule = ruleWith({ id: "guarded", globs: ["src/**/*.ts"], tools: ["edit"], model: "*sonnet*", branch: "main" });
		const lines = explainPath([rule], "src/a.ts");
		expect(lines).toContain("guarded: would activate — glob `src/**/*.ts`");
		expect(lines).toContain("  also requires tools: edit");
		expect(lines).toContain("  also requires model: *sonnet*");
		expect(lines).toContain("  also requires branch: main");
	});

	it("marks alwaysApply rules as active regardless of the path", () => {
		const rule = ruleWith({ id: "always", alwaysApply: true });
		const lines = explainPath([rule], "docs/readme.txt");
		expect(lines).toContain("always: always active (path-independent)");
	});

	it("marks non-path rules as path-independent and names their real triggers", () => {
		const rule = ruleWith({ id: "tool-driven", tools: ["grep"] });
		const lines = explainPath([rule], "src/a.ts");
		expect(lines).toContain("tool-driven: path-independent (activated by its non-path conditions, not by this path)");
		expect(lines).toContain("  trigger tools: grep");
	});

	it("keeps discovery order across mixed rules and is total for an empty list", () => {
		const rules = [
			ruleWith({ id: "b-second", globs: ["src/**/*.ts"] }),
			ruleWith({ id: "a-first", globs: ["**/*.py"] }),
		];
		const lines = explainPath(rules, "src/a.ts");
		expect(lines.findIndex((line) => line.startsWith("b-second:"))).toBeLessThan(
			lines.findIndex((line) => line.startsWith("a-first:")),
		);
		expect(explainPath([], "src/a.ts")).toEqual(["why src/a.ts (treated as touched this session):"]);
	});
});
