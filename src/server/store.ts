import type { StatementSync } from "node:sqlite";
import type { AttachmentRef, EntryBody, JsonObject } from "../shared/messages.ts";
import { messageText } from "../shared/messages.ts";
import type {
	Approval,
	ApprovalDecision,
	Device,
	Entry,
	Group,
	Page,
	PermissionRequest,
	PermissionRule,
	QuestionRequest,
	QueuedMessage,
	Session,
	SessionEvent,
	SessionKind,
	SessionOptions,
	SessionStatus,
	SessionUsage,
	TaskOutcome,
	ThinkingLevel,
	Todo,
	ToolCallStatus,
	ToolCallView,
	UsageDay,
	UsageTotals,
} from "../shared/types.ts";
import { localDay } from "./budget.ts";
import { type Db, json, transaction } from "./db/database.ts";
import { conflict, invalid, notFound } from "./errors.ts";
import type { BusEvent, EventBus } from "./events.ts";
import { newId } from "./ids.ts";
import type { CustomProviderConfig } from "./model/gateway.ts";
import { inheritableRules } from "./permissions/engine.ts";
import {
	type ApprovalRow,
	type DeviceRow,
	type EntryRow,
	type GroupRow,
	type QueueRow,
	type SessionRow,
	type ToolCallRow,
	toApproval,
	toDevice,
	toEntry,
	toGroup,
	toQueued,
	toSession,
	toToolCall,
	type UsageRow,
	usageTotals,
} from "./store-rows.ts";

export interface NewSession {
	name: string;
	kind: SessionKind;
	groupId?: string | null;
	responsibility?: string;
	cwd?: string | null;
	provider: string;
	model: string;
	thinking?: ThinkingLevel;
	rules?: PermissionRule[];
	options?: SessionOptions;
	/** The session that opens this one (a task it hands out). */
	parentId?: string | null;
}

export interface SessionPatch {
	name?: string;
	groupId?: string | null;
	/** A folder makes it a code session; null makes it a chat. */
	cwd?: string | null;
	responsibility?: string;
	provider?: string;
	model?: string;
	thinking?: ThinkingLevel;
	rules?: PermissionRule[];
	options?: SessionOptions;
	pinned?: boolean;
	archived?: boolean;
	/** Clears the unread count. */
	read?: boolean;
}

export interface SearchHit {
	sessionId: string;
	entryId: string;
	seq: number;
	/** Matched text with the match wrapped in U+0002 … U+0003, so the interface can highlight it without HTML. */
	snippet: string;
}

export const MATCH_START = "\u0002";
export const MATCH_END = "\u0003";

const MODEL_ROLES = "('system', 'user', 'assistant', 'toolResult')";
const NAME_MAX = 60;

/** Text indexed for search: what people and the model wrote, not thinking or tool output. */
function searchableText(body: EntryBody): string {
	if (body.role === "user") {
		const names = (body.attachments ?? []).map((item) => item.name).join("\n");
		return [messageText(body.message), names].filter(Boolean).join("\n");
	}
	if (body.role === "assistant") {
		return body.message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
	}
	return "";
}

export function validateSessionName(name: unknown): string {
	if (typeof name !== "string") throw invalid("The name must be text.", "name");
	const trimmed = name.trim();
	if (trimmed.length === 0) throw invalid("The name cannot be empty.", "name");
	if ([...trimmed].length > NAME_MAX) {
		throw invalid(`The name can be at most ${NAME_MAX} characters.`, "name");
	}
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
	if (/[\u0000-\u001f\u007f@]/.test(trimmed)) {
		throw invalid("The name cannot contain @ or control characters.", "name");
	}
	return trimmed;
}

/**
 * All reads and writes of Yew's data. Every change to a session's transcript appends a durable event
 * with the session's next sequence number; events are published on the bus only after the transaction
 * that wrote them commits.
 */
/** What a taken-back entry keeps: its role and time, without content. */
const TAKEN_BACK = "json_object('role', role, 'content', json('[]'), 'timestamp', created_at)";

export interface AttachmentHooks {
	onCopied?(
		fromSessionId: string,
		toSessionId: string,
		entryIds: ReadonlyMap<string, string>,
	): void;
	onRewound?(sessionId: string, entryIds: string[]): void;
	onQueuedRemoved?(sessionId: string, attachmentIds: string[]): void;
}

export class Store {
	readonly db: Db;
	readonly #bus: EventBus;
	readonly #statements = new Map<string, StatementSync>();
	#pending: BusEvent[] | null = null;
	#attachmentHooks: AttachmentHooks = {};

	constructor(db: Db, bus: EventBus) {
		this.db = db;
		this.#bus = bus;
	}

	setAttachmentHooks(hooks: AttachmentHooks): void {
		this.#attachmentHooks = hooks;
	}

	#q(sql: string): StatementSync {
		let statement = this.#statements.get(sql);
		if (!statement) {
			statement = this.db.prepare(sql);
			this.#statements.set(sql, statement);
		}
		return statement;
	}

	/** One write transaction; bus events raised inside it go out after it commits. */
	tx<T>(fn: () => T): T {
		if (this.#pending) return fn();
		this.#pending = [];
		let events: BusEvent[] = [];
		try {
			const result = transaction(this.db, fn);
			events = this.#pending;
			return result;
		} finally {
			this.#pending = null;
			for (const event of events) this.#bus.publish(event);
		}
	}

	#publish(event: BusEvent): void {
		if (this.#pending) this.#pending.push(event);
		else this.#bus.publish(event);
	}

	/** Publishes a global event; inside a transaction it waits for the commit. */
	publish(event: Extract<BusEvent, { scope: "global" }>["event"]): void {
		this.#publish({ scope: "global", event });
	}

	/** Publishes an ephemeral event right away (drafts, live tool output). */
	live(sessionId: string, event: Extract<BusEvent, { scope: "live" }>["event"]): void {
		this.#bus.publish({ scope: "live", sessionId, event });
	}

	// --- events ---

	appendEvent(sessionId: string, event: SessionEvent): number {
		return this.tx(() => {
			const row = this.#q(
				"UPDATE sessions SET event_seq = event_seq + 1 WHERE id = ? RETURNING event_seq",
			).get(sessionId) as { event_seq: number } | undefined;
			if (!row) throw notFound("Session", sessionId);
			this.#q(
				"INSERT INTO session_events (session_id, seq, type, data, created_at) VALUES (?, ?, ?, ?, ?)",
			).run(sessionId, row.event_seq, event.type, JSON.stringify(event), Date.now());
			this.#publish({ scope: "session", sessionId, seq: row.event_seq, event });
			return row.event_seq;
		});
	}

	/** Events after `seq`, oldest first. `complete` is false when older events were pruned. */
	eventsAfter(
		sessionId: string,
		seq: number,
		limit = 1000,
	): { events: { seq: number; event: SessionEvent }[]; complete: boolean } {
		const oldest = this.#q("SELECT MIN(seq) AS seq FROM session_events WHERE session_id = ?").get(
			sessionId,
		) as { seq: number | null };
		const rows = this.#q(
			"SELECT seq, data FROM session_events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?",
		).all(sessionId, seq, limit) as { seq: number; data: string }[];
		const complete = oldest.seq === null || oldest.seq <= seq + 1;
		return {
			events: rows.map((row) => ({ seq: row.seq, event: JSON.parse(row.data) as SessionEvent })),
			complete,
		};
	}

	pruneEvents(olderThan: number): void {
		this.#q("DELETE FROM session_events WHERE created_at < ?").run(olderThan);
	}

	// --- devices ---

	listDevices(): Device[] {
		const rows = this.#q(
			"SELECT * FROM devices ORDER BY created_at, id",
		).all() as unknown as DeviceRow[];
		return rows.map(toDevice);
	}

	deviceByKey(publicKey: string): Device | null {
		const row = this.#q("SELECT * FROM devices WHERE public_key = ?").get(publicKey) as
			| DeviceRow
			| undefined;
		return row ? toDevice(row) : null;
	}

	addDevice(name: string, publicKey: string): Device {
		return this.tx(() => {
			const id = newId();
			const now = Date.now();
			this.#q(
				"INSERT INTO devices (id, name, public_key, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
			).run(id, name, publicKey, now, now);
			this.#devicesChanged();
			return this.#device(id);
		});
	}

	updateDevice(
		id: string,
		patch: { name?: string; push?: boolean; pushToken?: string | null },
	): Device {
		return this.tx(() => {
			const current = this.#device(id);
			this.#q("UPDATE devices SET name = ?, push = ? WHERE id = ?").run(
				patch.name ?? current.name,
				(patch.push ?? current.push) ? 1 : 0,
				id,
			);
			if (patch.pushToken !== undefined) {
				this.#q("UPDATE devices SET push_token = ? WHERE id = ?").run(patch.pushToken, id);
			}
			this.#devicesChanged();
			return this.#device(id);
		});
	}

	/** A paired phone connected; noted at most once a minute. */
	touchDevice(id: string): void {
		const now = Date.now();
		this.#q(
			"UPDATE devices SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)",
		).run(now, id, now - 60_000);
	}

	deleteDevice(id: string): void {
		this.tx(() => {
			this.#device(id);
			this.#q("DELETE FROM devices WHERE id = ?").run(id);
			this.#devicesChanged();
		});
	}

	/** Paired phones that take notifications and have given a token. */
	pushTargets(): { id: string; publicKey: string; token: string }[] {
		const rows = this.#q(
			"SELECT id, public_key, push_token FROM devices WHERE push = 1 AND push_token IS NOT NULL",
		).all() as { id: string; public_key: string; push_token: string }[];
		return rows.map((row) => ({ id: row.id, publicKey: row.public_key, token: row.push_token }));
	}

	/** Forgets a token Apple no longer knows. */
	dropPushToken(token: string): void {
		this.tx(() => {
			const changed = this.#q("UPDATE devices SET push_token = NULL WHERE push_token = ?").run(
				token,
			);
			if (changed.changes > 0) this.#devicesChanged();
		});
	}

	#device(id: string): Device {
		const row = this.#q("SELECT * FROM devices WHERE id = ?").get(id) as DeviceRow | undefined;
		if (!row) throw notFound("Device", id);
		return toDevice(row);
	}

	#devicesChanged(): void {
		this.publish({ type: "devices", devices: this.listDevices() });
	}

	// --- groups ---

	listGroups(): Group[] {
		const rows = this.#q(
			"SELECT * FROM groups ORDER BY position, id",
		).all() as unknown as GroupRow[];
		return rows.map(toGroup);
	}

	getGroup(id: string): Group {
		const row = this.#q("SELECT * FROM groups WHERE id = ?").get(id) as GroupRow | undefined;
		if (!row) throw notFound("Group", id);
		return toGroup(row);
	}

	createGroup(name: string): Group {
		const clean = this.#groupName(name);
		return this.tx(() => {
			const now = Date.now();
			const max = this.#q("SELECT MAX(position) AS p FROM groups").get() as { p: number | null };
			const id = newId();
			this.#q(
				"INSERT INTO groups (id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
			).run(id, clean, (max.p ?? 0) + 1, now, now);
			this.#publishGroups();
			return this.getGroup(id);
		});
	}

	updateGroup(id: string, patch: { name?: string; position?: number }): Group {
		return this.tx(() => {
			const group = this.getGroup(id);
			const name = patch.name === undefined ? group.name : this.#groupName(patch.name);
			const position = patch.position ?? group.position;
			if (!Number.isFinite(position)) throw invalid("The position must be a number.", "position");
			this.#q("UPDATE groups SET name = ?, position = ?, updated_at = ? WHERE id = ?").run(
				name,
				position,
				Date.now(),
				id,
			);
			this.#publishGroups();
			return this.getGroup(id);
		});
	}

	/** Deletes a group; its sessions stay and move to "no group". */
	deleteGroup(id: string): void {
		this.tx(() => {
			this.getGroup(id);
			const members = this.#q("SELECT id FROM sessions WHERE group_id = ?").all(id) as {
				id: string;
			}[];
			this.#q("UPDATE sessions SET group_id = NULL, updated_at = ? WHERE group_id = ?").run(
				Date.now(),
				id,
			);
			this.#q("DELETE FROM groups WHERE id = ?").run(id);
			for (const member of members) this.#emitSession(member.id);
			this.#publishGroups();
		});
	}

	#groupName(name: unknown): string {
		if (typeof name !== "string" || name.trim().length === 0) {
			throw invalid("The group name cannot be empty.", "name");
		}
		const trimmed = name.trim();
		if ([...trimmed].length > NAME_MAX) {
			throw invalid(`The group name can be at most ${NAME_MAX} characters.`, "name");
		}
		return trimmed;
	}

	#publishGroups(): void {
		this.#publish({ scope: "global", event: { type: "groups", groups: this.listGroups() } });
	}

	// --- sessions ---

	getSession(id: string): Session {
		const row = this.#q("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
		if (!row) throw notFound("Session", id);
		return toSession(row);
	}

	findSessionByName(name: string): Session | undefined {
		const row = this.#q("SELECT * FROM sessions WHERE name = ? COLLATE NOCASE").get(name) as
			| SessionRow
			| undefined;
		return row ? toSession(row) : undefined;
	}

	listSessions(options: {
		archived?: boolean;
		cursor?: string | null;
		limit: number;
	}): Page<Session> {
		const archived = options.archived ? "archived_at IS NOT NULL" : "archived_at IS NULL";
		const rows = this.#q(
			`SELECT * FROM sessions WHERE ${archived} AND id > ? ORDER BY id LIMIT ?`,
		).all(options.cursor ?? "", options.limit + 1) as unknown as SessionRow[];
		const more = rows.length > options.limit;
		const items = rows.slice(0, options.limit).map(toSession);
		return { items, nextCursor: more ? (items.at(-1)?.id ?? null) : null };
	}

	createSession(input: NewSession): Session {
		const name = validateSessionName(input.name);
		return this.tx(() => {
			if (this.findSessionByName(name)) {
				throw conflict(`A session named "${name}" already exists.`, { field: "name" });
			}
			if (input.groupId) this.getGroup(input.groupId);
			if (input.parentId) this.getSession(input.parentId);
			const now = Date.now();
			const id = newId();
			this.#q(
				`INSERT INTO sessions (id, name, kind, group_id, responsibility, cwd, provider, model, thinking,
					rules, options, parent_id, last_activity_at, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				id,
				name,
				input.kind,
				input.groupId ?? null,
				input.responsibility ?? "",
				input.cwd ?? null,
				input.provider,
				input.model,
				input.thinking ?? "medium",
				JSON.stringify(input.rules ?? []),
				JSON.stringify(input.options ?? {}),
				input.parentId ?? null,
				now,
				now,
				now,
			);
			return this.#emitSession(id);
		});
	}

	/**
	 * Copies a session's history into another, new session: its entries up to and including
	 * `throughSeq` (all of them when null) with their sequence numbers, and the tool calls those
	 * entries made. Returns the sequence number of the last entry copied, 0 when there was none.
	 */
	copyHistory(fromId: string, toId: string, throughSeq: number | null): number {
		return this.tx(() => this.#copyHistory(fromId, toId, throughSeq));
	}

	#copyHistory(fromId: string, toId: string, throughSeq: number | null): number {
		let last = 0;
		const ids = new Map<string, string>();
		const rows = this.#q(
			"SELECT * FROM messages WHERE session_id = ? AND seq <= ? AND rewound = 0 ORDER BY seq",
		).all(fromId, throughSeq ?? Number.MAX_SAFE_INTEGER) as unknown as EntryRow[];
		for (const row of rows) {
			const entryId = newId();
			ids.set(row.id, entryId);
			last = row.seq;
			this.#q(
				"INSERT INTO messages (id, session_id, seq, role, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			).run(entryId, toId, row.seq, row.role, row.body, row.created_at);
			const text = searchableText(JSON.parse(row.body) as EntryBody);
			if (text) {
				this.#q("INSERT INTO message_search (text, session_id, message_id) VALUES (?, ?, ?)").run(
					text,
					toId,
					entryId,
				);
			}
		}
		const calls = this.#q("SELECT * FROM tool_calls WHERE session_id = ? ORDER BY id").all(
			fromId,
		) as unknown as ToolCallRow[];
		for (const call of calls) {
			const messageId = ids.get(call.message_id);
			if (!messageId) continue;
			this.#q(
				`INSERT INTO tool_calls (id, session_id, message_id, call_id, tool, args, status, detail,
					result_message_id, started_at, finished_at, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				newId(),
				toId,
				messageId,
				call.call_id,
				call.tool,
				call.args,
				// A call that never ran is pending in the copy, one cut off while running needs review:
				// the copy's next message closes both, as it would in the original.
				call.status === "waiting"
					? "pending"
					: call.status === "running"
						? "needs_review"
						: call.status,
				call.detail,
				call.result_message_id ? (ids.get(call.result_message_id) ?? null) : null,
				call.started_at,
				call.finished_at,
				call.created_at,
			);
		}
		this.#attachmentHooks.onCopied?.(fromId, toId, ids);
		this.#q("UPDATE sessions SET message_seq = ? WHERE id = ?").run(last, toId);
		return last;
	}

	/**
	 * A new session that goes on from one point of another: the same settings, and the conversation
	 * up to that point: through a finished reply, or up to just before a message from the person. The
	 * original goes on as it is, working or not. The new one starts with a fresh view of its folder
	 * and instruction files.
	 */
	forkSession(id: string, entryId: string, name: string): Session {
		return this.tx(() => {
			const source = this.getSession(id);
			const through = this.turnPoint(id, entryId);
			const copy = this.createSession({
				name,
				kind: source.kind,
				groupId: source.groupId,
				responsibility: source.responsibility,
				cwd: source.cwd,
				provider: source.provider,
				model: source.model,
				thinking: source.thinking,
				rules: inheritableRules(source.rules),
				options: source.options,
			});
			this.#copyHistory(id, copy.id, through);
			const restoredTokens = this.#contextTokensThrough(id, through);
			if (restoredTokens > 0) {
				this.#q("UPDATE sessions SET context_tokens = ? WHERE id = ?").run(restoredTokens, copy.id);
			}
			return this.#emitSession(copy.id);
		});
	}

	/**
	 * The last entry a fork or a rewind keeps for a point the person picked: a finished reply itself
	 * (text, no tool calls), or everything before a message from the person. Nothing else is a point
	 * where the conversation can stop.
	 */
	turnPoint(sessionId: string, entryId: string): number {
		const entry = this.getEntry(entryId);
		const row = this.#q("SELECT rewound FROM messages WHERE id = ?").get(entryId) as {
			rewound: number;
		};
		if (entry.sessionId === sessionId && row.rewound === 0) {
			if (entry.role === "user") return entry.seq - 1;
			const finished =
				entry.role === "assistant" &&
				entry.message.content.some((block) => block.type === "text" && block.text.trim()) &&
				!entry.message.content.some((block) => block.type === "toolCall");
			if (finished) return entry.seq;
		}
		throw invalid("Pick one of the session's replies or one of your messages in it.", "entryId");
	}

	/**
	 * Takes the conversation back to just after `throughSeq`. What came after
	 * is deleted, since a rewind is often for a key or something private pasted by mistake: each entry
	 * keeps a row without content, so numbering and references stay whole, and its tool calls'
	 * arguments and results, the approvals asked for them, its search entries and the session's event
	 * history go. Files changed, commands run and letters sent meanwhile stay as they are. It cannot go
	 * back past the latest summary of earlier history. Returns how many entries were taken back.
	 */
	rewindSession(id: string, throughSeq: number): number {
		const count = this.tx(() => {
			this.getSession(id);
			const summary = this.#q(
				"SELECT seq FROM messages WHERE session_id = ? AND role = 'compaction' AND rewound = 0 ORDER BY seq DESC LIMIT 1",
			).get(id) as { seq: number } | undefined;
			if (summary && throughSeq < summary.seq) {
				throw conflict(
					"The conversation cannot go back past the point where its earlier history was summarized.",
					undefined,
					"before-summary",
				);
			}
			const gone = this.#q(
				"SELECT id FROM messages WHERE session_id = ? AND seq > ? AND rewound = 0",
			).all(id, throughSeq) as { id: string }[];
			if (gone.length === 0) return 0;
			this.#q(
				"UPDATE messages SET rewound = 1 WHERE session_id = ? AND seq > ? AND rewound = 0",
			).run(id, throughSeq);
			for (const row of gone) {
				this.#q("DELETE FROM message_search WHERE message_id = ?").run(row.id);
			}
			this.#attachmentHooks.onRewound?.(
				id,
				gone.map((row) => row.id),
			);
			// Calls taken back before they finished are closed, so nothing picks them up later.
			this.#q(
				`UPDATE tool_calls SET status = 'error', finished_at = ?
				WHERE session_id = ? AND status IN ('pending', 'waiting', 'running', 'needs_review')
				AND message_id IN (SELECT id FROM messages WHERE session_id = ? AND rewound = 1)`,
			).run(Date.now(), id, id);
			this.#q(
				`DELETE FROM approvals WHERE tool_call_id IN (SELECT id FROM tool_calls
				WHERE message_id IN (SELECT id FROM messages WHERE session_id = ? AND rewound = 1))`,
			).run(id);
			this.#q(
				`UPDATE tool_calls SET args = '{}', detail = NULL
				WHERE message_id IN (SELECT id FROM messages WHERE session_id = ? AND rewound = 1)`,
			).run(id);
			this.#q(`UPDATE messages SET body = ${TAKEN_BACK} WHERE session_id = ? AND rewound = 1`).run(
				id,
			);
			// Earlier events can carry what was taken back. A client that missed some loads the
			// conversation again, as it does after a rewind anyway.
			this.#q("DELETE FROM session_events WHERE session_id = ?").run(id);
			// Recompute context_tokens from the surviving transcript instead of zeroing the meter.
			const restoredTokens = this.#contextTokensThrough(id, throughSeq);
			// A fresh look at the folder and instruction files next turn; context_tokens reflects the kept history.
			this.#q("UPDATE sessions SET context = NULL, context_tokens = ? WHERE id = ?").run(
				restoredTokens,
				id,
			);
			this.appendEvent(id, { type: "rewound", throughSeq });
			this.#emitSession(id);
			return gone.length;
		});
		// Old copies of the pages leave the write-ahead log too, where it is not in use.
		try {
			this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		} catch {
			// Another connection is reading; the log is overwritten later.
		}
		return count;
	}

	/**
	 * Restores the context size at `throughSeq` after a rewind or fork: uses the exact provider-reported
	 * token total from the last surviving assistant reply after the latest compaction, plus a rough
	 * estimate for any trailing user/tool entries (or compaction summary when no reply followed it).
	 */
	#contextTokensThrough(id: string, throughSeq: number): number {
		if (throughSeq <= 0) return 0;
		const compaction = this.#q(
			"SELECT seq, body FROM messages WHERE session_id = ? AND seq <= ? AND rewound = 0 AND role = 'compaction' ORDER BY seq DESC LIMIT 1",
		).get(id, throughSeq) as { seq: number; body: string } | undefined;
		const startSeq = compaction ? compaction.seq : 0;
		const rows = this.#q(
			"SELECT seq, role, body FROM messages WHERE session_id = ? AND seq >= ? AND seq <= ? AND rewound = 0 ORDER BY seq ASC",
		).all(id, startSeq, throughSeq) as { seq: number; role: string; body: string }[];

		let baseTokens = 0;
		let afterIndex = 0;
		for (let i = rows.length - 1; i >= 0; i--) {
			const row = rows[i];
			if (row?.role !== "assistant") continue;
			try {
				const parsed = JSON.parse(row.body) as {
					message?: {
						usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
					};
				};
				const usage = parsed.message?.usage;
				if (usage) {
					const total =
						(usage.input ?? 0) +
						(usage.cacheRead ?? 0) +
						(usage.cacheWrite ?? 0) +
						(usage.output ?? 0);
					if (total > 0) {
						baseTokens = total;
						afterIndex = i + 1;
						break;
					}
				}
			} catch {
				// Ignore malformed row and keep scanning earlier replies.
			}
		}

		// Estimate any entries after the anchor reply (or after the compaction boundary if no reply yet).
		let extraChars = 0;
		for (let i = afterIndex; i < rows.length; i++) {
			const row = rows[i];
			if (!row) continue;
			if (row.role === "notice") continue;
			try {
				const parsed = JSON.parse(row.body) as EntryBody;
				if (parsed.role === "compaction") {
					extraChars += parsed.compaction.summary.length;
				} else if (parsed.role === "user" || parsed.role === "toolResult") {
					extraChars += messageText(parsed.message).length;
				} else if (parsed.role === "assistant") {
					extraChars += messageText(parsed.message).length;
				}
			} catch {
				// Skip unreadable row.
			}
		}
		return baseTokens + Math.ceil(extraChars / 4);
	}

	/**
	 * A copy of a session to take another way from here: the same settings, team, workspace, task list
	 * and conversation (with its tool calls), under a new name. Usage starts at zero; letters, approvals
	 * and the main-conversation role stay with the original. Not while the original is working, since its
	 * last calls would have no results.
	 */
	duplicateSession(id: string, name: string): Session {
		return this.tx(() => {
			const source = this.getSession(id);
			if (source.status === "working" || source.status === "waiting") {
				throw conflict(
					"Wait until the session stops working, then make the copy.",
					undefined,
					"session-busy",
				);
			}
			const copy = this.createSession({
				name,
				kind: source.kind,
				groupId: source.groupId,
				responsibility: source.responsibility,
				cwd: source.cwd,
				provider: source.provider,
				model: source.model,
				thinking: source.thinking,
				rules: inheritableRules(source.rules),
				options: source.options,
			});
			this.copyHistory(id, copy.id, null);
			const context = this.#q("SELECT context, message_seq FROM sessions WHERE id = ?").get(id) as {
				context: string | null;
				message_seq: number;
			};
			this.#q(
				`UPDATE sessions SET todos = ?, context = ?, message_seq = ?, context_tokens = ?,
					last_activity_at = ? WHERE id = ?`,
			).run(
				JSON.stringify(source.todos),
				context.context,
				context.message_seq,
				source.contextTokens,
				Date.now(),
				copy.id,
			);
			return this.#emitSession(copy.id);
		});
	}

	updateSession(id: string, patch: SessionPatch): Session {
		return this.tx(() => {
			const current = this.getSession(id);
			const sets: string[] = [];
			const values: (string | number | null)[] = [];
			const set = (column: string, value: string | number | null) => {
				sets.push(`${column} = ?`);
				values.push(value);
			};
			if (patch.name !== undefined) {
				const name = validateSessionName(patch.name);
				const other = this.findSessionByName(name);
				if (other && other.id !== id) {
					throw conflict(`A session named "${name}" already exists.`, { field: "name" });
				}
				set("name", name);
			}
			if (patch.groupId !== undefined) {
				if (patch.groupId !== null) this.getGroup(patch.groupId);
				set("group_id", patch.groupId);
			}
			if (patch.cwd !== undefined) set("cwd", patch.cwd);
			if (patch.responsibility !== undefined) set("responsibility", patch.responsibility);
			if (patch.provider !== undefined) set("provider", patch.provider);
			if (patch.model !== undefined) set("model", patch.model);
			if (patch.thinking !== undefined) set("thinking", patch.thinking);
			if (patch.rules !== undefined) set("rules", JSON.stringify(patch.rules));
			if (patch.options !== undefined) {
				set("options", JSON.stringify({ ...current.options, ...patch.options }));
			}
			if (patch.pinned !== undefined) set("pinned", patch.pinned ? 1 : 0);
			if (patch.archived !== undefined) {
				set("archived_at", patch.archived ? (current.archivedAt ?? Date.now()) : null);
			}
			if (patch.read) set("unread", 0);
			if (sets.length === 0) return current;
			set("updated_at", Date.now());
			this.#q(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
			return this.#emitSession(id);
		});
	}

	setStatus(id: string, status: SessionStatus, detail: string | null = null): Session {
		return this.tx(() => {
			this.#q("UPDATE sessions SET status = ?, status_detail = ?, updated_at = ? WHERE id = ?").run(
				status,
				detail,
				Date.now(),
				id,
			);
			return this.#emitSession(id);
		});
	}

	setTodos(id: string, todos: Todo[]): Session {
		return this.tx(() => {
			this.#q("UPDATE sessions SET todos = ?, updated_at = ? WHERE id = ?").run(
				JSON.stringify(todos),
				Date.now(),
				id,
			);
			return this.#emitSession(id);
		});
	}

	/** Adds one model request's usage; `contextTokens` is what that request put in the context window. */
	addUsage(id: string, usage: UsageTotals, contextTokens: number, now = Date.now()): Session {
		return this.tx(() => {
			this.#q(
				`UPDATE sessions SET usage_input = usage_input + ?, usage_output = usage_output + ?,
					usage_cache_read = usage_cache_read + ?, usage_cache_write = usage_cache_write + ?,
					usage_cost = usage_cost + ?, context_tokens = ?, updated_at = ? WHERE id = ?`,
			).run(
				usage.input,
				usage.output,
				usage.cacheRead,
				usage.cacheWrite,
				usage.cost,
				contextTokens,
				now,
				id,
			);
			this.#q(
				`INSERT INTO usage_daily (session_id, day, input, output, cache_read, cache_write, cost)
					VALUES (?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT (session_id, day) DO UPDATE SET input = input + excluded.input,
						output = output + excluded.output, cache_read = cache_read + excluded.cache_read,
						cache_write = cache_write + excluded.cache_write, cost = cost + excluded.cost`,
			).run(
				id,
				localDay(now),
				usage.input,
				usage.output,
				usage.cacheRead,
				usage.cacheWrite,
				usage.cost,
			);
			return this.#emitSession(id);
		});
	}

	/** Dollars spent on a local calendar day, by one session or by all of them. */
	spentOn(day: string, sessionId?: string): number {
		const row = (
			sessionId
				? this.#q(
						"SELECT COALESCE(SUM(cost), 0) AS cost FROM usage_daily WHERE day = ? AND session_id = ?",
					).get(day, sessionId)
				: this.#q("SELECT COALESCE(SUM(cost), 0) AS cost FROM usage_daily WHERE day = ?").get(day)
		) as { cost: number };
		return row.cost;
	}

	/** What each session spent on a day, for the sessions that used a model then. */
	spentBySession(day: string): Record<string, number> {
		const rows = this.#q("SELECT session_id, cost FROM usage_daily WHERE day = ?").all(day) as {
			session_id: string;
			cost: number;
		}[];
		return Object.fromEntries(rows.map((row) => [row.session_id, row.cost]));
	}

	/** Cost and tokens of all sessions together on each day from `from` to `to`; days without use are left out. */
	usageByDay(from: string, to: string): UsageDay[] {
		const rows = this.#q(
			`SELECT day, SUM(cost) AS cost, SUM(input) AS input, SUM(output) AS output,
					SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write
				FROM usage_daily WHERE day >= ? AND day <= ? GROUP BY day ORDER BY day`,
		).all(from, to) as unknown as (UsageRow & { day: string })[];
		return rows.map((row) => ({ day: row.day, ...usageTotals(row) }));
	}

	/** What each session used on a day, the one that cost most first. */
	usageBySession(day: string): SessionUsage[] {
		const rows = this.#q(
			`SELECT u.session_id, s.name, s.archived_at, u.cost, u.input, u.output, u.cache_read, u.cache_write
				FROM usage_daily u JOIN sessions s ON s.id = u.session_id
				WHERE u.day = ? ORDER BY u.cost DESC, s.name`,
		).all(day) as unknown as (UsageRow & {
			session_id: string;
			name: string;
			archived_at: number | null;
		})[];
		return rows.map((row) => ({
			sessionId: row.session_id,
			name: row.name,
			archived: row.archived_at !== null,
			...usageTotals(row),
		}));
	}

	setContextTokens(id: string, contextTokens: number): Session {
		return this.tx(() => {
			this.#q("UPDATE sessions SET context_tokens = ?, updated_at = ? WHERE id = ?").run(
				contextTokens,
				Date.now(),
				id,
			);
			return this.#emitSession(id);
		});
	}

	/** Counts a letter against the session's quota. */
	countLetterSent(id: string): Session {
		return this.tx(() => {
			this.#q("UPDATE sessions SET letters_sent = letters_sent + 1 WHERE id = ?").run(id);
			return this.#emitSession(id);
		});
	}

	/** The person wrote or decided: the session may send a full quota of letters again. */
	resetLettersSent(id: string): void {
		this.tx(() => {
			const result = this.#q(
				"UPDATE sessions SET letters_sent = 0 WHERE id = ? AND letters_sent > 0",
			).run(id);
			if (result.changes > 0) this.#emitSession(id);
		});
	}

	/** The person stepped in: a message, an approval or an answer. */
	addIntervention(id: string): void {
		this.tx(() => {
			this.#q("UPDATE sessions SET interventions = interventions + 1 WHERE id = ?").run(id);
			this.#emitSession(id);
		});
	}

	setOutcome(id: string, outcome: TaskOutcome): Session {
		return this.tx(() => {
			this.#q("UPDATE sessions SET outcome = ?, updated_at = ? WHERE id = ?").run(
				outcome,
				Date.now(),
				id,
			);
			return this.#emitSession(id);
		});
	}

	/** Every session that is not archived, oldest first; the directory sessions address letters with. */
	activeSessions(): Session[] {
		const rows = this.#q(
			"SELECT * FROM sessions WHERE archived_at IS NULL ORDER BY created_at, id",
		).all() as unknown as SessionRow[];
		return rows.map(toSession);
	}

	bumpUnread(id: string): Session {
		return this.tx(() => {
			this.#q("UPDATE sessions SET unread = unread + 1 WHERE id = ?").run(id);
			return this.#emitSession(id);
		});
	}

	/** The saved system-prompt inputs (environment and instruction files) for this session. */
	getContextSnapshot<T>(id: string): T | null {
		const row = this.#q("SELECT context FROM sessions WHERE id = ?").get(id) as
			| { context: string | null }
			| undefined;
		if (!row) throw notFound("Session", id);
		return json<T | null>(row.context, null);
	}

	setContextSnapshot(id: string, snapshot: unknown): void {
		this.#q("UPDATE sessions SET context = ? WHERE id = ?").run(JSON.stringify(snapshot), id);
	}

	#emitSession(id: string): Session {
		return this.tx(() => {
			const current = this.getSession(id);
			// The event carries the session as it is after the event, including its own sequence number.
			const session = { ...current, eventSeq: current.eventSeq + 1 };
			this.appendEvent(id, { type: "session", session });
			this.#publish({ scope: "global", event: { type: "sessionSummary", session } });
			return session;
		});
	}

	// --- transcript entries ---

	appendEntry(sessionId: string, body: EntryBody): Entry {
		return this.tx(() => {
			const now = Date.now();
			const active = body.role === "user" || body.role === "assistant";
			const row = this.#q(
				`UPDATE sessions SET message_seq = message_seq + 1,
					last_activity_at = CASE WHEN ? THEN ? ELSE last_activity_at END, updated_at = ?
				WHERE id = ? RETURNING message_seq`,
			).get(active ? 1 : 0, now, now, sessionId) as { message_seq: number } | undefined;
			if (!row) throw notFound("Session", sessionId);
			const id = newId();
			this.#q(
				"INSERT INTO messages (id, session_id, seq, role, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			).run(id, sessionId, row.message_seq, body.role, JSON.stringify(body), now);
			const text = searchableText(body);
			if (text) {
				this.#q("INSERT INTO message_search (text, session_id, message_id) VALUES (?, ?, ?)").run(
					text,
					sessionId,
					id,
				);
			}
			const entry: Entry = { ...body, id, sessionId, seq: row.message_seq, createdAt: now };
			this.appendEvent(sessionId, { type: "entry", entry });
			if (active) this.#emitSession(sessionId);
			return entry;
		});
	}

	getEntry(id: string): Entry {
		const row = this.#q("SELECT * FROM messages WHERE id = ?").get(id) as EntryRow | undefined;
		if (!row) throw notFound("Message", id);
		return toEntry(row);
	}

	/** The session's entry with this sequence number, if it was not taken back. */
	entryAt(sessionId: string, seq: number): Entry | null {
		const row = this.#q(
			"SELECT * FROM messages WHERE session_id = ? AND seq = ? AND rewound = 0",
		).get(sessionId, seq) as EntryRow | undefined;
		return row ? toEntry(row) : null;
	}

	/** A page of the transcript, newest last; `before` is a seq to page backwards from. */
	listEntries(
		sessionId: string,
		options: { before?: number | null; limit: number },
	): { entries: Entry[]; olderCursor: number | null } {
		const rows = this.#q(
			"SELECT * FROM messages WHERE session_id = ? AND seq < ? AND rewound = 0 ORDER BY seq DESC LIMIT ?",
		).all(
			sessionId,
			options.before ?? Number.MAX_SAFE_INTEGER,
			options.limit + 1,
		) as unknown as EntryRow[];
		const more = rows.length > options.limit;
		const entries = rows.slice(0, options.limit).reverse().map(toEntry);
		return { entries, olderCursor: more ? (entries[0]?.seq ?? null) : null };
	}

	/** Every entry, oldest first; the Markdown export needs the whole transcript, not one page. */
	allEntries(sessionId: string): Entry[] {
		this.getSession(sessionId);
		const rows = this.#q(
			"SELECT * FROM messages WHERE session_id = ? AND rewound = 0 ORDER BY seq",
		).all(sessionId) as unknown as EntryRow[];
		return rows.map(toEntry);
	}

	/** Entries the model sees: everything since the latest compaction, plus that compaction's summary. */
	contextEntries(sessionId: string): Entry[] {
		const latest = this.#q(
			"SELECT * FROM messages WHERE session_id = ? AND role = 'compaction' AND rewound = 0 ORDER BY seq DESC LIMIT 1",
		).get(sessionId) as EntryRow | undefined;
		if (!latest) {
			const rows = this.#q(
				`SELECT * FROM messages WHERE session_id = ? AND role IN ${MODEL_ROLES} AND rewound = 0 ORDER BY seq`,
			).all(sessionId) as unknown as EntryRow[];
			return rows.map(toEntry);
		}
		const compaction = toEntry(latest);
		const firstKept = compaction.role === "compaction" ? compaction.compaction.firstKeptSeq : 0;
		const rows = this.#q(
			`SELECT * FROM messages WHERE session_id = ? AND role IN ${MODEL_ROLES} AND seq >= ? AND rewound = 0 ORDER BY seq`,
		).all(sessionId, firstKept) as unknown as EntryRow[];
		return [compaction, ...rows.map(toEntry)];
	}

	// --- tool calls ---

	createToolCall(input: {
		sessionId: string;
		messageId: string;
		callId: string;
		tool: string;
		args: JsonObject;
		status?: ToolCallStatus;
	}): ToolCallView {
		return this.tx(() => {
			const id = newId();
			this.#q(
				`INSERT INTO tool_calls (id, session_id, message_id, call_id, tool, args, status, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				id,
				input.sessionId,
				input.messageId,
				input.callId,
				input.tool,
				JSON.stringify(input.args),
				input.status ?? "pending",
				Date.now(),
			);
			return this.#emitToolCall(id);
		});
	}

	getToolCall(id: string): ToolCallView {
		const row = this.#q("SELECT * FROM tool_calls WHERE id = ?").get(id) as ToolCallRow | undefined;
		if (!row) throw notFound("Tool call", id);
		return toToolCall(row);
	}

	updateToolCall(
		id: string,
		patch: {
			status?: ToolCallStatus;
			detail?: JsonObject | null;
			resultMessageId?: string;
			startedAt?: number;
			finishedAt?: number;
		},
	): ToolCallView {
		return this.tx(() => {
			const current = this.getToolCall(id);
			this.#q(
				`UPDATE tool_calls SET status = ?, detail = ?, result_message_id = ?, started_at = ?,
					finished_at = ? WHERE id = ?`,
			).run(
				patch.status ?? current.status,
				patch.detail === undefined
					? current.detail === null
						? null
						: JSON.stringify(current.detail)
					: patch.detail === null
						? null
						: JSON.stringify(patch.detail),
				patch.resultMessageId ?? current.resultMessageId,
				patch.startedAt ?? current.startedAt,
				patch.finishedAt ?? current.finishedAt,
				id,
			);
			return this.#emitToolCall(id);
		});
	}

	toolCallsForMessages(messageIds: string[]): ToolCallView[] {
		if (messageIds.length === 0) return [];
		const placeholders = messageIds.map(() => "?").join(", ");
		const rows = this.db
			.prepare(`SELECT * FROM tool_calls WHERE message_id IN (${placeholders}) ORDER BY id`)
			.all(...messageIds) as unknown as ToolCallRow[];
		return rows.map(toToolCall);
	}

	/** Every call in the session, oldest first; used by the Markdown export. */
	toolCallsForSession(sessionId: string): ToolCallView[] {
		const rows = this.#q(
			"SELECT * FROM tool_calls WHERE session_id = ? ORDER BY created_at, id",
		).all(sessionId) as unknown as ToolCallRow[];
		return rows.map(toToolCall);
	}

	toolCallsByStatus(sessionId: string, statuses: ToolCallStatus[]): ToolCallView[] {
		const placeholders = statuses.map(() => "?").join(", ");
		const rows = this.db
			.prepare(
				`SELECT * FROM tool_calls WHERE session_id = ? AND status IN (${placeholders}) ORDER BY id`,
			)
			.all(sessionId, ...statuses) as unknown as ToolCallRow[];
		return rows.map(toToolCall);
	}

	#emitToolCall(id: string): ToolCallView {
		const toolCall = this.getToolCall(id);
		this.appendEvent(toolCall.sessionId, { type: "toolCall", toolCall });
		return toolCall;
	}

	// --- approvals and questions ---

	createApproval(input: {
		sessionId: string;
		toolCallId: string | null;
		kind: Approval["kind"];
		request: PermissionRequest | QuestionRequest;
	}): Approval {
		return this.tx(() => {
			const id = newId();
			this.#q(
				`INSERT INTO approvals (id, session_id, tool_call_id, kind, request, created_at)
				VALUES (?, ?, ?, ?, ?, ?)`,
			).run(
				id,
				input.sessionId,
				input.toolCallId,
				input.kind,
				JSON.stringify(input.request),
				Date.now(),
			);
			return this.#emitApproval(id);
		});
	}

	getApproval(id: string): Approval {
		const row = this.#q("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
		if (!row) throw notFound("Approval", id);
		return toApproval(row);
	}

	/** Records the person's answer. Only a pending request can be answered, and only once. */
	resolveApproval(
		id: string,
		response: { decision?: ApprovalDecision; reason?: string; answer?: string },
	): Approval {
		return this.tx(() => {
			const approval = this.getApproval(id);
			if (approval.status !== "pending") {
				throw conflict(
					"This request has already been answered or withdrawn.",
					undefined,
					"already-answered",
				);
			}
			this.#q(
				"UPDATE approvals SET status = 'resolved', response = ?, resolved_at = ? WHERE id = ?",
			).run(JSON.stringify(response), Date.now(), id);
			return this.#emitApproval(id);
		});
	}

	cancelApproval(id: string): Approval {
		return this.tx(() => {
			this.#q(
				"UPDATE approvals SET status = 'cancelled', resolved_at = ? WHERE id = ? AND status = 'pending'",
			).run(Date.now(), id);
			return this.#emitApproval(id);
		});
	}

	pendingApprovals(sessionId: string): Approval[] {
		const rows = this.#q(
			"SELECT * FROM approvals WHERE session_id = ? AND status = 'pending' ORDER BY id",
		).all(sessionId) as unknown as ApprovalRow[];
		return rows.map(toApproval);
	}

	/** The session's questions the person answered, newest first. */
	answeredQuestions(sessionId: string, limit = 500): Approval[] {
		const rows = this.#q(
			`SELECT * FROM approvals WHERE session_id = ? AND kind = 'question' AND status = 'resolved'
				ORDER BY id DESC LIMIT ?`,
		).all(sessionId, limit) as unknown as ApprovalRow[];
		return rows.map(toApproval);
	}

	approvalsForToolCalls(toolCallIds: string[]): Approval[] {
		if (toolCallIds.length === 0) return [];
		const placeholders = toolCallIds.map(() => "?").join(", ");
		const rows = this.db
			.prepare(`SELECT * FROM approvals WHERE tool_call_id IN (${placeholders}) ORDER BY id`)
			.all(...toolCallIds) as unknown as ApprovalRow[];
		return rows.map(toApproval);
	}

	/** Every pending approval and question, oldest first, for the approval center. */
	allPendingApprovals(): Approval[] {
		const rows = this.#q(
			"SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at, id",
		).all() as unknown as ApprovalRow[];
		return rows.map(toApproval);
	}

	#emitApproval(id: string): Approval {
		const approval = this.getApproval(id);
		this.appendEvent(approval.sessionId, { type: "approval", approval });
		// The approval center lists every session's approvals, so it hears about each change too.
		this.#publish({ scope: "global", event: { type: "approval", approval } });
		return approval;
	}

	// --- messages queued while a session works ---

	listQueue(sessionId: string): QueuedMessage[] {
		const rows = this.#q("SELECT * FROM queued_messages WHERE session_id = ? ORDER BY id").all(
			sessionId,
		) as unknown as QueueRow[];
		return rows.map(toQueued);
	}

	enqueue(sessionId: string, text: string, attachments?: AttachmentRef[]): QueuedMessage {
		return this.tx(() => {
			this.getSession(sessionId);
			const now = Date.now();
			const id = newId();
			const payload = attachments && attachments.length > 0 ? { text, attachments } : { text };
			this.#q(
				"INSERT INTO queued_messages (id, session_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
			).run(id, sessionId, JSON.stringify(payload), now, now);
			this.#emitQueue(sessionId);
			return this.#queued(id);
		});
	}

	updateQueued(sessionId: string, id: string, text: string): QueuedMessage {
		return this.tx(() => {
			const existing = this.#q("SELECT * FROM queued_messages WHERE id = ? AND session_id = ?").get(
				id,
				sessionId,
			) as QueueRow | undefined;
			if (!existing) {
				throw conflict(
					"This message was already delivered or withdrawn.",
					undefined,
					"already-delivered",
				);
			}
			const parsed = JSON.parse(existing.body) as { attachments?: AttachmentRef[] };
			const payload =
				parsed.attachments && parsed.attachments.length > 0
					? { text, attachments: parsed.attachments }
					: { text };
			this.#q(
				"UPDATE queued_messages SET body = ?, updated_at = ? WHERE id = ? AND session_id = ?",
			).run(JSON.stringify(payload), Date.now(), id, sessionId);
			this.#emitQueue(sessionId);
			return this.#queued(id);
		});
	}

	removeQueued(sessionId: string, id: string): void {
		this.tx(() => {
			const existing = this.#q("SELECT * FROM queued_messages WHERE id = ? AND session_id = ?").get(
				id,
				sessionId,
			) as QueueRow | undefined;
			if (!existing) {
				throw conflict(
					"This message was already delivered or withdrawn.",
					undefined,
					"already-delivered",
				);
			}
			const parsed = JSON.parse(existing.body) as { attachments?: AttachmentRef[] };
			this.#q("DELETE FROM queued_messages WHERE id = ? AND session_id = ?").run(id, sessionId);
			if (parsed.attachments && parsed.attachments.length > 0) {
				this.#attachmentHooks.onQueuedRemoved?.(
					sessionId,
					parsed.attachments.map((item) => item.id),
				);
			}
			this.#emitQueue(sessionId);
		});
	}

	/** Moves every queued message into the transcript in one transaction, so none is lost or doubled. */
	deliverQueue(
		sessionId: string,
		toBody: (text: string, attachments?: AttachmentRef[]) => EntryBody,
		onDelivered?: (entry: Entry, attachments: AttachmentRef[]) => void,
	): Entry[] {
		return this.tx(() => {
			const queued = this.listQueue(sessionId);
			if (queued.length === 0) return [];
			this.#q("DELETE FROM queued_messages WHERE session_id = ?").run(sessionId);
			const entries = queued.map((item) => {
				const entry = this.appendEntry(sessionId, toBody(item.text, item.attachments));
				if (item.attachments && item.attachments.length > 0) {
					onDelivered?.(entry, item.attachments);
				}
				return entry;
			});
			this.#emitQueue(sessionId);
			return entries;
		});
	}

	#queued(id: string): QueuedMessage {
		const row = this.#q("SELECT * FROM queued_messages WHERE id = ?").get(id) as
			| QueueRow
			| undefined;
		if (!row) throw notFound("Queued message", id);
		return toQueued(row);
	}

	#emitQueue(sessionId: string): void {
		this.appendEvent(sessionId, { type: "queue", queue: this.listQueue(sessionId) });
	}

	// --- text typed into a message box and not sent ---

	/** `place` is a session's id, or "home" for the box on the home page. */
	getUnsent(place: string): string {
		const row = this.#q("SELECT text FROM unsent WHERE place = ?").get(place) as
			| { text: string }
			| undefined;
		return row?.text ?? "";
	}

	/** Keeps the text for when the page comes back; an empty box keeps nothing. */
	setUnsent(place: string, text: string): void {
		if (text === "") {
			this.#q("DELETE FROM unsent WHERE place = ?").run(place);
			return;
		}
		this.#q(
			"INSERT INTO unsent (place, text) VALUES (?, ?) ON CONFLICT (place) DO UPDATE SET text = excluded.text",
		).run(place, text);
	}

	// --- settings ---

	getSetting<T>(key: string, fallback: T): T {
		const row = this.#q("SELECT value FROM settings WHERE key = ?").get(key) as
			| { value: string }
			| undefined;
		return row ? (JSON.parse(row.value) as T) : fallback;
	}

	setSetting(key: string, value: unknown): void {
		this.#q(
			"INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
		).run(key, JSON.stringify(value));
	}

	// --- custom model providers (their keys stay in the keychain) ---

	listCustomProviders(): CustomProviderConfig[] {
		const rows = this.#q("SELECT config FROM providers ORDER BY id").all() as { config: string }[];
		return rows.map((row) => JSON.parse(row.config) as CustomProviderConfig);
	}

	saveCustomProvider(config: CustomProviderConfig): void {
		const now = Date.now();
		this.#q(
			`INSERT INTO providers (id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET name = excluded.name, config = excluded.config,
				updated_at = excluded.updated_at`,
		).run(config.id, config.name, JSON.stringify(config), now, now);
	}

	deleteCustomProvider(id: string): boolean {
		return this.#q("DELETE FROM providers WHERE id = ?").run(id).changes > 0;
	}

	// --- sign-in tokens (only hashes are stored) ---

	saveAuthToken(hash: string, kind: "login" | "browser", expiresAt: number): void {
		this.#q("INSERT INTO auth_tokens (hash, kind, expires_at, created_at) VALUES (?, ?, ?, ?)").run(
			hash,
			kind,
			expiresAt,
			Date.now(),
		);
	}

	/** Removes a one-time login token and says whether it was valid; a token works only once. */
	consumeLoginToken(hash: string): boolean {
		const row = this.#q(
			"DELETE FROM auth_tokens WHERE hash = ? AND kind = 'login' AND expires_at > ? RETURNING hash",
		).get(hash, Date.now());
		return row !== undefined;
	}

	/** Checks a browser token and extends it; returns false when unknown or expired. */
	touchBrowserToken(hash: string, extendTo: number): boolean {
		const now = Date.now();
		const result = this.#q(
			`UPDATE auth_tokens SET last_used_at = ?, expires_at = MAX(expires_at, ?)
			WHERE hash = ? AND kind = 'browser' AND expires_at > ?`,
		).run(now, extendTo, hash, now);
		return result.changes > 0;
	}

	deleteAuthToken(hash: string): void {
		this.#q("DELETE FROM auth_tokens WHERE hash = ?").run(hash);
	}

	pruneAuthTokens(): void {
		this.#q("DELETE FROM auth_tokens WHERE expires_at <= ?").run(Date.now());
	}

	// --- search ---

	search(query: string, limit = 20): { sessions: Session[]; hits: SearchHit[] } {
		const q = query.trim();
		if (q.length === 0) return { sessions: [], hits: [] };
		const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
		const sessions = (
			this.#q(
				`SELECT * FROM sessions WHERE name LIKE ? ESCAPE '\\' OR responsibility LIKE ? ESCAPE '\\'
				ORDER BY last_activity_at DESC LIMIT ?`,
			).all(like, like, limit) as unknown as SessionRow[]
		).map(toSession);

		// The trigram index needs at least three characters; shorter queries scan the index text.
		const select = `SELECT s.session_id AS sessionId, s.message_id AS entryId, m.seq AS seq,
			snippet(message_search, 0, '${MATCH_START}', '${MATCH_END}', '…', 16) AS snippet
			FROM message_search s JOIN messages m ON m.id = s.message_id`;
		const hits =
			[...q].length >= 3
				? (this.#q(`${select} WHERE message_search MATCH ? ORDER BY rank LIMIT ?`).all(
						`"${q.replace(/"/g, '""')}"`,
						limit,
					) as unknown as SearchHit[])
				: (
						this.#q(
							`SELECT s.session_id AS sessionId, s.message_id AS entryId, m.seq AS seq, s.text AS snippet
							FROM message_search s JOIN messages m ON m.id = s.message_id
							WHERE s.text LIKE ? ESCAPE '\\' ORDER BY m.created_at DESC LIMIT ?`,
						).all(like, limit) as unknown as SearchHit[]
					).map((hit) => ({ ...hit, snippet: highlight(hit.snippet, q) }));
		return { sessions, hits };
	}

	// --- deleting ---

	/**
	 * Deletes archived sessions for good: their conversations, tool calls, approvals, queued messages,
	 * events, search entries, the text left unsent in their message box and the letters sent to them.
	 * Letters they sent and decisions they asked for stay, without the link to them. Sessions `keep`
	 * names (still running) are left alone.
	 */
	deleteArchivedSessions(keep: (id: string) => boolean = () => false): string[] {
		return this.tx(() => {
			const rows = this.#q("SELECT id FROM sessions WHERE archived_at IS NOT NULL").all() as {
				id: string;
			}[];
			const ids = rows.map((row) => row.id).filter((id) => !keep(id));
			for (const id of ids) {
				this.#q("DELETE FROM message_search WHERE session_id = ?").run(id);
				this.#q("DELETE FROM unsent WHERE place = ?").run(id);
				this.#q("DELETE FROM sessions WHERE id = ?").run(id);
			}
			if (ids.length > 0) this.publish({ type: "sessionsDeleted", ids });
			return ids;
		});
	}

	// --- restart recovery ---

	/**
	 * After a restart nothing is running. Work that was in flight is marked "needs review" and is not
	 * redone automatically: a tool call that was running may or may not have finished; a call that
	 * was only waiting for approval never ran and will be asked again.
	 */
	recoverAfterRestart(): string[] {
		return this.tx(() => {
			// A question Yew took from a reply has no call behind it: it still waits for the person.
			const affected = this.#q(
				`SELECT id FROM sessions WHERE status = 'working' OR (status = 'waiting' AND id NOT IN
					(SELECT session_id FROM approvals WHERE status = 'pending' AND tool_call_id IS NULL))`,
			).all() as { id: string }[];
			const now = Date.now();
			const running = this.#q("SELECT id FROM tool_calls WHERE status = 'running'").all() as {
				id: string;
			}[];
			for (const call of running) this.updateToolCall(call.id, { status: "needs_review" });
			const waiting = this.#q("SELECT id FROM tool_calls WHERE status = 'waiting'").all() as {
				id: string;
			}[];
			for (const call of waiting) this.updateToolCall(call.id, { status: "pending" });
			const pending = this.#q(
				"SELECT id FROM approvals WHERE status = 'pending' AND tool_call_id IS NOT NULL",
			).all() as { id: string }[];
			for (const approval of pending) this.cancelApproval(approval.id);
			for (const session of affected) {
				this.#q(
					"UPDATE sessions SET status = 'needs_review', status_detail = ?, updated_at = ? WHERE id = ?",
				).run("Yew Harness restarted while this session was working.", now, session.id);
				this.appendEntry(session.id, {
					role: "notice",
					notice: {
						kind: "restarted",
						text: "Yew Harness restarted while this session was working.",
						timestamp: now,
					},
				});
				this.#emitSession(session.id);
			}
			return affected.map((session) => session.id);
		});
	}
}

function highlight(text: string, query: string): string {
	const index = text.toLowerCase().indexOf(query.toLowerCase());
	if (index < 0) return text.slice(0, 120);
	const start = Math.max(0, index - 40);
	const end = Math.min(text.length, index + query.length + 60);
	return `${start > 0 ? "…" : ""}${text.slice(start, index)}${MATCH_START}${text.slice(index, index + query.length)}${MATCH_END}${text.slice(index + query.length, end)}${end < text.length ? "…" : ""}`;
}
