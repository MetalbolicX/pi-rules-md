/**
 * `pi-rules explain <path>` — print the S4 `why` report from the CLI (S12).
 *
 * The report itself is NOT reimplemented here: this module discovers rules and
 * prints `src/explain.ts`'s `explainPath` lines verbatim, so the CLI answer and
 * `/rules why <path>` can never drift apart.
 *
 * Scope — the CLI answers the PATH-CONDITION question only:
 * - It has no session. Tools/model/branch conditions are reported as caveats of
 *   a path decision, never evaluated (there is no session model, branch or tool
 *   list to evaluate them against); muting, budget and injection do not exist
 *   here either. `/rules why` inside a session remains the richer answer.
 * - Read set: exactly `lint`'s default directories — `<cwd>/.pi/rules` and the
 *   global rules directory (`~/.pi/agent/rules`, or `<agent dir>/rules` with
 *   `--agent-dir`/`PI_RULES_AGENT_DIR`). A missing directory contributes
 *   nothing. Ancestor (monorepo walk-up) and nested `.pi/rules` directories are
 *   deliberately NOT read here, and neither are imported formats
 *   (`.github/instructions`, `.claude/rules`): the authoring commands answer for
 *   the directory you are standing in, with no git subprocess and no glob over
 *   the tree below you. Trust is not consulted: a human typed the command.
 * - Discovery is the extension's own (`shell/discovery.ts`), so ids, ordering,
 *   mtime caching and the strict native parser are the production ones.
 *
 * Failure policy: parse/discovery errors are reported on stderr in `lint`'s
 * `<file>: <code>: <message>` shape (stdout stays exactly the report) and never
 * change the exit code. A path that matches nothing is NOT an error: the report
 * says why, and the command still exits 0. Only usage errors (no path) exit 2,
 * plus 1 for a rules read that could not complete at all.
 *
 * Path scale: touched paths in the extension are cwd-relative, so a path typed
 * on the command line is read that way. An ABSOLUTE path inside the working
 * directory is converted to that scale first (`toCwdScale`), which is what makes
 * a path copied from an editor explain the same rules a real touch would.
 * Anything else (a relative path, an absolute path outside cwd) is explained as
 * given.
 */
import path from "node:path";
import { discover, nodeDiscoveryDeps, projectRuleDirs } from "../../shell/discovery.ts";
import type { DiscoveryDeps } from "../../shell/discovery.ts";
import { explainPath } from "../explain.ts";
import { normalizedPath } from "../types.ts";
import type { Rule, RuleError } from "../types.ts";
import type { FlowOptions } from "./main.js";
import { resolveAgentDir } from "./paths.js";

export const EXPLAIN_USAGE = `Usage: pi-rules explain <path>

Explain what a path would do to your rules: it prints the same report as
\`/rules why <path>\`, once per rule, in discovery order.

Reads (the same defaults as \`pi-rules lint\`):
  .pi/rules            project rules, skipped silently when absent
  ~/.pi/agent/rules    global rules, skipped silently when absent

Only these two directories are read: native rule files in the directory you run
the command from, plus the global rules directory. Ancestor and nested
\`.pi/rules\` directories and imported formats (.github/instructions,
.claude/rules) are not part of this report.

This answers the path-condition question only. There is no session here, so
tools/model/branch conditions appear as caveats of a path decision and are never
evaluated; muting, budgets and prompt injection do not apply.

Explanations are on the working-directory scale: touched paths are cwd-relative,
so a relative path is used as given and an absolute path INSIDE the working
directory is converted to that scale. An absolute path outside it is explained
as given.

Output: the report lines on stdout. Rule files that fail to parse are reported
on stderr as "<file>: <code>: <message>" and never change the exit code.

Exit code: 0 for a completed report (including a path that matches nothing — the
report says why), 1 when the rules could not be read at all, 2 for a usage
error.

Options:
  --agent-dir <dir>    Use a specific Pi agent directory (global rules root)
  --help               Show this help`;

/** What one explain run needs from discovery: the rules plus their parse errors. */
export interface ExplainDiscovery {
	readonly rules: readonly Rule[];
	readonly errors: readonly RuleError[];
}

/** Injected discovery seam, so tests drive rule lists without a filesystem. */
export interface ExplainDeps {
	readonly discover: (input: { readonly cwd: string; readonly agentDir: string }) => Promise<ExplainDiscovery>;
}

/**
 * Production discovery for one explain run.
 *
 * The extension's `discover` is reused unchanged except for ONE injected
 * decision: the nested `.pi/rules` enumeration returns `[]`, which is what makes
 * the CLI read set identical to `lint`'s defaults (cwd + global only). The
 * walk-up list is the single cwd directory (`projectRuleDirs(cwd, undefined)`),
 * so no git subprocess runs and nothing above cwd can be read. Importers are
 * not configured. A missing directory resolves to nothing through the
 * production adapters, and nothing here throws for a missing source.
 */
export const discoverNativeRules = async (
	input: { readonly cwd: string; readonly agentDir: string },
	deps: DiscoveryDeps = { ...nodeDiscoveryDeps(), listNestedRuleDirs: async () => [] },
): Promise<ExplainDiscovery> => {
	const cwd = normalizedPath(input.cwd);
	const result = await discover(deps, new Map(), {
		globalDir: normalizedPath(path.join(input.agentDir, "rules")),
		projectDirs: projectRuleDirs(cwd, undefined),
		isProjectTrusted: true,
		cwd,
	});
	return { rules: result.rules, errors: result.errors };
};

/** Production deps for `explainFlow`. */
export const nodeExplainDeps = (): ExplainDeps => ({ discover: discoverNativeRules });

/**
 * Re-expresses the typed path on the scale touched paths use (cwd-relative).
 *
 * Pure and total: a relative path passes through untouched (the shell already
 * resolved it against the working directory conceptually), and so does an
 * absolute path that is NOT inside `cwd` — there is no honest cwd-relative
 * spelling for it, and inventing one (`../…`) would match globs the extension
 * never matches. An absolute path inside cwd becomes its relative form; cwd
 * itself becomes `.`. Separators are normalized either way.
 */
export const toCwdScale = (rawPath: string, cwd: string): string => {
	if (!path.isAbsolute(rawPath)) {
		return normalizedPath(rawPath);
	}
	const relative = path.relative(cwd, rawPath);
	if (relative === "" || relative.startsWith("..")) {
		return relative === "" ? "." : normalizedPath(rawPath);
	}
	return normalizedPath(relative);
};

const detailOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

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
 * `pi-rules explain <path>` command wrapper: discover → print `explainPath`
 * lines. Total at the boundary: parse errors become stderr lines, an
 * unexpected discovery throw becomes one error line plus exit 1, and stdout is
 * always exactly the report the pure core produced.
 */
export const explainFlow = async (options: FlowOptions, deps: ExplainDeps = nodeExplainDeps()): Promise<number> => {
	const rawPath = options.path;
	if (rawPath === undefined || rawPath.trim() === "") {
		emit("stderr", options, ["error: a path argument is required", EXPLAIN_USAGE]);
		return 2;
	}
	const env = options.io?.env ?? process.env;
	const agentDir = resolveAgentDir(options.agentDir, env);
	const cwd = process.cwd();
	let found: ExplainDiscovery;
	try {
		found = await deps.discover({ cwd, agentDir });
	} catch (cause) {
		emit("stderr", options, [`error: failed to discover rules: ${detailOf(cause)}`]);
		return 1;
	}
	emit(
		"stderr",
		options,
		found.errors.map((error) => `${error.file ?? "<unknown>"}: ${error.code}: ${error.message}`),
	);
	emit("stdout", options, explainPath(found.rules, toCwdScale(rawPath, cwd)));
	return 0;
};
