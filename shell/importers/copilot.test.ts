/**
 * Tests for the Copilot importer (S11): `.github/instructions/**\/*.instructions.md`
 * with `applyTo` comma-separated globs.
 *
 * The adapter is pure and LENIENT: unknown frontmatter keys are ignored, an
 * absent `applyTo` (or no frontmatter at all) means "applies everywhere"
 * (`applyTo: **`, Copilot's own semantics), and only the keys the importer
 * actually consumes are validated. Every failure is a typed RuleError naming
 * the REAL file and surfaces in `/rules`, never a throw.
 */
import { describe, expect, it } from "vitest";
import { normalizedPath } from "../../src/types.ts";
import { COPILOT_IMPORTER, copilotAdapter } from "./copilot.ts";

const PATH = normalizedPath("/work/.github/instructions/typescript.instructions.md");

const adapt = (text: string, path = PATH) => copilotAdapter({ path, text });

const withFrontmatter = (frontmatter: string, body = "Body line.\n"): string => `---\n${frontmatter}\n---\n${body}`;

describe("copilotAdapter — applyTo globs", () => {
	it("maps a single applyTo glob to a touched-path rule", () => {
		const result = adapt(withFrontmatter("applyTo: src/**/*.ts"));
		expect(result).toEqual({
			ok: true,
			value: { description: "typescript", globs: ["src/**/*.ts"], alwaysApply: false, content: "Body line.\n" },
		});
	});

	it("splits a comma-separated applyTo list, trimming entries and dropping empties", () => {
		const result = adapt(withFrontmatter('applyTo: " src/**/*.ts ,  , docs/** ,"'));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.globs).toEqual(["src/**/*.ts", "docs/**"]);
		expect(result.value.alwaysApply).toBe(false);
	});

	it("dedupes repeated globs, keeping first-seen order", () => {
		const result = adapt(withFrontmatter("applyTo: src/**, docs/**, src/**"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.globs).toEqual(["src/**", "docs/**"]);
	});

	// YAML requires the `**` to be quoted (an unquoted `*` is an alias), which is
	// exactly how Copilot documentation authors it; the adapter sees the string.
	it.each(['"**"', "'**'", "' ** '"])("maps the all-matching form %s to alwaysApply", (applyTo) => {
		const result = adapt(withFrontmatter(`applyTo: ${applyTo}`));
		expect(result).toEqual({
			ok: true,
			value: { description: "typescript", alwaysApply: true, content: "Body line.\n" },
		});
	});

	it("keeps the non-`**` globs while `**` makes the rule always-apply", () => {
		const result = adapt(withFrontmatter("applyTo: '**, src/**'"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.alwaysApply).toBe(true);
		expect(result.value.globs).toEqual(["src/**"]);
	});

	it("treats a non-`**` glob as a plain glob (no implicit always)", () => {
		const result = adapt(withFrontmatter("applyTo: '**/*.md'"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.alwaysApply).toBe(false);
		expect(result.value.globs).toEqual(["**/*.md"]);
	});
});

describe("copilotAdapter — description and leniency", () => {
	it("uses the description key when present", () => {
		const result = adapt(withFrontmatter("applyTo: src/**\ndescription: TypeScript conventions"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.description).toBe("TypeScript conventions");
	});

	it("falls back to the file stem when description is absent, empty or blank", () => {
		for (const frontmatter of ["applyTo: src/**", 'applyTo: src/**\ndescription: ""', "applyTo: src/**\ndescription: '   '"]) {
			const result = adapt(withFrontmatter(frontmatter));
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.description).toBe("typescript");
		}
	});

	it("ignores every frontmatter key it does not consume", () => {
		const result = adapt(withFrontmatter("applyTo: src/**\nversion: 9\nexcludeAgent: code-review\nmode: agent"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.globs).toEqual(["src/**"]);
	});

	it("applies everywhere when there is no frontmatter at all, body verbatim", () => {
		const text = "# Team conventions\n\nAlways write tests.\n";
		const result = adapt(text);
		expect(result).toEqual({
			ok: true,
			value: { description: "typescript", alwaysApply: true, content: text },
		});
	});

	it("applies everywhere when the frontmatter has no applyTo key", () => {
		const result = adapt(withFrontmatter("description: Conventions"));
		expect(result).toEqual({
			ok: true,
			value: { description: "Conventions", alwaysApply: true, content: "Body line.\n" },
		});
	});

	it("keeps the markdown body verbatim, blank lines included", () => {
		const result = adapt(withFrontmatter("applyTo: src/**", "\n\n# Heading\n\n- item\n"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.content).toBe("\n\n# Heading\n\n- item\n");
	});
});

describe("copilotAdapter — parse errors carry the real file", () => {
	it.each([
		["a YAML list", "applyTo:\n  - src/**\n  - docs/**"],
		["a number", "applyTo: 3"],
		["a boolean", "applyTo: true"],
	])("rejects a non-string applyTo (%s)", (_label, frontmatter) => {
		const result = adapt(withFrontmatter(frontmatter));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("invalid-value");
		expect(result.error.file).toBe(PATH);
		expect(result.error.message).toContain("applyTo");
	});

	it.each([[""], ['""'], ["' , , '"]])("rejects an empty applyTo list (%j)", (applyTo) => {
		const result = adapt(withFrontmatter(`applyTo: ${applyTo}`));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("invalid-value");
		expect(result.error.file).toBe(PATH);
	});

	it("rejects a non-string description", () => {
		const result = adapt(withFrontmatter("applyTo: src/**\ndescription:\n  - nope"));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("invalid-value");
		expect(result.error.file).toBe(PATH);
		expect(result.error.message).toContain("description");
	});

	it("propagates a broken YAML block as yaml-syntax naming the real file", () => {
		const result = adapt("---\napplyTo: [unclosed\n---\nBody\n");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("yaml-syntax");
		expect(result.error.file).toBe(PATH);
	});
});

describe("COPILOT_IMPORTER descriptor", () => {
	it("names the Copilot root, its file suffix and the adapter", () => {
		expect(COPILOT_IMPORTER.name).toBe("copilot");
		expect(COPILOT_IMPORTER.dir).toBe(".github/instructions");
		expect(COPILOT_IMPORTER.fileSuffix).toBe(".instructions.md");
		expect(COPILOT_IMPORTER.adapter).toBe(copilotAdapter);
	});
});
