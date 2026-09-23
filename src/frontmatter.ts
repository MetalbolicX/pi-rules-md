/**
 * Strict frontmatter parser for rule format v1.
 *
 * `parseRule` is pure: raw file text plus discovery metadata in,
 * `Result<Rule, RuleError>` out — it never throws and never touches the
 * filesystem. Filesystem access lives in `readRuleFile`, which takes the
 * read call as an injected parameter (functional core / imperative shell).
 *
 * Strictness policy (every failure is a typed RuleError, never silent):
 * - YAML is parsed with the core schema: no YAML 1.1 unsafe coercions
 *   (`yes` stays the string "yes"), duplicate keys are rejected.
 * - Anchors and aliases are rejected outright: rules are data, not templates.
 * - Unknown keys are errors; every known key has an exact expected type.
 * - Defaults are materialized here so `Rule` fields stay required downstream.
 */
import { isAlias, isMap, isScalar, isSeq, parseDocument, visit } from "yaml";
import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";
import { ruleId } from "./types.ts";
import type { Enforcement, MatchMode, NormalizedPath, Rule, RuleError, RuleErrorCode, RuleSource } from "./types.ts";

/** Discovery metadata for a rule file, threaded through parsing and errors. */
export interface RuleMeta {
	/** Normalized path of the rule file. */
	readonly path: NormalizedPath;
	/** Where the rule was discovered. */
	readonly source: RuleSource;
}

/** Frontmatter keys rule format v1 knows about; anything else is an error. */
const KNOWN_KEYS: ReadonlySet<string> = new Set([
	"alwaysApply",
	"branch",
	"description",
	"enforcement",
	"globs",
	"match",
	"model",
	"priority",
	"tools",
	"version",
]);

const MATCH_MODES: readonly MatchMode[] = ["touched", "exists", "both"];
const ENFORCEMENTS: readonly Enforcement[] = ["enforce", "recommend", "inform"];

const ruleError = (code: RuleErrorCode, message: string, file?: string): RuleError =>
	file === undefined ? { code, message } : { code, message, file };

const yamlSyntax = (detail: string, file: NormalizedPath): RuleError =>
	ruleError("yaml-syntax", `invalid YAML frontmatter: ${detail}`, file);

const invalidValue = (key: string, expected: string, file: NormalizedPath): RuleError =>
	ruleError("invalid-value", `frontmatter key "${key}" is invalid: expected ${expected}`, file);

/**
 * Splits the leading `---` frontmatter block from the markdown body.
 * The opening delimiter must be the very first line (byte 0) and the closing
 * delimiter must be a line containing exactly `---`. Returns null when the
 * block is absent, misplaced, or unterminated.
 */
const splitFrontmatter = (raw: string): { readonly frontmatter: string; readonly content: string } | null => {
	if (!raw.startsWith("---")) {
		return null;
	}
	const firstBreak = raw.indexOf("\n");
	if (firstBreak === -1 || raw.slice(3, firstBreak).replace(/\r$/, "") !== "") {
		return null;
	}
	let index = firstBreak + 1;
	for (;;) {
		const breakAt = raw.indexOf("\n", index);
		const lineEnd = breakAt === -1 ? raw.length : breakAt;
		const line = raw.slice(index, lineEnd);
		if (line === "---" || line === "---\r") {
			return {
				frontmatter: raw.slice(firstBreak + 1, index),
				content: breakAt === -1 ? "" : raw.slice(breakAt + 1),
			};
		}
		if (breakAt === -1) {
			return null;
		}
		index = breakAt + 1;
	}
};

/** Trims leading/trailing blank lines only; inner formatting is kept verbatim. */
const trimBlankEdges = (content: string): string =>
	content.replace(/^(?:[^\S\n]*\n)+/, "").replace(/(?:\n[^\S\n]*)+$/, "");

/**
 * Parses the frontmatter body into a plain key/value mapping with anchors,
 * aliases, duplicate keys, and non-mapping roots rejected.
 */
const parseYamlBody = (frontmatter: string, file: NormalizedPath): Result<Record<string, unknown>, RuleError> => {
	const doc = parseDocument(frontmatter, { schema: "core", uniqueKeys: true });
	if (doc.errors.length > 0) {
		return err(yamlSyntax(doc.errors[0]?.message ?? "unparseable document", file));
	}
	let forbidden: string | undefined;
	visit(doc.contents, (_key, node) => {
		if (isAlias(node)) {
			forbidden ??= "aliases are not allowed";
		} else if ((isScalar(node) || isMap(node) || isSeq(node)) && typeof node.anchor === "string") {
			forbidden ??= "anchors are not allowed";
		}
		return undefined;
	});
	if (forbidden !== undefined) {
		return err(yamlSyntax(forbidden, file));
	}
	const value: unknown = doc.toJS();
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return err(yamlSyntax("frontmatter must be a YAML mapping", file));
	}
	return ok(value as Record<string, unknown>);
};

/** Accepts a string (normalized to a one-element array) or an array of strings. */
const asStringArray = (value: unknown): readonly string[] | null => {
	if (typeof value === "string") {
		return [value];
	}
	if (Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string")) {
		return [...value];
	}
	return null;
};

const isMatchMode = (value: unknown): value is MatchMode => MATCH_MODES.includes(value as MatchMode);

const isEnforcement = (value: unknown): value is Enforcement => ENFORCEMENTS.includes(value as Enforcement);

/**
 * Parses raw rule file text into a validated {@link Rule}. Pure and total:
 * every failure path returns a typed RuleError, never a thrown exception.
 */
export const parseRule = (raw: string, meta: RuleMeta): Result<Rule, RuleError> => {
	const file = meta.path;
	const split = splitFrontmatter(raw);
	if (split === null) {
		return err(
			ruleError(
				"missing-frontmatter",
				"no frontmatter block: rule files must start with a `---` line and close it with a second `---` line",
				file,
			),
		);
	}
	const parsed = parseYamlBody(split.frontmatter, file);
	if (!parsed.ok) {
		return parsed;
	}
	const frontmatter: Record<string, unknown> = parsed.value;

	for (const key of Object.keys(frontmatter)) {
		if (!KNOWN_KEYS.has(key)) {
			return err(ruleError("unknown-key", `unknown frontmatter key "${key}"`, file));
		}
	}

	if (frontmatter["version"] !== 1) {
		return err(
			ruleError("invalid-version", 'frontmatter key "version" is required and must be exactly the number 1', file),
		);
	}

	const description = frontmatter["description"];
	if (typeof description !== "string" || description.trim() === "") {
		return err(
			ruleError(
				"missing-description",
				'frontmatter key "description" is required and must be a non-empty string',
				file,
			),
		);
	}

	let globs: readonly string[] | undefined;
	if (frontmatter["globs"] !== undefined) {
		const parsedGlobs = asStringArray(frontmatter["globs"]);
		if (parsedGlobs === null) {
			return err(invalidValue("globs", "a string or an array of strings", file));
		}
		// An explicitly empty array is never a valid trigger, and must not slip
		// past `match-without-globs` (which only checks absence) leaving a dead
		// `match` key. This runs in the field-types stage, which precedes the
		// match-without-globs check below.
		if (parsedGlobs.length === 0) {
			return err(invalidValue("globs", "a non-empty string or a non-empty array of strings", file));
		}
		globs = parsedGlobs;
	}

	const matchValue = frontmatter["match"];
	if (matchValue !== undefined && !isMatchMode(matchValue)) {
		return err(invalidValue("match", `"touched", "exists", or "both"`, file));
	}

	let tools: readonly string[] | undefined;
	if (frontmatter["tools"] !== undefined) {
		const parsedTools = asStringArray(frontmatter["tools"]);
		if (parsedTools === null) {
			return err(invalidValue("tools", "a string or an array of strings", file));
		}
		tools = parsedTools;
	}

	const branchValue = frontmatter["branch"];
	if (branchValue !== undefined && typeof branchValue !== "string") {
		return err(invalidValue("branch", "a string", file));
	}

	const modelValue = frontmatter["model"];
	if (modelValue !== undefined && typeof modelValue !== "string") {
		return err(invalidValue("model", "a string", file));
	}

	const priorityValue = frontmatter["priority"];
	if (priorityValue !== undefined && (typeof priorityValue !== "number" || !Number.isInteger(priorityValue))) {
		return err(invalidValue("priority", "an integer", file));
	}

	const enforcementValue = frontmatter["enforcement"];
	if (enforcementValue !== undefined && !isEnforcement(enforcementValue)) {
		return err(invalidValue("enforcement", `"enforce", "recommend", or "inform"`, file));
	}

	const alwaysApplyValue = frontmatter["alwaysApply"];
	if (alwaysApplyValue !== undefined && typeof alwaysApplyValue !== "boolean") {
		return err(invalidValue("alwaysApply", "a boolean", file));
	}

	const hasGlobs = globs !== undefined && globs.length > 0;
	if (matchValue !== undefined && globs === undefined) {
		return err(ruleError("match-without-globs", 'frontmatter key "match" requires "globs" to be set', file));
	}

	const hasActivation =
		hasGlobs ||
		(tools !== undefined && tools.length > 0) ||
		typeof branchValue === "string" ||
		typeof modelValue === "string" ||
		alwaysApplyValue === true;
	if (!hasActivation) {
		return err(
			ruleError(
				"no-activation-condition",
				"rule has no activation condition: set one of globs, tools, branch, model, or alwaysApply: true",
				file,
			),
		);
	}

	// Defaults are materialized exactly once, here, so Rule stays concrete.
	const rule: Rule = {
		id: ruleId(`${meta.source}:${file}`),
		path: file,
		source: meta.source,
		description,
		match: matchValue ?? "both",
		priority: priorityValue ?? 0,
		enforcement: enforcementValue ?? "inform",
		alwaysApply: alwaysApplyValue ?? false,
		version: 1,
		content: trimBlankEdges(split.content),
		...(globs === undefined ? {} : { globs }),
		...(tools === undefined ? {} : { tools }),
		...(branchValue === undefined ? {} : { branch: branchValue as string }),
		...(modelValue === undefined ? {} : { model: modelValue as string }),
	};
	return ok(rule);
};

/**
 * Thin injected-fs wrapper: reads the rule file through the supplied
 * `readFile` and parses it. Never throws — a read failure becomes a
 * `"read-failure"` RuleError and parse failures propagate as their own codes.
 */
export const readRuleFile = async (
	readFile: (path: string) => Promise<string>,
	meta: RuleMeta,
): Promise<Result<Rule, RuleError>> => {
	let raw: string;
	try {
		raw = await readFile(meta.path);
	} catch (cause) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		return err(ruleError("read-failure", `failed to read rule file: ${detail}`, meta.path));
	}
	return parseRule(raw, meta);
};
