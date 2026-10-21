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
		// Every command in one table, install first and the authoring commands last.
		expect(output.stdout.join("\n")).toMatch(/install.*uninstall.*update.*status.*doctor.*lint.*new.*explain/s);
		expect(output.stdout.join("\n")).toMatch(/new <name>/);
		expect(output.stdout.join("\n")).toMatch(/explain <path>/);
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
			lint: async () => 0,
			new: async () => 0,
			explain: async () => 0,
		};
		await expect(runCli(["install"], output, flows)).resolves.toBe(0);
		expect(received?.agentDir).toBe("/sandbox/agent");
	});
});

describe("runCli lint dispatch", () => {
	test("lint --help prints the lint help, not the generic usage", async () => {
		const output = io();
		await expect(runCli(["lint", "--help"], output)).resolves.toBe(0);
		expect(output.stdout.join("\n")).toContain("Usage: pi-rules lint [dir...]");
		expect(output.stdout.join("\n")).toContain("<file>: <code>: <message>");
	});

	test("lint forwards positional directories to the flow", async () => {
		const output = io();
		let received: readonly string[] | undefined;
		const flows = {
			install: async () => 0,
			uninstall: async () => 0,
			update: async () => 0,
			status: async () => 0,
			doctor: async () => 0,
			lint: async (options: { dirs?: readonly string[] }) => {
				received = options.dirs;
				return 1;
			},
			new: async () => 0,
			explain: async () => 0,
		};
		await expect(runCli(["lint", "rules-a", "rules-b"], output, flows)).resolves.toBe(1);
		expect(received).toEqual(["rules-a", "rules-b"]);
	});

	test("lint without directories forwards an empty positional list", async () => {
		const output = io();
		let received: readonly string[] | undefined;
		const flows = {
			install: async () => 0,
			uninstall: async () => 0,
			update: async () => 0,
			status: async () => 0,
			doctor: async () => 0,
			lint: async (options: { dirs?: readonly string[] }) => {
				received = options.dirs;
				return 0;
			},
			new: async () => 0,
			explain: async () => 0,
		};
		await expect(runCli(["lint"], output, flows)).resolves.toBe(0);
		expect(received).toEqual([]);
	});

	test("other commands still reject positional arguments", async () => {
		const output = io();
		await expect(runCli(["status", "extra"], output)).resolves.toBe(2);
		expect(output.stderr.join("\n")).toMatch(/Usage:.*pi-rules/s);
	});
});

describe("runCli new/explain dispatch", () => {
	test("new --help prints the new help, not the generic usage", async () => {
		const output = io();
		await expect(runCli(["new", "--help"], output)).resolves.toBe(0);
		expect(output.stdout.join("\n")).toContain("Usage: pi-rules new <name> [--global]");
		expect(output.stdout.join("\n")).toContain("NEVER overwritten");
	});

	test("explain --help prints the explain help, not the generic usage", async () => {
		const output = io();
		await expect(runCli(["explain", "--help"], output)).resolves.toBe(0);
		expect(output.stdout.join("\n")).toContain("Usage: pi-rules explain <path>");
		expect(output.stdout.join("\n")).toContain("path-condition");
	});

	test("new forwards the rule name and the --global flag", async () => {
		const output = io();
		let received: { name?: string; global?: boolean } | undefined;
		const flows = {
			install: async () => 0,
			uninstall: async () => 0,
			update: async () => 0,
			status: async () => 0,
			doctor: async () => 0,
			lint: async () => 0,
			new: async (options: { name?: string; global?: boolean }) => {
				received = options;
				return 0;
			},
			explain: async () => 0,
		};
		await expect(runCli(["new", "use-tabs", "--global"], output, flows)).resolves.toBe(0);
		expect(received?.name).toBe("use-tabs");
		expect(received?.global).toBe(true);
	});

	test("new without --global forwards global: false", async () => {
		const output = io();
		let received: { global?: boolean } | undefined;
		const flows = {
			install: async () => 0,
			uninstall: async () => 0,
			update: async () => 0,
			status: async () => 0,
			doctor: async () => 0,
			lint: async () => 0,
			new: async (options: { global?: boolean }) => {
				received = options;
				return 0;
			},
			explain: async () => 0,
		};
		await expect(runCli(["new", "use-tabs"], output, flows)).resolves.toBe(0);
		expect(received?.global).toBe(false);
	});

	test("explain forwards the path", async () => {
		const output = io();
		let received: string | undefined;
		const flows = {
			install: async () => 0,
			uninstall: async () => 0,
			update: async () => 0,
			status: async () => 0,
			doctor: async () => 0,
			lint: async () => 0,
			new: async () => 0,
			explain: async (options: { path?: string }) => {
				received = options.path;
				return 0;
			},
		};
		await expect(runCli(["explain", "src/app.ts"], output, flows)).resolves.toBe(0);
		expect(received).toBe("src/app.ts");
	});

	test.each([["new"], ["explain"]])("%s without its argument is a usage error (exit 2)", async (command: string) => {
		const output = io();
		let called = false;
		const flows = {
			install: async () => 0,
			uninstall: async () => 0,
			update: async () => 0,
			status: async () => 0,
			doctor: async () => 0,
			lint: async () => 0,
			new: async () => {
				called = true;
				return 0;
			},
			explain: async () => {
				called = true;
				return 0;
			},
		};
		await expect(runCli([command], output, flows)).resolves.toBe(2);
		expect(called).toBe(false);
		expect(output.stdout).toEqual([]);
		expect(output.stderr.join("\n")).toMatch(/Usage: pi-rules (new <name> \[--global\]|explain <path>)/);
	});

	test.each([
		["new", "a", "b"],
		["explain", "a", "b"],
	])("%s rejects a second positional argument", async (command: string, first: string, second: string) => {
		const output = io();
		await expect(runCli([command, first, second], output)).resolves.toBe(2);
		expect(output.stdout).toEqual([]);
		expect(output.stderr.join("\n")).toContain("exactly one");
	});

	test("--global is only accepted by new", async () => {
		const output = io();
		await expect(runCli(["lint", "--global"], output)).resolves.toBe(2);
		expect(output.stderr.join("\n")).toMatch(/Usage:.*pi-rules/s);
	});

	test("lint still rejects an unknown flag", async () => {
		const output = io();
		await expect(runCli(["lint", "--bogus"], output)).resolves.toBe(2);
	});

	test("an unknown flag on new answers with the new usage", async () => {
		const output = io();
		await expect(runCli(["new", "use-tabs", "--bogus"], output)).resolves.toBe(2);
		expect(output.stderr.join("\n")).toContain("Usage: pi-rules new <name>");
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
			lint: async () => 0,
			new: async () => 0,
			explain: async () => 0,
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
			lint: async () => 0,
			new: async () => 0,
			explain: async () => 0,
		};
		await expect(runCli(["status"], output, flows)).rejects.toThrow("boom");
	});
});
