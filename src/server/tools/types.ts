import type { ImageBlock, JsonObject, TextBlock } from "../../shared/messages.ts";
import type {
	Letter,
	PermissionRequest,
	QuestionRequest,
	Session,
	SessionStatus,
	TaskOutcome,
	Todo,
} from "../../shared/types.ts";
import type { Outgoing, PostOffice } from "../mail/post.ts";
import type { ManagePlan } from "../manage.ts";
import type { Subject } from "../permissions/engine.ts";
import type { Jobs } from "./jobs.ts";
import type { ReadState } from "./read-state.ts";

export interface ToolResult {
	content: (TextBlock | ImageBlock)[];
	isError?: boolean;
	/** Data for the interface only, such as a diff; never sent to the model. */
	detail?: JsonObject;
}

export interface ToolContext {
	session: Session;
	signal: AbortSignal;
	readState: ReadState;
	jobs: Jobs;
	/** Where long outputs are written; inside Yew's data directory. */
	tmpDir: string;
	acceptsImages: boolean;
	version: string;
	/** Live output for the interface while the tool runs. */
	output(text: string): void;
	setTodos(todos: Todo[]): void;
	/**
	 * Whether sessions may never read `path` (an absolute path): credentials, Yew's own data, the
	 * folders the person keeps from sessions. Searches leave such files out of their results.
	 */
	offLimits?(path: string): boolean;
	/** Asks the person a question in Yew and waits for the answer. */
	/** Puts questions to the person and waits; resolves with the answer as the session reads it. */
	ask(request: QuestionRequest): Promise<string>;
	/**
	 * Asks the person to allow something the running call needs, such as a site a command in the
	 * sandbox wants to reach, on a card for this call. Resolves false when they decline or nobody
	 * can answer (an unattended run, a helper). `until` withdraws the card when the need has passed,
	 * such as when the command ended first. Absent where the call cannot ask.
	 */
	permit?(request: PermissionRequest, until?: AbortSignal): Promise<boolean>;
	mail: MailContext;
	/** Sends a helper with a task and waits for its answer (blueprint 6.11, item 43). */
	helper(task: string): Promise<{ text: string; calls: number; stopped?: string }>;
}

/** How waiting for another session ended (send_letter and open_session with `wait`). */
export type WaitResult =
	| { kind: "letter"; letter: Letter }
	| { kind: "ended"; status: SessionStatus; text: string; detail: string | null; stopped: boolean }
	| { kind: "timeout" }
	/** Waiting would close a circle of sessions waiting for each other. */
	| { kind: "cycle" }
	/** The recipient is not running (it needs the person first); the letter waits for it. */
	| { kind: "not-running"; status: SessionStatus }
	/** This session was stopped while it waited. */
	| { kind: "stopped" }
	/** The person archived the recipient before it read the letter. */
	| { kind: "archived" };

export interface OpenInput {
	name: string;
	brief: string;
	/** Absolute folder inside the opener's, or null for a chat; undefined keeps the opener's folder. */
	cwd?: string | null;
	provider?: string;
	model?: string;
	/** Give the new session a copy of the opener's conversation so far. */
	fork?: boolean;
	/** The person's words the brief passes on, as the opener copied them; Yew looks each up. */
	quotes?: unknown;
}

/** Letters, decision cards and child sessions, as the calling session. */
export interface MailContext {
	post: PostOffice;
	/** The calling session may put cards in the approval center. */
	canPostCards: boolean;
	send(out: Outgoing): Letter;
	wait(letter: Letter): Promise<WaitResult>;
	open(input: OpenInput): { session: Session; letter: Letter };
	finish(outcome: TaskOutcome): Session;
	/** Applies a manage_yew call, all of it or none; returns what changed, one line each. */
	manage(args: JsonObject): string[];
}

/**
 * The model's way to ask for a person's approval in the automatic mode. Offered on tools that change
 * things or reach out: write, edit, shell and web_fetch.
 */
export const CONFIRM_ARGUMENT = {
	type: "boolean",
	description:
		"Ask the person before this runs. Set it when the call is risky, destructive or hard to undo.",
} as const;

export interface ToolDefinition {
	name: string;
	/** Yew's own wording (AGENTS.md: no text copied from other products). */
	description: string;
	/** JSON Schema of the arguments. */
	parameters: JsonObject;
	/** Read-only tools in one batch run in parallel; any other tool makes the batch sequential. */
	readOnly: boolean;
	/** Offered only to sessions with a working folder; chats get the rest. */
	needsFolder: boolean;
	/** Offered only when this says so, e.g. card tools to the main conversation. */
	offered?(session: Session, roles: Roles): boolean;
	/** What the call touches, for the permission check. Throws ToolInputError on bad arguments. */
	subject(args: JsonObject, session: Session, lookup?: Lookup): Subject;
	/**
	 * What the person sees besides the call itself when Yew asks for permission: its purpose, the change
	 * it would make. Never throws; a call without a preview is asked about as it is.
	 */
	preview?(args: JsonObject, session: Session, lookup: Lookup): PermissionPreview;
	run(args: JsonObject, ctx: ToolContext): Promise<ToolResult>;
}

/** The parts of a permission request a tool fills in (see PermissionRequest). */
export type PermissionPreview = Partial<
	Pick<PermissionRequest, "description" | "diff" | "changes">
>;

/** What a tool may look up while Yew checks a call, before the call runs. */
export interface Lookup {
	/** A session's or team's name by id, so what the person reads names the sessions. */
	name(id: string): string | null;
	/** Checks a manage_yew call of the calling session and says what it would change, changing nothing. */
	plan(args: JsonObject): ManagePlan;
}

/** What a session may do beyond its tools' own checks. */
export interface Roles {
	canPostCards: boolean;
	/** May change Yew with manage_yew: sessions, teams and settings. */
	canOrganize: boolean;
}

/** Bad arguments from the model; reported back to it as an error result. */
export class ToolInputError extends Error {}

export const text = (value: string): TextBlock => ({ type: "text", text: value });

export function errorResult(message: string): ToolResult {
	return { content: [text(message)], isError: true };
}

export function str(args: JsonObject, key: string, required: true): string;
export function str(args: JsonObject, key: string, required?: false): string | undefined;
export function str(args: JsonObject, key: string, required = false): string | undefined {
	const value = args[key];
	if (value === undefined || value === null) {
		if (required) throw new ToolInputError(`Missing argument: ${key}.`);
		return undefined;
	}
	if (typeof value !== "string") throw new ToolInputError(`${key} must be a string.`);
	return value;
}

export function int(args: JsonObject, key: string, min: number, max: number): number | undefined {
	const value = args[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
		throw new ToolInputError(`${key} must be a whole number from ${min} to ${max}.`);
	}
	return value;
}

export function bool(args: JsonObject, key: string): boolean | undefined {
	const value = args[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "boolean") throw new ToolInputError(`${key} must be true or false.`);
	return value;
}
