/**
 * Claude importer (S11): markdown rules anywhere below `.claude/rules`.
 *
 * Mapping (Claude Code's own `.claude/rules` + `paths:` semantics,
 * code.claude.com/docs/en/claude-md):
 * - `paths` is OPTIONAL and accepts three documented shapes, all normalized to
 *   the same touched-path glob list:
 *   1. one glob string — `paths: src/**\/*.ts`;
 *   2. a comma-separated string — `paths: src/**\/*.ts, docs/**` (Claude's
 *      documented inline form), split on the commas that are OUTSIDE a `{…}`
 *      brace group, so `src/**\/*.{ts,tsx}, docs/**` is exactly two globs;
 *   3. a YAML list of glob strings — `paths: ["src/**\/*.ts", "docs/**"]`.
 *   Entries are trimmed, blank entries dropped, and duplicates collapsed to
 *   first-seen order. A string value is simply the one-entry case of the
 *   comma-separated form, so both go through the same brace-aware split.
 * - Brace expansion is a normal glob feature here: `src/**\/*.{ts,tsx}` reaches
 *   the shared glob engine (`globMatcher` → picomatch) verbatim, and picomatch
 *   expands braces itself — nothing is expanded, escaped or rewritten here.
 * - `!`-negated entries are passed through untouched. Claude does not document
 *   negation, so this importer makes no promise beyond the one the engine
 *   already keeps: a `!` entry behaves exactly like a native rule's negated
 *   glob (exclude matching paths from the positive set), and a `paths` list of
 *   ONLY negations matches nothing, like every other rule.
 * - `paths` ABSENT means "applies everywhere" (`alwaysApply: true`, no globs).
 *   A file with NO frontmatter at all is the same case. This is Claude's own
 *   default: a rule without `paths` is always applied.
 * - `**` is NOT special here (unlike Copilot's `applyTo`): it stays an ordinary
 *   glob that matches every path, so it only fires once something is touched.
 * - `description` precedence, in order: an explicit non-blank `description`
 *   string; else the FIRST body heading (`#`…`######` at line start, followed by
 *   whitespace — its `#` run is stripped and it is trimmed); else the file stem
 *   (`typescript.md` → `typescript`). A blank explicit `description` counts as
 *   absent. Headings inside fenced code blocks are not special-cased: the first
 *   line that looks like an ATX heading wins.
 * - Every other key (`globs`, `applyTo`, `version`, `match`, vendor keys, …) is
 *   IGNORED: this format belongs to Claude, so its unknown keys must never fail
 *   an import.
 * - The markdown body is everything after the closing `---` line, verbatim
 *   (blank lines included); with no frontmatter the whole file is the body.
 *
 * Failures are typed RuleErrors naming the REAL file: a `paths` value that is
 * neither a string nor a list of strings, a `paths` list whose entries all trim
 * to nothing, a non-string `description`, broken YAML, or an unterminated
 * frontmatter block. Discovery reports them in `/rules` under that same path,
 * exactly like a native rule parse error.
 */
import { err, ok } from "../../src/result.ts";
import type { Result } from "../../src/result.ts";
import type { NormalizedPath, RuleError } from "../../src/types.ts";
import { fileStemOf, readImporterDocument } from "./seam.ts";
import type { ImportedRule, Importer, ImporterAdapter, ImporterFile } from "./seam.ts";

/** Directory Claude owns, relative to the project root. */
export const CLAUDE_IMPORTER_DIR = ".claude/rules";

/**
 * Suffix identifying a Claude rule file. Claude rules are plain markdown, so
 * the suffix is `.md` and the id stem is the plain file stem
 * (`typescript.md` → `typescript`).
 */
export const CLAUDE_FILE_SUFFIX = ".md";

/** ATX heading at line start: one to six `#`, then whitespace, then the text. */
const HEADING = /^#{1,6}[ \t]+(.*)$/;

const invalid = (message: string, file: NormalizedPath): RuleError => ({ code: "invalid-value", message, file });

/** Trims entries, drops blanks, and collapses duplicates to first-seen order. */
const normalizeGlobs = (values: readonly string[]): readonly string[] => {
	const seen = new Set<string>();
	const globs: string[] = [];
	for (const value of values) {
		const glob = value.trim();
		if (glob === "" || seen.has(glob)) {
			continue;
		}
		seen.add(glob);
		globs.push(glob);
	}
	return globs;
};

/**
 * Splits Claude's comma-separated `paths` string on the commas that are NOT
 * inside a `{…}` brace group. Brace expansion is allowed in the same value
 * (`src/**\/*.{ts,tsx}`), so a naive `split(",")` would cut one glob into
 * `src/**\/*.{ts` and `tsx}`; only top-level commas separate globs. An
 * unbalanced brace simply keeps the rest as one entry — the glob engine then
 * treats it exactly as any other malformed pattern.
 */
const splitCommaSeparated = (raw: string): readonly string[] => {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let index = 0; index < raw.length; index += 1) {
		const char = raw[index];
		if (char === "{") {
			depth += 1;
		} else if (char === "}" && depth > 0) {
			depth -= 1;
		} else if (char === "," && depth === 0) {
			parts.push(raw.slice(start, index));
			start = index + 1;
		}
	}
	parts.push(raw.slice(start));
	return parts;
};

/**
 * Documented `description` fallback: the FIRST heading of the body (its `#` run
 * stripped, trimmed), skipping headings with no text. `undefined` when the body
 * has no heading at all — the caller then falls back to the file stem.
 */
const firstHeading = (content: string): string | undefined => {
	for (const line of content.split("\n")) {
		const matched = HEADING.exec(line.replace(/\r$/, ""));
		if (matched === null) {
			continue;
		}
		const text = (matched[1] ?? "").trim();
		if (text !== "") {
			return text;
		}
	}
	return undefined;
};

/** Trims entries, drops blanks, and collapses duplicates to first-seen order. */

/**
 * `paths` → globs, over the three documented shapes. `undefined` means the key
 * is absent (the rule applies everywhere); an empty result after trimming is an
 * error, never a silent "always apply" — a `paths` key that names nothing is
 * document damage the author must see.
 */
const parsePaths = (value: unknown, file: NormalizedPath): Result<readonly string[] | undefined, RuleError> => {
	if (value === undefined) {
		return ok(undefined);
	}
	if (typeof value === "string") {
		// One glob is the one-entry case of Claude's comma-separated form.
		const globs = normalizeGlobs(splitCommaSeparated(value));
		return globs.length === 0
			? err(invalid('frontmatter key "paths" is invalid: expected at least one glob', file))
			: ok(globs);
	}
	if (!Array.isArray(value)) {
		return err(
			invalid(
				'frontmatter key "paths" is invalid: expected a glob string, a comma-separated string, or a list of glob strings',
				file,
			),
		);
	}
	for (const entry of value) {
		if (typeof entry !== "string") {
			return err(invalid('frontmatter key "paths" is invalid: expected a list of glob strings', file));
		}
	}
	const globs = normalizeGlobs(value as readonly string[]);
	return globs.length === 0
		? err(invalid('frontmatter key "paths" is invalid: expected at least one glob', file))
		: ok(globs);
};

/** Documented description fallback chain: heading, then file stem. */
const fallbackDescription = (content: string, path: NormalizedPath): string =>
	firstHeading(content) ?? fileStemOf(path, CLAUDE_FILE_SUFFIX);

/**
 * Adapts one Claude rule file. Pure and total: the returned Result is the only
 * failure channel, and every error names the file being adapted.
 */
export const claudeAdapter: ImporterAdapter = (file: ImporterFile): Result<ImportedRule, RuleError> => {
	const document = readImporterDocument(file);
	if (!document.ok) {
		return document;
	}
	if (document.value.kind === "absent") {
		// No frontmatter means no `paths`: Claude applies the file everywhere.
		const { content } = document.value;
		return ok({ description: fallbackDescription(content, file.path), alwaysApply: true, content });
	}
	const { frontmatter, content } = document.value;

	const paths = parsePaths(frontmatter.paths, file.path);
	if (!paths.ok) {
		return paths;
	}
	const { description } = frontmatter;
	if (description !== undefined && typeof description !== "string") {
		return err(invalid('frontmatter key "description" is invalid: expected a string', file.path));
	}
	const explicit = typeof description === "string" ? description.trim() : "";
	const globs = paths.value;

	return ok({
		description: explicit === "" ? fallbackDescription(content, file.path) : explicit,
		alwaysApply: globs === undefined,
		content,
		...(globs === undefined ? {} : { globs }),
	});
};

/** The Claude importer declaration discovery instantiates (S11). */
export const CLAUDE_IMPORTER: Importer = {
	name: "claude",
	dir: CLAUDE_IMPORTER_DIR,
	fileSuffix: CLAUDE_FILE_SUFFIX,
	adapter: claudeAdapter,
};
