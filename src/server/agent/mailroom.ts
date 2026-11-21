/**
 * A session's letters over one turn: what it sent and read, the call that waits for another
 * session's answer, the scheduled run a turn may be, and what Yew sends on the session's behalf
 * when the turn ends. The loop in runner.ts asks this module; it does not keep letter state.
 */
import { isAbsolute, join } from "node:path";
import { plainLine } from "../../shared/messages.ts";
import {
	type Letter,
	type PermissionMode,
	permissionModeOf,
	type Session,
	type SessionStatus,
} from "../../shared/types.ts";
import { conflict, invalid, YewError } from "../errors.ts";
import { decisionRef, letterRef, letterText, type ScheduleRef } from "../mail/envelope.ts";
import { BODY_MAX, type PostOffice, reasonText, SUMMARY_MAX } from "../mail/post.ts";
import type { ModelGateway } from "../model/gateway.ts";
import { resolveWorkingFolder } from "../paths.ts";
import { inheritableRules } from "../permissions/engine.ts";
import { isInside } from "../permissions/paths.ts";
import type { ScheduleBook } from "../schedules.ts";
import { type Store, validateSessionName } from "../store.ts";
import type { OpenInput, WaitResult } from "../tools/types.ts";
import { PERMISSION_MODE } from "./prompt.ts";

const clip = (text: string, max: number) =>
	[...text].length > max ? `${[...text].slice(0, max - 1).join("")}…` : text;

/** Session names are unique: "修复登录", then "修复登录 2"… */
export function freeName(store: Store, base: string): string {
	if (!store.findSessionByName(base)) return base;
	for (let n = 2; ; n++) {
		const name = `${base.slice(0, 55)} ${n}`;
		if (!store.findSessionByName(name)) return name;
	}
}

/** A turn a scheduled task started. */
export interface ScheduledRun {
	letterId: string;
	scheduleId: string;
	name: string;
	/** The permission mode for this run; null keeps the session's own. */
	mode: PermissionMode | null;
	/** Nobody is there to approve or answer, until the person writes to the session. */
	unattended: boolean;
	/** What Yew refused for want of the person, for the report. */
	refused: string[];
}

/** One turn of a session: what it sent and read, who started it, and the scheduled run it is. */
interface Turn {
	sent: Letter[];
	read: Map<string, number>;
	/** The person started it with a message or by continuing. */
	byPerson: boolean;
	/** Letters were delivered at least once. */
	started: boolean;
	run: ScheduledRun | null;
	/** Server-stamped ID of the person's message in the main conversation that started this chain. */
	originEntryId: string | null;
}

export interface MailroomOptions {
	store: Store;
	gateway: ModelGateway;
	post: PostOffice;
	schedules: ScheduleBook;
	log: (line: string) => void;
	/** The longest a call waits for another session's answer. */
	waitMs: number;
	isRunning: (sessionId: string) => boolean;
	/** A letter arrived that no waiting call takes: start its session if it is free. */
	wake: (sessionId: string) => void;
	/** A turn ended normally with nobody to report to: `said` is its last reply. */
	quiet: (session: Session, said: string) => void;
}

export class Mailroom {
	readonly #store: Store;
	readonly #gateway: ModelGateway;
	readonly #post: PostOffice;
	readonly #schedules: ScheduleBook;
	readonly #log: (line: string) => void;
	readonly #waitMs: number;
	readonly #isRunning: (sessionId: string) => boolean;
	readonly #wake: (sessionId: string) => void;
	readonly #quiet: (session: Session, said: string) => void;
	/** Sessions blocked in send_letter or open_session: the session, letter and tool call each waits on. */
	readonly #waits = new Map<
		string,
		{ target: string; letterId: string; callId: string; resolve: (result: WaitResult) => void }
	>();
	/**
	 * Each working session's current turn: the letters it sent, and for each letter it read, how many it
	 * had sent by then, so Yew can tell what it asked after reading a request.
	 */
	readonly #turns = new Map<string, Turn>();
	/** Letters handed to a waiting tool call, by the call's id, until the call's result is stored. */
	readonly #handed = new Map<string, string>();

	constructor(options: MailroomOptions) {
		this.#store = options.store;
		this.#gateway = options.gateway;
		this.#post = options.post;
		this.#schedules = options.schedules;
		this.#log = options.log;
		this.#waitMs = options.waitMs;
		this.#isRunning = options.isRunning;
		this.#wake = options.wake;
		this.#quiet = options.quiet;
	}

	/** A turn begins. */
	begin(sessionId: string, byPerson: boolean, originEntryId: string | null = null): void {
		this.#turns.set(sessionId, {
			sent: [],
			read: new Map(),
			byPerson,
			started: false,
			run: null,
			originEntryId,
		});
	}

	/** Updates the server-stamped main-conversation origin entry for this turn. */
	setOrigin(sessionId: string, originEntryId: string | null): void {
		const turn = this.#turns.get(sessionId);
		if (turn) turn.originEntryId = originEntryId;
	}

	/** Server-stamped main-conversation origin entry for outgoing letters from this turn. */
	originOf(sessionId: string): string | null {
		return this.#turns.get(sessionId)?.originEntryId ?? null;
	}

	/** The scheduled run this turn is, if it is one. */
	run(sessionId: string): ScheduledRun | null {
		return this.#turns.get(sessionId)?.run ?? null;
	}

	/** Whether this is the turn's first delivery; from now on it is not. */
	firstDelivery(sessionId: string): boolean {
		const turn = this.#turns.get(sessionId);
		if (!turn) return false;
		const first = !turn.started;
		turn.started = true;
		return first;
	}

	/** The person wrote to the session: somebody is watching a scheduled run now. */
	watched(sessionId: string): void {
		const run = this.#turns.get(sessionId)?.run;
		if (run) run.unattended = false;
	}

	/** The letter a waiting call was handed, once: the call's result is being stored. */
	takeHanded(callId: string): string | null {
		const letterId = this.#handed.get(callId) ?? null;
		this.#handed.delete(callId);
		return letterId;
	}

	/** A session was archived and these letters to it dropped: calls waiting on them stop waiting. */
	archived(sessionId: string, dropped: Set<string>): void {
		for (const waiting of [...this.#waits.values()]) {
			if (waiting.target === sessionId && dropped.has(waiting.letterId)) {
				waiting.resolve({ kind: "archived" });
			}
		}
	}

	/** Notes a letter the session sent in this turn, for what Yew sends on its behalf at the end. */
	sent(sessionId: string, letter: Letter): Letter {
		this.#turns.get(sessionId)?.sent.push(letter);
		return letter;
	}

	/** Notes that the session read a letter in this turn. */
	#read(sessionId: string, letterId: string): void {
		const turn = this.#turns.get(sessionId);
		turn?.read.set(letterId, turn.sent.length);
	}

	/**
	 * A letter is queued: a reply to the letter a session waits on goes to that waiting call; anything
	 * else wakes the recipient (or reaches it between tool calls).
	 */
	queued(letter: Letter): void {
		const waiting = this.#waits.get(letter.toSession);
		if (waiting && letter.fromSession === waiting.target && letter.replyTo === waiting.letterId) {
			this.#post.mail.setLetterStatus(letter.id, "delivered", {
				entryId: null,
				deliveredAt: Date.now(),
			});
			this.#handed.set(waiting.callId, letter.id);
			this.#read(letter.toSession, letter.id);
			waiting.resolve({ kind: "letter", letter: this.#post.mail.getLetter(letter.id) });
			return;
		}
		this.#wake(letter.toSession);
	}

	/**
	 * Moves queued letters into the transcript; the model reads them, the interface shows letters. A
	 * scheduled task's letter starts a turn of its own: only a turn that Yew started for waiting letters
	 * takes it, as its first delivery, and one per turn. Its own permission mode and the rule that nobody
	 * is watching then hold for that turn alone.
	 */
	deliver(sessionId: string, first: boolean): number {
		const turn = this.#turns.get(sessionId);
		let letters = this.#post.mail.queuedFor(sessionId);
		let adopted: Letter | null = null;
		if (first && turn && !turn.byPerson) {
			adopted = letters.find((letter) => letter.scheduleId !== null) ?? null;
		}
		letters = letters.filter((letter) => letter.scheduleId === null || letter === adopted);
		if (letters.length === 0) return 0;
		const session = this.#store.getSession(sessionId);
		if (adopted && turn) {
			const schedule = this.#schedules.find(adopted.scheduleId as string);
			turn.run = {
				letterId: adopted.id,
				scheduleId: adopted.scheduleId as string,
				name: schedule?.name ?? adopted.fromName,
				mode: schedule?.permissionMode ?? null,
				unattended: true,
				refused: [],
			};
		}
		this.#store.tx(() => {
			for (const letter of letters) {
				let decision = null;
				if (letter.decision !== null) {
					try {
						decision = decisionRef(this.#post.mail.cardByNumber(letter.decision));
					} catch {
						decision = null;
					}
				}
				const schedule = this.#scheduleRef(letter);
				const note = letter === adopted && turn?.run ? this.#runNote(session, turn.run) : null;
				const entry = this.#store.appendEntry(sessionId, {
					role: "user",
					message: {
						role: "user",
						content: letterText(letter, decision, schedule, note),
						timestamp: Date.now(),
					},
					letter: letterRef(letter, decision, schedule),
				});
				this.#post.mail.setLetterStatus(letter.id, "delivered", {
					entryId: entry.id,
					deliveredAt: Date.now(),
				});
				this.#read(sessionId, letter.id);
			}
		});
		this.#post.enterChain(sessionId, letters);
		// Propagate the server-stamped main-conversation origin along delegated letters when not directly prompted by the person.
		if (turn && !turn.originEntryId) {
			const inherited = [...letters]
				.reverse()
				.find((letter) => letter.originEntryId)?.originEntryId;
			if (inherited) turn.originEntryId = inherited;
		}
		return letters.length;
	}

	/** The scheduled task a letter belongs to, if it still exists. */
	#scheduleRef(letter: Letter): ScheduleRef | null {
		if (!letter.scheduleId) return null;
		const schedule = this.#schedules.find(letter.scheduleId);
		return schedule ? { id: schedule.id, name: schedule.name } : null;
	}

	/** What Yew tells a session about the scheduled run it is starting. */
	#runNote(session: Session, run: ScheduledRun): string {
		const lines = [
			"This is a scheduled run and nobody is watching: Yew refuses calls that need the person's approval, and questions for them.",
		];
		if (run.mode && run.mode !== permissionModeOf(session.options)) {
			lines.push(`For this run: ${PERMISSION_MODE[run.mode]}`);
		}
		const main = this.#post.mainSessionId();
		const mainName = main && main !== session.id ? this.#post.sessionName(main) : null;
		lines.push(
			mainName
				? `When you finish, Yew sends your last reply to the main conversation (${mainName}) as the report.`
				: "Your last reply is the report.",
		);
		return lines.join(" ");
	}

	/** The session as the permission check sees it: with the scheduled run's own mode, if it has one. */
	withRunMode(session: Session): Session {
		const mode = this.#turns.get(session.id)?.run?.mode;
		if (!mode) return session;
		return { ...session, options: { ...session.options, permissionMode: mode } };
	}

	/**
	 * The turn is over. Sessions waiting for this one get its last reply. Every
	 * session whose request it read and has not answered hears how the turn ended: when the turn finished
	 * normally and nothing it asked others is still open, its last reply goes back as the report and the
	 * request is done; after an error, a stop, or while it waits for answers of its own, a notice says so
	 * and the request stays open, so the real result still follows. A task session's opener hears about
	 * every turn. What is owed is read from the database, so a restart in the middle
	 * loses nothing. Yew's letters never ask for more letters, so this cannot loop.
	 */
	endTurn(
		sessionId: string,
		status: SessionStatus,
		detail: string | null,
		stopped: boolean,
		said: string,
	): void {
		this.#post.resetChain(sessionId);
		const turn: Turn = this.#turns.get(sessionId) ?? {
			sent: [],
			read: new Map<string, number>(),
			byPerson: false,
			started: true,
			run: null,
			originEntryId: null,
		};
		this.#turns.delete(sessionId);
		const mail = this.#post.mail;
		const session = this.#store.getSession(sessionId);
		const failed = stopped || status === "error";
		const open = (letter: Letter) =>
			["queued", "held", "delivered"].includes(mail.getLetter(letter.id).status);

		const sawEnd = new Set<string>();
		for (const [waiter, waiting] of [...this.#waits]) {
			if (waiting.target !== sessionId) continue;
			if (mail.getLetter(waiting.letterId).status === "queued") {
				// A letter not read yet starts the next turn at once: wait for that turn. Not when the
				// person stopped this session or archived it.
				if (session.archivedAt !== null) {
					waiting.resolve({ kind: "archived" });
					continue;
				}
				if (!stopped) continue;
			}
			sawEnd.add(waiter);
			waiting.resolve({ kind: "ended", status, text: said, detail, stopped });
		}

		const scheduledLetters = mail.scheduledRead(sessionId);
		const isScheduledTaskSession = session.kind === "task" && scheduledLetters.length > 0;

		const owed = new Map<string, Letter[]>();
		for (const request of mail.openRequests(sessionId)) {
			if (!request.fromSession) continue;
			owed.set(request.fromSession, [...(owed.get(request.fromSession) ?? []), request]);
		}
		// Scheduled task sessions report to their owner standing session and main via #finishRun below.
		if (session.parentId && !isScheduledTaskSession && !owed.has(session.parentId)) {
			owed.set(session.parentId, []);
		}

		for (const [requester, requests] of owed) {
			const close = () => {
				for (const request of requests) mail.closeRequest(request.id);
			};
			let target: Session | null = null;
			try {
				target = this.#store.getSession(requester);
			} catch {
				target = null;
			}
			if (!target || target.archivedAt !== null) {
				close();
				continue;
			}
			// What it sent after reading these requests (all of this turn for requests read earlier).
			const since =
				requests.length === 0
					? 0
					: Math.min(...requests.map((request) => turn.read.get(request.id) ?? 0));
			const after = turn.sent.slice(since);
			// A question back or work handed on that is still open: its reply is not the answer yet.
			const asking = after.some((letter) => letter.kind === "request" && open(letter));
			const finished = !failed && !asking;
			// It saw the end through its wait; a normal end answered it.
			if (sawEnd.has(requester)) {
				if (finished) close();
				continue;
			}
			const wrote = after.filter(
				(letter) =>
					letter.toSession === requester &&
					letter.status !== "refused" &&
					letter.status !== "dropped",
			);
			const replyTo = requests.at(-1)?.id ?? null;
			if (finished) {
				// A task session that already reported to its opener in this turn has said it.
				if (requests.length === 0 && wrote.some((letter) => letter.kind === "report")) continue;
				this.#autoLetter(session, requester, {
					kind: "report",
					summary: plainLine(said) || `${session.name} finished without a written reply.`,
					body: said,
					replyTo,
				});
				close();
				continue;
			}
			// Waiting for answers and already in touch with the requester: nothing to add.
			if (!failed && wrote.length > 0) continue;
			const follows = `When ${session.name} goes on, its reply comes to you.`;
			this.#autoLetter(session, requester, {
				kind: "notice",
				summary: stopped
					? `The person stopped ${session.name} before it finished.`
					: status === "error"
						? `${session.name} stopped with an error.`
						: plainLine(said) || `${session.name} is waiting for answers from other sessions.`,
				body: [status === "error" && !stopped ? (detail ?? "") : said, follows]
					.filter(Boolean)
					.join("\n\n"),
				replyTo,
			});
		}
		// Runs of scheduled tasks this turn read end with it; read from the database, so a run that a
		// restart interrupted ends with the turn that continues it.
		let reported = false;
		for (const letter of scheduledLetters) {
			const run = turn.run?.letterId === letter.id ? turn.run : null;
			if (this.#finishRun(session, letter, run, { status, detail, said, stopped })) reported = true;
		}
		mail.finishRead(sessionId);
		if (!failed && owed.size === 0 && !reported) this.#quiet(session, said);
	}

	/**
	 * A scheduled run ended. Its result goes on the task, and to the main conversation as a report, which
	 * sums it up for the person. For `task_session` runs, the owner standing
	 * session also receives the report, and a clean run archives the temporary task session when
	 * `autoArchive` is on. A run the person stopped needs no report.
	 */
	#finishRun(
		session: Session,
		letter: Letter,
		run: ScheduledRun | null,
		end: { status: SessionStatus; detail: string | null; said: string; stopped: boolean },
	): boolean {
		const outcome = end.stopped ? "stopped" : end.status === "error" ? "error" : "done";
		const first = plainLine(end.said);
		this.#schedules.finished(
			letter,
			outcome,
			outcome === "error" ? end.detail : outcome === "done" ? first || null : null,
		);
		const schedule = letter.scheduleId ? this.#schedules.find(letter.scheduleId) : null;
		const refused = run?.refused ?? [];
		const isTaskRun =
			schedule?.mode === "task_session" &&
			session.kind === "task" &&
			schedule.sessionId !== session.id;
		const main = this.#post.mainSessionId();
		const name = schedule?.name ?? letter.fromName;
		const body = [
			outcome === "error" ? (end.detail ?? "") : "",
			end.said,
			refused.length > 0
				? `Refused because nobody was watching:\n${refused.map((line) => `- ${line}`).join("\n")}`
				: "",
		]
			.filter(Boolean)
			.join("\n\n");
		const summary =
			outcome === "error"
				? `The scheduled task "${name}" stopped with an error in ${session.name}.`
				: first || `${session.name} finished the scheduled task "${name}" without a written reply.`;

		let sentAny = false;
		if (outcome !== "stopped") {
			const targets = new Set<string>();
			if (isTaskRun && schedule) targets.add(schedule.sessionId);
			if (main && main !== session.id) targets.add(main);
			for (const target of targets) {
				let recipient: Session | null = null;
				try {
					recipient = this.#store.getSession(target);
				} catch {
					recipient = null;
				}
				if (!recipient || recipient.archivedAt !== null) continue;
				this.#autoLetter(session, target, {
					kind: outcome === "done" ? "report" : "notice",
					summary,
					body,
					replyTo: null,
					schedule: letter.scheduleId,
				});
				sentAny = true;
			}
		}

		// Clean task_session runs archive themselves automatically when configured; errors or refused calls stay visible.
		if (isTaskRun && schedule?.autoArchive && outcome === "done" && refused.length === 0) {
			try {
				this.#store.updateSession(session.id, { archived: true });
			} catch {
				// Best-effort cleanup.
			}
		}
		return sentAny;
	}

	/** A letter Yew sends on a session's behalf at the end of its turn. */
	#autoLetter(
		session: Session,
		to: string,
		letter: {
			kind: "report" | "notice";
			summary: string;
			body: string;
			replyTo: string | null;
			schedule?: string | null;
		},
	): void {
		try {
			this.#post.send(
				{ kind: "session", session },
				{
					to,
					kind: letter.kind,
					summary: clip(letter.summary, SUMMARY_MAX),
					body: clip(letter.body, BODY_MAX),
					replyTo: letter.replyTo,
					auto: true,
					schedule: letter.schedule ?? null,
				},
			);
		} catch (error) {
			if (!(error instanceof YewError)) throw error;
			this.#log(`session ${session.id}: no ${letter.kind} to ${to}: ${error.message}`);
		}
	}

	/**
	 * Waits until the recipient of `letter` replies to it or ends its turn, at most `waitMs`. Refuses to
	 * wait when the recipient already waits for this session, directly or through others: neither could
	 * go on.
	 */
	awaitReply(
		sessionId: string,
		letter: Letter,
		signal: AbortSignal,
		callId: string,
	): Promise<WaitResult> {
		const target = letter.toSession;
		for (let at: string | undefined = target, hops = 0; at && hops < 100; hops++) {
			if (at === sessionId) return Promise.resolve({ kind: "cycle" });
			at = this.#waits.get(at)?.target;
		}
		const current = this.#post.mail.getLetter(letter.id);
		if (current.status === "queued" && !this.#isRunning(target)) {
			return Promise.resolve({
				kind: "not-running",
				status: this.#store.getSession(target).status,
			});
		}
		return new Promise<WaitResult>((resolve) => {
			const finish = (result: WaitResult) => {
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
				if (this.#waits.get(sessionId)?.resolve === finish) this.#waits.delete(sessionId);
				resolve(result);
			};
			const onAbort = () => finish({ kind: "stopped" });
			const timer = setTimeout(() => finish({ kind: "timeout" }), this.#waitMs);
			this.#waits.set(sessionId, { target, letterId: letter.id, callId, resolve: finish });
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	/**
	 * Opens a task session for `parent` and sends it the brief as a request. Its permissions are never
	 * above the parent's: same mode and rules, the parent's folder or one inside it.
	 */
	openChild(
		parent: Session,
		input: OpenInput,
		/** The tool call opening it; with `fork`, the conversation is copied up to the step that made it. */
		callRowId?: string,
	): { session: Session; letter: Letter } {
		const brief = input.brief.trim();
		if (!brief) throw invalid("The brief is empty.", "brief");
		if ([...brief].length > BODY_MAX) {
			throw invalid(`The brief can be at most ${BODY_MAX} characters.`, "brief");
		}
		// The brief must be able to go out before there is a session to send it to.
		const blocked = this.#post.blockedNew(parent);
		if (blocked) {
			throw conflict(`Not opened: ${reasonText(blocked)}.`, undefined, "letter-refused");
		}
		this.#post.checkQuotes(parent, input.quotes);
		let cwd = parent.cwd;
		if (input.cwd === null) cwd = null;
		else if (input.cwd !== undefined) {
			if (!parent.cwd) {
				throw invalid("You have no working folder, so the new session cannot have one.", "folder");
			}
			const folder = resolveWorkingFolder(
				isAbsolute(input.cwd) ? input.cwd : join(parent.cwd, input.cwd),
			);
			if (!isInside(folder, parent.cwd)) {
				throw invalid("The folder must be your working folder or inside it.", "folder");
			}
			cwd = folder;
		}
		let provider = parent.provider;
		let model = parent.model;
		if (input.provider && input.model) {
			if (!this.#gateway.model(input.provider, input.model)) {
				throw invalid(`${input.provider} has no model ${input.model}.`, "model");
			}
			provider = input.provider;
			model = input.model;
		}
		const session = this.#store.tx(() => {
			const child = this.#store.createSession({
				name: freeName(this.#store, validateSessionName(input.name)),
				kind: "task",
				groupId: parent.groupId,
				cwd,
				provider,
				model,
				thinking: parent.thinking,
				rules: inheritableRules(parent.rules),
				options: {
					permissionMode: permissionModeOf(parent.options),
					...(cwd !== null && parent.options.extraDirs?.length
						? { extraDirs: parent.options.extraDirs }
						: {}),
					...(parent.options.allowedDomains?.length
						? { allowedDomains: parent.options.allowedDomains }
						: {}),
					...(cwd !== null && parent.options.allowContainers ? { allowContainers: true } : {}),
				},
				parentId: parent.id,
			});
			if (input.fork) this.#fork(parent, child, callRowId);
			return child;
		});
		const letter = this.sent(
			parent.id,
			this.#post.send(
				{ kind: "session", session: parent },
				{
					to: session.id,
					kind: "request",
					summary: clip(plainLine(brief), SUMMARY_MAX),
					body: brief,
					originEntryId: this.originOf(parent.id),
					quotes: input.quotes,
				},
			),
		);
		return { session: this.#store.getSession(session.id), letter };
	}

	/**
	 * Gives a new task session the opener's conversation so far: everything before the step that
	 * opened it, so no half-made step with unanswered calls goes along. A note after it tells the new
	 * session who it is now; the brief follows as its request.
	 */
	#fork(parent: Session, child: Session, callRowId: string | undefined): void {
		const call = callRowId ? this.#store.getToolCall(callRowId) : null;
		const through = call ? this.#store.getEntry(call.messageId).seq - 1 : null;
		if (this.#store.copyHistory(parent.id, child.id, through) === 0) return;
		this.#store.appendEntry(child.id, {
			role: "system",
			message: {
				role: "system",
				content: `You were forked from the session "${parent.name}": the conversation above happened there, up to the moment it opened you. You are "${child.name}" now, a task session of your own. Your task is the request below; your replies go back to "${parent.name}".`,
				timestamp: Date.now(),
			},
		});
	}
}
