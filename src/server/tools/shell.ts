import { join } from "node:path";
import type { Session } from "../../shared/types.ts";
import { classifyGuardMode, guardPreview, sshPreview } from "../permissions/shell.ts";
import { activeSandbox, type SiteQuestion } from "../sandbox.ts";
import { validateSandboxDomain } from "../settings.ts";
import { startCommand } from "./process.ts";
import {
	bool,
	CONFIRM_ARGUMENT,
	errorResult,
	int,
	str,
	type ToolDefinition,
	type ToolResult,
	text,
} from "./types.ts";

const DEFAULT_TIMEOUT = 120;
const MAX_TIMEOUT = 600;

const DESCRIPTION =
	"Run a command with the user's login shell in the working folder. Standard input is closed, so commands must not wait for input. Output keeps the last 2000 lines or 50 KB; longer output is saved to a file named in the result. Times out after 120 seconds by default (timeout_seconds, up to 600). Set background to start a long-running command, such as a dev server, and check on it with shell_job.";

const PARAMETERS = {
	command: { type: "string", description: "The command line to run." },
	description: {
		type: "string",
		description:
			"What the command is for, in a few words in the language the person writes in. Yew shows it to the person when it asks for their permission.",
	},
	timeout_seconds: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT },
	background: { type: "boolean", description: "Start the command and return at once." },
};

/** Offered while the system sandbox is on (sandbox.ts). */
const OUTSIDE_SANDBOX = {
	type: "boolean",
	description:
		"Run outside the sandbox when the command needs saved credentials (such as git push), repository setup (git init, clone, remote or local git config, as one git command on its own: no cd or other commands with it; for a repository outside the working folder, git -C with the full path of a folder you may write), launching a desktop app (open -a <name>, on its own), listening on a local port, or writing outside the session's folders. Whether the person is asked follows the session's permission mode.",
};

/** The folders a session's commands may write: its working folder and the extra folders it may write. */
function writableFolders(session: Session): string[] {
	return [
		...(session.cwd ? [session.cwd] : []),
		...(session.options.extraDirs ?? [])
			.filter((dir) => dir.access === "write")
			.map((dir) => dir.path),
	];
}

export const shellTool: ToolDefinition = {
	name: "shell",
	get description() {
		return activeSandbox() === "none"
			? DESCRIPTION
			: `${DESCRIPTION} Commands run in a sandbox: they write only in the working folder and temporary folders, and reach package registries and code hosts; connecting to another site asks the person.`;
	},
	get parameters() {
		return {
			type: "object",
			properties: {
				...PARAMETERS,
				...(activeSandbox() === "none" ? {} : { outside_sandbox: OUTSIDE_SANDBOX }),
				confirm: CONFIRM_ARGUMENT,
			},
			required: ["command"],
			additionalProperties: false,
		};
	},
	readOnly: false,
	needsFolder: true,
	subject(args) {
		return {
			kind: "command",
			tool: "shell",
			command: str(args, "command", true),
			...(outsideSandbox(args) ? { outsideSandbox: true } : {}),
		};
	},
	preview(args, session) {
		const command = typeof args.command === "string" ? args.command : "";
		const description = typeof args.description === "string" ? args.description.trim() : "";
		const ssh = command ? sshPreview(command) : null;
		// A command that opens the outer guard says what it changes, or that the app runs unprotected.
		const guard = command
			? guardPreview(command, session.cwd, { writable: writableFolders(session) })
			: null;
		const combined = [guard, ssh, description].filter(Boolean).join("\n");
		return combined ? { description: combined.slice(0, 600) } : {};
	},
	async run(args, ctx): Promise<ToolResult> {
		const command = str(args, "command", true);
		const outside = outsideSandbox(args);
		const timeout = int(args, "timeout_seconds", 1, MAX_TIMEOUT) ?? DEFAULT_TIMEOUT;
		const cwd = ctx.session.cwd;
		if (!cwd) return errorResult("This session has no working folder.");
		const writableDirs = writableFolders(ctx.session);
		const allowedSites = ctx.session.options.allowedDomains ?? [];
		const logDir = join(ctx.tmpDir, "output");

		if (bool(args, "background")) {
			const job = await ctx.jobs.start({
				command,
				cwd,
				sessionId: ctx.session.id,
				logDir,
				outsideSandbox: outside,
				writableDirs,
				allowedSites,
			});
			return {
				content: [
					text(
						`Started in the background as ${job.id}. Use shell_job to read its output or stop it; Yew will tell you when it ends.`,
					),
				],
				detail: { job: job.id },
			};
		}

		const started = Date.now();
		const permit = ctx.permit;
		// A question still open when the command has ended is withdrawn.
		const asking = new AbortController();
		const running = await startCommand({
			command,
			cwd,
			sessionId: ctx.session.id,
			logDir,
			onOutput: ctx.output,
			outsideSandbox: outside,
			guardMode: classifyGuardMode(command, { writable: writableDirs }),
			writableDirs,
			allowedSites,
			// A site outside the sandbox's list is put to the person on this call's card.
			...(permit
				? {
						ask: (question: SiteQuestion) => {
							let rememberHost: string | null = null;
							if (!question.unsure) {
								try {
									rememberHost = validateSandboxDomain(question.host, "allowedDomains");
								} catch {
									rememberHost = null;
								}
							}
							return permit(
								{
									tool: "shell",
									summary:
										question.port === undefined
											? question.host
											: `${question.host}:${question.port}`,
									mustConfirm: false,
									reasons: [question.unsure ? "connect-site-unsure" : "connect-site"],
									description: command.slice(0, 300),
									...(rememberHost
										? {
												rememberRules: [
													{ effect: "allow", tool: "sandbox_site", pattern: rememberHost },
												],
											}
										: {}),
									...(question.unsure ? { running: question.unsure } : {}),
								},
								asking.signal,
							);
						},
					}
				: {}),
		});
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			running.stop();
		}, timeout * 1000);
		const onAbort = () => running.stop();
		ctx.signal.addEventListener("abort", onAbort, { once: true });
		const { exitCode, signal } = await running.done;
		asking.abort();
		clearTimeout(timer);
		ctx.signal.removeEventListener("abort", onAbort);

		const output = running.output.render();
		const status = timedOut
			? `Stopped after ${timeout} seconds (timeout).`
			: ctx.signal.aborted
				? "Stopped by the user."
				: exitCode === null
					? `Ended by signal ${signal ?? "unknown"}.`
					: `Exit code ${exitCode}.`;
		return {
			content: [text(output ? `${status}\n${output}` : `${status} No output.`)],
			isError: timedOut || exitCode === null,
			detail: {
				exitCode,
				timedOut,
				durationMs: Date.now() - started,
				logFile: running.output.file,
			},
		};
	},
};

/** Whether the call asks to run outside the sandbox; only while there is one. */
function outsideSandbox(args: Parameters<typeof bool>[0]): boolean {
	return bool(args, "outside_sandbox") === true && activeSandbox() !== "none";
}

export const shellJobTool: ToolDefinition = {
	name: "shell_job",
	description: "Read the output of a command started with background, or stop it.",
	parameters: {
		type: "object",
		properties: {
			job: { type: "string", description: "The job id, such as job-1." },
			action: {
				type: "string",
				enum: ["output", "stop"],
				description: "output (default) or stop.",
			},
		},
		required: ["job"],
		additionalProperties: false,
	},
	readOnly: false,
	needsFolder: true,
	subject() {
		return { kind: "none" };
	},
	async run(args, ctx): Promise<ToolResult> {
		const id = str(args, "job", true);
		const action = str(args, "action") ?? "output";
		const job = ctx.jobs.get(id);
		if (!job) return errorResult(`There is no job ${id} in this session.`);
		if (action === "stop" && !job.finished) {
			job.running.stop();
			await job.running.done;
		}
		const state = job.finished
			? `${id} ended${job.finished.exitCode === null ? "" : ` with exit code ${job.finished.exitCode}`}.`
			: `${id} is still running.`;
		const output = job.running.output.render();
		return { content: [text(output ? `${state}\n${output}` : `${state} No output yet.`)] };
	},
};
