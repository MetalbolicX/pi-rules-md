/**
 * Deterministic domain generators for property tests (rule format v1).
 *
 * Every generator consumes the seeded harness (`./seeded.ts`) only — no
 * Math.random, no clocks — so a fixed seed reproduces the exact same case
 * sequence across runs. Generators produce values from the rule-format-v1
 * vocabulary (frontmatter documents, Rule objects, evaluation contexts,
 * match reasons, state events, pi events) so property tests can assert
 * invariants over hundreds of shapes without hand-written fixtures.
 *
 * Two YAML emission details keep generated documents parseable by the strict
 * parser:
 * - strings are always double-quoted, so word-like values can never be
 *   coerced to numbers/booleans/null by the YAML core schema,
 * - sequences use flow style (`key: ["a", "b"]`) so defect injection can
 *   rewrite a whole key with a single-line replacement.
 */
import type { PiEventShape } from "../../../shell/collectors.ts";
import type { StateEvent } from "../../../src/state.ts";
import { normalizedPath, ruleId } from "../../../src/types.ts";
import type { Enforcement, EvaluationContext, MatchMode, MatchReason, Rule, RuleSource } from "../../../src/types.ts";
import type { Seeded } from "./seeded.ts";

/** Builds `count` generated values, passing the index to each call. */
export const times = <T>(count: number, generate: (index: number) => T): readonly T[] =>
	Array.from({ length: count }, (_, index) => generate(index));

const WORDS: readonly string[] = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
const GLOB_POOL: readonly string[] = [
	"src/**/*.ts",
	"docs/*.md",
	"*.json",
	"tests/**/*.test.ts",
	"lib/**",
	"!**/*.gen.ts",
];
const TOOL_POOL: readonly string[] = ["bash", "edit", "read", "grep"];
const MODEL_POOL: readonly string[] = ["gpt-6", "claude-4", "gemini-3"];
const BRANCH_POOL: readonly string[] = ["main", "feat/rules", "dev"];
const PATH_POOL: readonly string[] = [
	"src/a.ts",
	"src/lib/b.ts",
	"docs/x.md",
	"tests/a.test.ts",
	"README.md",
	"shell/c.ts",
];
export const CONTENT_POOL: readonly string[] = [
	"Run pnpm typecheck before every commit.",
	"Keep functions pure and total.",
	"Prefer readonly data structures.",
	"Never swallow errors silently.",
	"Tabs for indentation, always.",
	"Write the test before the fix.",
	"Keep one focused write thread.",
	"Small diffs review faster.",
];
const MATCH_MODES: readonly MatchMode[] = ["touched", "exists", "both"];
const ENFORCEMENTS: readonly Enforcement[] = ["enforce", "recommend", "inform"];
const SOURCES: readonly RuleSource[] = ["global", "project"];

/** Picks `int(min, max)` items from `pool` WITH repetition (dupes are valid data). */
export const someOf = <T>(rng: Seeded, pool: readonly T[], min: number, max: number): readonly T[] =>
	times(rng.int(min, max), () => rng.pick(pool));

/** YAML-safe double-quoted scalar for a generated string value. */
export const yq = (value: string): string =>
	`"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;

/** One generated, fully valid frontmatter document plus its expected fields. */
export interface GeneratedDoc {
	/** Frontmatter lines (between the `---` delimiters), in emission order. */
	readonly lines: readonly string[];
	/** Markdown body below the closing delimiter (no blank leading/trailing lines). */
	readonly body: string;
	readonly description: string;
	readonly globs: readonly string[] | undefined;
	readonly match: MatchMode;
	readonly tools: readonly string[] | undefined;
	readonly branch: string | undefined;
	readonly model: string | undefined;
	readonly priority: number;
	readonly enforcement: Enforcement;
	readonly alwaysApply: boolean;
}

/** Wraps frontmatter lines and a body into a raw rule file's text. */
export const emitDoc = (doc: Pick<GeneratedDoc, "lines" | "body">): string =>
	`---\n${doc.lines.join("\n")}\n---\n${doc.body}\n`;

/**
 * Generates one valid rule document: every cross-field invariant the parser
 * enforces is satisfied (version exactly 1, non-empty description, match
 * only with globs, at least one activation condition), so the property test
 * controls which single defect an invalid variant carries.
 */
export const generateValidDoc = (rng: Seeded): GeneratedDoc => {
	const description = `${rng.pick(WORDS)} ${rng.pick(WORDS)} ${rng.pick(WORDS)}`;
	const priority = rng.bool() ? rng.int(-100, 100) : undefined;
	const enforcement = rng.bool() ? rng.pick(ENFORCEMENTS) : undefined;
	const globs = rng.bool() ? someOf(rng, GLOB_POOL, 1, 3) : undefined;
	const match = globs !== undefined && rng.bool() ? rng.pick(MATCH_MODES) : undefined;
	const tools = rng.bool() ? someOf(rng, TOOL_POOL, 0, 2) : undefined;
	const branch = rng.bool() ? rng.pick(BRANCH_POOL) : undefined;
	const model = rng.bool() ? rng.pick(MODEL_POOL) : undefined;
	const alwaysApplyRaw = rng.bool() ? rng.bool() : undefined;

	// Activation invariant: without any real trigger the document would be
	// rejected (no-activation-condition), so force alwaysApply: true — the
	// same escape hatch the format itself offers authors.
	const hasActivation =
		(globs !== undefined && globs.length > 0) ||
		(tools !== undefined && tools.length > 0) ||
		branch !== undefined ||
		model !== undefined ||
		alwaysApplyRaw === true;
	const alwaysApply = hasActivation ? alwaysApplyRaw : true;

	const lines: string[] = ["version: 1", `description: ${yq(description)}`];
	if (priority !== undefined) {
		lines.push(`priority: ${priority}`);
	}
	if (enforcement !== undefined) {
		lines.push(`enforcement: ${yq(enforcement)}`);
	}
	if (globs !== undefined) {
		lines.push(`globs: [${globs.map(yq).join(", ")}]`);
	}
	if (match !== undefined) {
		lines.push(`match: ${yq(match)}`);
	}
	if (tools !== undefined) {
		lines.push(`tools: [${tools.map(yq).join(", ")}]`);
	}
	if (branch !== undefined) {
		lines.push(`branch: ${yq(branch)}`);
	}
	if (model !== undefined) {
		lines.push(`model: ${yq(model)}`);
	}
	if (alwaysApply !== undefined) {
		lines.push(`alwaysApply: ${alwaysApply}`);
	}
	const body = times(rng.int(1, 3), () => `Use ${rng.pick(WORDS)} and ${rng.pick(WORDS)} carefully.`).join("\n");
	return {
		lines,
		body,
		description,
		globs,
		match: match ?? "both",
		tools,
		branch,
		model,
		priority: priority ?? 0,
		enforcement: enforcement ?? "inform",
		alwaysApply: alwaysApply ?? false,
	};
};

/** One generated invalid document: exactly one defect plus its expected error code. */
export interface GeneratedDefect {
	readonly raw: string;
	readonly expectedCode: string;
}

type DefectKind =
	| "unknown-key"
	| "version-int"
	| "version-string"
	| "version-bool"
	| "description-removed"
	| "description-number"
	| "globs-number"
	| "tools-number"
	| "match-bad"
	| "branch-number"
	| "model-number"
	| "alwaysApply-string"
	| "priority-float"
	| "priority-string"
	| "enforcement-bad"
	| "globs-removed-with-match"
	| "no-activation"
	| "no-frontmatter";

const hasLine = (lines: readonly string[], prefix: string): boolean =>
	lines.some((line) => line.startsWith(prefix));

const replaceLine = (lines: readonly string[], prefix: string, replacement: string): readonly string[] =>
	lines.map((line) => (line.startsWith(prefix) ? replacement : line));

const removeLine = (lines: readonly string[], prefix: string): readonly string[] =>
	lines.filter((line) => !line.startsWith(prefix));

/**
 * Generates one invalid document by injecting exactly ONE defect into a
 * generated valid document (or, for two shapes, by emitting a minimal broken
 * document directly). `expectedCode` pins the parser's error precedence, not
 * just "some rejection".
 */
export const generateInvalidDoc = (rng: Seeded): GeneratedDefect => {
	const doc = generateValidDoc(rng);
	const conditional: readonly (readonly [DefectKind, readonly string[]])[] = [
		["globs-number", ["globs:"]],
		["tools-number", ["tools:"]],
		["match-bad", ["match:"]],
		["branch-number", ["branch:"]],
		["model-number", ["model:"]],
		["alwaysApply-string", ["alwaysApply:"]],
		["priority-float", ["priority:"]],
		["priority-string", ["priority:"]],
		["enforcement-bad", ["enforcement:"]],
		["globs-removed-with-match", ["globs:", "match:"]],
	];
	const applicable: readonly DefectKind[] = [
		"unknown-key",
		"version-int",
		"version-string",
		"version-bool",
		"description-removed",
		"description-number",
		"no-activation",
		"no-frontmatter",
		...conditional.filter(([, required]) => required.every((prefix) => hasLine(doc.lines, prefix))).map(([kind]) => kind),
	];

	switch (rng.pick(applicable)) {
		case "unknown-key": {
			const key = `${rng.pick(WORDS)}${rng.int(0, 99)}key`;
			const lines = [...doc.lines.slice(0, 2), `${key}: ${yq("bogus")}`, ...doc.lines.slice(2)];
			return { raw: emitDoc({ lines, body: doc.body }), expectedCode: "unknown-key" };
		}
		case "version-int":
			return {
				raw: emitDoc({ lines: replaceLine(doc.lines, "version:", `version: ${rng.int(2, 99)}`), body: doc.body }),
				expectedCode: "invalid-version",
			};
		case "version-string":
			return {
				raw: emitDoc({ lines: replaceLine(doc.lines, "version:", `version: ${yq(String(rng.int(2, 99)))}`), body: doc.body }),
				expectedCode: "invalid-version",
			};
		case "version-bool":
			return {
				raw: emitDoc({ lines: replaceLine(doc.lines, "version:", `version: ${rng.bool() ? "true" : "false"}`), body: doc.body }),
				expectedCode: "invalid-version",
			};
		case "description-removed":
			return { raw: emitDoc({ lines: removeLine(doc.lines, "description:"), body: doc.body }), expectedCode: "missing-description" };
		case "description-number":
			return {
				raw: emitDoc({ lines: replaceLine(doc.lines, "description:", "description: 42"), body: doc.body }),
				expectedCode: "missing-description",
			};
		case "globs-number":
			return {
				raw: emitDoc({ lines: replaceLine(doc.lines, "globs:", "globs: 42"), body: doc.body }),
				expectedCode: "invalid-value",
			};
		case "tools-number":
			return {
				raw: emitDoc({ lines: replaceLine(doc.lines, "tools:", "tools: 42"), body: doc.body }),
				expectedCode: "invalid-value",
			};
		case "match-bad":
			return {
				raw: emitDoc({ lines: replaceLine(doc.lines, "match:", `match: ${yq("sometimes")}`), body: doc.body }),
				expectedCode: "invalid-value",
			};
		case "branch-number":
			return {
				raw: emitDoc({ lines: replaceLine(doc.lines, "branch:", "branch: 42"), body: doc.body }),
				expectedCode: "invalid-value",
			};
		case "model-number":
			return {
				raw: emitDoc({ lines: replaceLine(doc.lines, "model:", "model: 42"), body: doc.body }),
				expectedCode: "invalid-value",
			};
		case "alwaysApply-string":
			return {
				raw: emitDoc({ lines: replaceLine(doc.lines, "alwaysApply:", `alwaysApply: ${yq("yes")}`), body: doc.body }),
				expectedCode: "invalid-value",
			};
		case "priority-float":
			return {
				raw: emitDoc({ lines: replaceLine(doc.lines, "priority:", "priority: 1.5"), body: doc.body }),
				expectedCode: "invalid-value",
			};
		case "priority-string":
			return {
				raw: emitDoc({ lines: replaceLine(doc.lines, "priority:", `priority: ${yq("high")}`), body: doc.body }),
				expectedCode: "invalid-value",
			};
		case "enforcement-bad":
			return {
				raw: emitDoc({ lines: replaceLine(doc.lines, "enforcement:", `enforcement: ${yq("strict")}`), body: doc.body }),
				expectedCode: "invalid-value",
			};
		case "globs-removed-with-match":
			return {
				raw: emitDoc({ lines: removeLine(doc.lines, "globs:"), body: doc.body }),
				expectedCode: "match-without-globs",
			};
		case "no-activation":
			return {
				raw: emitDoc({ lines: ["version: 1", `description: ${yq("no triggers here")}`, "tools: []"], body: doc.body }),
				expectedCode: "no-activation-condition",
			};
		case "no-frontmatter":
			return { raw: doc.body, expectedCode: "missing-frontmatter" };
	}
};

/**
 * One random but valid Rule object (bypasses the parser — the parser's own
 * surface is exercised by the document generators). Optional fields are drawn
 * from shared pools so generated rule SETS contain duplicate globs (dedupe
 * pressure for scan patterns) and matching path/tool/model/branch values.
 * `content` overrides the default unique body — pass a shared pool value to
 * force content-hash collisions for selection tests.
 */
export const randomRule = (rng: Seeded, index: number, content?: string): Rule => {
	const alwaysApply = rng.next() < 0.15;
	const globs = !alwaysApply && rng.next() < 0.7 ? someOf(rng, GLOB_POOL, 1, 2) : undefined;
	const tools = rng.next() < 0.4 ? someOf(rng, TOOL_POOL, 0, 2) : undefined;
	const branch = rng.next() < 0.2 ? rng.pick(BRANCH_POOL) : undefined;
	const model = rng.next() < 0.2 ? rng.pick(MODEL_POOL) : undefined;
	return {
		id: ruleId(`rule-${index}`),
		index,
		path: normalizedPath(`rules/rule-${index}.md`),
		source: rng.pick(SOURCES),
		description: `${rng.pick(WORDS)} ${rng.pick(WORDS)} rule`,
		...(globs === undefined ? {} : { globs }),
		match: rng.pick(MATCH_MODES),
		...(tools === undefined ? {} : { tools }),
		...(branch === undefined ? {} : { branch }),
		...(model === undefined ? {} : { model }),
		priority: rng.int(-50, 50),
		enforcement: rng.pick(ENFORCEMENTS),
		alwaysApply,
		version: 1,
		content: content ?? `Rule ${index}: ${rng.pick(WORDS)} ${rng.pick(WORDS)}.`,
	};
};

/** One random, internally consistent EvaluationContext over the shared pools. */
export const randomContext = (rng: Seeded): EvaluationContext => ({
	now: 1700000000000,
	cwd: normalizedPath(rng.pick(["/work/proj", "/home/u/api"])),
	isProjectTrusted: rng.bool(),
	touchedPaths: someOf(rng, PATH_POOL, 0, 4).map(normalizedPath),
	existingPaths: someOf(rng, PATH_POOL, 0, 4).map(normalizedPath),
	toolNames: someOf(rng, TOOL_POOL, 0, 3),
	...(rng.bool() ? { model: rng.pick(MODEL_POOL) } : {}),
	...(rng.bool() ? { branch: rng.pick(BRANCH_POOL) } : {}),
});

/** 0–3 random match reasons (any kind), in generation order. */
export const randomReasons = (rng: Seeded): readonly MatchReason[] =>
	times(rng.int(0, 3), () =>
		rng.oneof<MatchReason>([
			(): MatchReason => ({ kind: "always" }),
			(): MatchReason => ({ kind: "glob", pattern: rng.pick(GLOB_POOL) }),
			(): MatchReason => ({ kind: "tool", tool: rng.pick(TOOL_POOL) }),
			(): MatchReason => ({ kind: "model", model: rng.pick(MODEL_POOL) }),
			(): MatchReason => ({ kind: "branch", branch: rng.pick(BRANCH_POOL) }),
		]),
	);

/** One random state event of any known kind. */
export const randomStateEvent = (rng: Seeded): StateEvent =>
	rng.oneof<StateEvent>([
		(): StateEvent => ({ type: "paths_touched", paths: someOf(rng, PATH_POOL, 0, 4).map(normalizedPath) }),
		(): StateEvent => ({ type: "block_injected", contentHash: `hash-${rng.int(0, 999)}` }),
		(): StateEvent => ({ type: "block_removed" }),
		(): StateEvent => ({ type: "session_compact" }),
		(): StateEvent => ({ type: "session_reset" }),
	]);

/** A raw path-like string in one of the shapes pi tool args actually carry. */
const randomRawPath = (rng: Seeded, cwd: string): string =>
	rng.oneof([
		(): string => `${cwd}/src/f${rng.int(0, 999)}.ts`,
		(): string => `docs/d${rng.int(0, 999)}.md`,
		(): string => "/etc/hosts",
		(): string => `nested\\f${rng.int(0, 999)}.ts`,
	]);

/** Tool-args object variants, including absent and non-string path fields. */
const randomToolArgs = (rng: Seeded, cwd: string): unknown =>
	rng.oneof<unknown>([
		(): Record<string, unknown> => ({ path: randomRawPath(rng, cwd) }),
		(): Record<string, unknown> => ({}),
		(): Record<string, unknown> => ({ path: 42 }),
		(): Record<string, unknown> => ({ path: randomRawPath(rng, cwd), extra: "ignored" }),
		(): undefined => undefined,
		(): null => null,
		(): string => "malformed args",
	]);

/**
 * One random pi-event-like value across the collector's input domain:
 * lifecycle kinds, tool_execution_start with recognized/unknown tools and
 * well-formed/malformed args, a foreign kind, and non-object garbage.
 */
export const randomPiEvent = (rng: Seeded, cwd: string): PiEventShape =>
	rng.oneof<PiEventShape>([
		(): PiEventShape => ({ type: "session_compact" }),
		(): PiEventShape => ({ type: "session_before_switch" }),
		(): PiEventShape => ({ type: "session_before_fork" }),
		(): PiEventShape => {
			const toolName = rng.pick(["read", "edit", "write", "grep", "find", "bash", "custom"]);
			const args = toolName === "bash" ? { command: "echo property-test", timeout: 1 } : randomToolArgs(rng, cwd);
			return { type: "tool_execution_start", toolCallId: `call-${String(rng.int(0, 999))}`, toolName, args };
		},
		(): PiEventShape => ({ type: "model_select" }) as unknown as PiEventShape,
		(): PiEventShape => null as unknown as PiEventShape,
		(): PiEventShape => undefined as unknown as PiEventShape,
		(): PiEventShape => 42 as unknown as PiEventShape,
	]);
