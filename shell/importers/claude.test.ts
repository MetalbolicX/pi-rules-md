/**
 * Tests for the Claude importer (S11): `.claude/rules/**\/*.md` with optional
 * `paths`.
 *
 * Claude's own semantics (code.claude.com/docs/en/claude-md `paths:`):
 * - `paths` is optional. With NO `paths` — and equally with no frontmatter at
 *   all — the rule applies everywhere (Claude's "no paths = always applied").
 * - It accepts three documented shapes: one glob string, a comma-separated
 *   string of globs, or a YAML list of glob strings. Brace expansion
 *   (`src/**\/*.{ts,tsx}`) is a normal glob feature and must work.
 * - `description` is optional; the fallback is the FIRST `#` heading of the
 *   body, and the file stem when the body has no heading.
 *
 * Like every importer, the adapter is PURE, TOTAL and LENIENT: unknown
 * frontmatter keys are ignored, and only the keys this format consumes are
 * validated. Every failure is a typed RuleError naming the REAL file.
 *
 * Discovery is exercised against real temp directories (production
 * `nodeDiscoveryDeps`), because the Claude importer must be indistinguishable
 * from any other project rule downstream: same trust gate, same mtime cache,
 * same ordering slot, same id namespace.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { globMatcher } from "../../src/conditions/predicates.ts";
import { normalizedPath } from "../../src/types.ts";
import { discover, nodeDiscoveryDeps } from "../discovery.ts";
import type { DiscoveryCache } from "../discovery.ts";
import { CLAUDE_IMPORTER, claudeAdapter } from "./claude.ts";
import { COPILOT_IMPORTER } from "./copilot.ts";
import type { Importer } from "./seam.ts";

const PATH = normalizedPath("/work/.claude/rules/typescript.md");

const adapt = (text: string, path = PATH) => claudeAdapter({ path, text });

const withFrontmatter = (frontmatter: string, body = "Body line.\n"): string => `---\n${frontmatter}\n---\n${body}`;

describe("claudeAdapter — paths forms", () => {
	it("maps a single `paths` string to a touched-path rule", () => {
		const result = adapt(withFrontmatter("paths: src/**/*.ts"));
		expect(result).toEqual({
			ok: true,
			value: { description: "typescript", globs: ["src/**/*.ts"], alwaysApply: false, content: "Body line.\n" },
		});
	});

	it("splits a comma-separated `paths` string, trimming entries and dropping empties", () => {
		const result = adapt(withFrontmatter('paths: " src/**/*.ts ,  , docs/** ,"'));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.globs).toEqual(["src/**/*.ts", "docs/**"]);
		expect(result.value.alwaysApply).toBe(false);
	});

	it("maps a `paths` list to its entries, trimming each and keeping order", () => {
		const result = adapt(withFrontmatter("paths:\n  - src/**/*.ts\n  - ' docs/** '"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.globs).toEqual(["src/**/*.ts", "docs/**"]);
		expect(result.value.alwaysApply).toBe(false);
	});

	it("keeps a brace group intact when splitting the comma-separated form", () => {
		const result = adapt(withFrontmatter('paths: "src/**/*.{ts,tsx}, docs/**"'));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.globs).toEqual(["src/**/*.{ts,tsx}", "docs/**"]);
	});

	it("drops blank entries in the list form, like the comma-separated form", () => {
		const result = adapt(withFrontmatter("paths:\n  - src/**\n  - '  '\n  - ''"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.globs).toEqual(["src/**"]);
	});

	it("dedupes repeated entries, keeping first-seen order", () => {
		const result = adapt(withFrontmatter("paths:\n  - src/**\n  - docs/**\n  - src/**"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.globs).toEqual(["src/**", "docs/**"]);
	});

	it("passes brace expansion through verbatim and it matches through the real glob engine", () => {
		const result = adapt(withFrontmatter("paths: src/**/*.{ts,tsx}"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.globs).toEqual(["src/**/*.{ts,tsx}"]);
		// picomatch expands braces natively; pinned here so the claim cannot rot.
		const matches = globMatcher(result.value.globs ?? []);
		expect(matches(normalizedPath("src/a.ts"))).toBe(true);
		expect(matches(normalizedPath("src/n/b.tsx"))).toBe(true);
		expect(matches(normalizedPath("src/n/b.js"))).toBe(false);
	});

	it("passes `!` entries through, so they behave exactly like native negations", () => {
		const result = adapt(withFrontmatter("paths:\n  - src/**/*.ts\n  - '!src/**/*.test.ts'"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.globs).toEqual(["src/**/*.ts", "!src/**/*.test.ts"]);
		const matches = globMatcher(result.value.globs ?? []);
		expect(matches(normalizedPath("src/a.ts"))).toBe(true);
		expect(matches(normalizedPath("src/a.test.ts"))).toBe(false);
	});

	it("treats `**` as an ordinary glob, not as Copilot's all-matching form", () => {
		const result = adapt(withFrontmatter("paths: '**'"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.alwaysApply).toBe(false);
		expect(result.value.globs).toEqual(["**"]);
	});

	it("applies everywhere when `paths` is absent (Claude: no paths = always applied)", () => {
		const result = adapt(withFrontmatter("description: Conventions"));
		expect(result).toEqual({
			ok: true,
			value: { description: "Conventions", alwaysApply: true, content: "Body line.\n" },
		});
	});

	it("applies everywhere when there is no frontmatter at all, body verbatim", () => {
		const text = "# Team conventions\n\nAlways write tests.\n";
		const result = adapt(text);
		expect(result).toEqual({
			ok: true,
			value: { description: "Team conventions", alwaysApply: true, content: text },
		});
	});
});

describe("claudeAdapter — description precedence", () => {
	it("uses an explicit `description` over the body heading", () => {
		const result = adapt(withFrontmatter("paths: src/**\ndescription: TypeScript conventions", "# Body heading\n"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.description).toBe("TypeScript conventions");
	});

	it("falls back to the FIRST heading of the body (any level, `#` runs stripped)", () => {
		for (const [heading, expected] of [
			["# TypeScript", "TypeScript"],
			["## Nested heading", "Nested heading"],
			["###   Spaced   ", "Spaced"],
		] as const) {
			const result = adapt(withFrontmatter("paths: src/**", `Intro line.\n\n${heading}\n\nBody.\n`));
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.description).toBe(expected);
		}
	});

	it("takes the first heading, not a later one", () => {
		const result = adapt(withFrontmatter("paths: src/**", "# First\n\n# Second\n"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.description).toBe("First");
	});

	it("falls back to the file stem when the body has no heading", () => {
		const result = adapt(withFrontmatter("paths: src/**", "Just prose, no heading.\n#hashtag not a heading\n"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.description).toBe("typescript");
	});

	it("treats a blank explicit description as absent (heading, then stem)", () => {
		const blank = adapt(withFrontmatter("paths: src/**\ndescription: '   '", "# Heading wins\n"));
		expect(blank.ok).toBe(true);
		if (!blank.ok) return;
		expect(blank.value.description).toBe("Heading wins");
		const stem = adapt(withFrontmatter("paths: src/**\ndescription: ''", "No heading here.\n"));
		expect(stem.ok).toBe(true);
		if (!stem.ok) return;
		expect(stem.value.description).toBe("typescript");
	});
});

describe("claudeAdapter — leniency and parse errors", () => {
	it("ignores every frontmatter key it does not consume", () => {
		const result = adapt(withFrontmatter("paths: src/**\napplyTo: docs/**\nglobs: [nope]\nmatch: exists\nversion: 9"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.globs).toEqual(["src/**"]);
	});

	it("keeps the markdown body verbatim, blank lines included", () => {
		const result = adapt(withFrontmatter("paths: src/**", "\n\n# Heading\n\n- item\n"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.content).toBe("\n\n# Heading\n\n- item\n");
	});

	it.each([
		["a number", "paths: 3"],
		["a boolean", "paths: true"],
		["a mapping", "paths:\n  - a: b"],
		["a nested list", "paths:\n  - [src/**]"],
	])("rejects a non-string, non-list-of-strings `paths` (%s)", (_label, frontmatter) => {
		const result = adapt(withFrontmatter(frontmatter));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("invalid-value");
		expect(result.error.file).toBe(PATH);
		expect(result.error.message).toContain("paths");
	});

	it.each([
		["an empty string", "paths: ''"],
		["only commas", "paths: ' , , '"],
		["an empty list", "paths: []"],
		["a list of blank entries", "paths:\n  - '  '\n  - ''"],
	])("rejects `paths` that trims down to nothing (%s)", (_label, frontmatter) => {
		const result = adapt(withFrontmatter(frontmatter));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("invalid-value");
		expect(result.error.file).toBe(PATH);
		expect(result.error.message).toContain("paths");
	});

	it("rejects a non-string description", () => {
		const result = adapt(withFrontmatter("paths: src/**\ndescription:\n  - nope"));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("invalid-value");
		expect(result.error.file).toBe(PATH);
		expect(result.error.message).toContain("description");
	});

	it("propagates broken YAML and unterminated frontmatter as errors naming the real file", () => {
		for (const text of ["---\npaths: [unclosed\n---\nBody\n", "---\npaths: src/**\nBody\n"]) {
			const result = adapt(text);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.code).toBe("yaml-syntax");
			expect(result.error.file).toBe(PATH);
		}
	});
});

describe("CLAUDE_IMPORTER descriptor", () => {
	it("names the Claude root, its file suffix and the adapter", () => {
		expect(CLAUDE_IMPORTER.name).toBe("claude");
		expect(CLAUDE_IMPORTER.dir).toBe(".claude/rules");
		expect(CLAUDE_IMPORTER.fileSuffix).toBe(".md");
		expect(CLAUDE_IMPORTER.adapter).toBe(claudeAdapter);
	});
});

/** Both production importer declarations, in production order (Copilot, then Claude). */
const IMPORTING: readonly Importer[] = [COPILOT_IMPORTER, CLAUDE_IMPORTER];

/** Runs production discovery over one temp repo, with the given importer list. */
const discoverRepo = async (
	root: string,
	importers: readonly Importer[] = IMPORTING,
	cache: DiscoveryCache = new Map(),
	trusted = true,
) =>
	discover(nodeDiscoveryDeps(), cache, {
		globalDir: join(root, "no-global-rules"),
		projectDirs: [],
		cwd: normalizedPath(root),
		isProjectTrusted: trusted,
		importers,
	});

describe("Claude importer discovery (S11)", () => {
	it("lists `.claude/rules/**/*.md` recursively with the importer contract", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-rules-md-claude-"));
		try {
			await mkdir(join(root, ".claude/rules/nested"), { recursive: true });
			await writeFile(join(root, ".claude/rules/typescript.md"), "---\npaths: src/**/*.ts\n---\nUse strict types.\n");
			await writeFile(join(root, ".claude/rules/nested/api.md"), "---\npaths:\n  - api/**\n---\nAPI rules.\n");
			// Not markdown: ignored entirely, not even read.
			await writeFile(join(root, ".claude/rules/notes.txt"), "---\npaths: src/**\n---\nignored\n");
			const result = await discoverRepo(root);
			expect(result.errors).toEqual([]);
			expect(result.rules.map((rule) => rule.id)).toEqual(["api", "typescript"]);
			expect(result.rules.find((rule) => rule.id === "typescript")).toMatchObject({
				source: "project",
				match: "touched",
				load: "pinned",
				enforcement: "inform",
				priority: 0,
				version: 1,
				alwaysApply: false,
				description: "typescript",
				globs: ["src/**/*.ts"],
				relativePath: normalizedPath("typescript.md"),
				content: "Use strict types.\n",
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("keeps imported globs cwd-relative (importer base IS cwd)", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-rules-md-claude-globs-"));
		try {
			await mkdir(join(root, ".claude/rules"), { recursive: true });
			await writeFile(join(root, ".claude/rules/b.md"), "---\npaths: packages/b/src/**\n---\nB.\n");
			const result = await discoverRepo(root);
			expect(result.rules[0]?.globs).toEqual(["packages/b/src/**"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("places Claude rules after Copilot's and before global, sharing ONE id namespace", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-rules-md-claude-order-"));
		try {
			await mkdir(join(root, ".pi/rules"), { recursive: true });
			await mkdir(join(root, ".github/instructions"), { recursive: true });
			await mkdir(join(root, ".claude/rules"), { recursive: true });
			await mkdir(join(root, "global"), { recursive: true });
			const native = "---\ndescription: Native\nversion: 1\nglobs: ['src/**']\nmatch: touched\n---\nNative body.\n";
			// The SAME stem in every source: each later source takes the next suffix,
			// so ordering and one shared namespace are both observable.
			await writeFile(join(root, ".pi/rules/typescript.md"), native);
			await writeFile(join(root, ".github/instructions/typescript.instructions.md"), "---\napplyTo: src/**\n---\nCopilot.\n");
			await writeFile(join(root, ".claude/rules/typescript.md"), "---\npaths: src/**\n---\nClaude.\n");
			await writeFile(join(root, "global/typescript.md"), native);
			const result = await discover(nodeDiscoveryDeps(), new Map(), {
				globalDir: join(root, "global"),
				projectDirs: [{ dir: join(root, ".pi/rules"), base: root }],
				cwd: normalizedPath(root),
				isProjectTrusted: true,
				importers: IMPORTING,
			});
			expect(result.rules.map((rule) => `${rule.source}:${rule.id}:${rule.content.trim()}`)).toEqual([
				"project:typescript:Native body.",
				"project:typescript-2:Copilot.",
				"project:typescript-3:Claude.",
				"global:typescript-4:Native body.",
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("lists nothing from `.claude/rules` when the project is untrusted", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-rules-md-claude-trust-"));
		try {
			await mkdir(join(root, ".claude/rules"), { recursive: true });
			await writeFile(join(root, ".claude/rules/typescript.md"), "---\npaths: src/**\n---\nBody.\n");
			const result = await discoverRepo(root, IMPORTING, new Map(), false);
			expect(result.rules).toEqual([]);
			expect(result.errors).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reports a Claude parse error under the REAL file and keeps the other rules", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-rules-md-claude-error-"));
		try {
			await mkdir(join(root, ".claude/rules"), { recursive: true });
			const broken = join(root, ".claude/rules/broken.md");
			await writeFile(broken, "---\npaths: 3\n---\nBody.\n");
			await writeFile(join(root, ".claude/rules/ok.md"), "---\npaths: src/**\n---\nOk.\n");
			const result = await discoverRepo(root);
			expect(result.rules.map((rule) => rule.id)).toEqual(["ok"]);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]?.code).toBe("invalid-value");
			expect(result.errors[0]?.file).toBe(normalizedPath(broken));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reuses the mtime cache for Claude files and re-reads on change", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-rules-md-claude-cache-"));
		try {
			await mkdir(join(root, ".claude/rules"), { recursive: true });
			const file = join(root, ".claude/rules/typescript.md");
			await writeFile(file, "---\npaths: src/**\n---\nBody.\n");
			const one = await discoverRepo(root);
			expect(one.rules[0]?.globs).toEqual(["src/**"]);
			const two = await discoverRepo(root, IMPORTING, one.cache);
			expect(two.rules).toEqual(one.rules);
			// Rewrite with a newer mtime: the new globs win.
			await writeFile(file, "---\npaths: docs/**\n---\nBody.\n");
			const three = await discoverRepo(root, IMPORTING, two.cache);
			expect(three.rules[0]?.globs).toEqual(["docs/**"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("lists nothing when importers are disabled (PI_RULES_IMPORT=none shape)", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-rules-md-claude-off-"));
		try {
			await mkdir(join(root, ".claude/rules"), { recursive: true });
			await writeFile(join(root, ".claude/rules/typescript.md"), "---\npaths: src/**\n---\nBody.\n");
			const result = await discoverRepo(root, []);
			expect(result.rules).toEqual([]);
			expect(result.errors).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
