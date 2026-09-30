import { mkdtemp, mkdir, readFile, access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, test } from "vitest";
import { runPi } from "./pi-runner.ts";

async function withFakePi(
	body: (bin: string, record: string, env: NodeJS.ProcessEnv) => Promise<void>,
) {
	const root = await mkdtemp(join(tmpdir(), "pi-rules-runner-"));
	const bin = join(root, "bin");
	await mkdir(bin);
	const record = join(root, "argv-record");
	const originalPath = process.env.PATH;
	const originalCwd = process.cwd();
	const env = {
		PATH: `${bin}${delimiter}${join(root, "empty")}`,
		PI_RULES_TEST_RECORD: record,
	};
	await mkdir(env.PATH.split(delimiter)[1]!);
	try {
		await body(bin, record, env);
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		process.chdir(originalCwd);
	}
}

const fakePi = `#!/bin/sh\nprintf '%s\\n' "$@" > "$PI_RULES_TEST_RECORD"\nexit "${"${PI_RULES_TEST_EXIT:-0}"}"\n`;

describe("runPi", () => {
	test("passes each argument unchanged and propagates the child exit code", async () => {
		await withFakePi(async (bin, record, env) => {
			await writeFile(join(bin, "pi"), fakePi, { mode: 0o755 });
			env.PI_RULES_TEST_EXIT = "4";
			const result = await runPi({ argv: ["install", "npm:pi-rules-md", "--local"], env });
			expect(result.exitCode).toBe(4);
			expect((await readFile(record, "utf8")).trimEnd().split("\n")).toEqual([
				"install",
				"npm:pi-rules-md",
				"--local",
			]);
		});
	});

	test("returns a clear error when pi is absent from PATH", async () => {
		await withFakePi(async (_bin, _record, env) => {
			const result = await runPi({ argv: ["list"], env: { ...env, PATH: env.PATH!.split(delimiter)[1] } });
			expect(result).toMatchObject({ exitCode: 1, error: "pi CLI not found on PATH" });
		});
	});

	test("kills a timed-out child with SIGKILL", async () => {
		await withFakePi(async (bin, _record, env) => {
			await writeFile(join(bin, "pi"), "#!/bin/sh\nwhile :; do :; done\n", { mode: 0o755 });
			const result = await runPi({ argv: ["list"], env, timeoutMs: 50 });
			expect(result).toMatchObject({ timedOut: true, signal: "SIGKILL" });
		});
	});

	test("dry run prints the command and never spawns", async () => {
		await withFakePi(async (bin, record, env) => {
			const output: string[] = [];
			const result = await runPi({ argv: ["install", "a b"], env, dryRun: true, stdout: output });
			expect(result.exitCode).toBe(0);
			expect(output).toEqual(["[pi-rules] [dry-run] Would run: pi install a b"]);
			await expect(access(record)).rejects.toThrow();
		});
	});

	test("capture returns child stdout and stderr", async () => {
		await withFakePi(async (bin, _record, env) => {
			await writeFile(join(bin, "pi"), "#!/bin/sh\necho out\necho err >&2\n", { mode: 0o755 });
			const result = await runPi({ argv: ["list"], env, capture: true });
			expect(result).toMatchObject({ exitCode: 0, stdout: "out\n", stderr: "err\n" });
		});
	});
});
