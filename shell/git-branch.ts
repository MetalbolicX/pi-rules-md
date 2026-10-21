/**
 * Git-branch and git-root resolution seam (imperative shell): the only place
 * the extension shells out to git, kept total so the injection cycle (and
 * monorepo discovery) can never break on it.
 *
 * pi's `ExtensionAPI.exec` is the effect that arrives here, structurally
 * mirrored and limited to what this module consumes (verified against the
 * installed `@earendil-works/pi-coding-agent@1.3.0`,
 * `dist/core/exec.d.ts`: `ExecResult { stdout, stderr, code, killed }`,
 * `ExecOptions { signal?, timeout?, cwd? }`). Tests inject a stub of the same
 * shape, so no test spawns a process.
 *
 * Contract (S2): one `git rev-parse --abbrev-ref HEAD` per `before_agent_start`.
 * Detached HEAD (git answers the literal `HEAD`), a non-git directory, a
 * non-zero exit, a rejected exec, or malformed output all mean "the session
 * has no branch" — `undefined`, never a throw.
 *
 * Contract (S10): `resolveGitRoot` answers "the enclosing git root of cwd" the
 * same way, through `git rev-parse --show-toplevel`. It is the ONLY bound on
 * monorepo walk-up — discovery never reads a `.pi/rules` above this root — so
 * every failure (not a repository, non-zero exit, rejected exec, empty or
 * multi-line output) degrades to `undefined`, and callers then keep today's
 * single-directory behavior. Output is separator-normalized to forward slashes
 * with any trailing separator dropped: git reports platform paths (on Windows
 * a drive path such as `C:/work/repo`), and the rest of this extension compares
 * normalized POSIX-style paths. A path containing spaces is kept intact — a
 * POSIX root may contain them; only multiple output LINES are malformed.
 */

import { normalizedPath } from "../src/types.ts";

/** Exec options as consumed here: the run's working directory. */
export interface ExecOptionsLike {
	readonly cwd?: string;
}

/** Exec result as consumed here: the command's stdout and exit code. */
export interface ExecResultLike {
	readonly stdout: string;
	readonly code: number;
}

/**
 * Structural mirror of pi's `exec` effect. Parameters stay mutable arrays
 * (`string[]`) exactly as pi declares them, so the real `ExtensionAPI` is
 * assignable to this type without casts.
 */
export type ExecLike = (command: string, args: string[], options?: ExecOptionsLike) => Promise<ExecResultLike>;

/** The single argv the branch query uses. */
const BRANCH_ARGS = ["rev-parse", "--abbrev-ref", "HEAD"];

/** The single argv the enclosing-root query uses (S10 walk-up bound). */
const ROOT_ARGS = ["rev-parse", "--show-toplevel"];

/**
 * Maps one exec outcome to a branch name, or `undefined` when there is no
 * usable branch. A git refname never contains whitespace, so an answer that
 * does (an empty line, or several refs) is malformed rather than a branch.
 */
const branchFromOutcome = (outcome: ExecResultLike | undefined): string | undefined => {
	if (outcome === undefined || typeof outcome.stdout !== "string" || outcome.code !== 0) {
		return undefined;
	}
	const branch = outcome.stdout.trim();
	return branch === "" || branch === "HEAD" || /\s/.test(branch) ? undefined : branch;
};

/**
 * Resolves the current branch of `cwd` through the injected exec effect.
 * Total: rejects, malformed results and every git failure degrade to
 * `undefined`; the caller's cycle always continues.
 */
export const resolveBranch = async (cwd: string, exec: ExecLike): Promise<string | undefined> => {
	try {
		return branchFromOutcome(await exec("git", [...BRANCH_ARGS], { cwd }));
	} catch {
		return undefined;
	}
};

/**
 * Normalizes one git path answer: separator-normalized, no trailing separator,
 * or `undefined` when the answer is not exactly one non-empty line.
 */
const pathFromOutcome = (outcome: ExecResultLike | undefined): string | undefined => {
	if (outcome === undefined || typeof outcome.stdout !== "string" || outcome.code !== 0) {
		return undefined;
	}
	const lines = outcome.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	const line = lines.length === 1 ? lines[0] : undefined;
	if (line === undefined) {
		return undefined;
	}
	const normalized = normalizedPath(line);
	return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
};

/**
 * Resolves the enclosing git root of `cwd` through the injected exec effect.
 * Total: a non-git directory, a non-zero exit, a rejected exec or malformed
 * output all degrade to `undefined`, which callers read as "no walk-up bound"
 * and therefore as today's single-directory discovery behavior.
 */
export const resolveGitRoot = async (cwd: string, exec: ExecLike): Promise<string | undefined> => {
	try {
		return pathFromOutcome(await exec("git", [...ROOT_ARGS], { cwd }));
	} catch {
		return undefined;
	}
};
