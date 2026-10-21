/**
 * Importer seam (S11): pluggable adapters that read rules authored for ANOTHER
 * tool (Copilot's `.github/instructions`, T14's `.claude/rules`, …).
 *
 * Functional core / imperative shell:
 * - An adapter is PURE and TOTAL: raw file text plus identity in,
 *   `Result<ImportedRule, RuleError>` out. It never reads the filesystem, never
 *   throws, and never knows where the rule goes.
 * - `materializeImportedRule` is the single place an import becomes a {@link Rule}:
 *   version 1, `match: "touched"`, `load: "pinned"`, `enforcement: "inform"`,
 *   `source: "project"`, `priority: 0`. Discovery owns the remaining identity
 *   (id from the shared stem namespace, absolute path, importer-root-relative
 *   reference path), so every importer behaves exactly like a native project
 *   rule downstream.
 * - Discovery owns listing and caching (shell/discovery.ts): `Importer`
 *   descriptors only say where the files live, which of them belong to the
 *   format, and how to adapt them.
 *
 * Lenient parsing — deliberately the OPPOSITE of `src/frontmatter.ts`:
 * - Unknown frontmatter keys are IGNORED, never rejected. The keys an adapter
 *   consumes are validated by that adapter; everything else is somebody else's
 *   schema and must not fail the import.
 * - Missing keys take the format's documented default (Copilot: an absent
 *   `applyTo` — or no frontmatter at all — means "applies everywhere").
 * - Only real document damage is a parse error: broken YAML, a non-mapping
 *   frontmatter root, or an unterminated `---` block. Errors carry the REAL
 *   file path so `/rules` reports them exactly where the user can fix them.
 * - Native-only strictness (required `version`/`description`, unknown-key
 *   rejection, activation-condition invariants) does NOT apply to imports.
 *
 * Splitting: the leading `---` block is split with the same delimiter rules as
 * the native parser (opening delimiter at byte 0, closing line exactly `---`),
 * implemented locally because the native splitter is private and the importer
 * must not inherit its strictness. YAML itself is still parsed by the `yaml`
 * package — the importer never re-implements YAML.
 *
 * Importer files live BELOW cwd, but their globs are authored against the
 * project root (the rule base is cwd, not the importer directory), so imported
 * rules rebase nothing (`rebaseRuleGlobs` identity) and a Copilot
 * `applyTo: src/**` matches the cwd-relative `src/**` exactly as written.
 */
import { parse } from "yaml";
import { err, ok } from "../../src/result.ts";
import type { Result } from "../../src/result.ts";
import { normalizedPath } from "../../src/types.ts";
import type { NormalizedPath, Rule, RuleError, RuleId } from "../../src/types.ts";

/** Identity an adapter needs: the file it is reading and its raw text. */
export interface ImporterFile {
	/** Absolute normalized path of the importer's file. */
	readonly path: NormalizedPath;
	/** Raw UTF-8 text, frontmatter block included. */
	readonly text: string;
}

/**
 * Rule-shaped data an adapter produces. `description` is REQUIRED — each
 * adapter materializes its own documented fallback (Copilot: the file stem).
 * `content` is the markdown body: verbatim, never trimmed.
 */
export interface ImportedRule {
	readonly description: string;
	/** Touched-path globs, when the format declares any. */
	readonly globs?: readonly string[];
	/** True when the format says "applies everywhere" (no glob needed). */
	readonly alwaysApply: boolean;
	/** Markdown body, verbatim. */
	readonly content: string;
}

/**
 * One format adapter: pure, total, lenient, and never throws. A failure is a
 * typed {@link RuleError} carrying the real file path.
 */
export type ImporterAdapter = (file: ImporterFile) => Result<ImportedRule, RuleError>;

/**
 * One importer declaration. Discovery lists `<cwd>/<dir>` recursively (the
 * existing rule-file listing), keeps the files whose name carries
 * `fileSuffix`, and adapts each through `adapter`. Both `dir` and
 * `fileSuffix` are validated again by the seam helpers, so a misconfigured
 * importer narrows itself away instead of widening the read set.
 */
export interface Importer {
	/** Stable importer name, for tests and reports (e.g. `"copilot"`). */
	readonly name: string;
	/** cwd-relative directory holding the files (e.g. `.github/instructions`). */
	readonly dir: string;
	/** Required file-name suffix (e.g. `.instructions.md`). */
	readonly fileSuffix: string;
	/** Format adapter. */
	readonly adapter: ImporterAdapter;
}

/**
 * Outcome of splitting the leading frontmatter block: absent (the file is all
 * body), present (body + markdown after the closing delimiter), or unterminated
 * (an opening `---` line with no closing line — a broken document, never body).
 */
export type FrontmatterSplit =
	| { readonly kind: "absent" }
	| { readonly kind: "present"; readonly body: string; readonly content: string }
	| { readonly kind: "unterminated" };

/**
 * Splits the leading `---` frontmatter block from the markdown body using the
 * native delimiter rules: the opening delimiter must be the very first line and
 * the closing delimiter a line containing exactly `---`. The body keeps the
 * lines between the delimiters verbatim; the markdown content starts right
 * after the closing delimiter line and is NOT trimmed.
 */
export const splitFrontmatter = (raw: string): FrontmatterSplit => {
	if (!raw.startsWith("---")) {
		return { kind: "absent" };
	}
	const firstBreak = raw.indexOf("\n");
	if (firstBreak === -1 || raw.slice(3, firstBreak).replace(/\r$/, "") !== "") {
		return { kind: "absent" };
	}
	let index = firstBreak + 1;
	for (;;) {
		const breakAt = raw.indexOf("\n", index);
		const lineEnd = breakAt === -1 ? raw.length : breakAt;
		const line = raw.slice(index, lineEnd);
		if (line === "---" || line === "---\r") {
			return {
				kind: "present",
				body: raw.slice(firstBreak + 1, index),
				content: breakAt === -1 ? "" : raw.slice(breakAt + 1),
			};
		}
		if (breakAt === -1) {
			return { kind: "unterminated" };
		}
		index = breakAt + 1;
	}
};

/** What an adapter consumes from one file: its split frontmatter and body. */
export type ImporterDocument =
	| { readonly kind: "absent"; readonly content: string }
	| { readonly kind: "present"; readonly frontmatter: Readonly<Record<string, unknown>>; readonly content: string };

/**
 * Reads one importer file leniently: no frontmatter means the whole text is the
 * body; a frontmatter block is parsed as a YAML mapping whose unknown keys are
 * preserved-and-ignored by the adapter. Only document damage becomes an error.
 */
const readMapping = (body: string, file: NormalizedPath): Result<Record<string, unknown>, RuleError> => {
	let value: unknown;
	try {
		value = parse(body, { schema: "core" });
	} catch (cause) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		return err({ code: "yaml-syntax", message: `invalid YAML frontmatter: ${detail}`, file });
	}
	if (value === null || value === undefined) {
		return ok({});
	}
	if (typeof value !== "object" || Array.isArray(value)) {
		return err({ code: "yaml-syntax", message: "invalid YAML frontmatter: frontmatter must be a YAML mapping", file });
	}
	return ok(value as Record<string, unknown>);
};

/** Reads one importer file into its split frontmatter plus body (lenient). */
export const readImporterDocument = (file: ImporterFile): Result<ImporterDocument, RuleError> => {
	const split = splitFrontmatter(file.text);
	if (split.kind === "absent") {
		return ok({ kind: "absent", content: file.text });
	}
	if (split.kind === "unterminated") {
		return err({ code: "yaml-syntax", message: "invalid YAML frontmatter: unterminated `---` block", file: file.path });
	}
	const mapping = readMapping(split.body, file.path);
	return mapping.ok ? ok({ kind: "present", frontmatter: mapping.value, content: split.content }) : mapping;
};

/**
 * Absolute normalized directory one importer reads, or `undefined` when its
 * declaration could escape the project (`..`, an absolute path, an empty
 * segment). A rejected declaration contributes nothing — the same posture as
 * a malformed nested-dir entry.
 */
export const importerRootDir = (cwd: string, importer: Importer): NormalizedPath | undefined => {
	const dir = importer.dir.replaceAll("\\", "/").replace(/\/+$/, "");
	if (dir === "" || dir.startsWith("/") || /^[A-Za-z]:\//.test(dir)) {
		return undefined;
	}
	const segments = dir.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
		return undefined;
	}
	const root = normalizedPath(cwd).replace(/\/+$/, "");
	return normalizedPath(root === "" ? `/${dir}` : `${root}/${dir}`);
};

/** Last path segment of a normalized path. */
export const fileNameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** File stem with `suffix` stripped from the basename (left intact when it does not apply). */
export const fileStemOf = (path: string, suffix: string): string => {
	const name = fileNameOf(path);
	return suffix !== "" && name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
};

/**
 * Stem of one importer file, or `undefined` when this file is not one of the
 * importer's (wrong suffix, or a malformed suffix declaration). Discovery uses
 * it both as the listing filter and as the id source, so the ids of imported
 * rules enter the SAME disambiguation namespace as native project rules:
 * `typescript.instructions.md` competes for `typescript`, never
 * `typescript.instructions`.
 */
export const importerFileStem = (path: string, importer: Importer): string | undefined => {
	const { fileSuffix } = importer;
	if (!fileSuffix.startsWith(".") || fileSuffix.length < 2) {
		return undefined;
	}
	const stem = fileStemOf(path, fileSuffix);
	return stem === "" || stem === fileNameOf(path) ? undefined : stem;
};

/** Identity discovery attaches to one adapted import. */
export interface ImportedRuleIdentity {
	/** Absolute normalized path of the importer file. */
	readonly path: NormalizedPath;
	/** Rule id resolved by discovery's shared stem namespace. */
	readonly id: RuleId;
	/** Reference path relative to the importer's own root. */
	readonly relativePath: NormalizedPath;
}

/**
 * Materializes the fixed importer contract on top of an adapter's output. This
 * is the ONLY place imported rules acquire native rule shape, so every importer
 * (Copilot today, Claude in T14) is downstream-indistinguishable from a native
 * project rule: version 1, touched matching, pinned loading, inform
 * enforcement, project source, priority 0.
 */
export const materializeImportedRule = (imported: ImportedRule, identity: ImportedRuleIdentity): Rule => ({
	id: identity.id,
	path: identity.path,
	relativePath: identity.relativePath,
	source: "project",
	description: imported.description,
	load: "pinned",
	match: "touched",
	priority: 0,
	enforcement: "inform",
	alwaysApply: imported.alwaysApply,
	version: 1,
	content: imported.content,
	...(imported.globs === undefined ? {} : { globs: imported.globs }),
});
