import { appendFileSync, existsSync } from "node:fs";
import type { PersonQuote } from "../../shared/messages.ts";
import {
	type Approval,
	type Card,
	type CardOption,
	type Letter,
	type LetterKind,
	letterQuotaOf,
	permissionModeOf,
	type Schedule,
	type Session,
} from "../../shared/types.ts";
import { conflict, invalid, YewError } from "../errors.ts";
import { readSettings, type Settings } from "../settings.ts";
import type { Store } from "../store.ts";
import { matchQuotes, quoteSources } from "./quotes.ts";
import { type CardFields, MailStore } from "./store.ts";

export const SUMMARY_MAX = 200;
export const BODY_MAX = 20_000;
const MINUTE = 60_000;
/** Letters one session may send the same session per minute; more should go in one letter. */
const PAIR_RATE = 3;
/**
 * Letters one session may send per minute in all. High enough for the main conversation to write to
 * each session once; the quota bounds the total anyway.
 */
const TOTAL_RATE = 20;
/** The same letter twice within this time is dropped. */
const DUPLICATE_WINDOW = 10 * MINUTE;
/** Letters one session may send another within DUPLICATE_WINDOW. */
const PAIR_LIMIT = 10;
/** Letters in one chain of hand-offs. */
const MAX_HOPS = 8;
/** A session that already sent this many letters in a chain is not written to again in it. */
const MAX_VISITS = 3;
const OPTIONS_MAX = 6;

/**
 * Why a letter was not delivered, as a code: the interface explains it in the person's language, and
 * `reasonText` explains it to the model.
 */
export type LetterReason =
	| "quota"
	| "rate"
	| "burst"
	| "duplicate"
	| "pair-limit"
	| "hops"
	| "loop"
	| "refuse-policy"
	| "hold-policy"
	| "lower-rank"
	| "person-refused"
	| "archived";

export function reasonText(reason: string | null): string {
	switch (reason) {
		case "quota":
			return "you have used up your letters until the person writes to you again";
		case "rate":
			return "you sent this session several letters in the last minute; put what you have to say in one letter";
		case "burst":
			return `you sent ${TOTAL_RATE} letters in the last minute; wait a moment before sending more`;
		case "duplicate":
			return "the same letter was already sent a moment ago";
		case "pair-limit":
			return "you sent this session too many letters in the last ten minutes";
		case "hops":
			return `this chain of hand-offs is already ${MAX_HOPS} letters long; stop and report to whoever started it`;
		case "loop":
			return "this chain keeps coming back to the same session; stop and report instead of sending it on";
		case "refuse-policy":
			return "the session does not accept letters";
		case "hold-policy":
			return "the session holds letters until the person releases them";
		case "lower-rank":
			return "the session has more permissions than you, so the person releases your letters to it first";
		case "person-refused":
			return "the person refused it";
		case "archived":
			return "the session was archived before it read the letter";
		default:
			return reason ?? "";
	}
}

/**
 * Who a letter is from: a session, the command line (`yew send`), the person (a decision), or a
 * scheduled task the person set up, which Yew sends in its name.
 */
export type Sender =
	| { kind: "session"; session: Session }
	| { kind: "cli" }
	| { kind: "person" }
	| { kind: "schedule"; schedule: Schedule };

export interface Outgoing {
	/** Session id; letters are addressed by id only, so renaming a session does not redirect them. */
	to: string;
	kind: LetterKind;
	summary: string;
	body?: string;
	replyTo?: string | null;
	/** Yew sends the session's final reply on its behalf. */
	auto?: boolean;
	/** A decision letter: the number of the decision it carries. */
	decision?: number | null;
	/** The scheduled task whose run the letter starts or reports on. */
	schedule?: string | null;
	/** Server-stamped ID of the person's message in the main conversation that started this chain. */
	originEntryId?: string | null;
	/**
	 * The person's words a session passes on, as it copied them. Yew looks each up and attaches what it
	 * found; a quote it cannot find stops the letter. Only a session's letters carry quotes.
	 */
	quotes?: unknown;
}

export interface PostHooks {
	/** A letter waits for its recipient: hand it to a call that waits for it, or start the session. */
	queued(letter: Letter): void;
}

/** The fields a session writes for a decision card; omitted fields keep their value on update. */
export interface CardInput {
	title?: string;
	context?: string;
	options?: CardOption[];
	recommended?: number | null;
	deadline?: string | null;
	sessions?: string[];
	/** Whether the decision can be undone; required for a new card. */
	undoable?: boolean;
	reversible?: string;
	after?: string;
	/** The session whose request this is; the decision goes back to it. */
	requestedBy?: string | null;
	/** Numbers of pending cards this one replaces; they are withdrawn. */
	replaces?: number[];
}

/**
 * Permission level for holding letters from sessions with fewer permissions: a chat, then the
 * default, automatic and skip modes.
 */
function rank(session: Session): number {
	if (!session.cwd) return 0;
	return { default: 1, review: 2, skip: 3 }[permissionModeOf(session.options)];
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Whether a letter from `from` answers a request `to` sent it and is still waiting on: it replies to that
 * request and is not a request itself (a question back is not the answer). Only the first answer counts,
 * because it closes the request.
 */
function answersOpenRequest(
	from: Session,
	to: Session,
	repliedTo: Letter | null,
	kind: LetterKind,
): boolean {
	return (
		repliedTo !== null &&
		kind !== "request" &&
		repliedTo.kind === "request" &&
		repliedTo.fromSession === to.id &&
		repliedTo.toSession === from.id &&
		repliedTo.status === "delivered"
	);
}

function limited(value: unknown, field: string, max: number, required: boolean): string {
	if (value === undefined || value === null) {
		if (required) throw invalid(`${field} is required.`, field);
		return "";
	}
	if (typeof value !== "string") throw invalid(`${field} must be text.`, field);
	const text = value.trim();
	if (required && !text) throw invalid(`${field} cannot be empty.`, field);
	if ([...text].length > max) throw invalid(`${field} can be at most ${max} characters.`, field);
	return text;
}

/**
 * Letters between sessions and decision cards for the person. Every check a letter passes lives
 * here: the address, the recipient's policy, the quota, rate limits, duplicates and the length
 * of a chain of hand-offs. The agent runner delivers what is queued.
 */
export class PostOffice {
	readonly mail: MailStore;
	readonly #store: Store;
	readonly #log: (line: string) => void;
	#hooks: PostHooks = { queued: () => {} };
	/** Each session's letters in the last minute, and to whom, for the per-minute limits. */
	readonly #sent = new Map<string, { to: string; time: number }[]>();
	/** The chain each working session is in: senders so far, oldest first. */
	readonly #chains = new Map<string, string[]>();

	constructor(store: Store, log: (line: string) => void = () => {}) {
		this.#store = store;
		this.mail = new MailStore(store);
		this.#log = log;
	}

	setHooks(hooks: PostHooks): void {
		this.#hooks = hooks;
	}

	/** The main conversation, if one is set and still there. */
	/** Yew's settings, for what list_sessions shows. */
	settings(): Settings {
		return readSettings(this.#store);
	}

	mainSessionId(): string | null {
		const id = this.#store.getSetting<string | null>("mainSessionId", null);
		if (!id) return null;
		try {
			return this.#store.getSession(id).archivedAt === null ? id : null;
		} catch {
			return null;
		}
	}

	/** Sessions that may put cards in the approval center: the main conversation and those allowed to. */
	canPostCards(session: Session): boolean {
		return session.id === this.mainSessionId() || session.options.canPostCards === true;
	}

	/** Sessions that may rename sessions and teams and move sessions between teams. */
	canOrganize(session: Session): boolean {
		return session.id === this.mainSessionId() || session.options.canOrganize === true;
	}

	letterQuota(session: Session): number {
		return letterQuotaOf(session.options, session.id === this.mainSessionId());
	}

	/** Sessions that can receive letters, with their groups' names (list_sessions). */
	directory(): { sessions: Session[]; groups: Map<string, string> } {
		return {
			sessions: this.#store.activeSessions(),
			groups: new Map(this.#store.listGroups().map((group) => [group.id, group.name])),
		};
	}

	sessionName(id: string): string | null {
		return this.#nameOf(id);
	}

	// --- chains of hand-offs ---

	/** Letters reached the session; letters it now sends continue the longest chain among them. */
	enterChain(sessionId: string, letters: Letter[]): void {
		let longest = this.#chains.get(sessionId) ?? [];
		for (const letter of letters) if (letter.path.length > longest.length) longest = letter.path;
		this.#chains.set(sessionId, longest);
	}

	/** The person wrote or decided, or the turn ended: what the session sends next starts a new chain. */
	resetChain(sessionId: string): void {
		this.#chains.delete(sessionId);
	}

	// --- letters ---

	/**
	 * The person's words `session` wants to pass on, as Yew found them in its records; throws for one it
	 * cannot find.
	 */
	checkQuotes(session: Session, quotes: unknown): PersonQuote[] {
		return matchQuotes(quotes, () => quoteSources(this.#store, this.mail, session));
	}

	send(sender: Sender, out: Outgoing): Letter {
		const summary = oneLine(limited(out.summary, "summary", SUMMARY_MAX * 4, true));
		if ([...summary].length > SUMMARY_MAX) {
			throw invalid(`The summary can be at most ${SUMMARY_MAX} characters.`, "summary");
		}
		const body = limited(out.body, "body", BODY_MAX, false);
		const to = this.#find(out.to);
		if (!to) throw invalid(`There is no session "${out.to}".`, "to");
		const from = sender.kind === "session" ? sender.session.id : null;
		if (from === to.id) throw invalid("A session cannot send a letter to itself.", "to");
		if (to.archivedAt !== null) {
			throw conflict(
				`${to.name} is archived and cannot receive letters.`,
				undefined,
				"session-archived",
			);
		}
		if (out.kind === "decision") this.#checkRelay(sender, out.decision);
		const quotes = sender.kind === "session" ? this.checkQuotes(sender.session, out.quotes) : [];
		let threadId: string | null = null;
		let repliedTo: Letter | null = null;
		// A report to a session whose request is open with the sender answers it: Yew links them, so the
		// session need not carry letter ids.
		const answering =
			!out.replyTo && out.kind === "report" && from !== null
				? this.mail
						.openRequests(from)
						.filter((request) => request.fromSession === to.id)
						.at(-1)
				: undefined;
		if (answering) {
			repliedTo = answering;
			threadId = answering.threadId;
		}
		if (out.replyTo) {
			try {
				repliedTo = this.mail.getLetter(out.replyTo);
			} catch {
				throw invalid(`There is no letter ${out.replyTo}.`, "replyTo");
			}
			if (from !== null && repliedTo.toSession !== from && repliedTo.fromSession !== from) {
				throw invalid("You can only reply to a letter you sent or received.", "replyTo");
			}
			threadId = repliedTo.threadId;
		}
		const path = from ? [...(this.#chains.get(from) ?? []), from] : [];
		const base = {
			threadId,
			replyTo: repliedTo?.id ?? null,
			fromKind: sender.kind === "schedule" ? ("yew" as const) : sender.kind,
			fromSession: from,
			fromName:
				sender.kind === "session"
					? sender.session.name
					: sender.kind === "schedule"
						? sender.schedule.name
						: sender.kind === "cli"
							? "yew send"
							: "person",
			toSession: to.id,
			kind: out.kind,
			summary,
			body,
			path,
			auto: out.auto ?? false,
			decision: out.decision ?? null,
			scheduleId: sender.kind === "schedule" ? sender.schedule.id : (out.schedule ?? null),
			originEntryId: out.originEntryId ?? null,
			quotes,
		};

		// Yew's automatic letters answer one request each, so they skip the limits (and cannot loop).
		if (sender.kind === "session" && !out.auto) {
			const current = this.#store.getSession(sender.session.id);
			const stop = this.#limits(current, to, path, summary, body, repliedTo?.id ?? null);
			if (stop) {
				return this.mail.addLetter({ ...base, status: stop.status, statusReason: stop.reason });
			}
		}
		// The first answer to a request the recipient is still waiting on closes that request.
		const answers =
			sender.kind === "session" &&
			!out.auto &&
			answersOpenRequest(sender.session, to, repliedTo, out.kind);
		const policy = this.#policy(sender, to, out.auto ?? false, answers);
		const letter = this.#store.tx(() => {
			const letter = this.mail.addLetter({
				...base,
				status: policy.status,
				statusReason: policy.reason ?? null,
			});
			if (sender.kind === "session" && !out.auto && policy.status !== "refused") {
				this.#store.countLetterSent(sender.session.id);
			}
			if (answers && repliedTo) this.mail.closeRequest(repliedTo.id);
			return letter;
		});
		if (sender.kind === "session" && !out.auto && policy.status !== "refused") {
			this.#recordSend(sender.session.id, to.id);
		}
		if (letter.status === "queued") this.#hooks.queued(letter);
		return this.mail.getLetter(letter.id);
	}

	/** The person lets a held letter through. */
	release(letterId: string): Letter {
		const letter = this.mail.getLetter(letterId);
		if (letter.status !== "held") {
			throw conflict("This letter is not waiting for you.", undefined, "already-answered");
		}
		const to = this.#store.getSession(letter.toSession);
		if (to.archivedAt !== null) {
			throw conflict(
				`${to.name} is archived and cannot receive letters. Restore it first.`,
				undefined,
				"session-archived",
			);
		}
		const released = this.mail.setLetterStatus(letterId, "queued", { reason: null });
		this.#hooks.queued(released);
		return this.mail.getLetter(letterId);
	}

	/** The person turns a held letter away. */
	refuse(letterId: string): Letter {
		const letter = this.mail.getLetter(letterId);
		if (letter.status !== "held") {
			throw conflict("This letter is not waiting for you.", undefined, "already-answered");
		}
		return this.mail.setLetterStatus(letterId, "refused", { reason: "person-refused" });
	}

	/** Only a decision the person made can be relayed as a decision letter. */
	#checkRelay(sender: Sender, number: number | null | undefined): void {
		if (sender.kind === "person") return;
		if (typeof number !== "number") {
			throw invalid("A decision letter must name the decision's number.", "decision");
		}
		let card: Card;
		try {
			card = this.mail.cardByNumber(number);
		} catch {
			throw invalid(`There is no decision #${number}.`, "decision");
		}
		if (card.status !== "decided") {
			throw invalid(`#${number} has not been decided by the person.`, "decision");
		}
	}

	/**
	 * Why a letter from `from` to a session that does not exist yet would not go out, or null.
	 * open_session asks before it opens one, so a refused brief leaves no session behind.
	 */
	blockedNew(from: Session): LetterReason | null {
		const current = this.#store.getSession(from.id);
		if (current.lettersSent >= this.letterQuota(current)) return "quota";
		if (this.#recent(from.id).length >= TOTAL_RATE) return "burst";
		if ((this.#chains.get(from.id) ?? []).length + 1 > MAX_HOPS) return "hops";
		return null;
	}

	/** The anti-runaway rules, in the order a person would want to hear them. */
	#limits(
		from: Session,
		to: Session,
		path: string[],
		summary: string,
		body: string,
		replyTo: string | null,
	): { status: "refused" | "dropped"; reason: LetterReason } | null {
		if (from.lettersSent >= this.letterQuota(from)) return { status: "refused", reason: "quota" };
		const between = this.mail.recentBetween(from.id, to.id, Date.now() - DUPLICATE_WINDOW);
		// The same words answering a different letter are not a duplicate.
		const same = (letter: Letter) =>
			letter.summary === summary && letter.body === body && letter.replyTo === replyTo;
		if (between.some(same)) return { status: "dropped", reason: "duplicate" };
		const recent = this.#recent(from.id);
		if (recent.filter((sent) => sent.to === to.id).length >= PAIR_RATE) {
			return { status: "refused", reason: "rate" };
		}
		if (recent.length >= TOTAL_RATE) return { status: "refused", reason: "burst" };
		if (path.length > MAX_HOPS) return { status: "refused", reason: "hops" };
		if (path.filter((id) => id === to.id).length >= MAX_VISITS) {
			return { status: "refused", reason: "loop" };
		}
		if (between.length >= PAIR_LIMIT) return { status: "dropped", reason: "pair-limit" };
		return null;
	}

	/** The session's letters in the last minute, and to whom. */
	#recent(sessionId: string): { to: string; time: number }[] {
		const since = Date.now() - MINUTE;
		return (this.#sent.get(sessionId) ?? []).filter((sent) => sent.time > since);
	}

	#recordSend(sessionId: string, to: string): void {
		const recent = this.#recent(sessionId);
		recent.push({ to, time: Date.now() });
		this.#sent.set(sessionId, recent);
	}

	/**
	 * The recipient's receive policy, and the hold for letters from sessions with fewer permissions. Both
	 * are for letters the recipient did not ask for: Yew's automatic letters and the first answer to a
	 * request it is still waiting on go straight through.
	 */
	#policy(
		sender: Sender,
		to: Session,
		auto: boolean,
		answers: boolean,
	): { status: "queued" | "held" | "refused"; reason?: LetterReason } {
		// The person's decisions and the tasks they scheduled are theirs: no policy holds them back.
		if (sender.kind === "person" || sender.kind === "schedule") return { status: "queued" };
		if (sender.kind === "session" && (auto || answers)) return { status: "queued" };
		const policy = to.options.receive ?? "accept";
		if (policy === "refuse") return { status: "refused", reason: "refuse-policy" };
		if (policy === "hold") return { status: "held", reason: "hold-policy" };
		if (sender.kind !== "session") return { status: "queued" };
		const from = sender.session;
		const exempt =
			from.id === this.mainSessionId() || from.parentId === to.id || to.parentId === from.id;
		if (!exempt && rank(from) < rank(to)) return { status: "held", reason: "lower-rank" };
		return { status: "queued" };
	}

	// --- the approval center ---

	/** Everything waiting for the person: approvals and questions, decision cards and held letters. */
	center(): { approvals: Approval[]; cards: Card[]; held: Letter[] } {
		return {
			approvals: this.#store.allPendingApprovals(),
			cards: this.mail.pendingCards(),
			held: this.mail.heldLetters(),
		};
	}

	postCard(session: Session, input: CardInput): Card {
		this.#requireMaintainer(session);
		const fields = this.#cardFields(input, null);
		const requestedBy = input.requestedBy
			? this.#sessionId(input.requestedBy)
			: (this.#asker(session) ?? session.id);
		return this.#store.tx(() => {
			const card = this.mail.addCard(session.id, requestedBy, fields);
			for (const number of input.replaces ?? []) {
				const old = this.#card(number);
				if (old.status === "pending")
					this.mail.withdrawCard(old.id, `Merged into #${card.number}.`);
			}
			return this.mail.getCard(card.id);
		});
	}

	updateCard(session: Session, number: number, input: CardInput): Card {
		this.#requireMaintainer(session);
		const card = this.#pending(number);
		return this.mail.updateCardFields(card.id, this.#cardFields(input, card));
	}

	withdrawCard(session: Session, number: number, reason: string): Card {
		this.#requireMaintainer(session);
		const card = this.#pending(number);
		return this.mail.withdrawCard(card.id, limited(reason, "reason", 500, true));
	}

	/**
	 * The person decides. The decision is recorded as theirs, goes to the session whose request it was and
	 * to the session that put up the card, and is added to the decision log file if one is set.
	 */
	decide(cardId: string, choice: number | null, note: string | null): Card {
		const card = this.mail.getCard(cardId);
		if (card.status !== "pending") {
			throw conflict("This card was already decided or withdrawn.", undefined, "already-answered");
		}
		if (
			choice !== null &&
			(!Number.isInteger(choice) || choice < 0 || choice >= card.options.length)
		) {
			throw invalid("Choose one of the card's options.", "choice");
		}
		const text = note?.trim() ? limited(note, "note", 4000, false) : null;
		if (choice === null && !text) throw invalid("Choose an option or write a note.", "note");
		const decided = this.mail.decideCard(card.id, choice, text);
		const chosen = choice === null ? null : (card.options[choice]?.label ?? null);
		const body = [
			`The person decided #${card.number}: ${card.title}`,
			chosen ? `Chosen: ${chosen}` : "No option chosen; see the note.",
			text ? `Note: ${text}` : null,
		]
			.filter(Boolean)
			.join("\n");
		const recipients = [...new Set([card.requestedBy, card.createdBy])].filter(
			(id): id is string => id !== null,
		);
		for (const id of recipients) {
			try {
				const session = this.#store.getSession(id);
				if (session.archivedAt !== null) continue;
				this.#store.resetLettersSent(id);
				this.resetChain(id);
				this.send(
					{ kind: "person" },
					{
						to: id,
						kind: "decision",
						summary: `#${card.number} ${oneLine(card.title)}`.slice(0, SUMMARY_MAX),
						body,
						decision: card.number,
					},
				);
			} catch (error) {
				if (!(error instanceof YewError)) throw error;
				this.#log(`decision #${card.number}: could not reach ${id}: ${error.message}`);
			}
		}
		this.#appendLog(decided);
		return decided;
	}

	#appendLog(card: Card): void {
		const path = this.#store.getSetting<string | null>("decisionLog", null);
		if (!path) return;
		const english = this.#store.getSetting<string>("language", "system") === "en";
		const requester = card.requestedBy ? this.#nameOf(card.requestedBy) : null;
		const chosen = card.choice === null ? null : (card.options[card.choice]?.label ?? null);
		const time = new Date(card.decidedAt ?? Date.now());
		const pad = (n: number) => String(n).padStart(2, "0");
		const stamp = `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`;
		const parts = english
			? [
					stamp,
					`#${card.number}`,
					oneLine(card.title),
					`Chosen: ${chosen ?? "(note only)"}`,
					...(card.note ? [`Note: ${oneLine(card.note)}`] : []),
					...(requester ? [`Requested by: ${requester}`] : []),
					"Decided by the person in Yew Harness",
				]
			: [
					stamp,
					`#${card.number}`,
					oneLine(card.title),
					`选择：${chosen ?? "（只写了备注）"}`,
					...(card.note ? [`备注：${oneLine(card.note)}`] : []),
					...(requester ? [`提出：${requester}`] : []),
					"本人在 Yew Harness 里决定",
				];
		try {
			const header = existsSync(path) ? "" : english ? "# Approval log\n\n" : "# 审批记录\n\n";
			appendFileSync(path, `${header}- ${parts.join(" · ")}\n`, { mode: 0o600 });
		} catch (error) {
			this.#log(`decision log ${path}: ${(error as Error).message}`);
		}
	}

	#nameOf(sessionId: string): string | null {
		try {
			return this.#store.getSession(sessionId).name;
		} catch {
			return null;
		}
	}

	#requireMaintainer(session: Session): void {
		if (!this.canPostCards(session)) {
			throw conflict(
				"Only the main conversation, or a session the person allowed, can put cards in the approval center.",
				undefined,
				"not-allowed",
			);
		}
	}

	#card(number: number): Card {
		try {
			return this.mail.cardByNumber(number);
		} catch {
			throw invalid(`There is no card #${number}.`, "number");
		}
	}

	#pending(number: number): Card {
		const card = this.#card(number);
		if (card.status !== "pending") {
			throw conflict(`#${number} was already decided or withdrawn.`, undefined, "already-answered");
		}
		return card;
	}

	#sessionId(id: unknown): string {
		if (typeof id !== "string") throw invalid("A session must be named by name or id.", "sessions");
		const found = this.#find(id);
		if (!found) throw invalid(`There is no session "${id}".`, "sessions");
		return found.id;
	}

	/** A session by id or by its name (names are unique). */
	#find(ref: string): Session | undefined {
		try {
			return this.#store.getSession(ref);
		} catch {
			return this.#store.findSessionByName(ref);
		}
	}

	/**
	 * The session whose open request a card most likely answers: the only other session with a request
	 * open with the poster. With none or several, the card is the poster's own question.
	 */
	#asker(session: Session): string | null {
		const askers = new Set(
			this.mail
				.openRequests(session.id)
				.map((request) => request.fromSession)
				.filter((id): id is string => id !== null && id !== session.id),
		);
		return askers.size === 1 ? ([...askers][0] as string) : null;
	}

	/** Checks a card's six points; on update, missing fields keep the card's current values. */
	#cardFields(input: CardInput, current: Card | null): CardFields {
		const options =
			input.options === undefined
				? (current?.options ?? [])
				: (() => {
						if (!Array.isArray(input.options) || input.options.length > OPTIONS_MAX) {
							throw invalid(`Give at most ${OPTIONS_MAX} options.`, "options");
						}
						return input.options.map((option, index) => {
							const label = limited(option?.label, `options[${index}].label`, 200, true);
							const detail = limited(option?.detail, `options[${index}].detail`, 1000, false);
							return detail ? { label, detail } : { label };
						});
					})();
		const recommended =
			input.recommended === undefined ? (current?.recommended ?? null) : input.recommended;
		if (
			recommended !== null &&
			(!Number.isInteger(recommended) || recommended < 0 || recommended >= options.length)
		) {
			throw invalid("recommended must be the index of one of the options.", "recommended");
		}
		const sessions =
			input.sessions === undefined
				? (current?.sessions ?? [])
				: [...new Set(input.sessions.map((id) => this.#sessionId(id)))];
		const deadline =
			input.deadline === undefined
				? (current?.deadline ?? null)
				: limited(input.deadline, "deadline", 100, false) || null;
		if (input.undoable !== undefined && typeof input.undoable !== "boolean") {
			throw invalid("undoable must be true or false.", "undoable");
		}
		const undoable = input.undoable ?? current?.undoable ?? null;
		if (undoable === null) {
			throw invalid("Say whether the decision can be undone (undoable).", "undoable");
		}
		return {
			title:
				input.title === undefined && current
					? current.title
					: limited(input.title, "title", 300, true),
			context:
				input.context === undefined
					? (current?.context ?? "")
					: limited(input.context, "context", 10_000, false),
			options,
			recommended,
			deadline,
			sessions,
			undoable,
			reversible:
				input.reversible === undefined
					? (current?.reversible ?? "")
					: limited(input.reversible, "reversible", 500, false),
			after:
				input.after === undefined
					? (current?.after ?? "")
					: limited(input.after, "after", 2000, false),
		};
	}
}
