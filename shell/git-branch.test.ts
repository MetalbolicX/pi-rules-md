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
import { resolveBranch } from "./git-branch.ts";
import type { ExecLike, ExecResultLike } from "./git-branch.ts";

/** The exact argv the seam is pinned to: one ref query per cycle. */
const BRANCH_ARGS = ["rev-parse", "--abbrev-ref", "HEAD"];

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
