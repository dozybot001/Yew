import { rmSync } from "node:fs";
import { join } from "node:path";
import {
	type AssistantMessage,
	type AttachmentRef,
	type EntryBody,
	type JsonObject,
	messageText,
	type Notice,
	plainLine,
	type ToolCallBlock,
	type ToolResultMessage,
} from "../../shared/messages.ts";
import {
	type Approval,
	type ApprovalDecision,
	type Entry,
	type PermissionNote,
	type PermissionRequest,
	permissionModeOf,
	personOnly,
	type QuestionAnswer,
	type QuestionRequest,
	type QueuedMessage,
	type Session,
	type SessionStatus,
	type ToolCallView,
} from "../../shared/types.ts";
import { AttachmentStore } from "../attachments.ts";
import {
	type BudgetMark,
	crossedWarning,
	dollars,
	grantMore,
	localDay,
	reached,
} from "../budget.ts";
import { conflict, invalid, YewError } from "../errors.ts";
import type { HookEvent, HookOutcome, Hooks } from "../hooks.ts";
import { PostOffice } from "../mail/post.ts";
import { Manager } from "../manage.ts";
import type { ModelGateway, ModelInfo } from "../model/gateway.ts";
import type { PermissionEngine } from "../permissions/engine.ts";
import { ScheduleBook } from "../schedules.ts";
import { skillFolders } from "../skills.ts";
import { type Store, validateSessionName } from "../store.ts";
import { Jobs } from "../tools/jobs.ts";
import { choicesFrom, settleAnswer } from "../tools/misc.ts";
import { ReadState } from "../tools/read-state.ts";
import { ALL_TOOLS, specs, toolsFor } from "../tools/registry.ts";
import {
	type Lookup,
	type MailContext,
	type Roles,
	type ToolContext,
	type ToolDefinition,
	ToolInputError,
	type ToolResult,
} from "../tools/types.ts";
import { ContextKeeper, notice } from "./compaction.ts";
import {
	hookNote,
	prepareModelMessages,
	sanitizeInterrupted,
	usageTotals,
	YEW_NOTE,
} from "./context.ts";
import { Held } from "./held.ts";
import { runHelper } from "./helper.ts";
import { freeName, Mailroom } from "./mailroom.ts";
import {
	CHOICES_PROMPT,
	type ContextSnapshot,
	helperPrompt,
	type InstructionExtras,
	NAMING_PROMPT,
	type Placement,
	systemPrompt,
} from "./prompt.ts";
import { reviewStep } from "./review.ts";

/** Words a reply uses to offer a next step instead of asking outright. */
const OFFER =
	/如需|需要的话|要不要|是否需要|告诉我|说一声|let me know|tell me if|shall i|should i|would you like|do you want/i;

/**
 * The question a reply ends with, if it ends with one: its last paragraph (outside code) when that asks
 * something or offers a next step. A session that asks the person this way goes idle, so Yew puts the
 * question in the approval center for it (blueprint principle 8: Yew carries this, not a prompt rule).
 */
export function askedInReply(text: string): string | null {
	const prose = text.replace(/```[\s\S]*?(```|$)/g, "").trim();
	const last =
		prose
			.split(/\n\s*\n/)
			.at(-1)
			?.trim() ?? "";
	if (!last) return null;
	const end = last.replace(/[\s*_`)\]）」』"'”’]+$/u, "");
	if (!/[?？]$/.test(end) && !OFFER.test(last)) return null;
	return last.length > 600 ? `…${last.slice(-600)}` : last;
}

type Answer = {
	decision?: ApprovalDecision;
	reason?: string;
	answer?: string;
	answers?: QuestionAnswer[];
};

interface Live {
	controller: AbortController;
	done: Promise<void>;
	waiters: Map<string, (answer: Answer | null) => void>;
}

export interface AgentsOptions {
	store: Store;
	gateway: ModelGateway;
	permissions: PermissionEngine;
	home: string;
	version: string;
	/** The tools sessions may be offered; a function is asked every time, for tools that come and go. */
	tools?: ToolDefinition[] | (() => ToolDefinition[]);
	log?: (line: string) => void;
	/** How often streaming drafts go to the interface. */
	draftIntervalMs?: number;
	/** Letters and the approval center; one is made when not given. */
	post?: PostOffice;
	/** The longest send_letter and open_session wait for an answer; tests shorten it. */
	waitMs?: number;
	/** Scheduled tasks; one is made when not given. */
	schedules?: ScheduleBook;
	/** The person's home folder, for `~/.claude` skills and instructions; absent, they are not read. */
	userHome?: string | null;
	/** The most model requests one turn makes before Yew stops it; tests lower it. */
	maxSteps?: number;
	/** The person's hooks (hooks.ts); none when not given. */
	hooks?: Hooks;
	/** Per-session message attachments; one is made when not given. */
	attachments?: AttachmentStore;
}

/** How many times the Stop hooks may send a session back to work in one turn. */
const MAX_STOP_HOOKS = 3;

const MAX_MESSAGE_CHARS = 100_000;
const MAX_STEPS = 500;
/** How many times in a row a reply cut off at the model's output limit is continued by itself. */
const MAX_CUT_REPLIES = 8;
/** How long a session waits for another one's answer (blueprint 7.1: one wait, no polling). */
const WAIT_MS = 30 * 60 * 1000;
/** The result of a call that was running when Yew stopped (blueprint 7.3). */

const CUT_CALL =
	"Not run: your reply was cut off at the output limit before its tool calls were complete. Make the call again; write long content in parts.";
const CUT_TOO_OFTEN = "The reply was cut off at the model's output limit several times in a row.";

const RESTARTED =
	"Yew restarted while this call was running. It may or may not have finished; check the current state before running it again.";

const MAX_DRAFT_THINKING_CHARS = 12_000;
const MAX_DRAFT_ARG_CHARS = 500;

/**
 * Slims a streaming draft before pushing it over SSE so a giant `write` payload or 150 KB thinking
 * block does not flood WebKit at 10 Hz. The complete message is persisted to SQLite when it finishes.
 */
function slimDraft(draft: AssistantMessage): AssistantMessage {
	return {
		...draft,
		content: draft.content.map((block) => {
			if (block.type === "thinking") {
				return block.thinking.length > MAX_DRAFT_THINKING_CHARS
					? { ...block, thinking: `…${block.thinking.slice(-MAX_DRAFT_THINKING_CHARS)}` }
					: block;
			}
			if (block.type === "toolCall") {
				const slimArgs: JsonObject = {};
				for (const [k, v] of Object.entries(block.arguments)) {
					if (typeof v === "string" && v.length > MAX_DRAFT_ARG_CHARS) {
						slimArgs[k] = `${v.slice(0, MAX_DRAFT_ARG_CHARS)}… (${v.length} chars)`;
					} else {
						slimArgs[k] = v;
					}
				}
				return { ...block, arguments: slimArgs };
			}
			return block;
		}),
	};
}

const clip = (text: string, max: number) =>
	[...text].length > max ? `${[...text].slice(0, max - 1).join("")}…` : text;

const userEntry = (text: string, attachments?: AttachmentRef[]): EntryBody => ({
	role: "user",
	message: { role: "user", content: text, timestamp: Date.now() },
	...(attachments && attachments.length > 0 ? { attachments } : {}),
});

/** Tokens the next request starts from: everything sent plus what the model just wrote. */
function contextSize(message: AssistantMessage): number {
	const usage = message.usage;
	return usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
}

function resultEntry(
	call: { callId: string; tool: string },
	result: ToolResult,
	started: number,
): EntryBody {
	const message: ToolResultMessage = {
		role: "toolResult",
		toolCallId: call.callId,
		toolName: call.tool,
		content: result.content,
		isError: result.isError ?? false,
		timestamp: Date.now(),
		durationMs: Date.now() - started,
	};
	return { role: "toolResult", message };
}

const failure = (text: string): ToolResult => ({
	content: [{ type: "text", text }],
	isError: true,
});

/**
 * Runs sessions. Each working session is one async loop in this process (M1 plan, section 4): ask the
 * model, check and run the tools it calls, feed back the results, and repeat until the model stops.
 * Every step is stored as it happens, so a restart can tell what was in flight.
 */
export class Agents {
	readonly #store: Store;
	readonly #gateway: ModelGateway;
	readonly #permissions: PermissionEngine;
	readonly #home: string;
	readonly #version: string;
	readonly #allTools: () => ToolDefinition[];
	readonly #log: (line: string) => void;
	readonly #draftInterval: number;
	readonly #live = new Map<string, Live>();
	readonly #readStates = new Map<string, ReadState>();
	readonly #jobs = new Map<string, Jobs>();
	/** Messages from Yew itself (such as "a background job ended") waiting to reach the model. */
	readonly #notes = new Map<string, string[]>();
	readonly #hooks: Hooks | null;
	/** By session: what the person wrote that the UserPromptSubmit hooks have not seen yet. */
	readonly #prompts = new Map<string, string[]>();
	/** By tool call: what ran without being asked about (skip mode) or was allowed by the check. */
	readonly #permissionNotes = new Map<string, PermissionNote>();
	/** Letters, decision cards and the approval center. */
	readonly post: PostOffice;
	/** Scheduled tasks, whose runs end in this runner. */
	readonly schedules: ScheduleBook;
	/** Per-session message attachments. */
	readonly attachments: AttachmentStore;
	readonly #mail: Mailroom;
	/** Each working session's latest written reply in this turn. */
	readonly #lastText = new Map<string, string>();
	/** Sessions whose question from a reply is getting its choices: stopped when the question goes. */
	readonly #choosing = new Map<string, AbortController>();
	readonly #userHome: string | null;
	/**
	 * Sessions the person stopped (letters wait until the person writes to them or continues them) and
	 * sessions that stopped at a daily spending limit (raising the limit that day continues them).
	 */
	readonly #held: Held;
	readonly #maxSteps: number;
	readonly #context: ContextKeeper;
	readonly #manager: Manager;
	/** A session's or team's name by id, for what the person reads on permission cards. */
	readonly #names = (id: string): string | null => {
		const session = this.post.sessionName(id);
		if (session) return session;
		try {
			return this.#store.getGroup(id).name;
		} catch {
			return null;
		}
	};

	constructor(options: AgentsOptions) {
		this.#store = options.store;
		this.#gateway = options.gateway;
		this.#permissions = options.permissions;
		this.#home = options.home;
		this.#version = options.version;
		const tools = options.tools ?? ALL_TOOLS;
		this.attachments = options.attachments ?? new AttachmentStore(options.store, options.home);
		const readAttachment = this.attachments.readTool();
		this.#allTools = () => {
			const list = typeof tools === "function" ? tools() : tools;
			return list.some((tool) => tool.name === readAttachment.name)
				? list
				: [...list, readAttachment];
		};
		this.#store.setAttachmentHooks({
			onCopied: (fromId, toId, entryIds) => this.attachments.copyForSession(fromId, toId, entryIds),
			onRewound: (sessionId, entryIds) => this.attachments.deleteForEntries(sessionId, entryIds),
			onQueuedRemoved: (sessionId, ids) => this.attachments.deletePending(sessionId, ids),
		});
		this.#log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
		this.#draftInterval = options.draftIntervalMs ?? 50;
		this.post = options.post ?? new PostOffice(options.store, this.#log);
		this.schedules = options.schedules ?? new ScheduleBook(options.store);
		this.#userHome = options.userHome ?? null;
		this.#held = new Held(options.store);
		this.#maxSteps = options.maxSteps ?? MAX_STEPS;
		this.#hooks = options.hooks ?? null;
		this.#context = new ContextKeeper({
			store: this.#store,
			gateway: this.#gateway,
			home: this.#home,
			placement: (session) => this.#placement(session),
			extras: () => this.#extras(),
		});
		// Folders the person keeps from sessions are refused like credential locations.
		this.#permissions.hidden = () => this.#store.getSetting<string[]>("hiddenFolders", []);
		// Memory folders and the person's skill folders are read without asking, like the working folder.
		this.#permissions.readRoots = () => [
			...this.#store.getSetting<string[]>("memoryDirs", []),
			...skillFolders(null, this.#home, this.#userHome),
		];
		this.#mail = new Mailroom({
			store: this.#store,
			gateway: this.#gateway,
			post: this.post,
			schedules: this.schedules,
			log: this.#log,
			waitMs: options.waitMs ?? WAIT_MS,
			isRunning: (id) => this.isRunning(id),
			wake: (id) => this.#wake(id),
			quiet: (session, said) => this.#askFromReply(session, said),
		});
		this.post.setHooks({ queued: (letter) => this.#mail.queued(letter) });
		this.#manager = new Manager({
			store: this.#store,
			schedules: this.schedules,
			home: this.#home,
			mainId: () => this.post.mainSessionId(),
			modelExists: (provider, model) => Boolean(this.#gateway.model(provider, model)),
			onArchived: (id) => this.archived(id),
		});
	}

	/** What tools may look up while Yew checks a call of `session`. */
	#lookup(session: Session): Lookup {
		return { name: this.#names, plan: (args) => this.#manager.plan(session, args) };
	}

	get home(): string {
		return this.#home;
	}

	isRunning(sessionId: string): boolean {
		return this.#live.has(sessionId);
	}

	/**
	 * Whether a command of this session may still be writing its output file: a turn is running, or a
	 * background command has not ended. The data cleanup leaves such a session's files alone.
	 */
	hasLiveCommands(sessionId: string): boolean {
		if (this.isRunning(sessionId)) return true;
		return (
			this.#jobs
				.get(sessionId)
				?.list()
				.some((job) => !job.finished) ?? false
		);
	}

	/** Resolves when the session is not running. */
	async whenIdle(sessionId: string): Promise<void> {
		await this.#live.get(sessionId)?.done;
	}

	/** The person sends a message: it starts a turn, or waits in the queue while one runs (blueprint 7.1). */
	send(
		sessionId: string,
		text: string,
		attachmentIds: string[] = [],
	): { entry: Entry } | { queued: QueuedMessage } {
		const trimmed = text.trim();
		if (!trimmed && attachmentIds.length === 0) throw invalid("The message is empty.", "text");
		if (text.length > MAX_MESSAGE_CHARS) throw invalid("The message is too long.", "text");
		const session = this.#store.getSession(sessionId);
		if (session.archivedAt !== null)
			throw conflict("This session is archived. Restore it first.", undefined, "session-archived");
		const attachments =
			attachmentIds.length > 0 ? this.attachments.verifyPending(sessionId, attachmentIds) : [];
		// The person stepped in: a full quota of letters again, and a new chain of hand-offs (blueprint 7.1).
		this.#dropReplyQuestions(sessionId);
		this.#held.resume(sessionId);
		this.#store.resetLettersSent(sessionId);
		this.#store.addIntervention(sessionId);
		this.post.resetChain(sessionId);
		if (this.isRunning(sessionId)) {
			return { queued: this.#store.enqueue(sessionId, text, attachments) };
		}
		this.#dropLeftovers(sessionId, "Not run: the person sent a new message instead of continuing.");
		const entry = this.#store.tx(() => {
			const created = this.#store.appendEntry(sessionId, userEntry(text, attachments));
			if (attachments.length > 0) {
				this.attachments.bindToEntry(
					sessionId,
					attachments.map((item) => item.id),
					created.id,
				);
			}
			return created;
		});
		const hookPrompt = trimmed || attachments.map((item) => `[Attached: ${item.name}]`).join(", ");
		this.#prompted(sessionId, [hookPrompt]);
		const originEntryId = sessionId === this.post.mainSessionId() ? entry.id : null;
		this.#start(sessionId, { byPerson: true, originEntryId });
		return { entry };
	}

	/** Picks up after a stop, an error or a restart, without a new message. */
	continue(sessionId: string): void {
		const session = this.#store.getSession(sessionId);
		if (this.isRunning(sessionId))
			throw conflict("This session is already working.", undefined, "session-busy");
		if (session.archivedAt !== null)
			throw conflict("This session is archived. Restore it first.", undefined, "session-archived");
		const entries = this.#store.contextEntries(sessionId);
		if (entries.length === 0)
			throw conflict("There is nothing to continue yet.", undefined, "nothing-to-continue");
		this.#dropReplyQuestions(sessionId);
		this.#held.resume(sessionId);
		// Continuing a session that stopped at a spending limit gives it as much room again for today.
		grantMore(this.#store, session, Date.now());
		this.#start(sessionId, { resume: true, byPerson: true });
	}

	/** The person stops a session. Letters that arrive later wait until the person writes or continues. */
	stop(sessionId: string): void {
		const live = this.#live.get(sessionId);
		if (!live) return;
		this.#held.pause(sessionId);
		this.#held.uncap(sessionId);
		live.controller.abort();
	}

	/** Records the person's answer to a permission request or a question, and lets the session go on. */
	answer(approvalId: string, answer: Answer): Approval {
		const approval = this.#store.getApproval(approvalId);
		if (approval.kind === "permission") {
			if (!answer.decision) throw invalid("Choose allow_once, allow_always or deny.", "decision");
			const request = approval.request as { mustConfirm?: boolean; rememberRules?: unknown[] };
			if (answer.decision === "allow_always" && (request.mustConfirm || !request.rememberRules)) {
				throw invalid("This operation can only be allowed once.", "decision");
			}
		} else {
			// The session reads the answer as text; the structured answer stays for the card.
			const settled = settleAnswer(approval.request as QuestionRequest, answer);
			answer = {
				answer: settled.text,
				...(settled.answers ? { answers: settled.answers } : {}),
			};
			if ((approval.request as QuestionRequest).fromReply) {
				// Nothing waits for it: the answer is the person's next message to the session.
				const resolved = this.#store.resolveApproval(approvalId, answer);
				this.send(approval.sessionId, settled.text);
				return resolved;
			}
		}
		const resolved = this.#store.resolveApproval(approvalId, answer);
		this.#store.addIntervention(approval.sessionId);
		const waiter = this.#live.get(approval.sessionId)?.waiters.get(approvalId);
		waiter?.(answer);
		return resolved;
	}

	/**
	 * Takes the conversation back to a point the person picked (blueprint 6.11, item 42): one of its
	 * replies, or just before one of the person's messages. Not while it works. A question Yew made of a
	 * reply goes with the reply. Returns how many entries were taken back.
	 */
	rewind(sessionId: string, entryId: string): number {
		if (this.isRunning(sessionId)) {
			throw conflict("Stop the session first, then take it back.", undefined, "session-busy");
		}
		const count = this.#store.rewindSession(sessionId, this.#store.turnPoint(sessionId, entryId));
		this.#dropReplyQuestions(sessionId);
		for (const approval of this.#store.pendingApprovals(sessionId)) {
			this.#store.cancelApproval(approval.id);
		}
		if (this.#store.getSession(sessionId).status !== "idle")
			this.#store.setStatus(sessionId, "idle");
		return count;
	}

	/** Shortens the context now; the session must not be working. */
	async compactNow(sessionId: string): Promise<void> {
		if (this.isRunning(sessionId))
			throw conflict("Wait until the session stops working.", undefined, "session-busy");
		const session = this.#store.getSession(sessionId);
		const model = this.#requireModel(session);
		// Compacting does not change where the session stands: one that needs review or failed still does.
		const keep = session.status === "needs_review" || session.status === "error";
		const controller = new AbortController();
		const done = this.#context.compact(session, model, controller.signal, true).then(() => {});
		this.#live.set(sessionId, { controller, done, waiters: new Map() });
		try {
			this.#store.setStatus(sessionId, "working");
			await done;
		} finally {
			this.#live.delete(sessionId);
			if (keep) this.#store.setStatus(sessionId, session.status, session.statusDetail);
			else this.#store.setStatus(sessionId, "idle");
			this.#wake(sessionId);
		}
	}

	/**
	 * Starts a fresh context window in place for a session (blueprint 6.12, item 50); the session must
	 * not be working. Full history stays searchable and scrollable; only the active model window resets.
	 */
	async renewNow(sessionId: string, summarize = true): Promise<"done" | "nothing" | "failed"> {
		if (this.isRunning(sessionId)) {
			throw conflict("Wait until the session stops working.", undefined, "session-busy");
		}
		const session = this.#store.getSession(sessionId);
		const model = summarize
			? this.#requireModel(session)
			: (this.#gateway.model(session.provider, session.model) ?? null);
		const keep = session.status === "needs_review" || session.status === "error";
		const openRequests = this.post.mail.openRequests(sessionId);
		const openNote =
			openRequests.length > 0
				? `Open requests from other sessions still awaiting your reply:\n${openRequests
						.map((req) => `- From "${req.fromName}": ${req.summary}`)
						.join("\n")}`
				: null;
		const controller = new AbortController();
		let outcome: "done" | "nothing" | "failed" = "nothing";
		const done = this.#context
			.renew(session, model, controller.signal, summarize, openNote)
			.then((res) => {
				outcome = res;
			});
		this.#live.set(sessionId, { controller, done, waiters: new Map() });
		try {
			this.#store.setStatus(sessionId, "working");
			await done;
			return outcome;
		} finally {
			this.#live.delete(sessionId);
			if (keep) this.#store.setStatus(sessionId, session.status, session.statusDetail);
			else this.#store.setStatus(sessionId, "idle");
			this.#wake(sessionId);
		}
	}

	/**
	 * The person archived a session. Letters waiting for it are dropped, so they do not linger or arrive
	 * when it is restored, and sessions waiting on one of them stop waiting.
	 */
	archived(sessionId: string): void {
		const letters = this.post.mail.dropWaiting(sessionId, "archived");
		for (const letter of letters) this.schedules.finished(letter, "skipped", "archived");
		const dropped = new Set(letters.map((letter) => letter.id));
		this.#mail.archived(sessionId, dropped);
	}

	/**
	 * Deletes every archived session for good, except one that is still working. Their scratch folders go
	 * too, and the main conversation setting if it named one of them. Returns the deleted sessions' ids.
	 */
	deleteArchived(): string[] {
		const ids = this.#store.deleteArchivedSessions((id) => this.isRunning(id));
		for (const id of ids) {
			rmSync(join(this.#home, "tmp", id), { recursive: true, force: true });
			// Its artifacts' rows went with the session; their files go too.
			rmSync(join(this.#home, "artifacts", id), { recursive: true, force: true });
			this.attachments.deleteSessionFolder(id);
			this.#readStates.delete(id);
			this.#jobs.get(id)?.stopAll();
			this.#jobs.delete(id);
			this.#held.forget(id);
		}
		if (ids.includes(this.#store.getSetting<string | null>("mainSessionId", null) ?? "")) {
			this.#store.setSetting("mainSessionId", null);
		}
		// Their scheduled tasks went with them.
		if (ids.length > 0) this.schedules.refresh();
		return ids;
	}

	/** Sessions at work now: a restart for an update waits for them (updates.ts). */
	busy(): number {
		return this.#live.size;
	}

	shutdown(): void {
		for (const live of this.#live.values()) live.controller.abort();
		for (const jobs of this.#jobs.values()) jobs.stopAll();
	}

	#start(
		sessionId: string,
		options: { resume?: boolean; byPerson?: boolean; originEntryId?: string | null } = {},
	): void {
		const controller = new AbortController();
		const live: Live = { controller, done: Promise.resolve(), waiters: new Map() };
		this.#live.set(sessionId, live);
		this.#lastText.delete(sessionId);
		this.#mail.begin(sessionId, options.byPerson ?? false, options.originEntryId ?? null);
		live.done = this.#run(sessionId, live, options.resume ?? false)
			.catch((error: unknown) =>
				this.#log(`session ${sessionId}: ${(error as Error).stack ?? error}`),
			)
			.finally(() => {
				this.#live.delete(sessionId);
				// Letters that arrived after the last delivery start the next turn, unless the person stopped this one.
				if (!controller.signal.aborted) this.#wake(sessionId);
			});
	}

	/** The calls a session can make depend on its place: card tools for the main conversation. */
	#roles(session: Session): Roles {
		return {
			canPostCards: this.post.canPostCards(session),
			canOrganize: this.post.canOrganize(session),
		};
	}

	/**
	 * The conversation moves on: calls left over from an interrupted run will not be run later. Calls that
	 * were running when Yew stopped may have finished, so they say that rather than "not run".
	 */
	#dropLeftovers(sessionId: string, reason: string): void {
		this.#store.tx(() => {
			for (const call of this.#store.toolCallsByStatus(sessionId, ["pending", "needs_review"])) {
				const text = call.status === "needs_review" ? RESTARTED : reason;
				this.#finishCall(call, failure(text), "error", Date.now());
			}
		});
	}

	/** Memory folders from the settings, and where the person's own skills and instructions are. */
	#extras(): InstructionExtras {
		return {
			memoryDirs: this.#store.getSetting<string[]>("memoryDirs", []),
			userHome: this.#userHome,
			disabledSkills: this.#store.getSetting<string[]>("disabledSkills", []),
		};
	}

	#requireModel(session: Session): ModelInfo {
		const model = this.#gateway.model(session.provider, session.model);
		if (!model) throw invalid(`${session.provider} has no model ${session.model}.`, "model");
		return model;
	}

	async #run(sessionId: string, live: Live, resume: boolean): Promise<void> {
		const signal = live.controller.signal;
		this.#store.setStatus(sessionId, "working");
		let endStatus: SessionStatus = "idle";
		let detail: string | null = null;
		let capped: string | null = null;
		try {
			let retriedOverflow = false;
			let cutReplies = 0;
			let stopHooks = 0;
			if (resume) await this.#resumeCalls(sessionId, live);
			this.#deliver(sessionId);
			for (let step = 0; ; step++) {
				if (signal.aborted) break;
				if (step >= this.#maxSteps) {
					// Not finished: the person decides whether it goes on.
					endStatus = "error";
					detail = `Stopped after ${this.#maxSteps} steps in one turn.`;
					this.#notice(sessionId, "error", detail, {
						code: "step-limit",
						steps: this.#maxSteps,
					});
					break;
				}
				const session = this.#store.getSession(sessionId);
				const over = reached(this.#store, session, Date.now());
				if (over) {
					capped = this.#budgetNotice(sessionId, "budget-reached", over);
					break;
				}
				const model = this.#requireModel(session);
				const snapshot = this.#context.refresh(session);
				const compacted = await this.#context.compactIfNeeded(session, model, signal);
				if (compacted === "failed") {
					// Going on would ask for a summary again at every step and end in a context that does not fit.
					if (!signal.aborted) {
						endStatus = "error";
						detail = "The context could not be shortened.";
					}
					break;
				}
				if (signal.aborted) break;
				// The person's hooks: at the start of a session and for what they wrote (hooks.ts).
				if (await this.#promptHooks(sessionId)) break;
				if (signal.aborted) break;

				const currentSnapshot =
					compacted === "done"
						? (this.#store.getContextSnapshot<ContextSnapshot>(sessionId) ?? snapshot)
						: snapshot;
				const final = await this.#ask(
					this.#store.getSession(sessionId),
					model,
					currentSnapshot,
					signal,
				);
				const message = sanitizeInterrupted(final);
				const entry =
					message.content.length > 0
						? this.#store.appendEntry(sessionId, { role: "assistant", message })
						: null;
				const said = message.content
					.map((block) => (block.type === "text" ? block.text : ""))
					.join("\n")
					.trim();
				if (said) this.#lastText.set(sessionId, said);
				this.#store.addUsage(sessionId, usageTotals(final), contextSize(final));
				for (const mark of crossedWarning(
					this.#store,
					session,
					usageTotals(final).cost,
					Date.now(),
				)) {
					this.#budgetNotice(sessionId, "budget-warning", mark);
				}

				if (final.stopReason === "aborted" || signal.aborted) {
					this.#notice(sessionId, "interrupted", "Stopped by the person.");
					break;
				}
				if (final.stopReason === "error") {
					if (
						!retriedOverflow &&
						this.#gateway.isContextOverflow(final, session.provider, session.model)
					) {
						retriedOverflow = true;
						const shortened = await this.#context.compact(
							this.#store.getSession(sessionId),
							model,
							signal,
							true,
						);
						if (shortened === "done") continue;
						if (signal.aborted) break;
					}
					endStatus = "error";
					detail = final.errorMessage ?? "The model request failed.";
					this.#notice(sessionId, "error", detail, { code: "model-error" });
					break;
				}
				const calls = message.content.filter(
					(block): block is ToolCallBlock => block.type === "toolCall",
				);
				if (calls.length === 0 || !entry) {
					if (final.stopReason === "length") {
						// The reply stopped at the model's output limit, not because the model was done.
						if (cutReplies >= MAX_CUT_REPLIES) {
							endStatus = "error";
							detail = CUT_TOO_OFTEN;
							this.#notice(sessionId, "error", detail, { code: "output-cut" });
							break;
						}
						cutReplies++;
						this.#note(
							sessionId,
							"Your reply was cut off at the output limit. Go on from where it stopped; write long content to a file in parts.",
						);
					}
					// The person's Stop hooks may send it back to work, a few times at most.
					if (this.#hooks?.has("Stop") && stopHooks < MAX_STOP_HOOKS) {
						const stopped = await this.#hook("Stop", sessionId, {
							stop_hook_active: stopHooks > 0,
						});
						if (stopped.block) {
							stopHooks++;
							this.#store.appendEntry(
								sessionId,
								userEntry(hookNote("Stop", `It asks you to go on: ${stopped.block}`)),
							);
							this.#deliver(sessionId);
							continue;
						}
					}
					// The model is done; anything the person sent meanwhile starts the next round.
					if (this.#deliver(sessionId)) continue;
					break;
				}
				const rows = calls.map((call) =>
					this.#store.createToolCall({
						sessionId,
						messageId: entry.id,
						callId: call.id,
						tool: call.name,
						args: call.arguments,
					}),
				);
				if (final.stopReason === "length") {
					// The reply stopped at the output limit in the middle of its calls. Arguments that were
					// cut short can still read as complete (half a file to write, say), so none of them runs.
					this.#store.tx(() => {
						for (const row of rows) this.#finishCall(row, failure(CUT_CALL), "error", Date.now());
					});
					if (cutReplies >= MAX_CUT_REPLIES) {
						endStatus = "error";
						detail = CUT_TOO_OFTEN;
						this.#notice(sessionId, "error", detail, { code: "output-cut" });
						break;
					}
					cutReplies++;
					this.#deliver(sessionId);
					continue;
				}
				cutReplies = 0;
				await this.#runCalls(sessionId, rows, calls, live);
				if (signal.aborted) {
					this.#notice(sessionId, "interrupted", "Stopped by the person.");
					break;
				}
				this.#deliver(sessionId);
			}
		} catch (error) {
			endStatus = "error";
			detail =
				error instanceof YewError
					? error.message
					: `Yew Harness hit an internal error: ${(error as Error).message}`;
			if (!(error instanceof YewError))
				this.#log(`session ${sessionId}: ${(error as Error).stack ?? error}`);
			// The code lets the interface explain the problem in the person's language.
			const data: JsonObject =
				error instanceof YewError
					? { code: error.code, ...((error.details ?? {}) as JsonObject) }
					: { code: "internal-error" };
			this.#notice(sessionId, "error", detail, data);
		} finally {
			this.#store.live(sessionId, { type: "draftCleared" });
			if (signal.aborted) endStatus = "idle";
			this.#store.setStatus(sessionId, endStatus, detail);
			this.#store.bumpUnread(sessionId);
			if (capped && !signal.aborted) this.#held.cap(sessionId, localDay(Date.now()));
			else this.#held.uncap(sessionId);
			// To the sessions that wait for this one, a stop at a spending limit is a turn that failed.
			const said = this.#lastText.get(sessionId) ?? "";
			this.#lastText.delete(sessionId);
			if (capped && !signal.aborted) this.#mail.endTurn(sessionId, "error", capped, false, said);
			else this.#mail.endTurn(sessionId, endStatus, detail, signal.aborted, said);
			if (endStatus === "idle" && !signal.aborted && !capped) {
				this.#nameAfterFirstTurn(sessionId).catch((error: unknown) =>
					this.#log(`session ${sessionId}: naming failed: ${(error as Error).message}`),
				);
			}
		}
	}

	/**
	 * A session started from the home page is named after the start of its first message. After its
	 * first turn its own model gives it a short name, once; a name the person or the main conversation
	 * chose is kept (blueprint section 5).
	 */
	async #nameAfterFirstTurn(sessionId: string): Promise<void> {
		const session = this.#store.getSession(sessionId);
		if (!session.options.autoName) return;
		this.#store.updateSession(sessionId, { options: { autoName: false } });
		const model = this.#gateway.model(session.provider, session.model);
		if (!model) return;
		const entries = this.#store.contextEntries(sessionId);
		const asked = entries.find((entry) => entry.role === "user");
		const replied = entries.find((entry) => entry.role === "assistant");
		const textOf = (entry: Entry | undefined) => {
			if (!entry) return "";
			if (entry.role === "user") {
				const raw = messageText(entry.message).trim();
				if (raw) return raw;
				return (entry.attachments ?? []).map((item) => item.name).join(", ");
			}
			if (entry.role === "assistant") return messageText(entry.message).trim();
			return "";
		};
		const first = clip(textOf(asked), 2000);
		if (!first) return;
		const reply = await this.#gateway.stream({
			provider: session.provider,
			model: model.id,
			thinking: "off",
			systemPrompt: NAMING_PROMPT,
			messages: [
				{
					role: "user",
					content: `The person's first message:\n${first}\n\nThe start of the reply:\n${clip(textOf(replied), 500)}`,
					timestamp: Date.now(),
				},
			],
			tools: [],
			signal: new AbortController().signal,
		});
		const now = this.#store.getSession(sessionId);
		this.#store.addUsage(sessionId, usageTotals(reply), now.contextTokens);
		const said = reply.content
			.map((block) => (block.type === "text" ? block.text : ""))
			.join("")
			.trim();
		const name = plainLine(said)
			.replace(/^["'“”‘’「」『』《》]+|["'“”‘’「」『』《》]+$/g, "")
			.replace(/[。.!！?？]+$/, "")
			.trim();
		// Renamed meanwhile, or nothing usable came back: keep the name it has.
		if (reply.stopReason !== "stop" || !name || now.name !== session.name) return;
		let chosen: string;
		try {
			chosen = freeName(this.#store, validateSessionName(clip(name, 40)));
		} catch {
			return;
		}
		this.#store.updateSession(sessionId, { name: chosen });
		// One turn in, there is little prompt cache to keep: the prompt learns the name without an update.
		const saved = this.#store.getContextSnapshot<ContextSnapshot>(sessionId);
		if (saved) {
			this.#store.setContextSnapshot(sessionId, {
				...saved,
				name: chosen,
				...(saved.told ? { told: { ...saved.told, name: chosen } } : {}),
			});
		}
	}

	async #ask(
		session: Session,
		model: ModelInfo,
		snapshot: ContextSnapshot,
		signal: AbortSignal,
	): Promise<AssistantMessage> {
		const tools = toolsFor(session, this.#allTools(), this.#roles(session));
		let last = 0;
		let pending: ReturnType<typeof setTimeout> | null = null;
		let latest: AssistantMessage | null = null;
		const flush = () => {
			pending = null;
			last = Date.now();
			if (latest) this.#store.live(session.id, { type: "draft", draft: slimDraft(latest) });
		};
		try {
			const messages = await prepareModelMessages(
				this.#store.contextEntries(session.id),
				(entry) =>
					this.attachments.hydrateUserMessage(entry, {
						acceptsImages: model.input.includes("image"),
					}),
				snapshot.prunedBeforeSeq ?? 0,
			);
			return await this.#gateway.stream(
				{
					provider: session.provider,
					model: model.id,
					thinking: session.thinking,
					systemPrompt: systemPrompt(session, snapshot, this.#groupName(session)),
					messages,
					tools: specs(tools),
					signal,
					sessionId: session.id,
					onRetry: (retry) => {
						this.#log(
							`session ${session.id}: model request failed (${retry.error}); retry ${retry.attempt} of ${retry.of}`,
						);
						this.#store.live(session.id, {
							type: "retrying",
							attempt: retry.attempt,
							of: retry.of,
							seconds: Math.round(retry.delayMs / 1000),
							text: clip(retry.error, 300),
						});
					},
				},
				(draft) => {
					latest = draft;
					if (pending) return;
					const wait = this.#draftInterval - (Date.now() - last);
					if (wait <= 0) flush();
					else pending = setTimeout(flush, wait);
				},
			);
		} finally {
			if (pending) clearTimeout(pending);
		}
	}

	/** Checks every call of a batch first (asking where needed), then runs the allowed ones (prior-art 4.1). */
	async #runCalls(
		sessionId: string,
		rows: ToolCallView[],
		calls: (ToolCallBlock | null)[],
		live: Live,
	): Promise<void> {
		const signal = live.controller.signal;
		const current = this.#store.getSession(sessionId);
		const byName = new Map(
			toolsFor(current, this.#allTools(), this.#roles(current)).map((tool) => [tool.name, tool]),
		);
		const results = new Map<
			string,
			{ result: ToolResult; status: "done" | "error" | "denied"; started: number }
		>();
		const approved: { row: ToolCallView; tool: ToolDefinition }[] = [];

		for (const [index, row] of rows.entries()) {
			const started = Date.now();
			if (signal.aborted) {
				results.set(row.id, {
					result: failure("Not run: stopped by the person."),
					status: "error",
					started,
				});
				continue;
			}
			const tool = byName.get(row.tool);
			const argumentsError = calls[index]?.argumentsError;
			if (!tool) {
				results.set(row.id, {
					result: failure(`There is no tool named ${row.tool}.`),
					status: "error",
					started,
				});
				continue;
			}
			if (argumentsError) {
				results.set(row.id, {
					result: failure(`The arguments were not valid JSON: ${argumentsError}`),
					status: "error",
					started,
				});
				continue;
			}
			const session = this.#store.getSession(sessionId);
			const activeRun = this.#mail.run(sessionId);
			// Scheduled unattended runs can never self-escalate by modifying schedules or widening permissions (even in skip mode).
			if (activeRun?.unattended && row.tool === "manage_yew") {
				let blockedReason: string | null = null;
				if (Array.isArray((row.args as { schedules?: unknown }).schedules)) {
					blockedReason = "Scheduled unattended runs cannot create or modify scheduled tasks.";
				} else {
					try {
						if (this.#manager.plan(session, row.args).tier === "widen") {
							blockedReason =
								"Scheduled unattended runs cannot widen permissions or runtime boundaries.";
						}
					} catch {
						// Invalid arguments will be caught normally below.
					}
				}
				if (blockedReason) {
					activeRun.refused.push(blockedReason);
					results.set(row.id, {
						result: { ...failure(`Refused: ${blockedReason}`), detail: { code: "unattended" } },
						status: "denied",
						started,
					});
					continue;
				}
			}
			// The person's PreToolUse hooks can stop a call before anything else (hooks.ts).
			if (this.#hooks?.has("PreToolUse", row.tool)) {
				const before = await this.#hook("PreToolUse", sessionId, {}, row.tool, row.args);
				if (before.block) {
					results.set(row.id, {
						result: failure(hookNote("PreToolUse", `It stopped this call: ${before.block}`)),
						status: "denied",
						started,
					});
					continue;
				}
			}
			let decision: ReturnType<PermissionEngine["decide"]>;
			try {
				// In the automatic mode the model asks for a person's approval itself, with `confirm`.
				const flagged = (row.args as { confirm?: unknown }).confirm === true;
				const subject = tool.subject(row.args, session, this.#lookup(session));
				decision = this.#permissions.decide(subject, this.#mail.withRunMode(session), flagged);
			} catch (error) {
				const message =
					error instanceof ToolInputError
						? error.message
						: `Could not check this call: ${(error as Error).message}`;
				results.set(row.id, { result: failure(message), status: "error", started });
				continue;
			}
			if (decision.effect === "deny") {
				results.set(row.id, {
					result: failure(`Refused by Yew: ${decision.reason}`),
					status: "denied",
					started,
				});
				continue;
			}
			if (decision.effect === "allow" && decision.note) this.#notePermission(row.id, decision.note);
			// The automatic mode: the check decides first; the person is asked when it does not allow.
			if (decision.effect === "ask" && decision.review) {
				const verdict = await reviewStep({
					gateway: this.#gateway,
					store: this.#store,
					session,
					request: decision.request,
					signal: live.controller.signal,
				});
				if (verdict.allow) {
					this.#notePermission(row.id, { reviewed: verdict.reason });
					this.#recordReview(sessionId, decision.request, verdict.reason);
					approved.push({ row, tool });
					continue;
				}
				decision.request.review = verdict.reason;
			}
			const run = this.#mail.run(sessionId);
			if (decision.effect === "ask" && run?.unattended) {
				// Nobody is there to say yes: refuse now rather than wait (blueprint 6.1, item 6).
				run.refused.push(decision.request.summary);
				results.set(row.id, {
					result: {
						...failure(
							`Refused: this turn runs for the scheduled task "${run.name}" and nobody is watching, so nobody can approve it. Do what you can without it; Yew lists what was refused in the report.`,
						),
						detail: { code: "unattended" },
					},
					status: "denied",
					started,
				});
				continue;
			}
			if (decision.effect === "ask") {
				this.#store.updateToolCall(row.id, { status: "waiting" });
				const approval = this.#store.createApproval({
					sessionId,
					toolCallId: row.id,
					kind: "permission",
					// What the call is for and what it would change, so the person decides on what they see.
					request: {
						...decision.request,
						...tool.preview?.(row.args, session, this.#lookup(session)),
					},
				});
				const answer = await this.#waitFor(sessionId, approval.id, live);
				if (!answer || answer.decision === "deny" || answer.decision === undefined) {
					const reason = answer?.reason?.trim();
					const text = !answer
						? "Not run: stopped before the person decided."
						: reason
							? `The person declined this call: ${reason}`
							: "The person declined this call.";
					results.set(row.id, { result: failure(text), status: "denied", started });
					continue;
				}
				if (answer.decision === "allow_always" && decision.request.rememberRules) {
					const current = this.#store.getSession(sessionId);
					this.#store.updateSession(sessionId, {
						rules: [...current.rules, ...decision.request.rememberRules],
					});
				}
				// Clear "waiting" immediately once approved so the UI never keeps showing "Needs your permission".
				this.#store.updateToolCall(row.id, { status: "pending" });
			}
			approved.push({ row, tool });
		}

		const execute = async ({ row, tool }: { row: ToolCallView; tool: ToolDefinition }) => {
			const started = Date.now();
			if (signal.aborted) {
				results.set(row.id, {
					result: failure("Not run: stopped by the person."),
					status: "error",
					started,
				});
				return;
			}
			this.#store.updateToolCall(row.id, { status: "running", startedAt: started });
			let result: ToolResult;
			try {
				result = await tool.run(row.args, this.#toolContext(sessionId, row, live));
			} catch (error) {
				result = failure(
					error instanceof ToolInputError
						? error.message
						: `The tool failed: ${(error as Error).message}`,
				);
			}
			// The person's PostToolUse hooks see what it did, and may add a word for the model (hooks.ts).
			if (!result.isError && this.#hooks?.has("PostToolUse", row.tool)) {
				const said = result.content
					.map((block) => (block.type === "text" ? block.text : ""))
					.join("\n")
					.slice(0, 10_000);
				const after = await this.#hook(
					"PostToolUse",
					sessionId,
					{ tool_response: { content: said } },
					row.tool,
					row.args,
				);
				if (after.block) {
					result = {
						...result,
						content: [
							...result.content,
							{ type: "text", text: hookNote("PostToolUse", after.block) },
						],
					};
				}
			}
			results.set(row.id, { result, status: result.isError ? "error" : "done", started });
		};
		// Run contiguous read-only calls concurrently while preserving exact order around mutating calls.
		for (let i = 0; i < approved.length; ) {
			const currentCall = approved[i];
			if (!currentCall) break;
			if (!currentCall.tool.readOnly) {
				await execute(currentCall);
				i++;
				continue;
			}
			const start = i;
			while (i < approved.length && approved[i]?.tool.readOnly) i++;
			await Promise.all(approved.slice(start, i).map(execute));
		}

		// Results go into the transcript in the order the model made the calls.
		this.#store.tx(() => {
			for (const row of rows) {
				const outcome = results.get(row.id) ?? {
					result: failure("Not run."),
					status: "error" as const,
					started: Date.now(),
				};
				this.#finishCall(row, outcome.result, outcome.status, outcome.started);
			}
		});
	}

	#finishCall(
		row: Pick<ToolCallView, "id" | "callId" | "tool" | "sessionId">,
		result: ToolResult,
		status: "done" | "error" | "denied",
		started: number,
	): void {
		const entry = this.#store.appendEntry(row.sessionId, resultEntry(row, result, started));
		const detail = (result.detail as JsonObject | undefined) ?? null;
		const note = this.#permissionNotes.get(row.id);
		this.#permissionNotes.delete(row.id);
		this.#store.updateToolCall(row.id, {
			status,
			// The row shows what ran unasked with its risk, or what the check allowed.
			detail: note ? { ...detail, permission: note as unknown as JsonObject } : detail,
			resultMessageId: entry.id,
			finishedAt: Date.now(),
		});
		// A letter this call waited for is now in the transcript, inside the result.
		const handed = this.#mail.takeHanded(row.id);
		if (handed) this.post.mail.setLetterEntry(handed, entry.id);
	}

	/** What the person wrote, for the UserPromptSubmit hooks of the next step. */
	#prompted(sessionId: string, texts: string[]): void {
		const wanted = texts.filter((text) => text.trim());
		if (!this.#hooks || wanted.length === 0) return;
		this.#prompts.set(sessionId, [...(this.#prompts.get(sessionId) ?? []), ...wanted]);
	}

	/** Runs one event's hooks; a hook that failed is a notice for the person. */
	async #hook(
		event: HookEvent,
		sessionId: string,
		fields: JsonObject,
		tool?: string,
		args?: JsonObject,
	): Promise<HookOutcome> {
		const hooks = this.#hooks;
		if (!hooks) return { block: null, context: "", errors: [] };
		const session = this.#store.getSession(sessionId);
		const outcome = await hooks.run(event, fields, {
			sessionId,
			cwd: session.cwd,
			...(tool !== undefined ? { tool } : {}),
			...(args !== undefined ? { args } : {}),
		});
		for (const error of outcome.errors) {
			this.#notice(sessionId, "hook", error, { event, kind: "error", text: error });
		}
		return outcome;
	}

	/**
	 * SessionStart for a session's first turn, UserPromptSubmit for each thing the person wrote.
	 * What they print goes to the model as Yew's note; true when one stopped what the person wrote.
	 */
	async #promptHooks(sessionId: string): Promise<boolean> {
		if (!this.#hooks) return false;
		const first = !this.#store
			.contextEntries(sessionId)
			.some((entry) => entry.role === "assistant");
		if (first && this.#hooks.has("SessionStart")) {
			const started = await this.#hook("SessionStart", sessionId, { source: "startup" });
			if (started.context) {
				this.#store.appendEntry(sessionId, userEntry(hookNote("SessionStart", started.context)));
			}
		}
		const prompts = this.#prompts.get(sessionId) ?? [];
		this.#prompts.delete(sessionId);
		if (!this.#hooks.has("UserPromptSubmit")) return false;
		for (const prompt of prompts) {
			const checked = await this.#hook("UserPromptSubmit", sessionId, { prompt });
			if (checked.block) {
				this.#store.appendEntry(
					sessionId,
					userEntry(
						hookNote(
							"UserPromptSubmit",
							`It stopped the message above, so that message is not to be acted on: ${checked.block}`,
						),
					),
				);
				this.#notice(sessionId, "hook", checked.block, {
					event: "UserPromptSubmit",
					kind: "blocked",
					text: checked.block,
				});
				return true;
			}
			if (checked.context) {
				this.#store.appendEntry(
					sessionId,
					userEntry(hookNote("UserPromptSubmit", checked.context)),
				);
			}
		}
		return false;
	}

	/** Adds to what a call's row says about how it was allowed. */
	#notePermission(callId: string, note: PermissionNote): void {
		const current = this.#permissionNotes.get(callId) ?? {};
		const risk = [...new Set([...(current.risk ?? []), ...(note.risk ?? [])])];
		const reviewed = [current.reviewed, note.reviewed].filter((text) => text !== undefined);
		this.#permissionNotes.set(callId, {
			...(risk.length > 0 ? { risk } : {}),
			...(reviewed.length > 0 ? { reviewed: reviewed.filter(Boolean).join(" ") } : {}),
		});
	}

	/**
	 * A permission a running command asks for, such as reaching a site (blueprint 6.1, item 6): what
	 * only the person gives in the session's mode goes to them; otherwise skip mode allows it, and the
	 * automatic mode's check decides first. True when allowed; else the request to ask the person with.
	 */
	async #settlePermit(
		sessionId: string,
		callId: string,
		request: PermissionRequest,
		live: Live,
	): Promise<PermissionRequest | true> {
		const session = this.#store.getSession(sessionId);
		const mode = permissionModeOf(this.#mail.withRunMode(session).options);
		if (personOnly(request.reasons ?? [], mode)) return { ...request, matter: true };
		if (mode === "skip") {
			this.#notePermission(callId, { risk: request.reasons ?? [] });
			return true;
		}
		if (mode !== "review") return request;
		const verdict = await reviewStep({
			gateway: this.#gateway,
			store: this.#store,
			session,
			request,
			signal: live.controller.signal,
		});
		if (!verdict.allow) return { ...request, review: verdict.reason };
		this.#notePermission(callId, { reviewed: verdict.reason });
		this.#recordReview(sessionId, request, verdict.reason);
		return true;
	}

	/** Each step the check let run stays in the session to look back on. */
	#recordReview(sessionId: string, request: PermissionRequest, reason: string): void {
		notice(this.#store, sessionId, "reviewed", reason, {
			tool: request.tool,
			summary: request.summary.slice(0, 300),
			reason,
		});
	}

	/** After a restart: calls that were running get an honest "unknown" result; calls that never ran are checked again. */
	async #resumeCalls(sessionId: string, live: Live): Promise<void> {
		const unknown = this.#store.toolCallsByStatus(sessionId, ["needs_review"]);
		this.#store.tx(() => {
			for (const call of unknown) this.#finishCall(call, failure(RESTARTED), "error", Date.now());
		});
		const pending = this.#store.toolCallsByStatus(sessionId, ["pending"]);
		if (pending.length > 0)
			await this.#runCalls(
				sessionId,
				pending,
				pending.map(() => null),
				live,
			);
	}

	#waitFor(sessionId: string, approvalId: string, live: Live): Promise<Answer | null> {
		const signal = live.controller.signal;
		this.#store.setStatus(sessionId, "waiting");
		return new Promise<Answer | null>((resolve) => {
			const finish = (answer: Answer | null) => {
				live.waiters.delete(approvalId);
				signal.removeEventListener("abort", onAbort);
				if (!signal.aborted) this.#store.setStatus(sessionId, "working");
				resolve(answer);
			};
			const onAbort = () => {
				this.#store.cancelApproval(approvalId);
				finish(null);
			};
			live.waiters.set(approvalId, finish);
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	#toolContext(sessionId: string, row: ToolCallView, live: Live): ToolContext {
		const session = this.#store.getSession(sessionId);
		const model = this.#gateway.model(session.provider, session.model);
		let tail = "";
		let timer: ReturnType<typeof setTimeout> | null = null;
		let permits: Promise<boolean> = Promise.resolve(true);
		const context: ToolContext = {
			session,
			signal: live.controller.signal,
			readState: this.#readState(sessionId),
			jobs: this.#jobsFor(sessionId),
			tmpDir: join(this.#home, "tmp", sessionId),
			acceptsImages: model?.input.includes("image") ?? false,
			version: this.#version,
			output: (chunk) => {
				tail = (tail + chunk).slice(-4000);
				if (timer) return;
				timer = setTimeout(() => {
					timer = null;
					this.#store.live(sessionId, { type: "toolOutput", toolCallId: row.id, output: tail });
				}, 200);
			},
			setTodos: (todos) => this.#store.setTodos(sessionId, todos),
			offLimits: (path) => this.#permissions.offLimits(path),
			ask: async (request) => {
				const run = this.#mail.run(sessionId);
				if (run?.unattended) {
					const first = request.questions?.[0]?.question ?? request.question ?? "";
					run.refused.push(`Question: ${clip(plainLine(first), 200)}`);
					throw new ToolInputError(
						`Nobody can answer now: this turn runs for the scheduled task "${run.name}" and nobody is watching. Decide what you can yourself and say in your reply what is still open.`,
					);
				}
				const approval = this.#store.createApproval({
					sessionId,
					toolCallId: row.id,
					kind: "question",
					request,
				});
				const answer = await this.#waitFor(sessionId, approval.id, live);
				if (!answer?.answer) throw new ToolInputError("Stopped before the person answered.");
				return answer.answer;
			},
			permit: (asked, until) => {
				// One card at a time for a call; the next waits until the person has answered.
				const next = permits.then(async () => {
					if (until?.aborted) return false;
					const request = await this.#settlePermit(sessionId, row.id, asked, live);
					if (request === true) return true;
					const run = this.#mail.run(sessionId);
					if (run?.unattended) {
						run.refused.push(request.summary);
						return false;
					}
					this.#store.updateToolCall(row.id, { status: "waiting" });
					const approval = this.#store.createApproval({
						sessionId,
						toolCallId: row.id,
						kind: "permission",
						request,
					});
					// The need passed before the person answered: the card is withdrawn.
					const withdraw = () => {
						if (this.#store.getApproval(approval.id).status !== "pending") return;
						this.#store.cancelApproval(approval.id);
						live.waiters.get(approval.id)?.(null);
					};
					until?.addEventListener("abort", withdraw, { once: true });
					const answer = await this.#waitFor(sessionId, approval.id, live);
					until?.removeEventListener("abort", withdraw);
					if (!live.controller.signal.aborted) {
						this.#store.updateToolCall(row.id, { status: "running" });
					}
					if (answer?.decision === "allow_always" && request.rememberRules) {
						const newDomains = request.rememberRules
							.filter((rule) => rule.tool === "sandbox_site" && rule.pattern)
							.map((rule) => rule.pattern as string);
						if (newDomains.length > 0) {
							const current = this.#store.getSession(sessionId);
							const merged = [
								...new Set([...(current.options.allowedDomains ?? []), ...newDomains]),
							];
							this.#store.updateSession(sessionId, { options: { allowedDomains: merged } });
						}
					}
					return answer?.decision === "allow_once" || answer?.decision === "allow_always";
				});
				permits = next.catch(() => false);
				return next;
			},
			mail: this.#mailContext(sessionId, live, row.id),
			helper: (task) => {
				const parent = this.#store.getSession(sessionId);
				return runHelper({
					gateway: this.#gateway,
					permissions: this.#permissions,
					session: this.#mail.withRunMode(parent),
					tools: toolsFor(parent, this.#allTools(), this.#roles(parent)),
					lookup: this.#lookup(parent),
					// Its own reads, so they do not count as the session's before an edit; no questions.
					context: {
						...context,
						readState: new ReadState(),
						output: () => {},
						setTodos: () => {},
						ask: async () => {
							throw new ToolInputError("A helper cannot ask the person.");
						},
						permit: async () => false,
					},
					systemPrompt: helperPrompt(parent.name, parent.cwd),
					task,
					signal: live.controller.signal,
					onStep: (line) => context.output(`${line}\n`),
					onUsage: (usage) =>
						this.#store.addUsage(sessionId, usage, this.#store.getSession(sessionId).contextTokens),
				});
			},
		};
		return context;
	}

	// --- letters (blueprint section 7) ---

	#mailContext(sessionId: string, live: Live, callId: string): MailContext {
		return {
			post: this.post,
			canPostCards: this.post.canPostCards(this.#store.getSession(sessionId)),
			send: (out) => {
				const session = this.#store.getSession(sessionId);
				const originEntryId = this.#mail.originOf(sessionId);
				return this.#mail.sent(
					sessionId,
					this.post.send(
						{ kind: "session", session },
						{ ...out, ...(originEntryId ? { originEntryId } : {}) },
					),
				);
			},
			wait: (letter) => this.#mail.awaitReply(sessionId, letter, live.controller.signal, callId),
			open: (input) => this.#mail.openChild(this.#store.getSession(sessionId), input, callId),
			finish: (outcome) => this.#store.setOutcome(sessionId, outcome),
			manage: (args) => {
				const by = this.#store.getSession(sessionId);
				if (!this.post.canOrganize(by)) {
					throw conflict(
						"Only the main conversation, or a session the person allowed, can manage Yew.",
						undefined,
						"not-allowed",
					);
				}
				return this.#manager.apply(by, args);
			},
		};
	}

	/**
	 * Starts a session that has letters waiting, when it is free: idle, or stopped by an error. A session
	 * that needs review (blueprint 7.3) or that the person stopped waits for the person; one that is
	 * working gets its letters between tool calls.
	 */
	#wake(sessionId: string): void {
		if (this.isRunning(sessionId) || this.#held.isPaused(sessionId)) return;
		let session: Session;
		try {
			session = this.#store.getSession(sessionId);
		} catch {
			return;
		}
		if (session.archivedAt !== null) return;
		if (session.status !== "idle" && session.status !== "error") return;
		// At a spending limit letters wait: for the next day, a higher limit, or the person.
		if (reached(this.#store, session, Date.now())) return;
		if (this.post.mail.queuedFor(sessionId).length === 0) return;
		this.#dropLeftovers(sessionId, "Not run: a letter arrived and the conversation moved on.");
		this.#start(sessionId);
	}

	/** Starts every free session with letters waiting: after a restart, and for letters from `yew send`. */
	wakeQueued(): void {
		this.#continueCapped();
		for (const id of this.post.mail.sessionsWithQueued()) this.#wake(id);
	}

	/** Sessions that stopped at a spending limit today go on once the limit was raised or removed. */
	#continueCapped(): void {
		const now = Date.now();
		for (const [id, day] of this.#held.capped()) {
			let session: Session;
			try {
				session = this.#store.getSession(id);
			} catch {
				this.#held.uncap(id);
				continue;
			}
			if (day !== localDay(now) || session.archivedAt !== null || this.#held.isPaused(id)) {
				this.#held.uncap(id);
				continue;
			}
			if (this.isRunning(id) || reached(this.#store, session, now)) continue;
			this.#held.uncap(id);
			this.#start(id, { resume: true });
		}
	}

	/** A line for the person about a daily spending limit; returns the text. */
	#budgetNotice(
		sessionId: string,
		code: "budget-warning" | "budget-reached",
		mark: BudgetMark,
	): string {
		const whose = mark.scope === "session" ? "this session's" : "the shared";
		const amounts = `${dollars(mark.spent)} of ${dollars(mark.limit)}`;
		const text =
			code === "budget-reached"
				? `Stopped: today's spending reached ${whose} daily limit (${amounts}).`
				: `Today's spending passed 80% of ${whose} daily limit (${amounts}).`;
		this.#notice(sessionId, "budget", text, {
			code,
			scope: mark.scope,
			spent: mark.spent,
			limit: mark.limit,
		});
		return text;
	}

	/**
	 * A code session's last reply that nobody else reads, ending with a question or an offer, becomes a
	 * question in the approval center, and the session shows that it waits. The latest such question
	 * replaces an older one; the person's next message, or continuing, takes it away.
	 */
	#askFromReply(session: Session, said: string): void {
		if (!session.cwd || session.archivedAt !== null || session.id === this.post.mainSessionId()) {
			return;
		}
		const older = this.#replyQuestions(session.id);
		const asked = askedInReply(said);
		if (asked) {
			this.#dropReplyQuestions(session.id);
			const card = this.#store.createApproval({
				sessionId: session.id,
				toolCallId: null,
				kind: "question",
				request: { questions: [{ question: asked }], fromReply: true },
			});
			const choosing = new AbortController();
			this.#choosing.set(session.id, choosing);
			this.#offerChoices(session, card.id, asked, said, choosing.signal)
				.catch((error: unknown) =>
					this.#log(
						`session ${session.id}: no choices for its question: ${(error as Error).message}`,
					),
				)
				.finally(() => {
					if (this.#choosing.get(session.id) === choosing) this.#choosing.delete(session.id);
				});
		}
		if (asked || older.length > 0) this.#store.setStatus(session.id, "waiting", null);
	}

	/**
	 * Gives a question taken from a reply its choices, so the person answers with one click. The
	 * session's own model writes them from the end of the reply. The card is there meanwhile, and
	 * stays as it is when this fails, when the question has no fixed answers, or when the person has
	 * answered by then.
	 */
	async #offerChoices(
		session: Session,
		approvalId: string,
		asked: string,
		said: string,
		signal: AbortSignal,
	): Promise<void> {
		const model = this.#gateway.model(session.provider, session.model);
		if (!model) return;
		const reply = await this.#gateway.stream({
			provider: session.provider,
			model: model.id,
			thinking: "off",
			systemPrompt: CHOICES_PROMPT,
			messages: [
				{
					role: "user",
					content: `The end of the reply:\n${said.slice(-3000)}\n\nThe question:\n${asked}`,
					timestamp: Date.now(),
				},
			],
			tools: [],
			signal,
		});
		const now = this.#store.getSession(session.id);
		this.#store.addUsage(session.id, usageTotals(reply), now.contextTokens);
		const wrote = reply.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		const choices = choicesFrom(wrote);
		if (!choices || signal.aborted) return;
		this.#store.amendApproval(approvalId, {
			questions: [{ question: asked, ...choices }],
			fromReply: true,
		});
	}

	#replyQuestions(sessionId: string): Approval[] {
		return this.#store
			.pendingApprovals(sessionId)
			.filter((approval) => (approval.request as QuestionRequest).fromReply === true);
	}

	#dropReplyQuestions(sessionId: string): void {
		this.#choosing.get(sessionId)?.abort();
		this.#choosing.delete(sessionId);
		for (const approval of this.#replyQuestions(sessionId)) this.#store.cancelApproval(approval.id);
	}

	/** The main conversation and the session's opener, as the system prompt names them. */
	#placement(session: Session): Placement {
		const mainId = this.post.mainSessionId();
		const ref = (id: string | null) => {
			if (!id) return null;
			try {
				return { id, name: this.#store.getSession(id).name };
			} catch {
				return null;
			}
		};
		return { main: ref(mainId), parent: ref(session.parentId), team: this.#groupName(session) };
	}

	#readState(sessionId: string): ReadState {
		let state = this.#readStates.get(sessionId);
		if (!state) {
			state = new ReadState();
			this.#readStates.set(sessionId, state);
		}
		return state;
	}

	#jobsFor(sessionId: string): Jobs {
		let jobs = this.#jobs.get(sessionId);
		if (!jobs) {
			jobs = new Jobs((job) => {
				const code = job.finished?.exitCode;
				const note = `Background job ${job.id} (${job.command}) ended${code === null || code === undefined ? "" : ` with exit code ${code}`}. Use shell_job to read its output.`;
				this.#note(sessionId, note);
				this.#notice(sessionId, "job_finished", note, {
					job: job.id,
					command: job.command,
					exitCode: code ?? null,
				});
			});
			this.#jobs.set(sessionId, jobs);
		}
		return jobs;
	}

	#note(sessionId: string, note: string): void {
		const notes = this.#notes.get(sessionId) ?? [];
		notes.push(note);
		this.#notes.set(sessionId, notes);
	}

	/** Moves Yew's notes, letters and the person's queued messages into the transcript; true if anything arrived. */
	#deliver(sessionId: string): boolean {
		const notes = this.#notes.get(sessionId) ?? [];
		this.#notes.delete(sessionId);
		for (const note of notes) {
			this.#store.appendEntry(sessionId, userEntry(`${YEW_NOTE} ${note}`));
		}
		const letters = this.#mail.deliver(sessionId, this.#mail.firstDelivery(sessionId));
		const delivered = this.#store.deliverQueue(sessionId, userEntry, (entry, refs) => {
			this.attachments.bindToEntry(
				sessionId,
				refs.map((item) => item.id),
				entry.id,
			);
		});
		this.#prompted(
			sessionId,
			delivered.map((entry) => {
				if (entry.role !== "user") return "";
				const raw = messageText(entry.message).trim();
				return (
					raw || (entry.attachments ?? []).map((item) => `[Attached: ${item.name}]`).join(", ")
				);
			}),
		);
		const fromPerson = delivered.length;
		if (fromPerson > 0) {
			// What the person wrote starts a new chain of hand-offs, and they are watching now.
			this.post.resetChain(sessionId);
			this.#mail.watched(sessionId);
			const lastEntry = delivered.at(-1);
			if (lastEntry && sessionId === this.post.mainSessionId()) {
				this.#mail.setOrigin(sessionId, lastEntry.id);
			}
		}
		return letters > 0 || fromPerson > 0 || notes.length > 0;
	}

	/** The name of the session's group, for the system prompt. */
	#groupName(session: Session): string | null {
		if (!session.groupId) return null;
		return this.#store.listGroups().find((group) => group.id === session.groupId)?.name ?? null;
	}

	#notice(sessionId: string, kind: Notice["kind"], text: string, data?: JsonObject): void {
		notice(this.#store, sessionId, kind, text, data);
	}
}
