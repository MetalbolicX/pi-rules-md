import { describe, expect, test } from "vitest";
import { NotImplementedFlowError, runCli } from "./main.ts";

function io(env: NodeJS.ProcessEnv = {}) {
	return { env, stdout: [] as string[], stderr: [] as string[] };
}

describe("runCli argument handling", () => {
	test("parse errors exit 2 and print usage to stderr", async () => {
		const output = io();
		await expect(runCli(["install", "--unknown"], output)).resolves.toBe(2);
		expect(output.stderr.join("\n")).toMatch(/Usage:.*pi-rules/s);
	});

	test("rejects an empty --agent-dir with a usage error", async () => {
		const output = io();
		await expect(runCli(["status", "--agent-dir", ""], output)).resolves.toBe(2);
		expect(output.stderr.join("\n")).toContain("error: --agent-dir requires a non-empty path");
		expect(output.stderr.join("\n")).toMatch(/Usage:.*pi-rules/s);
	});

	test("--help exits 0 and lists pi-rules commands", async () => {
		const output = io();
		await expect(runCli(["--help"], output)).resolves.toBe(0);
		expect(output.stdout.join("\n")).toMatch(/install.*uninstall.*update.*status.*doctor/s);
	});

	test("no args prints usage and exits 2", async () => {
		const output = io();
		await expect(runCli([], output)).resolves.toBe(2);
		expect(output.stderr.join("\n")).toMatch(/Usage:.*pi-rules/s);
	});

	test("unknown command exits 2 and prints usage", async () => {
		const output = io();
		await expect(runCli(["not-a-command"], output)).resolves.toBe(2);
		expect(output.stderr.join("\n")).toMatch(/Usage:.*pi-rules/s);
	});

	test.each(["constructor", "toString", "hasOwnProperty", "__proto__"])("inherited object key %s is an unknown command", async (command) => {
		const output = io();
		await expect(runCli([command], output)).resolves.toBe(2);
		expect(output.stdout).toEqual([]);
		expect(output.stderr.join("\n")).toMatch(/Usage:.*pi-rules/s);
	});

	test("threads PI_RULES_AGENT_DIR to the selected flow", async () => {
		const output = io({ PI_RULES_AGENT_DIR: "/sandbox/agent" });
		let received: { agentDir?: string } | undefined;
		const flows = {
			install: async (options: { agentDir?: string }) => {
				received = options;
				return 0;
			},
			uninstall: async () => 0,
			update: async () => 0,
			status: async () => 0,
			doctor: async () => 0,
		};
		await expect(runCli(["install"], output, flows)).resolves.toBe(0);
		expect(received?.agentDir).toBe("/sandbox/agent");
	});
});

describe("runCli unimplemented flows degrade gracefully", () => {
	test("an injected unimplemented flow exits 2 with a clear message, not a crash", async () => {
		const output = io();
		const flows = {
			install: async () => 0,
			uninstall: async () => 0,
			update: async () => 0,
			status: async () => 0,
			doctor: async () => {
				throw new NotImplementedFlowError("doctor");
			},
		};
		await expect(runCli(["doctor"], output, flows)).resolves.toBe(2);
		expect(output.stderr.join("\n")).toMatch(/doctor flow not implemented/);
		expect(output.stderr.join("\n")).toMatch(/Usage:.*pi-rules/s);
	});

	test("unexpected flow errors still propagate", async () => {
		const output = io();
		const flows = {
			install: async () => 0,
			uninstall: async () => 0,
			update: async () => 0,
			status: async () => {
				throw new Error("boom");
			},
			doctor: async () => 0,
		};
		await expect(runCli(["status"], output, flows)).rejects.toThrow("boom");
	});
});
