import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { installFlow } from "./install.js";
import { uninstallFlow } from "./uninstall.js";
import { updateFlow } from "./update.js";
import { statusFlow } from "./status.js";

export const USAGE = `Usage: pi-rules <command> [options]

Commands:
  install    Install pi-rules-md
  uninstall  Remove pi-rules-md
  update     Update pi-rules-md
  status     Show installation status
  doctor     Diagnose installation health

Options:
  --local              Use the project scope (install/uninstall/update)
  --purge              Remove the package directory (uninstall)
  --agent-dir <dir>    Use a specific Pi agent directory
  --dry-run            Print actions without changing anything
  --help               Show this help`;

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
	io?: CliIO;
	fetchImpl?: typeof fetch;
}

export type CliFlows = Record<"install" | "uninstall" | "update" | "status" | "doctor", (options: FlowOptions) => number | Promise<number>>;

export class NotImplementedFlowError extends Error {
	constructor(name: string) {
		super(`${name} flow not implemented`);
		this.name = "NotImplementedFlowError";
	}
}

const notImplemented = (name: string) => async (_options: FlowOptions): Promise<number> => {
	throw new NotImplementedFlowError(name);
};
const defaultFlows: CliFlows = {
	install: installFlow,
	uninstall: uninstallFlow,
	update: updateFlow,
	status: statusFlow,
	doctor: notImplemented("doctor"),
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
	if (!(command in defaultFlows)) {
		io.stderr.push(USAGE);
		return 2;
	}

	let options: FlowOptions;
	try {
		const { values } = parseArgs({
			args: commandArgs,
			strict: true,
			allowPositionals: false,
			options: {
				...(command === "install" || command === "uninstall" || command === "update" ? { local: { type: "boolean" as const } } : {}),
				...(command === "uninstall" ? { purge: { type: "boolean" as const } } : {}),
				"agent-dir": { type: "string" },
				"dry-run": { type: "boolean" },
				help: { type: "boolean" },
			},
		});
		if (values.help) {
			io.stdout.push(USAGE);
			return 0;
		}
		const agentDir = values["agent-dir"] ?? io.env.PI_RULES_AGENT_DIR;
		options = {
			...(agentDir === undefined ? {} : { agentDir }),
			local: values.local === true,
			purge: values.purge === true,
			dryRun: values["dry-run"] ?? false,
		};
	} catch (error) {
		io.stderr.push(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
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
