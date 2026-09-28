import { describe, expect, it } from "vitest";
import { createReadRuleTool, readRuleContent } from "./read-rule.ts";
import { normalizedPath, ruleId } from "../src/types.ts";
import type { Rule } from "../src/types.ts";

const rule = (fields: { readonly name?: string; readonly body?: string; readonly load?: "pinned" | "on-demand" }): Rule => ({
	id: ruleId(fields.name ?? "python-style"),
	path: normalizedPath("/rules/python/style.md"),
	relativePath: normalizedPath("python/style.md"),
	source: "global",
	description: "Python style",
	load: fields.load ?? "on-demand",
	match: "both",
	priority: 0,
	enforcement: "inform",
	alwaysApply: true,
	version: 1,
	content: fields.body ?? "Use descriptive names.\n",
});

const execute = async (name: string, rules: readonly Rule[]) => {
	const tool = createReadRuleTool(() => rules);
	return tool.execute("tool-call", { name }, undefined, undefined, {} as never);
};

describe("read_rule", () => {
	it("returns the body for an exact rules-relative path", async () => {
		const expected = "Use descriptive names.\n";
		expect(readRuleContent("python/style.md", [rule({ body: expected })])).toBe(expected);
	});

	it("returns Unknown rule for an unknown name", async () => {
		expect(await execute("python/missing.md", [rule({})])).toMatchObject({
			content: [{ type: "text", text: "Unknown rule: python/missing.md" }],
		});
	});

	it("rejects traversal, POSIX absolute, and Windows absolute names", () => {
		for (const name of ["../secret.md", "python/../secret.md", "/etc/passwd", "C:\\rules\\style.md", "\\\\server\\share\\rule.md"]) {
			expect(readRuleContent(name, [rule({})])).toBe(`Unknown rule: ${name}`);
		}
	});

	it("returns the rule body for a rule with on-demand load policy", async () => {
		const body = "Reference rule full body, available through read_rule.";
		expect(await execute("python/style.md", [rule({ load: "on-demand", body })])).toMatchObject({
			content: [{ type: "text", text: body }],
		});
	});

	it("never throws if the discovered-rule provider fails", async () => {
		const tool = createReadRuleTool(() => { throw new Error("discovery unavailable"); });
		await expect(tool.execute("tool-call", { name: "python/style.md" }, undefined, undefined, {} as never)).resolves.toMatchObject({
			content: [{ type: "text", text: "Unknown rule: python/style.md" }],
		});
	});
});
