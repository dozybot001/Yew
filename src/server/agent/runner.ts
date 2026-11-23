import { rmSync } from "node:fs";
import { join } from "node:path";
import {
	type AssistantMessage,
	type JsonObject,
	messageText,
	type Notice,
	type ToolCallBlock,
} from "../../shared/messages.ts";
import type {
	Approval,
	Entry,
	QuestionRequest,
	QueuedMessage,
	Session,
	SessionStatus,
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
import type { Hooks } from "../hooks.ts";
import { PostOffice } from "../mail/post.ts";
import { Manager } from "../manage.ts";
import type { ModelGateway, ModelInfo } from "../model/gateway.ts";
import type { PermissionEngine } from "../permissions/engine.ts";
import { ScheduleBook } from "../schedules.ts";
import { skillFolders } from "../skills.ts";
import type { Store } from "../store.ts";
import { Jobs } from "../tools/jobs.ts";
import { settleAnswer } from "../tools/misc.ts";
import { ReadState } from "../tools/read-state.ts";
import { ALL_TOOLS, specs, toolsFor } from "../tools/registry.ts";
import type { Roles, ToolDefinition } from "../tools/types.ts";
import { type Answer, Calls, failure, type Live } from "./calls.ts";
import { ContextKeeper, notice } from "./compaction.ts";
import {
	clip,
	hookNote,
	prepareModelMessages,
	sanitizeInterrupted,
	usageTotals,
	userEntry,
	YEW_NOTE,
} from "./context.ts";
import { Held } from "./held.ts";
import { Mailroom } from "./mailroom.ts";
import { nameAfterFirstTurn } from "./naming.ts";
import {
	type ContextSnapshot,
	type InstructionExtras,
	type Placement,
	systemPrompt,
} from "./prompt.ts";
import { ReplyQuestions } from "./reply-question.ts";
import { SessionHooks } from "./session-hooks.ts";

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
	/**
	 * Whether a model reads the end of each reply for a question to the person (reply-question.ts).
	 * `yew serve` turns it on; not when not given, so tests can script every model request.
	 */
	readReplies?: boolean;
}

/** How many times the Stop hooks may send a session back to work in one turn. */
const MAX_STOP_HOOKS = 3;

const MAX_MESSAGE_CHARS = 100_000;
const MAX_STEPS = 500;
/** How many times in a row a reply cut off at the model's output limit is continued by itself. */
const MAX_CUT_REPLIES = 8;
/** How long a session waits for another one's answer: one wait, no polling. */
const WAIT_MS = 30 * 60 * 1000;

const CUT_CALL =
	"Not run: your reply was cut off at the output limit before its tool calls were complete. Make the call again; write long content in parts.";
const CUT_TOO_OFTEN = "The reply was cut off at the model's output limit several times in a row.";

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

/** Tokens the next request starts from: everything sent plus what the model just wrote. */
function contextSize(message: AssistantMessage): number {
	const usage = message.usage;
	return usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
}

/**
 * Runs sessions. Each working session is one async loop in this process: ask the model, check and
 * run the tools it calls, feed back the results, and repeat until the model stops. Every step is
 * stored as it happens, so a restart can tell what was in flight.
 */
export class Agents {
	readonly #store: Store;
	readonly #gateway: ModelGateway;
	readonly #permissions: PermissionEngine;
	readonly #home: string;
	readonly #allTools: () => ToolDefinition[];
	readonly #log: (line: string) => void;
	readonly #draftInterval: number;
	readonly #live = new Map<string, Live>();
	readonly #readStates = new Map<string, ReadState>();
	readonly #jobs = new Map<string, Jobs>();
	/** Messages from Yew itself (such as "a background job ended") waiting to reach the model. */
	readonly #notes = new Map<string, string[]>();
	readonly #hooks: SessionHooks;
	readonly #calls: Calls;
	readonly #replyQuestions: ReplyQuestions;
	/** Letters, decision cards and the approval center. */
	readonly post: PostOffice;
	/** Scheduled tasks, whose runs end in this runner. */
	readonly schedules: ScheduleBook;
	/** Per-session message attachments. */
	readonly attachments: AttachmentStore;
	readonly #mail: Mailroom;
	/** Each working session's latest written reply in this turn. */
	readonly #lastText = new Map<string, string>();
	readonly #userHome: string | null;
	/**
	 * Sessions the person stopped (letters wait until the person writes to them or continues them) and
	 * sessions that stopped at a daily spending limit (raising the limit that day continues them).
	 */
	readonly #held: Held;
	readonly #maxSteps: number;
	readonly #context: ContextKeeper;
	readonly #manager: Manager;

	constructor(options: AgentsOptions) {
		this.#store = options.store;
		this.#gateway = options.gateway;
		this.#permissions = options.permissions;
		this.#home = options.home;
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
		this.#hooks = new SessionHooks(options.store, options.hooks ?? null);
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
			quiet: (session, said) => this.#replyQuestions.ask(session, said),
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
		this.#calls = new Calls({
			store: this.#store,
			gateway: this.#gateway,
			permissions: this.#permissions,
			home: this.#home,
			version: options.version,
			post: this.post,
			mail: this.#mail,
			manager: this.#manager,
			hooks: this.#hooks,
			tools: (session) => this.#toolsOf(session),
			readState: (id) => this.#readState(id),
			jobs: (id) => this.#jobsFor(id),
		});
		this.#replyQuestions = new ReplyQuestions({
			store: this.#store,
			gateway: this.#gateway,
			log: this.#log,
			mainId: () => this.post.mainSessionId(),
			isRunning: (id) => this.isRunning(id),
			settled: (id) => this.#wake(id),
			enabled: options.readReplies ?? false,
		});
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

	/** The person sends a message: it starts a turn, or waits in the queue while one runs. */
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
		// The person stepped in: a full quota of letters again, and a new chain of hand-offs.
		this.#replyQuestions.drop(sessionId);
		this.#held.resume(sessionId);
		this.#store.resetLettersSent(sessionId);
		this.#store.addIntervention(sessionId);
		this.post.resetChain(sessionId);
		if (this.isRunning(sessionId)) {
			return { queued: this.#store.enqueue(sessionId, text, attachments) };
		}
		this.#calls.dropLeftovers(
			sessionId,
			"Not run: the person sent a new message instead of continuing.",
		);
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
		this.#hooks.prompted(sessionId, [hookPrompt]);
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
		this.#replyQuestions.drop(sessionId);
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
	 * Takes the conversation back to a point the person picked: one of its replies, or just before
	 * one of the person's messages. Not while it works. A question Yew made of a reply goes with the
	 * reply. Returns how many entries were taken back.
	 */
	rewind(sessionId: string, entryId: string): number {
		if (this.isRunning(sessionId)) {
			throw conflict("Stop the session first, then take it back.", undefined, "session-busy");
		}
		const count = this.#store.rewindSession(sessionId, this.#store.turnPoint(sessionId, entryId));
		this.#replyQuestions.drop(sessionId);
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
	 * Starts a fresh context window in place for a session; the session must not be working. Full
	 * history stays searchable and scrollable; only the active model window resets.
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
	#toolsOf(session: Session): ToolDefinition[] {
		const roles: Roles = {
			canPostCards: this.post.canPostCards(session),
			canOrganize: this.post.canOrganize(session),
		};
		return toolsFor(session, this.#allTools(), roles);
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
			if (resume) await this.#calls.resume(sessionId, live);
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
				if (await this.#hooks.beforeRequest(sessionId)) break;
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
					if (this.#hooks.has("Stop") && stopHooks < MAX_STOP_HOOKS) {
						const stopped = await this.#hooks.run("Stop", sessionId, {
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
						for (const row of rows) {
							this.#calls.finish(row, failure(CUT_CALL), "error", Date.now());
						}
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
				await this.#calls.run(sessionId, rows, calls, live);
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
				nameAfterFirstTurn(this.#store, this.#gateway, sessionId).catch((error: unknown) =>
					this.#log(`session ${sessionId}: naming failed: ${(error as Error).message}`),
				);
			}
		}
	}

	async #ask(
		session: Session,
		model: ModelInfo,
		snapshot: ContextSnapshot,
		signal: AbortSignal,
	): Promise<AssistantMessage> {
		const tools = this.#toolsOf(session);
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

	/**
	 * Starts a session that has letters waiting, when it is free: idle, or stopped by an error. A session
	 * that needs review or that the person stopped waits for the person; one that is working gets its
	 * letters between tool calls.
	 */
	#wake(sessionId: string): void {
		if (this.isRunning(sessionId) || this.#held.isPaused(sessionId)) return;
		// Its last reply may ask the person something: letters wait until that is known.
		if (this.#replyQuestions.reading(sessionId)) return;
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
		this.#calls.dropLeftovers(
			sessionId,
			"Not run: a letter arrived and the conversation moved on.",
		);
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
		this.#hooks.prompted(
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
