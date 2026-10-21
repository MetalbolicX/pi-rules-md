import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { installFlow } from "./install.js";
import { uninstallFlow } from "./uninstall.js";
import { updateFlow } from "./update.js";
import { statusFlow } from "./status.js";
import { doctorFlow } from "./doctor.js";
import { LINT_USAGE, lintFlow } from "./lint.js";
import { NEW_USAGE, newFlow } from "./new.js";
import { EXPLAIN_USAGE, explainFlow } from "./explain.js";

export const USAGE = `Usage: pi-rules <command> [options]

Commands:
  install                  Install pi-rules-md
  uninstall                Remove pi-rules-md
  update                   Update pi-rules-md
  status                   Show installation status
  doctor                   Diagnose installation health
  lint [dir...]            Validate rule files
  new <name> [--global]    Scaffold a valid rule file
  explain <path>           Explain which rules a path would activate

Options:
  --local              Use the project scope (install/uninstall/update)
  --purge              Remove the package directory (uninstall)
  --global             Scaffold a global rule (new)
  --agent-dir <dir>    Use a specific Pi agent directory
  --dry-run            Print actions without changing anything
  --help               Show this help`;

/**
 * Per-command help: `--help` after a command prints that command's own usage
 * (its positionals, defaults and exit codes), not the generic command table.
 */
const commandUsage = (command: string): string => {
	switch (command) {
		case "lint":
			return LINT_USAGE;
		case "new":
			return NEW_USAGE;
		case "explain":
			return EXPLAIN_USAGE;
		default:
			return USAGE;
	}
};

export interface CliIO {
	env: NodeJS.ProcessEnv;
	stdout: string[];
	stderr: string[];
}

export interface FlowOptions {
	agentDir?: string;
	local?: boolean;
	purge?: boolean;
	dryRun: boolean;
	/** `lint`: the rule directories to lint (its positionals). */
	dirs?: readonly string[];
	/** `new`: the rule name to scaffold. */
	name?: string;
	/** `explain`: the path whose activation is explained. */
	path?: string;
	/** `new`: scaffold in the global rules directory instead of the project's. */
	global?: boolean;
	io?: CliIO;
	fetchImpl?: typeof fetch;
}

export type CliFlows = Record<
	"install" | "uninstall" | "update" | "status" | "doctor" | "lint" | "new" | "explain",
	(options: FlowOptions) => number | Promise<number>
>;

export class NotImplementedFlowError extends Error {
	constructor(name: string) {
		super(`${name} flow not implemented`);
		this.name = "NotImplementedFlowError";
	}
}

const defaultFlows: CliFlows = {
	install: installFlow,
	uninstall: uninstallFlow,
	update: updateFlow,
	status: statusFlow,
	doctor: doctorFlow,
	lint: lintFlow,
	new: newFlow,
	explain: explainFlow,
};

export async function runCli(args: string[], io: CliIO, flows: CliFlows = defaultFlows): Promise<number> {
	const [command, ...commandArgs] = args;
	if (command === "--help") {
		io.stdout.push(USAGE);
		return 0;
	}
	if (!command) {
		io.stderr.push(USAGE);
		return 2;
	}
	// Own keys only: `in` also accepts inherited names such as `constructor`.
	if (!Object.hasOwn(defaultFlows, command)) {
		io.stderr.push(USAGE);
		return 2;
	}

	let options: FlowOptions;
	try {
		const { values, positionals } = parseArgs({
			args: commandArgs,
			strict: true,
			// `lint` takes the rule directories to lint; `new` a rule name and
			// `explain` a path. Every other command takes no positionals.
			allowPositionals: command === "lint" || command === "new" || command === "explain",
			options: {
				...(command === "install" || command === "uninstall" || command === "update" ? { local: { type: "boolean" as const } } : {}),
				...(command === "uninstall" ? { purge: { type: "boolean" as const } } : {}),
				...(command === "new" ? { global: { type: "boolean" as const } } : {}),
				"agent-dir": { type: "string" },
				"dry-run": { type: "boolean" },
				help: { type: "boolean" },
			},
		});
		if (values.help) {
			io.stdout.push(commandUsage(command));
			return 0;
		}
		// `new` and `explain` take exactly one positional: a missing or extra one is
		// a usage error, reported with that command's own usage text.
		if ((command === "new" || command === "explain") && positionals.length !== 1) {
			const noun = command === "new" ? "a rule name" : "a path";
			io.stderr.push(`error: ${command} requires exactly one argument (${noun})\n${commandUsage(command)}`);
			return 2;
		}
		const agentDir = values["agent-dir"] ?? io.env.PI_RULES_AGENT_DIR;
		if (agentDir !== undefined && agentDir.trim() === "") {
			io.stderr.push(`error: --agent-dir requires a non-empty path\n${USAGE}`);
			return 2;
		}
		options = {
			...(agentDir === undefined ? {} : { agentDir }),
			local: values.local === true,
			purge: values.purge === true,
			dryRun: values["dry-run"] ?? false,
			...(command === "lint" ? { dirs: positionals } : {}),
			...(command === "new" ? { name: positionals[0], global: values.global === true } : {}),
			...(command === "explain" ? { path: positionals[0] } : {}),
		};
	} catch (error) {
		// Argument-shape errors answer with the command's own usage when it has one.
		io.stderr.push(`${error instanceof Error ? error.message : String(error)}\n${commandUsage(command)}`);
		return 2;
	}
	try {
		return await flows[command as keyof CliFlows]({ ...options, io });
	} catch (error) {
		if (error instanceof NotImplementedFlowError) {
			io.stderr.push(`error: ${error.message} in this build; it lands in an upcoming release.\n${USAGE}`);
			return 2;
		}
		throw error;
	}
}

// oxlint-disable-next-line unicorn/prefer-import-meta-properties -- compare canonical argv path with the module URL as the CLI entry guard.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const io: CliIO = { env: process.env, stdout: [], stderr: [] };
	process.exitCode = await runCli(process.argv.slice(2), io);
	for (const line of io.stdout) console.log(line);
	for (const line of io.stderr) console.error(line);
}
