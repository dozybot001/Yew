/**
 * Transcript message shapes. They mirror the model library's message JSON field for field, so a stored
 * message replays without conversion; `src/server/model/` checks at compile time that they stay assignable.
 * Nothing outside the model layer imports the library's own types.
 */

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export interface TextBlock {
	type: "text";
	text: string;
	textSignature?: string;
}

export interface ThinkingBlock {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	redacted?: boolean;
}

export interface ImageBlock {
	type: "image";
	/** Base64 without the `data:` prefix. */
	data: string;
	mimeType: string;
}

export interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments: JsonObject;
	thoughtSignature?: string;
	/** Set when the model's arguments were not a valid JSON object; `arguments` is then `{}`. */
	argumentsError?: string;
}

export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning?: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
		totalFromProvider?: boolean;
	};
}

export type StopReason =
	| "pending"
	| "stop"
	| "length"
	| "toolUse"
	| "error"
	| "aborted"
	| "deferred";

export interface SystemMessage {
	role: "system";
	content: string;
	sections?: Record<string, string | null>;
	timestamp: number;
}

export interface UserMessage {
	role: "user";
	content: string | (TextBlock | ImageBlock)[];
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextBlock | ThinkingBlock | ToolCallBlock)[];
	api: string;
	provider: string;
	model: string;
	usage: TokenUsage;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number;
	durationMs?: number;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextBlock | ImageBlock)[];
	details?: JsonValue;
	isError: boolean;
	timestamp: number;
	durationMs?: number;
}

/** What the model sees. */
export type ModelMessage = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

/** Marks where older history was summarized or renewed; the model sees `summary` in place of messages before `firstKeptSeq`. */
export interface CompactionRecord {
	/** "compact" (default): summarizes older turns while keeping recent ones; "renew": fresh context window in place. */
	kind?: "compact" | "renew";
	summary: string;
	/**
	 * The latest message from the person (or letter) in the removed part, word for word, when the
	 * kept part has none: the request still being worked on. A summary only paraphrases it.
	 */
	request?: string;
	firstKeptSeq: number;
	tokensBefore: number;
	timestamp: number;
}

/** A line in the transcript for the person only; never sent to the model. */
export interface Notice {
	kind:
		| "interrupted"
		| "model_changed"
		| "restarted"
		| "error"
		| "compacted"
		| "renewed"
		| "job_finished"
		/** Another session changed this one with manage_yew; data has who and the changes. */
		| "changed"
		/** A daily spending limit: data has the code (budget-warning or budget-reached), scope, spent and limit. */
		| "budget"
		/** The automatic mode's check let a step run: data has tool, summary, reason. */
		| "reviewed"
		/** One of the person's hooks failed or stopped a message: data has event, kind and text. */
		| "hook";
	text?: string;
	data?: JsonObject;
	timestamp: number;
}

/** A decision the person made in the approval center, as delivered to a session. */
export interface DecisionRef {
	number: number;
	title: string;
	/** The option the person chose; null when they answered with a note only. */
	choice: string | null;
	note: string | null;
	decidedAt: number;
}

/** A letter delivered into a transcript. The interface shows it as a letter; the model reads `message`. */
export interface LetterRef {
	id: string;
	kind: "notice" | "request" | "decision" | "report";
	from: { kind: "session" | "person" | "cli" | "yew"; sessionId: string | null; name: string };
	summary: string;
	body: string;
	/** Yew sent the session's final reply on its behalf. */
	auto?: boolean;
	decision?: DecisionRef;
	/** The scheduled task whose run the letter starts or reports on. */
	schedule?: { id: string; name: string };
	/** The person's words the letter passes on, each found by Yew in its own records. */
	quotes?: PersonQuote[];
}

/**
 * Words of the person that a letter passes on, as Yew found them in its own records: a message the
 * person wrote, an answer they gave to a session's question, or their note or choice on a decision. A
 * session cannot write one itself; Yew attaches it only when the words are there.
 */
export interface PersonQuote {
	/** The person's words as Yew has them, or the whole option they chose. */
	text: string;
	source: "message" | "answer" | "decision";
	/** The session the person wrote in or answered; null for a decision. */
	sessionId: string | null;
	/** That session's name when the letter was sent. */
	sessionName: string | null;
	/** The decision's number, for a decision. */
	card?: number;
	/** An option the person picked, written by a session, rather than words the person typed. */
	chosen?: boolean;
	/** Part of what the person wrote rather than all of it. */
	excerpt?: boolean;
	/** When the person wrote or chose it. */
	at: number;
}

export type AttachmentKind = "image" | "pdf" | "text";

/**
 * Lightweight reference to a file the person attached to a message.
 * The bytes live under `~/.yew/attachments/<sessionId>/` and are hydrated into model input on demand,
 * so SQLite, SSE streams and phone sync never carry raw base64 payloads.
 */
export interface AttachmentRef {
	id: string;
	name: string;
	mimeType: string;
	kind: AttachmentKind;
	size: number;
	width?: number;
	height?: number;
	pages?: number;
}

export type EntryBody =
	| { role: "system"; message: SystemMessage }
	| { role: "user"; message: UserMessage; letter?: LetterRef; attachments?: AttachmentRef[] }
	| { role: "assistant"; message: AssistantMessage }
	| { role: "toolResult"; message: ToolResultMessage }
	| { role: "compaction"; compaction: CompactionRecord }
	| { role: "notice"; notice: Notice };

export type EntryRole = EntryBody["role"];

/**
 * The first line of a text without Markdown marks, for a one-line summary: a reply that starts with
 * "**Done**" reads "Done" in a letter's summary.
 */
export function plainLine(text: string): string {
	const first = (text.trim().split("\n")[0] ?? "").trim();
	return first
		.replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/\*\*(.+?)\*\*/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.trim();
}

/** A letter's body without a first line that only repeats the summary, as Yew's reports do. */
export function bodyAfterSummary(body: string, summary: string): string {
	const [first = "", ...rest] = body.trim().split("\n");
	return plainLine(first) === plainLine(summary) ? rest.join("\n").trim() : body;
}

export function messageText(message: ModelMessage): string {
	if (typeof message.content === "string") return message.content;
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") parts.push(block.text);
		else if (block.type === "thinking") parts.push(block.thinking);
		else if (block.type === "toolCall")
			parts.push(`${block.name} ${JSON.stringify(block.arguments)}`);
	}
	return parts.join("\n");
}

/** The first question of an ask_user call, and how many it asks, for one-line summaries. */
export function askedQuestion(
	args: Record<string, unknown>,
): { question: string; count: number } | null {
	const list = Array.isArray(args.questions) ? args.questions : null;
	const first = list ? (list[0] as { question?: unknown } | undefined)?.question : args.question;
	if (typeof first !== "string") return null;
	return { question: first, count: list ? list.length : 1 };
}
