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
 * - Unknown keys are errors; the accepted set is derived from the condition
 *   table (src/conditions/table.ts) plus the metadata keys checked here.
 * - The six condition keys parse THROUGH the table: each table spec owns its
 *   key's type rules (and error message); this module attaches the file and
 *   keeps the cross-field invariants, in the same stage order as before:
 *   field-types (via table) → match-without-globs → no-activation-condition.
 * - Defaults are materialized here so `Rule` fields stay required downstream.
 */
import { isAlias, isMap, isScalar, isSeq, parseDocument, visit } from "yaml";
import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";
import { CONDITION_KEYS, conditionSpec } from "./conditions/table.ts";
import type { ConditionName, ConditionValueOf } from "./conditions/table.ts";
import { ruleId } from "./types.ts";
import type { Enforcement, NormalizedPath, Rule, RuleError, RuleErrorCode, RuleSource } from "./types.ts";

/** Discovery metadata for a rule file, threaded through parsing and errors. */
export interface RuleMeta {
	/** Normalized path of the rule file. */
	readonly path: NormalizedPath;
	/** Where the rule was discovered. */
	readonly source: RuleSource;
}

/** Metadata keys validated directly here; condition keys come from the table. */
const METADATA_KEYS: readonly string[] = ["description", "enforcement", "keywords", "load", "priority", "version"];

/** Every accepted frontmatter key: the six condition keys (table) + metadata. */
const KNOWN_KEYS: ReadonlySet<string> = new Set<string>([...CONDITION_KEYS, ...METADATA_KEYS]);

const ENFORCEMENTS: readonly Enforcement[] = ["enforce", "recommend", "inform"];

const ruleError = (code: RuleErrorCode, message: string, file?: string): RuleError =>
	file === undefined ? { code, message } : { code, message, file };

const yamlSyntax = (detail: string, file: NormalizedPath): RuleError =>
	ruleError("yaml-syntax", `invalid YAML frontmatter: ${detail}`, file);

const invalidValue = (key: string, expected: string, file: NormalizedPath): RuleError =>
	ruleError("invalid-value", `frontmatter key "${key}" is invalid: expected ${expected}`, file);

/** Attaches the rule file to a table-produced parse error (specs are file-agnostic). */
const withFile = (error: RuleError, file: NormalizedPath): RuleError => ({ ...error, file });

/**
 * Parses one condition key through the table: absent stays `undefined` (the
 * default is materialized later), present must satisfy the spec. The result
 * keeps the spec's exact value type, so callers never cast.
 */
const parseConditionField = <N extends ConditionName>(
	name: N,
	frontmatter: Record<string, unknown>,
	file: NormalizedPath,
): Result<ConditionValueOf<N> | undefined, RuleError> => {
	const raw = frontmatter[name];
	if (raw === undefined) {
		return ok(undefined);
	}
	const parsed = conditionSpec(name).parse(raw);
	return parsed.ok ? ok(parsed.value) : err(withFile(parsed.error, file));
};

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

	const { description } = frontmatter;
	if (typeof description !== "string" || description.trim() === "") {
		return err(
			ruleError(
				"missing-description",
				'frontmatter key "description" is required and must be a non-empty string',
				file,
			),
		);
	}

	const globsParsed = parseConditionField("globs", frontmatter, file);
	if (!globsParsed.ok) {
		return err(globsParsed.error);
	}
	const globs = globsParsed.value;

	const matchParsed = parseConditionField("match", frontmatter, file);
	if (!matchParsed.ok) {
		return err(matchParsed.error);
	}
	const matchValue = matchParsed.value;

	const toolsParsed = parseConditionField("tools", frontmatter, file);
	if (!toolsParsed.ok) {
		return err(toolsParsed.error);
	}
	const tools = toolsParsed.value;

	const branchParsed = parseConditionField("branch", frontmatter, file);
	if (!branchParsed.ok) {
		return err(branchParsed.error);
	}
	const branchValue = branchParsed.value;

	const modelParsed = parseConditionField("model", frontmatter, file);
	if (!modelParsed.ok) {
		return err(modelParsed.error);
	}
	const modelValue = modelParsed.value;

	const priorityValue = frontmatter["priority"];
	if (priorityValue !== undefined && (typeof priorityValue !== "number" || !Number.isInteger(priorityValue))) {
		return err(invalidValue("priority", "an integer", file));
	}

	const enforcementValue = frontmatter["enforcement"];
	if (enforcementValue !== undefined && !isEnforcement(enforcementValue)) {
		return err(invalidValue("enforcement", `"enforce", "recommend", or "inform"`, file));
	}

	const loadValue = frontmatter["load"];
	if (loadValue !== undefined && loadValue !== "pinned" && loadValue !== "on-demand") {
		return err(invalidValue("load", `"pinned" or "on-demand"`, file));
	}

	const keywordsValue = frontmatter["keywords"];
	if (keywordsValue !== undefined && (!Array.isArray(keywordsValue) || keywordsValue.some((keyword) => typeof keyword !== "string"))) {
		return err(invalidValue("keywords", "an array of strings", file));
	}
	const keywords = Array.isArray(keywordsValue) ? keywordsValue.map((keyword: string) => keyword.trim()) : undefined;

	const alwaysApplyParsed = parseConditionField("alwaysApply", frontmatter, file);
	if (!alwaysApplyParsed.ok) {
		return err(alwaysApplyParsed.error);
	}
	const alwaysApplyValue = alwaysApplyParsed.value;

	const hasGlobs = globs !== undefined && globs.length > 0;
	if (matchValue !== undefined && globs === undefined) {
		return err(ruleError("match-without-globs", 'frontmatter key "match" requires "globs" to be set', file));
	}

	const hasActivation =
		hasGlobs ||
		(tools !== undefined && tools.length > 0) ||
		branchValue !== undefined ||
		modelValue !== undefined ||
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
		load: loadValue ?? "pinned",
		alwaysApply: alwaysApplyValue ?? false,
		version: 1,
		content: trimBlankEdges(split.content),
		...(globs === undefined ? {} : { globs }),
		...(tools === undefined ? {} : { tools }),
		...(branchValue === undefined ? {} : { branch: branchValue }),
		...(modelValue === undefined ? {} : { model: modelValue }),
		...(keywords === undefined ? {} : { keywords }),
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
