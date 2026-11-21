import type { StatementSync } from "node:sqlite";
import type { PersonQuote } from "../../shared/messages.ts";
import type {
	Card,
	CardOption,
	CardStatus,
	Letter,
	LetterFlow,
	LetterKind,
	LetterStatus,
	Page,
	SenderKind,
} from "../../shared/types.ts";
import { json } from "../db/database.ts";
import { notFound } from "../errors.ts";
import { newId } from "../ids.ts";
import type { Store } from "../store.ts";

interface LetterRow {
	id: string;
	thread_id: string;
	reply_to: string | null;
	from_kind: SenderKind;
	from_session: string | null;
	from_name: string;
	to_session: string;
	kind: LetterKind;
	summary: string;
	body: string;
	status: LetterStatus;
	status_reason: string | null;
	path: string;
	auto: number;
	decision: number | null;
	schedule_id: string | null;
	origin_entry_id: string | null;
	quotes: string;
	entry_id: string | null;
	created_at: number;
	delivered_at: number | null;
	updated_at: number;
}

interface CardRow {
	id: string;
	number: number;
	created_by: string | null;
	requested_by: string | null;
	title: string;
	context: string;
	options: string;
	recommended: number | null;
	deadline: string | null;
	sessions: string;
	undoable: number | null;
	reversible: string;
	after: string;
	status: CardStatus;
	choice: number | null;
	note: string | null;
	decided_at: number | null;
	withdrawn_reason: string | null;
	created_at: number;
	updated_at: number;
}

function toLetter(row: LetterRow): Letter {
	return {
		id: row.id,
		threadId: row.thread_id,
		replyTo: row.reply_to,
		fromKind: row.from_kind,
		fromSession: row.from_session,
		fromName: row.from_name,
		toSession: row.to_session,
		kind: row.kind,
		summary: row.summary,
		body: row.body,
		status: row.status,
		statusReason: row.status_reason,
		path: json<string[]>(row.path, []),
		auto: row.auto === 1,
		decision: row.decision,
		scheduleId: row.schedule_id,
		originEntryId: row.origin_entry_id,
		...quotesOf(row.quotes),
		createdAt: row.created_at,
		deliveredAt: row.delivered_at,
	};
}

/** A letter's checked quotes; a letter without any has no `quotes` field. */
function quotesOf(column: string | undefined): { quotes?: PersonQuote[] } {
	const quotes = json<PersonQuote[]>(column ?? "[]", []);
	return quotes.length > 0 ? { quotes } : {};
}

function toCard(row: CardRow): Card {
	return {
		id: row.id,
		number: row.number,
		createdBy: row.created_by,
		requestedBy: row.requested_by,
		title: row.title,
		context: row.context,
		options: json<CardOption[]>(row.options, []),
		recommended: row.recommended,
		deadline: row.deadline,
		sessions: json<string[]>(row.sessions, []),
		undoable: row.undoable === null ? null : row.undoable === 1,
		reversible: row.reversible,
		after: row.after,
		status: row.status,
		choice: row.choice,
		note: row.note,
		decidedAt: row.decided_at,
		withdrawnReason: row.withdrawn_reason,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export interface NewLetter {
	/** The thread to join; a new letter starts its own. */
	threadId?: string | null;
	replyTo?: string | null;
	fromKind: SenderKind;
	fromSession: string | null;
	fromName: string;
	toSession: string;
	kind: LetterKind;
	summary: string;
	body: string;
	status: LetterStatus;
	statusReason?: string | null;
	path?: string[];
	auto?: boolean;
	decision?: number | null;
	scheduleId?: string | null;
	originEntryId?: string | null;
	/** Already checked against Yew's records (PostOffice.checkQuotes). */
	quotes?: PersonQuote[];
}

/** The six points of a decision card (blueprint 6.4), as a session writes them. */
export interface CardFields {
	title: string;
	context: string;
	options: CardOption[];
	recommended: number | null;
	deadline: string | null;
	sessions: string[];
	undoable: boolean;
	reversible: string;
	after: string;
}

/**
 * Letters and decision cards in the database. Every change is announced on the global event stream after
 * its transaction commits, so the approval center and the letters list update in every tab.
 */
export class MailStore {
	readonly #store: Store;
	readonly #statements = new Map<string, StatementSync>();

	constructor(store: Store) {
		this.#store = store;
	}

	get db() {
		return this.#store.db;
	}

	#q(sql: string): StatementSync {
		let statement = this.#statements.get(sql);
		if (!statement) {
			statement = this.#store.db.prepare(sql);
			this.#statements.set(sql, statement);
		}
		return statement;
	}

	// --- letters ---

	addLetter(input: NewLetter): Letter {
		return this.#store.tx(() => {
			const id = newId();
			const now = Date.now();
			this.#q(
				`INSERT INTO letters (id, thread_id, reply_to, from_kind, from_session, from_name, to_session, kind,
					summary, body, status, status_reason, path, auto, decision, schedule_id, origin_entry_id, quotes,
					created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				id,
				input.threadId ?? id,
				input.replyTo ?? null,
				input.fromKind,
				input.fromSession,
				input.fromName,
				input.toSession,
				input.kind,
				input.summary,
				input.body,
				input.status,
				input.statusReason ?? null,
				JSON.stringify(input.path ?? []),
				input.auto ? 1 : 0,
				input.decision ?? null,
				input.scheduleId ?? null,
				input.originEntryId ?? null,
				JSON.stringify(input.quotes ?? []),
				now,
				now,
			);
			return this.#emitLetter(id);
		});
	}

	getLetter(id: string): Letter {
		return toLetter(this.#letterRow(id));
	}

	#letterRow(id: string): LetterRow {
		const row = this.#q("SELECT * FROM letters WHERE id = ?").get(id) as LetterRow | undefined;
		if (!row) throw notFound("Letter", id);
		return row;
	}

	/** The transcript entry a delivered letter became; null when it went to a waiting tool call. */
	letterEntry(id: string): string | null {
		return this.#letterRow(id).entry_id;
	}

	setLetterStatus(
		id: string,
		status: LetterStatus,
		extra: { reason?: string | null; entryId?: string | null; deliveredAt?: number } = {},
	): Letter {
		return this.#store.tx(() => {
			const current = this.#letterRow(id);
			this.#q(
				`UPDATE letters SET status = ?, status_reason = ?, entry_id = ?, delivered_at = ?, updated_at = ?
				WHERE id = ?`,
			).run(
				status,
				extra.reason === undefined ? current.status_reason : extra.reason,
				extra.entryId === undefined ? current.entry_id : extra.entryId,
				extra.deliveredAt ?? current.delivered_at,
				Date.now(),
				id,
			);
			return this.#emitLetter(id);
		});
	}

	/** Letters waiting for a session, oldest first. */
	queuedFor(sessionId: string): Letter[] {
		const rows = this.#q(
			"SELECT * FROM letters WHERE to_session = ? AND status = 'queued' ORDER BY created_at, id",
		).all(sessionId) as unknown as LetterRow[];
		return rows.map(toLetter);
	}

	/** Sessions with letters waiting to be delivered. */
	sessionsWithQueued(): string[] {
		const rows = this.#q(
			"SELECT DISTINCT to_session AS id FROM letters WHERE status = 'queued'",
		).all() as { id: string }[];
		return rows.map((row) => row.id);
	}

	/** Letters held for the person to release or refuse, oldest first. */
	heldLetters(): Letter[] {
		const rows = this.#q(
			"SELECT * FROM letters WHERE status = 'held' ORDER BY created_at, id",
		).all() as unknown as LetterRow[];
		return rows.map(toLetter);
	}

	/**
	 * Requests from other sessions that a session has read and not answered yet. A request stays open
	 * until the session answers it or finishes a turn normally, so a turn that ended with an error, was
	 * stopped, or is waiting for answers of its own still owes the requester a reply. Kept in the
	 * database, so what was owed when Yew stopped is still owed after it starts again.
	 */
	openRequests(sessionId: string): Letter[] {
		const rows = this.#q(
			`SELECT * FROM letters WHERE to_session = ? AND status = 'delivered' AND kind = 'request'
				AND from_kind = 'session' ORDER BY created_at, id`,
		).all(sessionId) as unknown as LetterRow[];
		return rows.map(toLetter);
	}

	/** Letters from scheduled tasks the session has read in the turn that is ending. */
	scheduledRead(sessionId: string): Letter[] {
		const rows = this.#q(
			`SELECT * FROM letters WHERE to_session = ? AND status = 'delivered' AND from_kind = 'yew'
				AND schedule_id IS NOT NULL ORDER BY created_at, id`,
		).all(sessionId) as unknown as LetterRow[];
		return rows.map(toLetter);
	}

	/**
	 * Server-stamped main-conversation entry IDs carried by letters delivered to `sessionId`,
	 * newest first (for authentic human traceability in review mode, blueprint 6.1, item 6).
	 */
	recentOriginEntries(sessionId: string, limit = 5): string[] {
		const rows = this.#q(
			`SELECT origin_entry_id AS id FROM letters
				WHERE to_session = ? AND status IN ('delivered', 'done') AND origin_entry_id IS NOT NULL
				GROUP BY origin_entry_id
				ORDER BY MAX(created_at) DESC
				LIMIT ?`,
		).all(sessionId, limit) as { id: string }[];
		return rows.map((row) => row.id);
	}

	/**
	 * The person's words that letters delivered to `sessionId` carried, newest letter first. Yew found
	 * them when those letters were sent, so the session may pass them on.
	 */
	receivedQuotes(sessionId: string, limit = 200): PersonQuote[] {
		const rows = this.#q(
			`SELECT quotes FROM letters
				WHERE to_session = ? AND status IN ('delivered', 'done') AND quotes != '[]'
				ORDER BY created_at DESC, id DESC
				LIMIT ?`,
		).all(sessionId, limit) as { quotes: string }[];
		return rows.flatMap((row) => json<PersonQuote[]>(row.quotes, []));
	}

	/**
	 * Decided cards directly involving `sessionId` (either requested by it or delivered to it as a
	 * person-authored decision letter), oldest first among the most recent `limit`.
	 */
	decidedCardsForSession(sessionId: string, limit = 5): Card[] {
		const rows = this.#q(
			`SELECT * FROM cards WHERE status = 'decided' AND (
				requested_by = ?
				OR EXISTS (
					SELECT 1 FROM letters
					WHERE to_session = ? AND from_kind = 'person' AND decision = cards.number
						AND status IN ('delivered', 'done')
				)
			) ORDER BY decided_at DESC, number DESC LIMIT ?`,
		).all(sessionId, sessionId, limit) as unknown as CardRow[];
		return rows.reverse().map(toCard);
	}

	/** The request was answered: it is done. */
	closeRequest(id: string): void {
		if (this.#letterRow(id).status === "delivered") this.setLetterStatus(id, "done");
	}

	/** At the end of a turn, what the session read is done, except requests it still owes a reply. */
	finishRead(sessionId: string): void {
		const rows = this.#q(
			`SELECT id FROM letters WHERE to_session = ? AND status = 'delivered'
				AND NOT (kind = 'request' AND from_kind = 'session')`,
		).all(sessionId) as { id: string }[];
		this.#store.tx(() => {
			for (const row of rows) this.setLetterStatus(row.id, "done");
		});
	}

	/** A letter handed to a waiting tool call reached the transcript with that call's result. */
	setLetterEntry(id: string, entryId: string): void {
		this.#q("UPDATE letters SET entry_id = ?, updated_at = ? WHERE id = ?").run(
			entryId,
			Date.now(),
			id,
		);
	}

	/**
	 * After a restart: letters handed to a waiting tool call whose result was never stored are delivered
	 * again as ordinary letters, so the answer is not lost.
	 */
	requeueHandedOff(): number {
		const rows = this.#q(
			"SELECT id FROM letters WHERE status = 'delivered' AND entry_id IS NULL",
		).all() as { id: string }[];
		this.#store.tx(() => {
			for (const row of rows) this.setLetterStatus(row.id, "queued");
		});
		return rows.length;
	}

	/** Letters waiting for a session that was archived: they will not be delivered. */
	dropWaiting(sessionId: string, reason: string): Letter[] {
		const rows = this.#q(
			"SELECT id FROM letters WHERE to_session = ? AND status IN ('queued', 'held')",
		).all(sessionId) as { id: string }[];
		return this.#store.tx(() =>
			rows.map((row) => this.setLetterStatus(row.id, "dropped", { reason })),
		);
	}

	/** Letters from one session to another since a time, refused ones left out. */
	recentBetween(from: string, to: string, since: number): Letter[] {
		const rows = this.#q(
			`SELECT * FROM letters WHERE from_session = ? AND to_session = ? AND created_at >= ?
				AND status != 'refused' ORDER BY created_at, id`,
		).all(from, to, since) as unknown as LetterRow[];
		return rows.map(toLetter);
	}

	/**
	 * For the sessions map: how many letters went from one session to another since a time, the busiest
	 * pair first. Letters that were refused or dropped never arrived and are left out, as are letters to
	 * or from an archived session, which the map does not show.
	 */
	letterFlows(since: number): LetterFlow[] {
		const rows = this.#q(
			`SELECT l.from_session AS sender, l.to_session AS receiver, COUNT(*) AS n, MAX(l.created_at) AS last
				FROM letters l
				JOIN sessions a ON a.id = l.from_session AND a.archived_at IS NULL
				JOIN sessions b ON b.id = l.to_session AND b.archived_at IS NULL
				WHERE l.created_at >= ? AND l.from_session != l.to_session
					AND l.status NOT IN ('refused', 'dropped')
				GROUP BY l.from_session, l.to_session
				ORDER BY n DESC, last DESC, sender, receiver`,
		).all(since) as { sender: string; receiver: string; n: number; last: number }[];
		return rows.map((row) => ({
			from: row.sender,
			to: row.receiver,
			count: row.n,
			lastAt: row.last,
		}));
	}

	/** All letters, newest first; with a session, the ones it sent or received. */
	listLetters(options: {
		sessionId?: string | null;
		cursor?: string | null;
		limit: number;
	}): Page<Letter> {
		const cursor = options.cursor ?? "￿";
		const rows = (options.sessionId
			? this.#q(
					`SELECT * FROM letters WHERE (from_session = ? OR to_session = ?) AND id < ?
						ORDER BY id DESC LIMIT ?`,
				).all(options.sessionId, options.sessionId, cursor, options.limit + 1)
			: this.#q("SELECT * FROM letters WHERE id < ? ORDER BY id DESC LIMIT ?").all(
					cursor,
					options.limit + 1,
				)) as unknown as LetterRow[];
		const more = rows.length > options.limit;
		const items = rows.slice(0, options.limit).map(toLetter);
		return { items, nextCursor: more ? (items.at(-1)?.id ?? null) : null };
	}

	#emitLetter(id: string): Letter {
		const letter = this.getLetter(id);
		this.#store.publish({ type: "letter", letter });
		return letter;
	}

	// --- decision cards ---

	addCard(createdBy: string | null, requestedBy: string | null, fields: CardFields): Card {
		return this.#store.tx(() => {
			const id = newId();
			const now = Date.now();
			const max = this.#q("SELECT MAX(number) AS n FROM cards").get() as { n: number | null };
			this.#q(
				`INSERT INTO cards (id, number, created_by, requested_by, title, context, options, recommended,
					deadline, sessions, undoable, reversible, after, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				id,
				(max.n ?? 0) + 1,
				createdBy,
				requestedBy,
				fields.title,
				fields.context,
				JSON.stringify(fields.options),
				fields.recommended,
				fields.deadline,
				JSON.stringify(fields.sessions),
				fields.undoable ? 1 : 0,
				fields.reversible,
				fields.after,
				now,
				now,
			);
			return this.#emitCard(id);
		});
	}

	getCard(id: string): Card {
		const row = this.#q("SELECT * FROM cards WHERE id = ?").get(id) as CardRow | undefined;
		if (!row) throw notFound("Card", id);
		return toCard(row);
	}

	cardByNumber(number: number): Card {
		const row = this.#q("SELECT * FROM cards WHERE number = ?").get(number) as CardRow | undefined;
		if (!row) throw notFound("Decision", `#${number}`);
		return toCard(row);
	}

	/** Replaces a pending card's six points. */
	updateCardFields(id: string, fields: CardFields): Card {
		return this.#store.tx(() => {
			this.#q(
				`UPDATE cards SET title = ?, context = ?, options = ?, recommended = ?, deadline = ?, sessions = ?,
					undoable = ?, reversible = ?, after = ?, updated_at = ? WHERE id = ?`,
			).run(
				fields.title,
				fields.context,
				JSON.stringify(fields.options),
				fields.recommended,
				fields.deadline,
				JSON.stringify(fields.sessions),
				fields.undoable ? 1 : 0,
				fields.reversible,
				fields.after,
				Date.now(),
				id,
			);
			return this.#emitCard(id);
		});
	}

	decideCard(id: string, choice: number | null, note: string | null): Card {
		return this.#store.tx(() => {
			const now = Date.now();
			this.#q(
				`UPDATE cards SET status = 'decided', choice = ?, note = ?, decided_at = ?, updated_at = ?
				WHERE id = ?`,
			).run(choice, note, now, now, id);
			return this.#emitCard(id);
		});
	}

	withdrawCard(id: string, reason: string): Card {
		return this.#store.tx(() => {
			this.#q(
				"UPDATE cards SET status = 'withdrawn', withdrawn_reason = ?, updated_at = ? WHERE id = ?",
			).run(reason, Date.now(), id);
			return this.#emitCard(id);
		});
	}

	/** Cards waiting for the person, oldest first. */
	pendingCards(): Card[] {
		const rows = this.#q(
			"SELECT * FROM cards WHERE status = 'pending' ORDER BY number",
		).all() as unknown as CardRow[];
		return rows.map(toCard);
	}

	/** Cards by status, newest number first; `cursor` is the last number of the previous page. */
	listCards(options: {
		status?: CardStatus | null;
		cursor?: number | null;
		limit: number;
	}): Page<Card> {
		const cursor = options.cursor ?? Number.MAX_SAFE_INTEGER;
		const rows = (options.status
			? this.#q(
					"SELECT * FROM cards WHERE status = ? AND number < ? ORDER BY number DESC LIMIT ?",
				).all(options.status, cursor, options.limit + 1)
			: this.#q("SELECT * FROM cards WHERE number < ? ORDER BY number DESC LIMIT ?").all(
					cursor,
					options.limit + 1,
				)) as unknown as CardRow[];
		const more = rows.length > options.limit;
		const items = rows.slice(0, options.limit).map(toCard);
		return { items, nextCursor: more ? String(items.at(-1)?.number ?? "") : null };
	}

	#emitCard(id: string): Card {
		const card = this.getCard(id);
		this.#store.publish({ type: "card", card });
		return card;
	}
}
