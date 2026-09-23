import { describe, expect, it } from "vitest";
import { parseRule, readRuleFile } from "./frontmatter.ts";
import type { RuleMeta } from "./frontmatter.ts";
import type { Result } from "./result.ts";
import { normalizedPath, ruleId } from "./types.ts";
import type { Rule, RuleError } from "./types.ts";

/** Unwraps an err result for assertion; fails the test on ok. */
const errOf = (result: Result<Rule, RuleError>): RuleError => {
	if (result.ok) {
		throw new Error(`expected err, got ok: ${JSON.stringify(result.value)}`);
	}
	return result.error;
};

/** Unwraps an ok result for assertion; fails the test on err. */
const okOf = (result: Result<Rule, RuleError>): Rule => {
	if (!result.ok) {
		throw new Error(`expected ok, got err: ${result.error.code} — ${result.error.message}`);
	}
	return result.value;
};

/** Wraps a YAML body into a full frontmatter block with optional trailing content. */
const fm = (yamlBody: string, content = ""): string => `---\n${yamlBody}\n---\n${content}`;

const projectMeta: RuleMeta = { path: normalizedPath(".pi/rules/ts.md"), source: "project" };

const GOLDEN = fm(
	[
		"description: TypeScript conventions",
		"version: 1",
		"globs:",
		'  - "src/**/*.ts"',
		'  - "!src/**/*.test.ts"',
		"match: touched",
		"tools: [read, edit]",
		"branch: main",
		"model: claude",
		"priority: 10",
		"enforcement: enforce",
		"alwaysApply: false",
	].join("\n"),
	"# TS rules\n\nUse tabs.\n\nDone.\n",
);

const MINIMAL = fm(["description: Always on", "version: 1", "alwaysApply: true"].join("\n"), "Body.");

describe("parseRule — happy path", () => {
	it("parses a golden rule with every field populated", () => {
		const rule = okOf(parseRule(GOLDEN, projectMeta));
		expect(rule).toEqual({
			id: ruleId("project:.pi/rules/ts.md"),
			path: normalizedPath(".pi/rules/ts.md"),
			source: "project",
			description: "TypeScript conventions",
			globs: ["src/**/*.ts", "!src/**/*.test.ts"],
			match: "touched",
			tools: ["read", "edit"],
			branch: "main",
			model: "claude",
			priority: 10,
			enforcement: "enforce",
			alwaysApply: false,
			version: 1,
			content: "# TS rules\n\nUse tabs.\n\nDone.",
		});
	});

	it("materializes defaults on a minimal rule (match both, priority 0, enforcement inform)", () => {
		const meta: RuleMeta = { path: normalizedPath(".pi/rules/mini.md"), source: "global" };
		const rule = okOf(parseRule(MINIMAL, meta));
		expect(rule.match).toBe("both");
		expect(rule.priority).toBe(0);
		expect(rule.enforcement).toBe("inform");
		expect(rule.alwaysApply).toBe(true);
		expect(rule.id).toBe(ruleId("global:.pi/rules/mini.md"));
	});

	it("defaults alwaysApply to false when absent", () => {
		const rule = okOf(parseRule(fm("description: x\nversion: 1\nglobs: src/**/*.ts"), projectMeta));
		expect(rule.alwaysApply).toBe(false);
		expect(rule.globs).toEqual(["src/**/*.ts"]);
	});

	it("derives a distinct id per source for the same path", () => {
		const globalMeta: RuleMeta = { path: normalizedPath(".pi/rules/ts.md"), source: "global" };
		const project = okOf(parseRule(MINIMAL, projectMeta));
		const global = okOf(parseRule(MINIMAL, globalMeta));
		expect(project.id).toBe(ruleId("project:.pi/rules/ts.md"));
		expect(global.id).toBe(ruleId("global:.pi/rules/ts.md"));
	});

	it("preserves inner blank lines and indentation in content, trimming only edge blank lines", () => {
		const raw = fm("description: keep\nversion: 1\nalwaysApply: true", "\nfirst\n\n  indented\n\n \nlast\n\n");
		const rule = okOf(parseRule(raw, projectMeta));
		expect(rule.content).toBe("first\n\n  indented\n\n \nlast");
	});

	it("normalizes a single string globs/tools value into an array", () => {
		const rule = okOf(parseRule(fm("description: x\nversion: 1\nglobs: src/**/*.ts\ntools: edit"), projectMeta));
		expect(rule.globs).toEqual(["src/**/*.ts"]);
		expect(rule.tools).toEqual(["edit"]);
	});

	it("is deterministic: same input yields an equal result", () => {
		expect(parseRule(GOLDEN, projectMeta)).toEqual(parseRule(GOLDEN, projectMeta));
	});
});

describe("parseRule — frontmatter structure", () => {
	it("rejects a file with no frontmatter block", () => {
		const error = errOf(parseRule("just markdown\n\nno delimiters\n", projectMeta));
		expect(error.code).toBe("missing-frontmatter");
		expect(error.file).toBe(projectMeta.path);
	});

	it("rejects an unterminated frontmatter block", () => {
		const error = errOf(parseRule("---\ndescription: x\nversion: 1\n", projectMeta));
		expect(error.code).toBe("missing-frontmatter");
	});

	it("rejects frontmatter not starting at byte 0", () => {
		const error = errOf(parseRule("\n---\ndescription: x\nversion: 1\n---\n", projectMeta));
		expect(error.code).toBe("missing-frontmatter");
	});

	it("rejects YAML syntax errors", () => {
		const error = errOf(parseRule(fm("description: [unclosed"), projectMeta));
		expect(error.code).toBe("yaml-syntax");
		expect(error.message).toContain("invalid YAML frontmatter");
	});

	it("rejects YAML that uses tabs for indentation", () => {
		const error = errOf(parseRule(fm("version: 1\ndescription: x\n\tglobs: nope"), projectMeta));
		expect(error.code).toBe("yaml-syntax");
	});

	it("rejects YAML anchors and aliases", () => {
		const error = errOf(
			parseRule(fm("version: 1\ndescription: x\nanchor: &a hello\nref: *a"), projectMeta),
		);
		expect(error.code).toBe("yaml-syntax");
	});

	it("rejects a non-mapping frontmatter root", () => {
		const error = errOf(parseRule("---\n- just\n- a list\n---\n", projectMeta));
		expect(error.code).toBe("yaml-syntax");
	});
});

describe("parseRule — strict validation", () => {
	it("rejects unknown frontmatter keys, naming the key", () => {
		const error = errOf(parseRule(fm("description: x\nversion: 1\nalwaysApply: true\nbanana: yes"), projectMeta));
		expect(error.code).toBe("unknown-key");
		expect(error.message).toContain("banana");
	});

	it("rejects an absent version", () => {
		const error = errOf(parseRule(fm("description: x\nalwaysApply: true"), projectMeta));
		expect(error.code).toBe("invalid-version");
	});

	it("rejects a version other than 1", () => {
		const error = errOf(parseRule(fm("description: x\nversion: 2\nalwaysApply: true"), projectMeta));
		expect(error.code).toBe("invalid-version");
	});

	it("rejects a non-numeric version (no unsafe coercion)", () => {
		const error = errOf(parseRule(fm('description: x\nversion: "1"\nalwaysApply: true'), projectMeta));
		expect(error.code).toBe("invalid-version");
	});

	it("rejects an absent description", () => {
		const error = errOf(parseRule(fm("version: 1\nalwaysApply: true"), projectMeta));
		expect(error.code).toBe("missing-description");
	});

	it("rejects an empty description", () => {
		const error = errOf(parseRule(fm('description: ""\nversion: 1\nalwaysApply: true'), projectMeta));
		expect(error.code).toBe("missing-description");
	});

	it("rejects a whitespace-only description", () => {
		const error = errOf(parseRule(fm("description: \"   \"\nversion: 1\nalwaysApply: true"), projectMeta));
		expect(error.code).toBe("missing-description");
	});

	it("rejects a non-string globs value, naming the key and expected type", () => {
		const error = errOf(parseRule(fm("description: x\nversion: 1\nalwaysApply: true\nglobs: 5"), projectMeta));
		expect(error.code).toBe("invalid-value");
		expect(error.message).toContain("globs");
		expect(error.message).toContain("string");
	});

	it("rejects a globs array with a non-string element", () => {
		const error = errOf(parseRule(fm("description: x\nversion: 1\nalwaysApply: true\nglobs: [1, 2]"), projectMeta));
		expect(error.code).toBe("invalid-value");
		expect(error.message).toContain("globs");
	});

	it("rejects a non-string tools value", () => {
		const error = errOf(parseRule(fm("description: x\nversion: 1\nalwaysApply: true\ntools: true"), projectMeta));
		expect(error.code).toBe("invalid-value");
		expect(error.message).toContain("tools");
	});

	it("rejects a non-integer priority", () => {
		const error = errOf(parseRule(fm("description: x\nversion: 1\nalwaysApply: true\npriority: 1.5"), projectMeta));
		expect(error.code).toBe("invalid-value");
		expect(error.message).toContain("integer");
	});

	it("rejects a string priority (no unsafe coercion)", () => {
		const error = errOf(parseRule(fm('description: x\nversion: 1\nalwaysApply: true\npriority: "5"'), projectMeta));
		expect(error.code).toBe("invalid-value");
	});

	it("rejects an unknown match value, naming the key", () => {
		const error = errOf(
			parseRule(fm('description: x\nversion: 1\nalwaysApply: true\nglobs: a\nmatch: "sometimes"'), projectMeta),
		);
		expect(error.code).toBe("invalid-value");
		expect(error.message).toContain("match");
	});

	it("rejects an unknown enforcement value", () => {
		const error = errOf(
			parseRule(fm("description: x\nversion: 1\nalwaysApply: true\nenforcement: block"), projectMeta),
		);
		expect(error.code).toBe("invalid-value");
		expect(error.message).toContain("enforcement");
	});

	it("rejects a non-boolean alwaysApply (string stays a string under the strict schema)", () => {
		const error = errOf(
			parseRule(fm("description: x\nversion: 1\nalwaysApply: yes"), projectMeta),
		);
		expect(error.code).toBe("invalid-value");
		expect(error.message).toContain("alwaysApply");
		expect(error.message).toContain("boolean");
	});

	it("rejects a non-string branch", () => {
		const error = errOf(parseRule(fm("description: x\nversion: 1\nbranch: 7"), projectMeta));
		expect(error.code).toBe("invalid-value");
		expect(error.message).toContain("branch");
	});

	it("rejects a non-string model", () => {
		const error = errOf(parseRule(fm("description: x\nversion: 1\nmodel: [claude]"), projectMeta));
		expect(error.code).toBe("invalid-value");
		expect(error.message).toContain("model");
	});

	it("requires at least one activation condition", () => {
		const error = errOf(parseRule(fm("description: x\nversion: 1\npriority: 3"), projectMeta));
		expect(error.code).toBe("no-activation-condition");
	});

	it("rejects match present without globs", () => {
		const error = errOf(parseRule(fm("description: x\nversion: 1\nmatch: touched"), projectMeta));
		expect(error.code).toBe("match-without-globs");
		expect(error.message).toContain("match");
	});
});

describe("parseRule — explicitly empty globs", () => {
	it("rejects globs: [] even when another activation condition is present", () => {
		const error = errOf(parseRule(fm("description: x\nversion: 1\nglobs: []\ntools: [edit]"), projectMeta));
		expect(error.code).toBe("invalid-value");
		expect(error.message).toContain("globs");
	});

	it("rejects match with globs: [] as invalid-value (field-types stage precedes match-without-globs)", () => {
		const error = errOf(parseRule(fm("description: x\nversion: 1\nglobs: []\nmatch: touched"), projectMeta));
		expect(error.code).toBe("invalid-value");
		expect(error.message).toContain("globs");
	});

	it("keeps match-without-globs for globs-absent even when another activation condition is present", () => {
		const error = errOf(parseRule(fm("description: x\nversion: 1\nmatch: touched\ntools: [edit]"), projectMeta));
		expect(error.code).toBe("match-without-globs");
		expect(error.message).toContain("match");
	});
});

describe("parseRule — condition table integration", () => {
	it("still recognizes metadata keys outside the condition table", () => {
		const error = errOf(parseRule(fm("description: x\nversion: 1\npriority: 3"), projectMeta));
		expect(error.code).toBe("no-activation-condition");
	});

	it("checks unknown keys before condition field types", () => {
		const error = errOf(parseRule(fm("description: x\nversion: 1\nglobs: 5\nbanana: yes"), projectMeta));
		expect(error.code).toBe("unknown-key");
		expect(error.message).toContain("banana");
	});

	it("keeps condition field-type checks before metadata checks", () => {
		const error = errOf(parseRule(fm("description: x\nversion: 1\npriority: 1.5\nglobs: 5"), projectMeta));
		expect(error.code).toBe("invalid-value");
		expect(error.message).toContain("globs");
	});

	it("attaches the rule file to condition parse errors", () => {
		const error = errOf(parseRule(fm("description: x\nversion: 1\nglobs: 5"), projectMeta));
		expect(error.code).toBe("invalid-value");
		expect(error.file).toBe(projectMeta.path);
	});
});

describe("readRuleFile", () => {
	it("reads through the injected readFile and parses the rule", async () => {
		const requested: string[] = [];
		const readFile = async (path: string): Promise<string> => {
			requested.push(path);
			return MINIMAL;
		};
		const meta: RuleMeta = { path: normalizedPath(".pi/rules/mini.md"), source: "global" };
		const result = await readRuleFile(readFile, meta);
		expect(requested).toEqual([".pi/rules/mini.md"]);
		const rule = okOf(result);
		expect(rule.id).toBe(ruleId("global:.pi/rules/mini.md"));
		expect(rule.alwaysApply).toBe(true);
	});

	it("propagates parse errors from the file body", async () => {
		const readFile = async (_path: string): Promise<string> => "plain markdown, no frontmatter";
		const result = await readRuleFile(readFile, projectMeta);
		expect(errOf(result).code).toBe("missing-frontmatter");
	});

	it("maps readFile failure to read-failure without throwing", async () => {
		const readFile = async (_path: string): Promise<string> => {
			throw new Error("EACCES: permission denied");
		};
		const result = await readRuleFile(readFile, projectMeta);
		const error = errOf(result);
		expect(error.code).toBe("read-failure");
		expect(error.message).toContain("EACCES");
		expect(error.file).toBe(projectMeta.path);
	});
});
