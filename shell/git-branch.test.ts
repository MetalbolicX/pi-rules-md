/**
 * Tests for the git-branch exec seam (shell/git-branch.ts).
 *
 * `resolveBranch` is total by contract: every observable git failure — a
 * non-git directory, a detached HEAD, a non-zero exit, a rejected promise, or
 * malformed output — degrades to "branch absent" (`undefined`) and never
 * throws into the injection cycle. The exec effect is fully injected, so
 * these tests never run git and never touch disk.
 */
import { describe, expect, it } from "vitest";
import { resolveBranch, resolveGitRoot } from "./git-branch.ts";
import type { ExecLike, ExecResultLike } from "./git-branch.ts";

/** The exact argv the seam is pinned to: one ref query per cycle. */
const BRANCH_ARGS = ["rev-parse", "--abbrev-ref", "HEAD"];

/** The exact argv the git-root query is pinned to (S10 walk-up bound). */
const ROOT_ARGS = ["rev-parse", "--show-toplevel"];

/** One recorded exec invocation. */
interface ExecCall {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string | undefined;
}

/** Exec stub answering every call with one fixed result, recording calls. */
const execReturning = (result: ExecResultLike): { readonly exec: ExecLike; readonly calls: ExecCall[] } => {
	const calls: ExecCall[] = [];
	const exec: ExecLike = async (command, args, options) => {
		calls.push({ command, args: [...args], cwd: options?.cwd });
		return result;
	};
	return { exec, calls };
};

/** Exec stub rejecting every call (spawn failure / aborted exec), recording calls. */
const execRejecting = (error: Error): { readonly exec: ExecLike; readonly calls: ExecCall[] } => {
	const calls: ExecCall[] = [];
	const exec: ExecLike = async (command, args, options) => {
		calls.push({ command, args: [...args], cwd: options?.cwd });
		throw error;
	};
	return { exec, calls };
};

describe("resolveBranch", () => {
	it("resolves the trimmed branch from `git rev-parse --abbrev-ref HEAD` in cwd", async () => {
		const { exec, calls } = execReturning({ stdout: "main\n", code: 0 });
		expect(await resolveBranch("/work", exec)).toBe("main");
		expect(calls).toEqual([{ command: "git", args: BRANCH_ARGS, cwd: "/work" }]);
	});

	it("keeps a multi-segment branch name intact", async () => {
		const { exec } = execReturning({ stdout: "feat/rules-v1-2-02-branch\n", code: 0 });
		expect(await resolveBranch("/work", exec)).toBe("feat/rules-v1-2-02-branch");
	});

	it("returns undefined outside a git repository (non-zero exit)", async () => {
		const { exec } = execReturning({ stdout: "", code: 128 });
		expect(await resolveBranch("/work", exec)).toBeUndefined();
	});

	it("returns undefined for a detached HEAD", async () => {
		const { exec } = execReturning({ stdout: "HEAD\n", code: 0 });
		expect(await resolveBranch("/work", exec)).toBeUndefined();
	});

	it("returns undefined for empty or whitespace-only output", async () => {
		for (const stdout of ["", "\n", "   \n\t"]) {
			const { exec } = execReturning({ stdout, code: 0 });
			expect(await resolveBranch("/work", exec)).toBeUndefined();
		}
	});

	it("returns undefined for multi-line output (not one refname)", async () => {
		const { exec } = execReturning({ stdout: "main\nother\n", code: 0 });
		expect(await resolveBranch("/work", exec)).toBeUndefined();
	});

	it("returns undefined when exec rejects (and never throws)", async () => {
		const { exec, calls } = execRejecting(new Error("spawn git ENOENT"));
		await expect(resolveBranch("/work", exec)).resolves.toBeUndefined();
		expect(calls).toHaveLength(1);
	});

	it("returns undefined for a malformed result instead of throwing", async () => {
		const malformed = [
			null,
			undefined,
			{ stdout: undefined, code: 0 },
			{ stdout: "main\n", code: undefined },
			{ stdout: 42, code: 0 },
		];
		for (const result of malformed) {
			const exec: ExecLike = async () => result as unknown as ExecResultLike;
			expect(await resolveBranch("/work", exec)).toBeUndefined();
		}
	});
});

describe("resolveGitRoot", () => {
	it("resolves the normalized enclosing git root from `git rev-parse --show-toplevel` in cwd", async () => {
		const { exec, calls } = execReturning({ stdout: "/repo\n", code: 0 });
		expect(await resolveGitRoot("/repo/packages/a", exec)).toBe("/repo");
		expect(calls).toEqual([{ command: "git", args: ROOT_ARGS, cwd: "/repo/packages/a" }]);
	});

	it("strips a trailing separator and normalizes backslashes to forward slashes", async () => {
		const trailing = execReturning({ stdout: "/repo/\n", code: 0 });
		expect(await resolveGitRoot("/repo/packages/a", trailing.exec)).toBe("/repo");
		const windows = execReturning({ stdout: "C:\\work\\repo\r\n", code: 0 });
		expect(await resolveGitRoot("C:\\work\\repo", windows.exec)).toBe("C:/work/repo");
	});

	it("keeps a root that contains spaces (a POSIX path may)", async () => {
		const { exec } = execReturning({ stdout: "/home/u/My Repo\n", code: 0 });
		expect(await resolveGitRoot("/home/u/My Repo/pkg", exec)).toBe("/home/u/My Repo");
	});

	it("returns undefined outside a git repository (non-zero exit)", async () => {
		const { exec } = execReturning({ stdout: "", code: 128 });
		expect(await resolveGitRoot("/work", exec)).toBeUndefined();
	});

	it("returns undefined for empty, whitespace-only or multi-line output", async () => {
		for (const stdout of ["", "\n", "  \n\t", "/repo\n/other\n"]) {
			const { exec } = execReturning({ stdout, code: 0 });
			expect(await resolveGitRoot("/work", exec)).toBeUndefined();
		}
	});

	it("returns undefined when exec rejects (and never throws)", async () => {
		const { exec, calls } = execRejecting(new Error("spawn git ENOENT"));
		await expect(resolveGitRoot("/work", exec)).resolves.toBeUndefined();
		expect(calls).toHaveLength(1);
	});

	it("returns undefined for a malformed result instead of throwing", async () => {
		const malformed = [
			null,
			undefined,
			{ stdout: undefined, code: 0 },
			{ stdout: "/repo\n", code: undefined },
			{ stdout: 42, code: 0 },
		];
		for (const result of malformed) {
			const exec: ExecLike = async () => result as unknown as ExecResultLike;
			expect(await resolveGitRoot("/work", exec)).toBeUndefined();
		}
	});
});
