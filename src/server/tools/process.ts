import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { containersNote, type GuardMode, guardedArgs } from "../guard.ts";
import { newId } from "../ids.ts";
import { gitSettingsNote } from "../permissions/shell.ts";
import {
	activeSandbox,
	checkRepositories,
	OUTSIDE_GIT,
	quote,
	type SiteQuestion,
	sandboxed,
	snapshotRepositories,
} from "../sandbox.ts";

export const MAX_LINES = 2000;
export const MAX_BYTES = 50 * 1024;

/**
 * Keeps the tail of a command's output (2000 lines or 50 KB, prior-art 4.2). Once the output grows past
 * that, everything is also written to a log file, so nothing is lost and the model can read it.
 */
export class OutputTail {
	#tail = "";
	#total = 0;
	#file: string | null = null;
	#dir: string;
	#buffered = "";

	constructor(dir: string) {
		this.#dir = dir;
	}

	push(chunk: string): void {
		this.#total += Buffer.byteLength(chunk);
		this.#tail += chunk;
		if (this.#file) {
			appendFileSync(this.#file, chunk);
		} else {
			this.#buffered += chunk;
			if (Buffer.byteLength(this.#buffered) > MAX_BYTES) {
				mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
				this.#file = join(this.#dir, `${newId()}.log`);
				writeFileSync(this.#file, this.#buffered, { mode: 0o600 });
				this.#buffered = "";
			}
		}
		if (this.#tail.length > MAX_BYTES * 2) this.#tail = this.#tail.slice(-MAX_BYTES * 2);
	}

	get file(): string | null {
		return this.#file;
	}

	/** The kept tail, cut at a line boundary, with a note when output was dropped. */
	render(): string {
		let text = this.#tail;
		let truncated = this.#file !== null;
		let lines = text.split("\n");
		if (lines.length > MAX_LINES) {
			lines = lines.slice(-MAX_LINES);
			truncated = true;
		}
		text = lines.join("\n");
		while (Buffer.byteLength(text) > MAX_BYTES) {
			const cut = text.indexOf("\n");
			text = cut < 0 ? text.slice(-MAX_BYTES) : text.slice(cut + 1);
			truncated = true;
		}
		if (!truncated) return text;
		const where = this.#file ? ` The full output (${this.#total} bytes) is in ${this.#file}.` : "";
		return `[Earlier output was cut; showing the last part.${where}]\n${text}`;
	}
}

/** Provider keys Yew keeps out of commands' environment (AGENTS.md: keys stay in the keychain). */
const KEY_VARIABLES =
	/^(ANTHROPIC|OPENAI|DEEPSEEK|GEMINI|GOOGLE|GROQ|MISTRAL|MOONSHOT|KIMI|ZAI|ZHIPU|MINIMAX|DASHSCOPE|QWEN|XIAOMI|MIMO|OPENROUTER|XAI|TOGETHER|FIREWORKS|CEREBRAS|HF|HUGGINGFACE|NVIDIA|BASETEN|VERCEL_AI_GATEWAY|AZURE_OPENAI)_API_KEY$/;

export function commandEnvironment(sessionId: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(process.env)) {
		// Keys stay out, and so do an evaluation's switches (docs/sim.md, section 3).
		if (!KEY_VARIABLES.test(name) && !name.startsWith("YEW_SIM")) env[name] = value;
	}
	return {
		...env,
		YEW_SESSION: sessionId,
		NO_COLOR: "1",
		PAGER: "cat",
		GIT_PAGER: "cat",
		GIT_TERMINAL_PROMPT: "0",
	};
}

/** Shells tried in order when SHELL is not set, or names a program that is not there. */
const SHELLS = ["/bin/zsh", "/usr/bin/zsh", "/bin/bash", "/usr/bin/bash", "/bin/sh"];

/**
 * The shell commands run in: the person's SHELL when it is there; otherwise zsh, then bash, then sh,
 * whichever this computer has. A service started at login or in a container often has no SHELL,
 * and Linux often has no zsh.
 */
export function loginShell(
	env: NodeJS.ProcessEnv = process.env,
	exists: (path: string) => boolean = existsSync,
): string {
	if (env.SHELL && exists(env.SHELL)) return env.SHELL;
	return SHELLS.find((shell) => exists(shell)) ?? "/bin/sh";
}

export interface RunningCommand {
	child: ChildProcess;
	output: OutputTail;
	done: Promise<{ exitCode: number | null; signal: string | null }>;
	stop(): void;
}

/**
 * Runs a command with the user's login shell in its own process group, so stopping it ends every
 * process it started. When the system sandbox is on (sandbox.ts) the command runs in it, able to
 * write in its working folder, unless the person approved `outsideSandbox` for this one command;
 * `ask` puts a site it wants to reach to the person. Stopping freezes the group first, so `a; b`
 * cannot slip into `b` while it is being ended (pi's approach on macOS, prior-art 4.2), then sends
 * SIGTERM and, 3 seconds later, SIGKILL.
 */
export async function startCommand(options: {
	command: string;
	cwd: string;
	sessionId: string;
	logDir: string;
	onOutput?: (chunk: string) => void;
	outsideSandbox?: boolean;
	/** Guard relaxation profile for explicitly approved Decision commands (`git-setup` or `launch-app`). */
	guardMode?: GuardMode;
	/** The repository a `git-setup` command names: checked after it, however deep it is. */
	repository?: string | null;
	/** The person lets this session use container engines outside the sandbox. */
	containers?: boolean;
	/** Folders this command may write inside the sandbox; defaults to `[cwd]`. */
	writableDirs?: string[];
	/** Extra domains this command may reach inside the sandbox without asking. */
	allowedSites?: string[];
	ask?: (question: SiteQuestion) => Promise<boolean>;
	/** Started in the background (shell_job), as a card listing what runs in the sandbox says. */
	background?: boolean;
}): Promise<RunningCommand> {
	const shell = loginShell();
	const env = commandEnvironment(options.sessionId);
	const outside = options.outsideSandbox === true && activeSandbox() !== "none";
	const writable =
		options.writableDirs && options.writableDirs.length > 0 ? options.writableDirs : [options.cwd];
	const guardMode: GuardMode = options.guardMode ?? "default";
	const box = outside
		? null
		: await sandboxed(`exec ${quote(shell)} -lc ${quote(options.command)}`, {
				grant: {
					writable,
					...(options.allowedSites && options.allowedSites.length > 0
						? { sites: options.allowedSites }
						: {}),
				},
				text: options.command,
				label: {
					kind: options.background ? "job" : "command",
					text: options.command.slice(0, 300),
				},
				...(options.ask ? { ask: options.ask } : {}),
			});
	if (box) {
		for (const name of box.unset) delete env[name];
		Object.assign(env, box.env);
	}
	// A repository setup outside the sandbox is checked when it ends: the repositories in the folders
	// it may write, and the one it names, which may be deeper than the walk through those folders goes.
	const gitAudit =
		!box && guardMode === "git-setup"
			? snapshotRepositories([...writable, ...(options.repository ? [options.repository] : [])])
			: null;
	const guarded = box
		? null
		: guardedArgs(shell, options.command, options.cwd, undefined, guardMode, writable, {
				containers: options.containers === true,
			});
	const outsideEnv =
		outside || guardMode === "git-setup"
			? {
					...env,
					...OUTSIDE_GIT,
					...(guardMode === "git-setup" ? { GIT_TEMPLATE_DIR: "" } : {}),
				}
			: env;
	const child = box
		? spawn(box.line, {
				shell: true,
				cwd: options.cwd,
				env,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			})
		: // Outside the sandbox it still runs in the guard, kept out of Yew's data (guard.ts).
			spawn(guarded?.file ?? shell, guarded?.args ?? ["-lc", options.command], {
				cwd: options.cwd,
				env: outsideEnv,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
	const output = new OutputTail(options.logDir);
	const onData = (data: Buffer) => {
		const chunk = data.toString("utf8");
		output.push(chunk);
		options.onOutput?.(chunk);
	};
	child.stdout?.on("data", onData);
	child.stderr?.on("data", onData);
	const done = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
		child.on("error", (error) => {
			output.push(`\n${error.message}\n`);
			resolve({ exitCode: null, signal: null });
		});
		child.on("close", (exitCode, signal) => resolve({ exitCode, signal }));
	}).then((result) => {
		// When a command failed, what the sandbox kept from it goes after the output, so the session
		// sees why.
		const { blocked, notes } = box?.finish() ?? { blocked: [], notes: [] };
		const auditNotes = gitAudit ? checkRepositories(gitAudit) : [];
		// A repository's settings refused by the sandbox or the guard: say when they are let through.
		// A container engine refused by the guard: say who can open it.
		const rendered = box || guarded ? output.render() : "";
		const settings = rendered ? gitSettingsNote(rendered) : null;
		const engines = guarded && options.containers !== true ? containersNote(rendered) : null;
		const allNotes = [
			...notes,
			...auditNotes,
			...(settings ? [settings] : []),
			...(engines ? [engines] : []),
		];
		if (allNotes.length > 0) {
			output.push(`\n[Yew Harness, after the command]\n${allNotes.join("\n")}\n`);
		}
		if (blocked.length > 0 && result.exitCode !== 0) {
			output.push(
				`\n[Blocked by the sandbox: ${blocked.length} time(s). If the command needs this, run it again with outside_sandbox.]\n${blocked.slice(0, 10).join("\n")}\n`,
			);
		}
		return result;
	});
	let stopping = false;
	const stop = () => {
		if (stopping || child.exitCode !== null || child.pid === undefined) return;
		stopping = true;
		const group = -child.pid;
		const send = (signal: NodeJS.Signals) => {
			try {
				process.kill(group, signal);
			} catch {
				// Already gone.
			}
		};
		send("SIGSTOP");
		send("SIGTERM");
		send("SIGCONT");
		const timer = setTimeout(() => send("SIGKILL"), 3000);
		void done.then(() => clearTimeout(timer));
	};
	return { child, output, done, stop };
}
