import { CronError, nextRun, parseCron } from "../shared/cron.ts";
import {
	type Letter,
	type PermissionMode,
	permissionModeOf,
	SCHEDULE_MODES,
	type Schedule,
	type ScheduleMode,
	type ScheduleSkip,
	type ScheduleStatus,
	type Session,
} from "../shared/types.ts";
import { conflict, invalid, notFound } from "./errors.ts";
import { newId } from "./ids.ts";
import { BODY_MAX, type PostOffice, SUMMARY_MAX } from "./mail/post.ts";
import { inheritableRules } from "./permissions/engine.ts";
import { type Store, validateSessionName } from "./store.ts";

interface ScheduleRow {
	id: string;
	name: string;
	cron: string;
	session_id: string;
	message: string;
	permission_mode: PermissionMode | null;
	mode: ScheduleMode;
	auto_archive: number;
	catch_up: number;
	enabled: number;
	next_run_at: number | null;
	last_run_at: number | null;
	last_status: ScheduleStatus | null;
	last_detail: string | null;
	last_letter_id: string | null;
	last_session_id: string | null;
	created_at: number;
	updated_at: number;
}

function toSchedule(row: ScheduleRow): Schedule {
	return {
		id: row.id,
		name: row.name,
		cron: row.cron,
		sessionId: row.session_id,
		message: row.message,
		permissionMode: row.permission_mode,
		mode: row.mode ?? "letter",
		autoArchive: row.auto_archive === 1,
		catchUp: row.catch_up === 1,
		enabled: row.enabled === 1,
		nextRunAt: row.next_run_at,
		lastRunAt: row.last_run_at,
		lastStatus: row.last_status,
		lastDetail: row.last_detail,
		lastLetterId: row.last_letter_id,
		lastSessionId: row.last_session_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/** What the person or manage_yew gives for a task; the session by id or name. Missing fields keep theirs. */
export interface ScheduleFields {
	name?: string;
	cron?: string;
	session?: string;
	message?: string;
	permissionMode?: PermissionMode | null;
	mode?: ScheduleMode;
	autoArchive?: boolean;
	catchUp?: boolean;
	enabled?: boolean;
}

/** A task's fields after checking: every one present, the session as an id. */
export interface ScheduleValues {
	name: string;
	cron: string;
	sessionId: string;
	message: string;
	permissionMode: PermissionMode | null;
	mode: ScheduleMode;
	autoArchive: boolean;
	catchUp: boolean;
	enabled: boolean;
}

const NAME_MAX = 60;

/** Checks a cron expression and that it names a time that exists; returns it tidied. */
export function checkCron(text: unknown, now = Date.now()): string {
	if (typeof text !== "string" || !text.trim()) throw invalid("Give the times as cron.", "cron");
	const tidy = text.trim().split(/\s+/).join(" ");
	try {
		if (nextRun(parseCron(tidy), now) === null) {
			throw invalid(`"${tidy}" names no date that exists, so it would never run.`, "cron");
		}
	} catch (error) {
		if (error instanceof CronError) throw invalid(error.message, "cron");
		throw error;
	}
	return tidy;
}

function nextAfter(cron: string, now: number): number | null {
	try {
		return nextRun(parseCron(cron), now);
	} catch {
		return null;
	}
}

/**
 * Scheduled tasks in the database. Every change goes out as a global event after its
 * transaction commits, so every open page sees it.
 */
export class ScheduleBook {
	readonly #store: Store;
	readonly #listeners = new Set<() => void>();

	constructor(store: Store) {
		this.#store = store;
	}

	/** Called after any change, such as a new time to wake up for. */
	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	list(): Schedule[] {
		const rows = this.#store.db
			.prepare("SELECT * FROM schedules ORDER BY name COLLATE NOCASE, id")
			.all() as unknown as ScheduleRow[];
		return rows.map(toSchedule);
	}

	get(id: string): Schedule {
		const row = this.#store.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as
			| ScheduleRow
			| undefined;
		if (!row) throw notFound("Scheduled task", id);
		return toSchedule(row);
	}

	/** A task by id or by name (names are unique, whatever the case). */
	find(ref: string): Schedule | null {
		const row = this.#store.db.prepare("SELECT * FROM schedules WHERE id = ?").get(ref) as
			| ScheduleRow
			| undefined;
		return row ? toSchedule(row) : this.#named(ref);
	}

	#named(name: string): Schedule | null {
		const row = this.#store.db
			.prepare("SELECT * FROM schedules WHERE name = ? COLLATE NOCASE")
			.get(name.trim()) as ScheduleRow | undefined;
		return row ? toSchedule(row) : null;
	}

	/** Checks the fields; missing ones come from `current`, or the defaults for a new task. */
	values(fields: ScheduleFields, current: Schedule | null, now = Date.now()): ScheduleValues {
		const name = fields.name === undefined ? current?.name : fields.name.trim();
		if (!name) throw invalid("A scheduled task needs a name.", "name");
		if ([...name].length > NAME_MAX) {
			throw invalid(`The name can be at most ${NAME_MAX} characters.`, "name");
		}
		// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
		if (/[\u0000-\u001f\u007f]/.test(name)) {
			throw invalid("The name cannot contain control characters.", "name");
		}
		const other = this.#named(name);
		if (other && other.id !== current?.id) {
			throw conflict(`There is already a scheduled task called "${other.name}".`, {
				field: "name",
			});
		}
		const cron = fields.cron === undefined ? current?.cron : checkCron(fields.cron, now);
		if (!cron) throw invalid("Give the times as cron.", "cron");
		const sessionId =
			fields.session === undefined ? current?.sessionId : this.#target(fields.session).id;
		if (!sessionId) throw invalid("Choose the session the letter goes to.", "session");
		const message = fields.message === undefined ? current?.message : fields.message.trim();
		if (!message) throw invalid("Write the letter the task sends.", "message");
		if ([...message].length > BODY_MAX) {
			throw invalid(`The letter can be at most ${BODY_MAX} characters.`, "message");
		}
		const mode: ScheduleMode = fields.mode ?? current?.mode ?? "letter";
		if (!(SCHEDULE_MODES as readonly string[]).includes(mode)) {
			throw invalid(`mode must be one of ${SCHEDULE_MODES.join(", ")}.`, "mode");
		}
		return {
			name,
			cron,
			sessionId,
			message,
			permissionMode:
				fields.permissionMode === undefined
					? (current?.permissionMode ?? null)
					: fields.permissionMode,
			mode,
			autoArchive: fields.autoArchive ?? current?.autoArchive ?? true,
			catchUp: fields.catchUp ?? current?.catchUp ?? true,
			enabled: fields.enabled ?? current?.enabled ?? true,
		};
	}

	/** The session a task writes to: a standing session that is not archived. */
	#target(ref: string): Session {
		let session: Session | undefined;
		try {
			session = this.#store.getSession(ref);
		} catch {
			session = this.#store.findSessionByName(ref);
		}
		if (!session) throw invalid(`There is no session "${ref}".`, "session");
		if (session.kind !== "standing") {
			throw invalid(
				`"${session.name}" is a task session; a scheduled task writes to a standing session.`,
				"session",
			);
		}
		if (session.archivedAt !== null) {
			throw invalid(`"${session.name}" is archived; restore it first.`, "session");
		}
		return session;
	}

	create(fields: ScheduleFields, now = Date.now()): Schedule {
		const values = this.values(fields, null, now);
		const id = newId();
		this.#store.tx(() => {
			this.#store.db
				.prepare(
					`INSERT INTO schedules (id, name, cron, session_id, message, permission_mode, mode, auto_archive, catch_up, enabled,
						next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					id,
					values.name,
					values.cron,
					values.sessionId,
					values.message,
					values.permissionMode,
					values.mode,
					values.autoArchive ? 1 : 0,
					values.catchUp ? 1 : 0,
					values.enabled ? 1 : 0,
					values.enabled ? nextAfter(values.cron, now) : null,
					now,
					now,
				);
			this.#publish();
		});
		return this.get(id);
	}

	update(id: string, fields: ScheduleFields, now = Date.now()): Schedule {
		const current = this.get(id);
		const values = this.values(fields, current, now);
		// New times, or turned back on: the next run counts from now, not from a time already past.
		const next =
			values.cron !== current.cron || values.enabled !== current.enabled
				? values.enabled
					? nextAfter(values.cron, now)
					: null
				: current.nextRunAt;
		this.#store.tx(() => {
			this.#store.db
				.prepare(
					`UPDATE schedules SET name = ?, cron = ?, session_id = ?, message = ?, permission_mode = ?,
						mode = ?, auto_archive = ?, catch_up = ?, enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?`,
				)
				.run(
					values.name,
					values.cron,
					values.sessionId,
					values.message,
					values.permissionMode,
					values.mode,
					values.autoArchive ? 1 : 0,
					values.catchUp ? 1 : 0,
					values.enabled ? 1 : 0,
					next,
					now,
					id,
				);
			this.#publish();
		});
		return this.get(id);
	}

	delete(id: string): void {
		this.get(id);
		this.#store.tx(() => {
			this.#store.db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
			this.#publish();
		});
	}

	/** Enabled tasks whose next run is due. */
	due(now: number): Schedule[] {
		const rows = this.#store.db
			.prepare(
				"SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, id",
			)
			.all(now) as unknown as ScheduleRow[];
		return rows.map(toSchedule);
	}

	/** When the next task is due, if any is on. */
	soonest(): number | null {
		const row = this.#store.db
			.prepare("SELECT MIN(next_run_at) AS at FROM schedules WHERE enabled = 1")
			.get() as { at: number | null };
		return row.at;
	}

	setNext(id: string, next: number | null): void {
		this.#store.db.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(next, id);
		this.#publish();
	}

	/** A run started: its letter (and optional fresh task session) is on its way. */
	started(id: string, letterId: string, at: number, sessionId: string | null = null): void {
		this.#store.db
			.prepare(
				"UPDATE schedules SET last_run_at = ?, last_status = 'running', last_detail = NULL, last_letter_id = ?, last_session_id = ? WHERE id = ?",
			)
			.run(at, letterId, sessionId, id);
		this.#publish();
	}

	/** A run was skipped; the letter of a run still going stays the latest. */
	skipped(id: string, reason: ScheduleSkip, at: number): void {
		this.#store.db
			.prepare(
				"UPDATE schedules SET last_run_at = ?, last_status = 'skipped', last_detail = ? WHERE id = ?",
			)
			.run(at, reason, id);
		this.#publish();
	}

	/**
	 * The turn that read a run's letter ended, or the letter was dropped; a later run may have started
	 * meanwhile, and then this one is no longer the latest.
	 */
	finished(
		letter: Letter,
		status: Exclude<ScheduleStatus, "running">,
		detail: string | null,
	): void {
		if (!letter.scheduleId) return;
		const result = this.#store.db
			.prepare(
				"UPDATE schedules SET last_run_at = ?, last_status = ?, last_detail = ? WHERE id = ? AND last_letter_id = ?",
			)
			.run(letter.createdAt, status, detail, letter.scheduleId, letter.id);
		if (Number(result.changes) > 0) this.#publish();
	}

	/** Archived sessions were deleted for good, and their tasks with them. */
	refresh(): void {
		this.#publish();
	}

	#publish(): void {
		this.#store.publish({ type: "schedules", schedules: this.list() });
		for (const listener of this.#listeners) listener();
	}
}

/** How late a run may start and still be on time; later, it was missed. */
const GRACE_MS = 2 * 60_000;
/** The longest the scheduler sleeps, so it notices a computer that woke up. */
const TICK_MS = 30_000;

const clip = (text: string, max: number) =>
	[...text].length > max ? `${[...text].slice(0, max - 1).join("")}…` : text;

const OPEN = new Set(["queued", "held", "delivered"]);

/**
 * Runs scheduled tasks on time: a run is a letter to the task's session in the task's
 * name, which the session reads in a turn of its own. Runs missed while Yew was not running or the
 * computer slept run once afterwards or are skipped, as the task says; a run whose last one is not
 * finished is skipped. The service keeps time; `yew schedule run` uses the same `run`.
 */
export class Scheduler {
	readonly book: ScheduleBook;
	readonly #store: Store;
	readonly #post: PostOffice;
	readonly #log: (line: string) => void;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#stopChange: (() => void) | null = null;

	constructor(store: Store, post: PostOffice, book: ScheduleBook, log: (line: string) => void) {
		this.#store = store;
		this.#post = post;
		this.book = book;
		this.#log = log;
	}

	/** Sends the task's letter (or spawns a fresh task session) now, unless archived or busy. */
	run(
		id: string,
		now = Date.now(),
	): { letter: Letter; session?: Session } | { skipped: ScheduleSkip } {
		const schedule = this.book.get(id);
		let owner: Session | null = null;
		try {
			owner = this.#store.getSession(schedule.sessionId);
		} catch {
			owner = null;
		}
		if (!owner || owner.archivedAt !== null) {
			this.book.skipped(id, "archived", now);
			return { skipped: "archived" };
		}
		if (
			(schedule.lastLetterId && this.#open(schedule.lastLetterId)) ||
			(schedule.lastSessionId && this.#sessionBusy(schedule.lastSessionId))
		) {
			this.book.skipped(id, "busy", now);
			return { skipped: "busy" };
		}
		const [first = "", ...rest] = schedule.message.split("\n");
		const line = first.trim();
		const summary = clip(line, SUMMARY_MAX);
		const body = summary === line ? rest.join("\n").trim() : schedule.message;

		if (schedule.mode === "task_session") {
			const stamp = formatRunStamp(now);
			const rawBase = `${schedule.name.replace(/@/g, "")} · ${stamp}`;
			const valid = validateSessionName(clip(rawBase, 55));
			let name = valid;
			for (let n = 2; this.#store.findSessionByName(name); n++) {
				name = `${valid.slice(0, 50)} ${n}`;
			}
			const taskSession = this.#store.createSession({
				name,
				kind: "task",
				groupId: owner.groupId,
				cwd: owner.cwd,
				responsibility: owner.responsibility,
				provider: owner.provider,
				model: owner.model,
				thinking: owner.thinking,
				rules: inheritableRules(owner.rules),
				options: {
					permissionMode: schedule.permissionMode ?? permissionModeOf(owner.options),
					...(owner.options.extraDirs?.length ? { extraDirs: owner.options.extraDirs } : {}),
					...(owner.options.allowedDomains?.length
						? { allowedDomains: owner.options.allowedDomains }
						: {}),
				},
				parentId: owner.id,
			});
			const letter = this.#post.send(
				{ kind: "schedule", schedule },
				{ to: taskSession.id, kind: "request", summary, body },
			);
			this.book.started(id, letter.id, now, taskSession.id);
			return { letter, session: taskSession };
		}

		// Letter mode: stands in for the person on the standing session with a fresh quota and chain.
		this.#store.resetLettersSent(owner.id);
		this.#post.resetChain(owner.id);
		const letter = this.#post.send(
			{ kind: "schedule", schedule },
			{ to: owner.id, kind: "request", summary, body },
		);
		this.book.started(id, letter.id, now, null);
		return { letter };
	}

	/** Runs, or skips, every task that is due; each one's next run counts from now. */
	tick(now = Date.now()): void {
		for (const schedule of this.book.due(now)) {
			const due = schedule.nextRunAt as number;
			this.book.setNext(schedule.id, nextAfter(schedule.cron, now));
			if (now - due > GRACE_MS && !schedule.catchUp) {
				this.book.skipped(schedule.id, "missed", due);
				continue;
			}
			try {
				this.run(schedule.id, now);
			} catch (error) {
				this.#log(`scheduled task ${schedule.name}: ${(error as Error).message}`);
			}
		}
	}

	/** Keeps time until stop(): wakes for the next run, and at least every half minute. */
	start(): void {
		this.#stopChange = this.book.onChange(() => this.#arm());
		this.#loop();
	}

	stop(): void {
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
		this.#stopChange?.();
		this.#stopChange = null;
	}

	#loop(): void {
		try {
			this.tick();
		} catch (error) {
			this.#log(`scheduled tasks: ${(error as Error).message}`);
		}
		this.#arm();
	}

	#arm(): void {
		if (!this.#stopChange) return;
		if (this.#timer) clearTimeout(this.#timer);
		const soonest = this.book.soonest();
		const wait =
			soonest === null ? TICK_MS : Math.min(TICK_MS, Math.max(50, soonest - Date.now() + 50));
		this.#timer = setTimeout(() => this.#loop(), wait);
	}

	#open(letterId: string): boolean {
		try {
			return OPEN.has(this.#post.mail.getLetter(letterId).status);
		} catch {
			return false;
		}
	}

	#sessionBusy(sessionId: string): boolean {
		try {
			const status = this.#store.getSession(sessionId).status;
			return status === "working" || status === "waiting";
		} catch {
			return false;
		}
	}
}

function formatRunStamp(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The run of a task was refused because it still runs, for the HTTP layer and the command line. */
export function skippedError(reason: ScheduleSkip, name: string) {
	return reason === "busy"
		? conflict(`The last run of "${name}" is not finished yet.`, undefined, "schedule-busy")
		: conflict(`The session of "${name}" is archived.`, undefined, "session-archived");
}
