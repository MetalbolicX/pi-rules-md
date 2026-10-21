/**
 * Copilot importer (S11): files named `*.instructions.md` anywhere below
 * `.github/instructions`.
 *
 * Mapping (GitHub/VS Code Copilot instructions semantics):
 * - `applyTo` is a comma-separated list of globs. Entries are trimmed and empty
 *   entries are dropped; duplicates collapse to first-seen order.
 * - The entry `**` alone means "every file": the rule becomes `alwaysApply`
 *   with no glob left. It is the ONLY form given that meaning — `**\/*.md`,
 *   `src/**` etc. stay ordinary touched-path globs. A mixed list keeps its
 *   non-`**` globs alongside `alwaysApply: true` (honest reporting; the globs
 *   are simply redundant).
 * - An ABSENT `applyTo` — and, identically, a file with NO frontmatter at all —
 *   means "applies everywhere" (`applyTo: **`), matching Copilot's own
 *   semantics. This is the documented lenient default.
 * - `description` is optional; absent, blank, or non-string-invalid values fall
 *   back to the file stem (`typescript.instructions.md` → `typescript`). A
 *   non-string `description` is a parse error, not a fallback.
 * - Every other key (`version`, `excludeAgent`, vendor-specific keys, …) is
 *   IGNORED: this format belongs to Copilot, so its unknown keys must never
 *   fail an import.
 * - The markdown body is everything after the closing `---` line, verbatim
 *   (blank lines included); with no frontmatter the whole file is the body.
 *
 * Failures are typed RuleErrors naming the REAL file: a non-string `applyTo`,
 * an empty `applyTo` list, a non-string `description`, broken YAML, or an
 * unterminated frontmatter block. Discovery reports them in `/rules` under that
 * same path, exactly like a native rule parse error.
 */
import { err, ok } from "../../src/result.ts";
import type { Result } from "../../src/result.ts";
import type { NormalizedPath, RuleError } from "../../src/types.ts";
import { fileStemOf, readImporterDocument } from "./seam.ts";
import type { ImportedRule, Importer, ImporterAdapter, ImporterFile } from "./seam.ts";

/** Directory Copilot owns, relative to the project root. */
export const COPILOT_IMPORTER_DIR = ".github/instructions";

/** Suffix identifying a Copilot instruction file. */
export const COPILOT_FILE_SUFFIX = ".instructions.md";

/** The one documented all-matching `applyTo` entry. */
const ALL_PATHS = "**";

const invalid = (message: string, file: NormalizedPath): RuleError => ({ code: "invalid-value", message, file });

/** `applyTo` → globs: comma split, trimmed, empties dropped, duplicates collapsed. */
const splitApplyTo = (raw: string): readonly string[] => {
	const seen = new Set<string>();
	const globs: string[] = [];
	for (const entry of raw.split(",")) {
		const glob = entry.trim();
		if (glob === "" || seen.has(glob)) {
			continue;
		}
		seen.add(glob);
		globs.push(glob);
	}
	return globs;
};

/** Documented description fallback: the file stem. */
const fallbackDescription = (path: NormalizedPath): string => fileStemOf(path, COPILOT_FILE_SUFFIX);

/**
 * Adapts one Copilot instructions file. Pure and total: the returned Result is
 * the only failure channel, and every error names the file being adapted.
 */
export const copilotAdapter: ImporterAdapter = (file: ImporterFile): Result<ImportedRule, RuleError> => {
	const document = readImporterDocument(file);
	if (!document.ok) {
		return document;
	}
	if (document.value.kind === "absent") {
		// No frontmatter means no `applyTo`: Copilot applies the file everywhere.
		return ok({ description: fallbackDescription(file.path), alwaysApply: true, content: document.value.content });
	}
	const { frontmatter, content } = document.value;

	const { applyTo, description } = frontmatter;
	let globs: readonly string[] | undefined;
	let alwaysApply = true;
	if (applyTo !== undefined) {
		if (typeof applyTo !== "string") {
			return err(invalid('frontmatter key "applyTo" is invalid: expected a comma-separated string of globs', file.path));
		}
		const entries = splitApplyTo(applyTo);
		if (entries.length === 0) {
			return err(invalid('frontmatter key "applyTo" is invalid: expected at least one glob', file.path));
		}
		alwaysApply = entries.includes(ALL_PATHS);
		const rest = entries.filter((entry) => entry !== ALL_PATHS);
		globs = rest.length === 0 ? undefined : rest;
	}

	if (description !== undefined && typeof description !== "string") {
		return err(invalid('frontmatter key "description" is invalid: expected a string', file.path));
	}
	const descriptionText = typeof description === "string" ? description.trim() : "";

	return ok({
		description: descriptionText === "" ? fallbackDescription(file.path) : descriptionText,
		alwaysApply,
		content,
		...(globs === undefined ? {} : { globs }),
	});
};

/** The Copilot importer declaration discovery instantiates (S11). */
export const COPILOT_IMPORTER: Importer = {
	name: "copilot",
	dir: COPILOT_IMPORTER_DIR,
	fileSuffix: COPILOT_FILE_SUFFIX,
	adapter: copilotAdapter,
};
