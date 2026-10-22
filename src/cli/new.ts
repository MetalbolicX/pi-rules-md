/**
 * `pi-rules new <name> [--global]` — scaffold a valid native rule file (S12).
 *
 * Functional core / imperative shell, like `lint`:
 * - `validateRuleName` turns the CLI argument into a safe file stem (pure,
 *   total: one typed message per rejection reason);
 * - `scaffoldRuleFile` renders the starter file (pure, total) — a MINIMAL rule
 *   that the extension's own strict parser accepts, so a scaffold can never be
 *   a file `/rules`/`pi-rules lint` would reject;
 * - `resolveNewTarget` decides where the file goes (pure): `<cwd>/.pi/rules/`
 *   for a project rule, `<agent dir>/rules/` with `--global`;
 * - `newFlow` is the thin command wrapper: validate → create the rules
 *   directory when missing → write → print the created path.
 *
 * The scaffold is deliberately small: `description` (derived from the name),
 * `version: 1`, one placeholder `globs` pattern with `match: touched`, and the
 * documented defaults spelled out (`priority: 0`, `enforcement: inform`,
 * `load: pinned`) so the author sees the knobs without opening the spec. The
 * body is a placeholder paragraph, not an HTML comment: a rule body is injected
 * verbatim into the prompt when the rule activates, so a comment would be
 * injected noise. Editing those bytes is the author's next step.
 *
 * Overwrite policy: REFUSED. The write is the refusal — `writeFile` runs with
 * `flag: "wx"` (exclusive create), so the answer is atomic at the OS level and
 * a check-then-write race cannot clobber a file the user just created. An
 * existing file is reported by name and exits 1 with the file untouched, and a
 * failed write never leaves a partial scaffold behind (one single write call).
 *
 * Directory policy: the target rules directory is created when missing
 * (`mkdir -p`). A project scaffold therefore works in a fresh repository, and
 * `--global` works on a machine that never wrote a global rule. Nothing else is
 * created and no existing file is modified.
 *
 * Name policy: the argument is a file stem, not a path. Rejected (exit 2, usage
 * error): empty names, names with whitespace, names with path separators
 * (`/`, `\`), names starting with `.` — discovery only lists `*.md` with the dot
 * rule off, so a hidden rule file would be silently ignored — and anything
 * ending up as `.` or `..`. A single trailing `.md` is stripped, so
 * `pi-rules new use-tabs.md` scaffolds `use-tabs.md` instead of
 * `use-tabs.md.md`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { err, ok } from "../result.ts";
import type { Result } from "../result.ts";
import { normalizedPath } from "../types.ts";
import type { NormalizedPath } from "../types.ts";
import type { FlowOptions } from "./main.js";
import { resolveAgentDir } from "./paths.js";

export const NEW_USAGE = `Usage: pi-rules new <name> [--global]

Scaffold a valid native rule file. The starter rule has frontmatter the strict
v1 schema accepts (description, version, one placeholder globs pattern with
match: touched, priority 0, enforcement inform, load pinned) plus a placeholder
body: \`pi-rules lint\` accepts it and \`pi-rules explain\` can explain it
immediately.

Target:
  .pi/rules/<name>.md          project rule (created if the directory is missing)
  <agent dir>/rules/<name>.md  with --global: the global rules directory,
                               ~/.pi/agent/rules unless --agent-dir moves it

The rules directory is created when it does not exist. An existing rule file is
NEVER overwritten: the command refuses, names the file, and exits 1, leaving the
file exactly as it was.

<name> is a file stem, not a path: it may not contain path separators or
whitespace, may not start with ".", and may not be "." or "..". A single
trailing ".md" is stripped, so \`new use-tabs.md\` writes \`use-tabs.md\`.

Output: one line, \`created <file>\`, naming the absolute path written.

Exit code: 0 when the file was created, 1 when it was refused or could not be
written, 2 for a usage error (missing or invalid name).

Options:
  --global             Scaffold in the global rules directory instead of the project's
  --agent-dir <dir>    Use a specific Pi agent directory (global rules root)
  --help               Show this help`;

/** Frontmatter key order of the scaffold, then the body placeholder below it. */
const SCAFFOLD_GLOBS = 'globs: "src/**/*"';

/** Body placeholder: prose, because an activated rule body is injected verbatim. */
const SCAFFOLD_BODY: readonly string[] = [
	"Describe the rule here: what the agent should do, and when. This body is",
	"injected into the prompt whenever the rule activates, so replace this",
	"placeholder before relying on it.",
];

/**
 * Validates one CLI name argument into a safe rule-file stem.
 *
 * Pure and total: returns the stem on success and one human-readable reason on
 * failure (the caller prints it as a usage error). A single trailing `.md` is
 * stripped first, so the file name is never doubled.
 */
export const validateRuleName = (raw: string): Result<string, string> => {
	const name = raw.endsWith(".md") ? raw.slice(0, -".md".length) : raw;
	if (name.trim() === "") {
		return err("rule name is required");
	}
	const invalid = (reason: string): Result<string, string> => err(`invalid rule name "${raw}": ${reason}`);
	if (/[/\\]/.test(name)) {
		return invalid("rule names cannot contain path separators");
	}
	if (/\s/.test(name)) {
		return invalid("rule names cannot contain whitespace");
	}
	if (name.startsWith(".")) {
		return invalid('rule names cannot start with "." (a hidden rule file would be ignored by discovery)');
	}
	return ok(name);
};

/**
 * Renders the scaffold for one validated rule name.
 *
 * The `description` is JSON-quoted because a YAML double-quoted scalar accepts
 * exactly those escapes, so a name carrying `:`, `"` or `#` still yields a
 * valid frontmatter block. The rest is fixed text, pinned by tests.
 */
export const scaffoldRuleFile = (name: string): string =>
	[
		"---",
		`description: ${JSON.stringify(`${name}: describe when this rule applies`)}`,
		"version: 1",
		SCAFFOLD_GLOBS,
		"match: touched",
		"priority: 0",
		"enforcement: inform",
		"load: pinned",
		"---",
		"",
		...SCAFFOLD_BODY,
		"",
	].join("\n");

/** Where a scaffold goes: the rules directory and the rule file inside it. */
export interface NewTarget {
	readonly dir: NormalizedPath;
	readonly file: NormalizedPath;
}

/** Resolves the target path for one validated name (project or global). */
export const resolveNewTarget = (input: {
	readonly cwd: string;
	readonly name: string;
	readonly global: boolean;
	readonly agentDir: string;
}): NewTarget => {
	const dir = normalizedPath(
		input.global ? path.resolve(input.agentDir, "rules") : path.resolve(input.cwd, ".pi", "rules"),
	);
	return { dir, file: normalizedPath(path.join(dir, `${input.name}.md`)) };
};

/** Injected I/O seam: directory creation plus one exclusive create-write. */
export interface NewDeps {
	/** Creates a directory and any missing parents; existing directories are fine. */
	readonly mkdir: (dir: string) => Promise<void>;
	/** Writes a NEW file. Must reject when the file already exists (exclusive create). */
	readonly writeFile: (file: string, text: string) => Promise<void>;
}

/** Production deps: `mkdir -p` plus `writeFile` with `flag: "wx"`. */
export const nodeNewDeps = (): NewDeps => ({
	mkdir: async (dir) => {
		await mkdir(dir, { recursive: true });
	},
	writeFile: async (file, text) => {
		await writeFile(file, text, { encoding: "utf8", flag: "wx" });
	},
});

const detailOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const isEexist = (cause: unknown): boolean => (cause as { code?: unknown } | null)?.code === "EEXIST";

const emit = (target: "stdout" | "stderr", options: FlowOptions, lines: readonly string[]): void => {
	if (options.io) {
		options.io[target].push(...lines);
		return;
	}
	for (const line of lines) {
		if (target === "stdout") console.log(line);
		else console.error(line);
	}
};

/**
 * `pi-rules new <name> [--global]` command wrapper.
 *
 * Validate → resolve → create directory → exclusive write → print the path.
 * Total at the boundary: every failure becomes a message plus an exit code, and
 * the only filesystem effects are the (possibly missing) rules directory and
 * the new file.
 */
export const newFlow = async (options: FlowOptions, deps: NewDeps = nodeNewDeps()): Promise<number> => {
	const validated = validateRuleName(options.name ?? "");
	if (!validated.ok) {
		emit("stderr", options, [`error: ${validated.error}`, NEW_USAGE]);
		return 2;
	}
	const env = options.io?.env ?? process.env;
	const target = resolveNewTarget({
		cwd: process.cwd(),
		name: validated.value,
		global: options.global === true,
		agentDir: resolveAgentDir(options.agentDir, env),
	});
	if (options.dryRun) {
		// Print-only mode is decided before any filesystem effect, so the rules
		// directory is not even created (the README --dry-run contract).
		emit("stdout", options, [`[dry-run] Would create ${target.file}`]);
		return 0;
	}
	try {
		await deps.mkdir(target.dir);
		await deps.writeFile(target.file, scaffoldRuleFile(validated.value));
	} catch (cause) {
		if (isEexist(cause)) {
			emit("stderr", options, [`error: ${target.file} already exists; refusing to overwrite`]);
			return 1;
		}
		emit("stderr", options, [`error: failed to create ${target.file}: ${detailOf(cause)}`]);
		return 1;
	}
	emit("stdout", options, [`created ${target.file}`]);
	return 0;
};
