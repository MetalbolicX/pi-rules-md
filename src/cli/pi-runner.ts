import { spawn } from "node:child_process";

export interface PiRunOptions {
	argv: string[];
	timeoutMs?: number;
	dryRun?: boolean;
	capture?: boolean;
	env?: NodeJS.ProcessEnv;
	stdout?: string[];
}

export interface PiRunResult {
	exitCode: number;
	stdout?: string;
	stderr?: string;
	error?: string;
	timedOut?: boolean;
	signal?: NodeJS.Signals | null;
}

export function runPi({ argv, timeoutMs = 30_000, dryRun = false, capture = false, env = process.env, stdout = [] }: PiRunOptions): Promise<PiRunResult> {
	if (dryRun) {
		stdout.push(`[pi-rules] [dry-run] Would run: pi ${argv.join(" ")}`);
		return Promise.resolve({ exitCode: 0 });
	}

	return new Promise((resolve) => {
		let child;
		try {
			child = spawn("pi", argv, { shell: false, env, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
		} catch (error) {
			resolve({ exitCode: 1, error: error instanceof Error ? error.message : String(error) });
			return;
		}
		let out = "";
		let err = "";
		let timedOut = false;
		let spawnError: Error | undefined;
		if (capture) {
			child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { out += chunk; });
			child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { err += chunk; });
		}
		child.once("error", (error) => { spawnError = error; });
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			if ((spawnError as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
				resolve({ exitCode: 1, error: "pi CLI not found on PATH", ...(capture ? { stdout: out, stderr: err } : {}) });
				return;
			}
			resolve({
				exitCode: timedOut ? 1 : code ?? 1,
				...(capture ? { stdout: out, stderr: err } : {}),
				...(spawnError ? { error: spawnError.message } : {}),
				...(timedOut ? { timedOut: true, signal: "SIGKILL" as const } : signal ? { signal } : {}),
			});
		});
	});
}
