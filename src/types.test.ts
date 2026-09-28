import { describe, expect, expectTypeOf, it } from "vitest";
import { normalizedPath, ruleId } from "./types.ts";
import type {
	EvaluationContext,
	InjectionBlock,
	MatchReason,
	MatchResult,
	NormalizedPath,
	Rule,
	RuleError,
	RuleErrorCode,
	RuleId,
	Selection,
} from "./types.ts";

describe("branded ids", () => {
	it("ruleId produces a RuleId", () => {
		expectTypeOf(ruleId("core-style")).toEqualTypeOf<RuleId>();
		expect(ruleId("core-style")).toBe("core-style");
	});

	it("RuleId is assignable to string but plain string is not assignable to RuleId", () => {
		expectTypeOf<RuleId>().toMatchTypeOf<string>();
		expectTypeOf<string>().not.toMatchTypeOf<RuleId>();
	});
});

describe("normalizedPath", () => {
	it("converts backslashes to forward slashes", () => {
		expect(normalizedPath("src\\types.ts")).toBe("src/types.ts");
	});

	it("converts every backslash", () => {
		expect(normalizedPath("a\\b\\c.ts")).toBe("a/b/c.ts");
	});

	it("keeps forward slashes unchanged", () => {
		expect(normalizedPath("src/types.ts")).toBe("src/types.ts");
	});

	it("produces a NormalizedPath brand", () => {
		expectTypeOf(normalizedPath("src/types.ts")).toEqualTypeOf<NormalizedPath>();
	});
});

describe("Rule", () => {
	const rule: Rule = {
		id: ruleId("ts-conventions"),
		path: normalizedPath(".pi/rules/ts-conventions.md"),
		source: "project",
		description: "TypeScript conventions",
		globs: ["src/**/*.ts", "!src/**/*.test.ts"],
		match: "both",
		tools: ["read", "edit"],
		branch: "main",
		model: "claude",
		priority: 10,
		enforcement: "enforce",
		alwaysApply: false,
		version: 1,
		content: "# TS rules\n\nUse tabs.",
	};

	it("carries shell-materialized discovery and rules-relative indices", () => {
		expectTypeOf<Rule["index"]>().toEqualTypeOf<number | undefined>();
		expectTypeOf<Rule["relativePath"]>().toEqualTypeOf<NormalizedPath | undefined>();
		expectTypeOf(rule).toEqualTypeOf<Rule>();
		expect(rule.version).toBe(1);
	});

	it("accepts a rule with only required fields (optionals omitted)", () => {
		const minimal: Rule = {
			id: ruleId("always-on"),
			path: normalizedPath(".pi/rules/always-on.md"),
			source: "global",
			description: "Always applied",
			match: "both",
			priority: 0,
			enforcement: "inform",
			alwaysApply: true,
			version: 1,
			content: "Body",
		};
		expect(minimal.globs).toBeUndefined();
		expect(minimal.tools).toBeUndefined();
		expect(minimal.branch).toBeUndefined();
		expect(minimal.model).toBeUndefined();
		expectTypeOf<Rule["load"]>().toEqualTypeOf<"pinned" | "on-demand" | undefined>();
		expectTypeOf<Rule["keywords"]>().toEqualTypeOf<string[] | undefined>();
		expect(minimal.load).toBeUndefined();
		expect(minimal.keywords).toBeUndefined();
	});

	it("rejects explicit undefined on optional fields (exactOptionalPropertyTypes)", () => {
		const minimal: Rule = {
			id: ruleId("x"),
			path: normalizedPath("x.md"),
			source: "project",
			description: "x",
			match: "both",
			priority: 0,
			enforcement: "inform",
			alwaysApply: false,
			version: 1,
			content: "b",
		};
		const broken = { ...minimal, globs: undefined };
		// @ts-expect-error exactOptionalPropertyTypes forbids explicit undefined
		const assigned: Rule = broken;
		expect(assigned.globs).toBeUndefined();
	});

	it("version is the literal 1, not any number", () => {
		expectTypeOf(rule.version).toEqualTypeOf<1>();
	});
});

describe("RuleError", () => {
	it("carries a machine code, a message, and optional file context", () => {
		const error: RuleError = {
			code: "unknown-key",
			message: 'unknown frontmatter key "banana"',
			file: "rules/x.md",
		};
		expect(error.code).toBe("unknown-key");
		expect(error.message).toContain("banana");
		expect(error.file).toBe("rules/x.md");
	});

	it("omits file when absent", () => {
		const error: RuleError = { code: "missing-frontmatter", message: "no --- block" };
		expect("file" in error).toBe(false);
	});

	it("forbids explicit file: undefined (exactOptionalPropertyTypes)", () => {
		// @ts-expect-error exactOptionalPropertyTypes forbids explicit undefined
		const error: RuleError = { code: "yaml-syntax", message: "x", file: undefined };
		expect(error.code).toBe("yaml-syntax");
	});

	it("accepts the source-unreadable code with a directory as file context", () => {
		const error: RuleError = {
			code: "source-unreadable",
			message: "failed to list rules source: EACCES",
			file: "/home/u/.pi/agent/rules",
		};
		expect(error.code).toBe("source-unreadable");
		expect(error.message).toContain("EACCES");
		expect(error.file).toBe("/home/u/.pi/agent/rules");
	});

	it("narrows exhaustively on the code discriminant", () => {
		const codeOf = (error: RuleError): RuleErrorCode => {
			switch (error.code) {
				case "missing-frontmatter":
				case "yaml-syntax":
				case "unknown-key":
				case "invalid-value":
				case "missing-description":
				case "no-activation-condition":
				case "match-without-globs":
				case "invalid-version":
				case "read-failure":
				case "source-unreadable":
					return error.code;
			}
		};
		expect(codeOf({ code: "read-failure", message: "x" })).toBe("read-failure");
		expect(codeOf({ code: "source-unreadable", message: "x" })).toBe("source-unreadable");
		expectTypeOf(codeOf({ code: "invalid-version", message: "x" })).toEqualTypeOf<RuleErrorCode>();
	});
});

describe("EvaluationContext", () => {
	it("accepts a context without optional model/branch", () => {
		const ctx: EvaluationContext = {
			now: 1_700_000_000_000,
			cwd: normalizedPath("/home/dev/project"),
			isProjectTrusted: true,
			touchedPaths: [normalizedPath("src/types.ts")],
			existingPaths: [normalizedPath("src/types.ts")],
			toolNames: ["read", "edit"],
		};
		expect(ctx.isProjectTrusted).toBe(true);
	});

	it("accepts optional model and branch when present", () => {
		const ctx: EvaluationContext = {
			now: 0,
			cwd: normalizedPath("/p"),
			isProjectTrusted: false,
			touchedPaths: [],
			existingPaths: [],
			toolNames: [],
			model: "gpt",
			branch: "feat/x",
		};
		expect(ctx.model).toBe("gpt");
	});
});

describe("MatchResult", () => {
	it("matched variant carries ruleId and reasons", () => {
		const m: MatchResult = {
			matched: true,
			ruleId: ruleId("r1"),
			reasons: [{ kind: "always" }, { kind: "glob", pattern: "src/**/*.ts" }],
		};
		expect(m.matched).toBe(true);
	});

	it("unmatched variant carries ruleId and a human-readable reason", () => {
		const m: MatchResult = {
			matched: false,
			ruleId: ruleId("r1"),
			reason: "no touched path matches src/**/*.ts",
		};
		expect(m.reason).toContain("no touched path");
	});

	it("narrows on the matched discriminant", () => {
		const report = (m: MatchResult): string => {
			if (m.matched) {
				expectTypeOf(m.reasons).toEqualTypeOf<readonly MatchReason[]>();
				expectTypeOf(m.ruleId).toEqualTypeOf<RuleId>();
				return `active ${m.ruleId}`;
			}
			expectTypeOf(m.reason).toEqualTypeOf<string>();
			return `inactive ${m.ruleId}: ${m.reason}`;
		};
		expect(report({ matched: false, ruleId: ruleId("r"), reason: "x" })).toContain("inactive");
	});
});

describe("MatchReason", () => {
	it("discriminates by trigger kind", () => {
		const label = (r: MatchReason): string => {
			switch (r.kind) {
				case "always":
					return "always";
				case "glob":
					return `glob ${r.pattern}`;
				case "tool":
					return `tool ${r.tool}`;
				case "model":
					return `model ${r.model}`;
				case "branch":
					return `branch ${r.branch}`;
			}
		};
		expect(label({ kind: "always" })).toBe("always");
		expect(label({ kind: "glob", pattern: "src/**/*.ts" })).toBe("glob src/**/*.ts");
		expect(label({ kind: "tool", tool: "edit" })).toBe("tool edit");
		expect(label({ kind: "model", model: "claude" })).toBe("model claude");
		expect(label({ kind: "branch", branch: "main" })).toBe("branch main");
	});
});

describe("Selection and InjectionBlock", () => {
	it("Selection separates active rules from dropped ones with a cause", () => {
		const rule: Rule = {
			id: ruleId("dup"),
			path: normalizedPath("dup.md"),
			source: "global",
			description: "dup",
			match: "both",
			priority: 0,
			enforcement: "inform",
			alwaysApply: true,
			version: 1,
			content: "same",
		};
		const selection: Selection = {
			active: [rule],
			onDemand: [],
			dropped: [{ rule, cause: "duplicate" }],
		};
		expect(selection.active).toHaveLength(1);
		expect(selection.dropped[0]?.cause).toBe("duplicate");
	});

	it("InjectionBlock carries sectionId, content and contentHash", () => {
		const block: InjectionBlock = {
			sectionId: "pi-rules-md",
			content: "# Rules",
			contentHash: "sha256-abc",
		};
		expectTypeOf(block).toEqualTypeOf<InjectionBlock>();
		expect(block.contentHash).toBe("sha256-abc");
	});
});
