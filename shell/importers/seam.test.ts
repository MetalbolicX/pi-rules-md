/**
 * Tests for the importer seam (S11): the pure helpers every format adapter and
 * discovery share — frontmatter splitting, lenient YAML reading, importer root
 * resolution, file-stem matching, and Rule materialization.
 *
 * The seam is LENIENT by design (the opposite of `src/frontmatter.ts`), so the
 * tests pin what is tolerated (unknown keys, missing keys, absent blocks) and
 * what is still a reported parse error (broken YAML, unterminated blocks).
 */
import { describe, expect, it } from "vitest";
import { ok } from "../../src/result.ts";
import { normalizedPath, ruleId } from "../../src/types.ts";
import {
	fileNameOf,
	fileStemOf,
	importerFileStem,
	importerRootDir,
	materializeImportedRule,
	readImporterDocument,
	splitFrontmatter,
} from "./seam.ts";
import type { ImportedRule, Importer } from "./seam.ts";

/** Adapter stub: the seam helpers never call it. */
const adapter = (): ReturnType<Importer["adapter"]> => ok({ description: "d", alwaysApply: true, content: "" });

const importerWith = (overrides: Partial<Importer> = {}): Importer => ({
	name: "test",
	dir: ".github/instructions",
	fileSuffix: ".instructions.md",
	adapter,
	...overrides,
});

const file = (text: string, path = "/work/.github/instructions/a.instructions.md") => ({ path: normalizedPath(path), text });

describe("importerRootDir", () => {
	it("joins the cwd-relative importer dir onto cwd", () => {
		expect(importerRootDir("/work", importerWith())).toBe("/work/.github/instructions");
	});

	it("normalizes a Windows cwd and keeps the drive segment", () => {
		expect(importerRootDir("C:\\work\\", importerWith())).toBe("C:/work/.github/instructions");
	});

	it("never doubles the separator at a filesystem root", () => {
		expect(importerRootDir("/", importerWith())).toBe("/.github/instructions");
	});

	it.each(["../evil", "/abs/dir", "", ".", "./github", "a/../b", "a//b"])("rejects an escaping or malformed dir %s", (dir) => {
		expect(importerRootDir("/work", importerWith({ dir }))).toBeUndefined();
	});
});

describe("importerFileStem / fileStemOf / fileNameOf", () => {
	it("matches files carrying the importer suffix and returns the bare stem", () => {
		expect(importerFileStem("/work/.github/instructions/typescript.instructions.md", importerWith())).toBe("typescript");
		expect(importerFileStem("/work/.github/instructions/nested/api.instructions.md", importerWith())).toBe("api");
	});

	it("rejects any file that does not carry the importer suffix", () => {
		expect(importerFileStem("/work/.github/instructions/notes.md", importerWith())).toBeUndefined();
		expect(importerFileStem("/work/.github/instructions/notes.txt", importerWith())).toBeUndefined();
	});

	it.each(["instructions.md", "", "."])("rejects a malformed file suffix %j", (fileSuffix) => {
		expect(importerFileStem("/work/.github/instructions/a.instructions.md", importerWith({ fileSuffix }))).toBeUndefined();
	});

	it("strips the suffix from the basename and leaves a non-matching name alone", () => {
		expect(fileStemOf("/a/b/c.md", ".md")).toBe("c");
		expect(fileStemOf("/a/b/c.md", ".txt")).toBe("c.md");
		expect(fileNameOf("/a/b/c.md")).toBe("c.md");
	});
});

describe("splitFrontmatter", () => {
	it("reports no frontmatter when the file does not start with a `---` line", () => {
		expect(splitFrontmatter("plain markdown\n---\nnot a block\n")).toEqual({ kind: "absent" });
		expect(splitFrontmatter("---not-a-delimiter\nx\n---\n")).toEqual({ kind: "absent" });
	});

	it("splits a block at byte 0 and keeps the body verbatim", () => {
		expect(splitFrontmatter("---\napplyTo: src/**\n---\n\nBody line 1\nBody 2\n")).toEqual({
			kind: "present",
			body: "applyTo: src/**\n",
			content: "\nBody line 1\nBody 2\n",
		});
	});

	it("reports an unterminated block instead of treating it as body", () => {
		expect(splitFrontmatter("---\napplyTo: src/**\nBody without a closing line\n")).toEqual({ kind: "unterminated" });
		expect(splitFrontmatter("---\n")).toEqual({ kind: "unterminated" });
	});
});

describe("readImporterDocument", () => {
	it("returns the whole text as body when there is no frontmatter", () => {
		const read = readImporterDocument(file("# Heading\n\nInstructions.\n"));
		expect(read).toEqual({ ok: true, value: { kind: "absent", content: "# Heading\n\nInstructions.\n" } });
	});

	it("parses the frontmatter mapping and ignores unknown keys (lenient)", () => {
		const read = readImporterDocument(file("---\napplyTo: src/**\nversion: 7\nvendorOnly: true\n---\nBody\n"));
		expect(read).toEqual({
			ok: true,
			value: {
				kind: "present",
				frontmatter: { applyTo: "src/**", version: 7, vendorOnly: true },
				content: "Body\n",
			},
		});
	});

	it("treats an empty frontmatter block as an empty mapping", () => {
		const read = readImporterDocument(file("---\n---\nBody\n"));
		expect(read).toEqual({ ok: true, value: { kind: "present", frontmatter: {}, content: "Body\n" } });
	});

	it("reports broken YAML as a yaml-syntax error naming the real file", () => {
		const read = readImporterDocument(file("---\napplyTo: [unclosed\n---\nBody\n"));
		expect(read.ok).toBe(false);
		if (read.ok) return;
		expect(read.error.code).toBe("yaml-syntax");
		expect(read.error.file).toBe("/work/.github/instructions/a.instructions.md");
	});

	it("reports a non-mapping frontmatter root as yaml-syntax", () => {
		const read = readImporterDocument(file("---\n- a\n- b\n---\nBody\n"));
		expect(read.ok).toBe(false);
		if (read.ok) return;
		expect(read.error.code).toBe("yaml-syntax");
		expect(read.error.message).toContain("mapping");
	});

	it("reports an unterminated frontmatter block as yaml-syntax", () => {
		const read = readImporterDocument(file("---\napplyTo: src/**\nBody\n"));
		expect(read.ok).toBe(false);
		if (read.ok) return;
		expect(read.error.code).toBe("yaml-syntax");
		expect(read.error.message).toContain("unterminated");
	});
});

describe("materializeImportedRule", () => {
	const identity = {
		path: normalizedPath("/work/.github/instructions/api.instructions.md"),
		id: ruleId("api"),
		relativePath: normalizedPath("api.instructions.md"),
	};

	const imported = (overrides: Partial<ImportedRule> = {}): ImportedRule => ({
		description: "API instructions",
		alwaysApply: false,
		content: "Body\n",
		...overrides,
	});

	it("materializes the fixed importer contract: v1, touched, pinned, inform, project", () => {
		const rule = materializeImportedRule(imported({ globs: ["src/**"] }), identity);
		expect(rule).toEqual({
			id: ruleId("api"),
			path: normalizedPath("/work/.github/instructions/api.instructions.md"),
			relativePath: normalizedPath("api.instructions.md"),
			source: "project",
			description: "API instructions",
			load: "pinned",
			match: "touched",
			priority: 0,
			enforcement: "inform",
			alwaysApply: false,
			version: 1,
			content: "Body\n",
			globs: ["src/**"],
		});
	});

	it("omits globs entirely for an always-apply import", () => {
		const rule = materializeImportedRule(imported({ alwaysApply: true }), identity);
		expect(rule.alwaysApply).toBe(true);
		expect(rule.globs).toBeUndefined();
		expect("globs" in rule).toBe(false);
	});
});
