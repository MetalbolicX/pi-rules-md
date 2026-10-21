/**
 * `pi-rules lint` — validate native rule files from the command line (S12).
 *
 * Functional core / imperative shell, like the rest of the CLI:
 * - `resolveLintTargets` decides WHICH directories are linted (pure);
 * - `lintRuleDirs` lists, reads and parses them through the injected
 *   {@link LintDeps} seam and returns a sorted error report (total: a failure in
 *   one source or file never aborts the pass and never throws);
 * - `lintFlow` is the thin command wrapper: it prints one
 *   `<file>: <code>: <message>` line per error plus one summary line to stdout
 *   and returns the exit code (1 when any error was found, 0 otherwise).
 *
 * Format scope: lint validates the NATIVE `.pi/rules` format only — the strict
 * `src/frontmatter.ts` schema (`readRuleFile`, i.e. `parseRule` plus the
 * injected read), exactly what the extension loads from `.pi/rules` and the
 * global rules directory. Importer-owned formats (`.github/instructions`,
 * `.claude/rules`) are deliberately NOT linted: they are lenient, use a
 * different key set, and are validated by their own adapters
 * (`shell/importers`). The help text states this.
 *
 * Directory policy:
 * - Explicit `dir...` arguments replace the defaults and MUST exist: a missing
 *   explicit directory is reported as one `source-unreadable` error (exit 1),
 *   because the user asked for that directory by name.
 * - Defaults are `<cwd>/.pi/rules` (project) and `<agent dir>/rules` (global,
 *   `~/.pi/agent/rules` unless `--agent-dir`/`PI_RULES_AGENT_DIR` moves the
 *   agent directory). A missing default directory is NOT an error — a project
 *   or machine without rules is a valid state, not a broken one.
 * - Overlapping/duplicate directories are linted once (first occurrence wins).
 *
 * File policy: recursive `**\/*.md` listing per directory, `.git` and
 * `node_modules` never scanned, non-`.md` names ignored defensively, symlinks
 * never followed (same read set shape as the extension's discovery adapter).
 * The listing is a local adapter rather than `nodeDiscoveryDeps().listRuleFiles`
 * because lint needs two things that adapter does not provide: a missing
 * directory must be distinguishable from an empty one (ENOENT propagates
 * here), and `node_modules` must be ignored (the discovery listing relies on
 * the hosts' `.pi/rules` layout instead). Parsing is fully reused.
 *
 * Failure granularity: one listing per target directory, so a rejected
 * `readdir` — including one from an unreadable NESTED directory — reports that
 * whole target as one `source-unreadable` error (discovery's per-source
 * granularity) instead of partially linting it. A rejected file read is
 * per-file (`read-failure`) and never stops the remaining files.
 *
 * Output contract (pinned by tests): errors sorted by file path, then code,
 * then message, so the output is stable across runs and machines; then one
 * summary line `lint: <files> rule files, <errors> errors`. Everything goes to
 * stdout, stderr stays empty (the lines are the machine-greppable output).
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { readRuleFile } from "../frontmatter.ts";
import { normalizedPath } from "../types.ts";
import type { NormalizedPath, RuleError, RuleErrorCode, RuleSource } from "../types.ts";
import type { FlowOptions } from "./main.js";
import { resolveAgentDir } from "./paths.js";

export const LINT_USAGE = `Usage: pi-rules lint [dir...]

Validate native pi-rules rule files: every directory below is scanned for
recursive \`**/*.md\` rule files and each one is parsed with the strict v1 rule
schema. Importer formats (.github/instructions, .claude/rules) are NOT linted:
only files meant to be native rules are checked.

Directories (defaults, used when no dir is given):
  .pi/rules            project rules, skipped silently when absent
  ~/.pi/agent/rules    global rules, skipped silently when absent

A directory passed on the command line must exist: a missing explicit
directory is an error. \`.git\` and \`node_modules\` are never scanned, non-.md
files are ignored, and symlinks are not followed.

Output: one "<file>: <code>: <message>" line per error, sorted by file then
code, followed by a "lint: <files> rule files, <errors> errors" summary line.

Exit code: 1 when any error was found, 0 otherwise (including when no rule
files were found).

Options:
  --agent-dir <dir>    Use a specific Pi agent directory (global rules root)
  --help               Show this help`;

/**
 * Directory-name segments never descended into: `.git` holds repository
 * internals and `node_modules` holds third-party markdown, matching the
 * extension's nested-discovery ignore policy.
 */
export const IGNORED_DIRECTORIES: readonly string[] = [".git", "node_modules"];

/**
 * Depth bound for the recursive listing, counted in directory segments below
 * the given directory (precedent: discovery's `MAX_RULES_SCAN_DEPTH = 10`).
 */
export const MAX_LINT_SCAN_DEPTH = 10;

/** Injected I/O seam: listing + reading, so tests drive every failure mode. */
export interface LintDeps {
  /** Lists `.md` file names under a directory, relative to it, forward slashes. Rejects when the directory is missing or unreadable. */
  readonly listRuleFiles: (dir: string) => Promise<readonly string[]>;
  /** Reads one file as UTF-8 text. */
  readonly readFile: (path: string) => Promise<string>;
}

/** One directory to lint, with the origin that decides the parser's source tag. */
export interface LintTarget {
  readonly dir: NormalizedPath;
  readonly source: RuleSource;
  /** True for a user-named directory: missing → error. Defaults are optional. */
  readonly required: boolean;
}

/** One collected problem, always attributed to a file (or a whole directory). */
export interface LintError {
  readonly file: string;
  readonly code: RuleErrorCode;
  readonly message: string;
}

export interface LintReport {
  /** Number of rule files the pass actually listed. */
  readonly files: number;
  /** Collected errors, sorted by file then code then message. */
  readonly errors: readonly LintError[];
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const detailOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const isEnoent = (cause: unknown): boolean => (cause as { code?: unknown } | null)?.code === "ENOENT";

/**
 * Decides which directories a run lints. Explicit `dirs` are resolved against
 * `cwd`, tagged project (the native format they hold is authored format) and
 * marked required; without them the two defaults apply, both optional. The
 * result is deduplicated by resolved path — linting the same directory twice
 * would only duplicate every error.
 */
export const resolveLintTargets = (input: {
  readonly cwd: string;
  readonly dirs: readonly string[];
  readonly agentDir: string;
}): readonly LintTarget[] => {
  const targets: LintTarget[] = [];
  const seen = new Set<string>();
  const add = (dir: string, source: RuleSource, required: boolean): void => {
    const resolved = normalizedPath(path.resolve(input.cwd, dir));
    if (seen.has(resolved)) return;
    seen.add(resolved);
    targets.push({ dir: resolved, source, required });
  };
  if (input.dirs.length > 0) {
    for (const dir of input.dirs) add(dir, "project", true);
    return targets;
  }
  add(".pi/rules", "project", false);
  add(normalizedPath(path.join(input.agentDir, "rules")), "global", false);
  return targets;
};

/** Parses one listed file, converting a read rejection into a typed error. */
const lintFile = async (
  deps: LintDeps,
  dir: NormalizedPath,
  name: string,
  source: RuleSource,
): Promise<RuleError | undefined> => {
  const abs = normalizedPath(path.resolve(dir, name));
  const parsed = await readRuleFile(deps.readFile, { path: abs, source });
  return parsed.ok ? undefined : parsed.error;
};

/**
 * Lints every target directory. Total: a missing optional directory
 * contributes nothing, a missing REQUIRED directory is one error, a rejected
 * listing is one `source-unreadable` error, and a rejected read is one
 * `read-failure` error per file — the pass always finishes and never throws.
 */
export const lintRuleDirs = async (
  targets: readonly LintTarget[],
  deps: LintDeps,
): Promise<LintReport> => {
  const errors: LintError[] = [];
  let files = 0;
  for (const target of targets) {
    let listed: readonly string[];
    try {
      listed = await deps.listRuleFiles(target.dir);
    } catch (cause) {
      if (isEnoent(cause)) {
        if (!target.required) continue;
        errors.push({ file: target.dir, code: "source-unreadable", message: "rules directory does not exist" });
        continue;
      }
      errors.push({ file: target.dir, code: "source-unreadable", message: `failed to list rules source: ${detailOf(cause)}` });
      continue;
    }
    const names = listed.filter((name) => name.endsWith(".md")).sort(compareText);
    files += names.length;
    for (const name of names) {
      const error = await lintFile(deps, target.dir, name, target.source);
      if (error) errors.push({ file: error.file ?? normalizedPath(path.resolve(target.dir, name)), code: error.code, message: error.message });
    }
  }
  errors.sort(
    (a, b) => compareText(a.file, b.file) || compareText(a.code, b.code) || compareText(a.message, b.message),
  );
  return { files, errors };
};

/** Rendering: one line per error, then the summary. Stdout only. */
export const formatLintReport = (report: LintReport): readonly string[] => [
  ...report.errors.map((error) => `${error.file}: ${error.code}: ${error.message}`),
  `lint: ${report.files} rule files, ${report.errors.length} errors`,
];

/**
 * Production adapter: recursive `.md` listing via `node:fs/promises`.
 *
 * `readdir` failures (ENOENT for a missing directory, EACCES, …) propagate so
 * the core can apply the required/optional policy. Entries are visited in
 * filesystem order and sorted by the caller; symlinks are skipped outright so
 * a link can never pull markdown from outside the linted tree.
 */
const listMarkdownFiles = async (root: string): Promise<readonly string[]> => {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_LINT_SCAN_DEPTH) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.includes(entry.name)) continue;
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      found.push(normalizedPath(path.relative(root, full)));
    }
  };
  await walk(root, 0);
  return found.sort(compareText);
};

/** Production deps for {@link lintRuleDirs}. */
export const nodeLintDeps = (): LintDeps => ({
  listRuleFiles: listMarkdownFiles,
  readFile: (file) => readFile(file, "utf8"),
});

const emit = (options: FlowOptions, lines: readonly string[]): void => {
  if (options.io) {
    options.io.stdout.push(...lines);
    return;
  }
  for (const line of lines) console.log(line);
};

/**
 * `pi-rules lint [dir...]` command wrapper. Resolves the targets, runs the
 * core, prints the report and returns the exit code. Totality is enforced
 * here as the last line of defence: an unexpected throw from outside the seam
 * is reported as a lint failure rather than escaping the CLI boundary.
 */
export const lintFlow = async (options: FlowOptions, deps: LintDeps = nodeLintDeps()): Promise<number> => {
  const env = options.io?.env ?? process.env;
  const agentDir = resolveAgentDir(options.agentDir, env);
  const targets = resolveLintTargets({ cwd: process.cwd(), dirs: options.dirs ?? [], agentDir });
  try {
    const report = await lintRuleDirs(targets, deps);
    emit(options, formatLintReport(report));
    return report.errors.length === 0 ? 0 : 1;
  } catch (cause) {
    emit(options, [`lint: ${targets.length} rule directories, failed: ${detailOf(cause)}`]);
    return 1;
  }
};
