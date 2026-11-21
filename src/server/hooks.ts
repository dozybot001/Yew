import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { JsonObject } from "../shared/messages.ts";
import { commandEnvironment, loginShell } from "./tools/process.ts";

/**
 * Hooks: commands the person sets to run at points of a session, written the way Claude Code's
 * `hooks` setting is, so ones made for it work here.
 *
 * They are kept in `hooks.json` in Yew Harness's data folder, which sessions cannot reach, so a
 * session cannot plant one; hooks in a project's own files are not read. A hook runs as the person,
 * gets a JSON description of the moment on standard input, and answers with its exit code:
 * 0 lets things go on (at the start of a session and when the person writes, what it prints goes
 * to the session as context); 2 stops the step and says why (before a call: the call does not run;
 * after it: the reason goes with the result; before the session stops: it goes on); anything else
 * is an error the person is told of. A hook can stop or add, never allow: it does not answer a
 * permission or a decision for the person.
 */
export const HOOK_EVENTS = [
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"Stop",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

interface HookCommand {
	command: string;
	/** Seconds. */
	timeout: number;
}

interface HookGroup {
	/** Tool names it applies to, as a regular expression; every tool when empty. */
	matcher: string;
	hooks: HookCommand[];
}

export interface HookOutcome {
	/** Why a hook stopped the step; null when none did. */
	block: string | null;
	/** What hooks printed for the session to know. */
	context: string;
	/** Hooks that failed, for the person: the command and what it said. */
	errors: string[];
}

const DEFAULT_TIMEOUT = 60;
const MAX_TIMEOUT = 600;
const MAX_OUTPUT = 64 * 1024;

/** Yew's tools by the names Claude Code gives them, so a matcher written for it matches. */
const CLAUDE_NAMES: Record<string, string> = {
	shell: "Bash",
	shell_job: "Bash",
	read: "Read",
	write: "Write",
	edit: "Edit",
	glob: "Glob",
	grep: "Grep",
	web_fetch: "WebFetch",
	web_search: "WebSearch",
	todo: "TodoWrite",
	ask_user: "AskUserQuestion",
	open_session: "Task",
	delegate: "Task",
};

export function claudeToolName(tool: string): string {
	return CLAUDE_NAMES[tool] ?? tool;
}

/** A tool's arguments in the shape Claude Code gives a hook: absolute `file_path`, `old_string`. */
export function claudeToolInput(tool: string, args: JsonObject, cwd: string | null): JsonObject {
	const path = (value: unknown) => {
		if (typeof value !== "string") return value;
		if (value.startsWith("~/")) return join(homedir(), value.slice(2));
		return isAbsolute(value) || !cwd ? value : resolve(cwd, value);
	};
	const {
		path: file,
		old_text,
		new_text,
		...rest
	} = args as JsonObject & {
		path?: unknown;
		old_text?: unknown;
		new_text?: unknown;
	};
	switch (tool) {
		case "read":
		case "write":
		case "edit":
			return {
				...rest,
				...(file !== undefined ? { file_path: path(file) as string } : {}),
				...(old_text !== undefined ? { old_string: old_text } : {}),
				...(new_text !== undefined ? { new_string: new_text } : {}),
			} as JsonObject;
		case "shell_job":
			return { ...args, run_in_background: true };
		default:
			return args;
	}
}

/** The hooks in a parsed file, the events and commands it can run; the rest is left out. */
export function readHooks(parsed: unknown): Partial<Record<HookEvent, HookGroup[]>> {
	const root = parsed && typeof parsed === "object" ? (parsed as { hooks?: unknown }).hooks : null;
	if (!root || typeof root !== "object") return {};
	const out: Partial<Record<HookEvent, HookGroup[]>> = {};
	for (const event of HOOK_EVENTS) {
		const groups = (root as Record<string, unknown>)[event];
		if (!Array.isArray(groups)) continue;
		out[event] = groups.flatMap((group): HookGroup[] => {
			if (!group || typeof group !== "object") return [];
			const { matcher, hooks } = group as { matcher?: unknown; hooks?: unknown };
			const commands = (Array.isArray(hooks) ? hooks : []).flatMap((hook): HookCommand[] => {
				const { type, command, timeout } = (hook ?? {}) as {
					type?: unknown;
					command?: unknown;
					timeout?: unknown;
				};
				if (type !== "command" || typeof command !== "string" || !command.trim()) return [];
				const seconds =
					typeof timeout === "number" && timeout > 0
						? Math.min(timeout, MAX_TIMEOUT)
						: DEFAULT_TIMEOUT;
				return [{ command, timeout: seconds }];
			});
			return commands.length > 0
				? [{ matcher: typeof matcher === "string" ? matcher : "", hooks: commands }]
				: [];
		});
	}
	return out;
}

/** Whether a group applies to a tool, by Yew's name or Claude Code's. */
export function matches(matcher: string, tool: string | undefined): boolean {
	if (!matcher || matcher === "*" || tool === undefined) return true;
	let pattern: RegExp;
	try {
		pattern = new RegExp(`^(?:${matcher})$`);
	} catch {
		return matcher === tool || matcher === claudeToolName(tool);
	}
	return pattern.test(tool) || pattern.test(claudeToolName(tool));
}

/** One hook's run: its exit code (null when it did not finish), and what it printed. */
async function runOne(
	hook: HookCommand,
	input: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((done) => {
		const child = spawn(loginShell(), ["-lc", hook.command], {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const keep = (into: "out" | "err") => (chunk: Buffer) => {
			if (into === "out") stdout = (stdout + chunk.toString("utf8")).slice(0, MAX_OUTPUT);
			else stderr = (stderr + chunk.toString("utf8")).slice(0, MAX_OUTPUT);
		};
		child.stdout.on("data", keep("out"));
		child.stderr.on("data", keep("err"));
		const timer = setTimeout(() => child.kill("SIGKILL"), hook.timeout * 1000);
		child.on("error", (error) => {
			clearTimeout(timer);
			done({ code: null, stdout, stderr: error.message });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			done({ code, stdout, stderr });
		});
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	});
}

/** What a hook that ended well printed: a block or context in Claude Code's JSON form, or plain text. */
function readAnswer(stdout: string): { block: string | null; context: string } {
	const text = stdout.trim();
	if (!text.startsWith("{")) return { block: null, context: text };
	try {
		const answer = JSON.parse(text) as {
			decision?: unknown;
			reason?: unknown;
			hookSpecificOutput?: {
				permissionDecision?: unknown;
				permissionDecisionReason?: unknown;
				additionalContext?: unknown;
			};
		};
		const said = (value: unknown) => (typeof value === "string" ? value : "");
		const specific = answer.hookSpecificOutput ?? {};
		if (answer.decision === "block") {
			return { block: said(answer.reason) || "A hook stopped this.", context: "" };
		}
		// "deny" stops a call; "allow" and "ask" are not taken: a hook does not allow for the person.
		if (specific.permissionDecision === "deny") {
			return {
				block: said(specific.permissionDecisionReason) || "A hook stopped this.",
				context: "",
			};
		}
		return { block: null, context: said(specific.additionalContext) };
	} catch {
		return { block: null, context: text };
	}
}

export class Hooks {
	readonly #file: string;
	#stamp = -1;
	#hooks: Partial<Record<HookEvent, HookGroup[]>> = {};

	constructor(yewHome: string) {
		this.#file = join(yewHome, "hooks.json");
	}

	/** The file is read again when it changed, so an edit applies from the next step. */
	#current(): Partial<Record<HookEvent, HookGroup[]>> {
		const stamp = existsSync(this.#file) ? statSync(this.#file).mtimeMs : 0;
		if (stamp !== this.#stamp) {
			this.#stamp = stamp;
			try {
				this.#hooks = stamp ? readHooks(JSON.parse(readFileSync(this.#file, "utf8"))) : {};
			} catch {
				this.#hooks = {};
			}
		}
		return this.#hooks;
	}

	has(event: HookEvent, tool?: string): boolean {
		return (this.#current()[event] ?? []).some((group) => matches(group.matcher, tool));
	}

	/** Runs the hooks for an event (and a tool), all at once, and puts their answers together. */
	async run(
		event: HookEvent,
		fields: JsonObject,
		at: { sessionId: string; cwd: string | null; tool?: string; args?: JsonObject },
	): Promise<HookOutcome> {
		const groups = (this.#current()[event] ?? []).filter((group) =>
			matches(group.matcher, at.tool),
		);
		const commands = groups.flatMap((group) => group.hooks);
		if (commands.length === 0) return { block: null, context: "", errors: [] };
		const cwd = at.cwd && existsSync(at.cwd) ? at.cwd : homedir();
		const input = JSON.stringify({
			session_id: at.sessionId,
			cwd,
			hook_event_name: event,
			...(at.tool !== undefined
				? {
						tool_name: claudeToolName(at.tool),
						tool_input: claudeToolInput(at.tool, at.args ?? {}, at.cwd),
					}
				: {}),
			...fields,
		});
		// The environment a session's command gets, keys left out; Claude Code's name for the project.
		const env = { ...commandEnvironment(at.sessionId), CLAUDE_PROJECT_DIR: cwd };
		const ran = await Promise.all(commands.map((hook) => runOne(hook, input, cwd, env)));
		const blocks: string[] = [];
		const context: string[] = [];
		const errors: string[] = [];
		ran.forEach((result, index) => {
			const command = commands[index]?.command ?? "";
			if (result.code === 2) {
				blocks.push(result.stderr.trim() || "A hook stopped this.");
			} else if (result.code === 0) {
				const answer = readAnswer(result.stdout);
				if (answer.block) blocks.push(answer.block);
				if (answer.context) context.push(answer.context);
			} else {
				const why = result.code === null ? "did not finish" : `ended with exit code ${result.code}`;
				errors.push(`${command}: ${why}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`);
			}
		});
		return {
			block: blocks.length > 0 ? blocks.join("\n") : null,
			context: context.join("\n"),
			errors,
		};
	}
}
