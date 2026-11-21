import { randomUUID } from "node:crypto";
import { plainLine } from "../shared/messages.ts";
import type {
	Approval,
	PermissionRequest,
	QuestionRequest,
	Schedule,
	Session,
} from "../shared/types.ts";
import { dollars } from "./budget.ts";
import type { BusEvent, EventBus } from "./events.ts";
import type { MailStore } from "./mail/store.ts";
import { type NotifyKind, SETTING_DEFAULTS } from "./settings.ts";
import type { Store } from "./store.ts";

/**
 * Decides what the phone is told and when.
 *
 * - What: new items in the approval center (permissions, questions, decision cards, held letters); a
 *   session that stopped with an error or is marked for review; a task session or a scheduled task
 *   that finished; spending that passed 80% of a daily limit or reached it.
 * - When: at once for the first, then at most one notification per window, which sums up what came
 *   in meanwhile. While you are at the Mac (Yew's page in front, used in the last two minutes), items
 *   that need you wait and go out when you have left and they are still open; the rest is not sent.
 * - Afterwards: when an item is handled, its notification is taken off the phone, and the app's badge
 *   is the number of items waiting in the approval center.
 * - Which: the person chooses the kinds in the settings. A kind that is turned off is not sent to
 *   any phone, whichever way its notifications travel.
 */

export type NoteKind =
	| "permission"
	| "question"
	| "card"
	| "letter"
	| "error"
	| "review"
	| "task"
	| "schedule"
	| "budget"
	| "many";

/** What a notification says, before it is sealed for a phone. The phone puts the kind into words. */
export interface Note {
	v: 1;
	/** The notification's id; a `clear` names it later. */
	id: string;
	kind: NoteKind;
	title: string;
	body: string;
	/** The session to open when it is tapped; without one, the approval center. */
	session?: string;
	/** For `many`: how many items it sums up. */
	n?: number;
	/** For `budget`: budget-warning or budget-reached; for `task` and `schedule`: how it ended. */
	code?: string;
	badge: number;
}

/** Tells the app to take notifications off the screen and set its badge. */
export interface Clear {
	v: 1;
	clear: string[];
	badge: number;
}

interface Item {
	key: string;
	kind: Exclude<NoteKind, "many">;
	title: string;
	body: string;
	session?: string;
	code?: string;
	at: number;
}

export interface NotifierOptions {
	store: Store;
	mail: MailStore;
	bus: EventBus;
	/** The scheduled tasks as they are now, so only runs that end later are news. */
	schedules?: () => Schedule[];
	/** Sends to every phone that takes notifications; returns how many were asked for. */
	send(note: Note | Clear, mode: "alert" | "background", id?: string): number;
	now?: () => number;
	/** How long a new item waits before it is sent, so one that is settled at once is not. */
	settleMs?: number;
	/** At most one notification per this long; later items in it are summed up in the next. */
	windowMs?: number;
	/** How long after its last use the Mac's page still counts as you being there. */
	presenceMs?: number;
	/** How long an item that could not be sent (no relay, no phone) is kept for a later try. */
	keepMs?: number;
}

/** The setting each kind of item belongs to. */
const NOTIFY_KIND: Record<Item["kind"], NotifyKind> = {
	permission: "waiting",
	question: "waiting",
	card: "waiting",
	letter: "waiting",
	error: "error",
	review: "error",
	task: "task",
	schedule: "task",
	budget: "budget",
};

const TITLE_MAX = 80;
const BODY_MAX = 240;
const clip = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max - 1)}…` : text;

export class Notifier {
	readonly #options: Required<
		Omit<NotifierOptions, "store" | "mail" | "bus" | "send" | "schedules">
	> &
		Pick<NotifierOptions, "store" | "mail" | "bus" | "send" | "schedules">;
	/** Items in the approval center that have not gone out yet. */
	readonly #waiting = new Map<string, Item>();
	/** One-off news that has not gone out yet. */
	#news: Item[] = [];
	/** Every item in the approval center seen so far, sent or not. */
	readonly #known = new Set<string>();
	/** For items that went out: the notification that carried each. */
	readonly #sent = new Map<string, string>();
	/** For each notification still on the phone: the items it carried that are still open. */
	readonly #notes = new Map<string, Set<string>>();
	readonly #sessions = new Map<string, { status: string; outcome: string | null }>();
	readonly #schedules = new Map<string, string>();
	#seenAt = 0;
	#lastSentAt = 0;
	#timer: NodeJS.Timeout | null = null;
	#interval: NodeJS.Timeout | null = null;
	#unsubscribe: (() => void) | null = null;

	constructor(options: NotifierOptions) {
		this.#options = {
			now: Date.now,
			settleMs: 1500,
			windowMs: 10_000,
			presenceMs: 2 * 60 * 1000,
			keepMs: 10 * 60 * 1000,
			...options,
		};
	}

	/** Starts from what is there now: only what comes after this is news. */
	start(): void {
		const { store } = this.#options;
		for (const item of this.#pending()) this.#known.add(item.key);
		for (const session of store.listSessions({ limit: 1000 }).items) this.#remember(session);
		for (const schedule of this.#options.schedules?.() ?? []) {
			this.#schedules.set(schedule.id, runOf(schedule));
		}
		this.#unsubscribe = this.#options.bus.subscribe((event) => this.#heard(event));
		// Presence runs out and windows end without any event.
		this.#interval = setInterval(() => this.tick(), 5000);
		this.#interval.unref();
	}

	stop(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = null;
		if (this.#timer) clearTimeout(this.#timer);
		if (this.#interval) clearInterval(this.#interval);
		this.#timer = null;
		this.#interval = null;
	}

	/** Yew's page on the Mac is in front and in use. */
	seen(): void {
		this.#seenAt = this.#options.now();
	}

	/** Whether the person wants to hear about this kind of item. */
	#wanted(kind: Item["kind"]): boolean {
		const chosen = this.#options.store.getSetting("notify", SETTING_DEFAULTS.notify);
		return chosen[NOTIFY_KIND[kind]] ?? true;
	}

	#remember(session: Session): void {
		this.#sessions.set(session.id, { status: session.status, outcome: session.outcome });
	}

	#heard(event: BusEvent): void {
		const now = this.#options.now();
		if (event.scope === "session") {
			const inner = event.event;
			if (inner.type !== "entry" || inner.entry.role !== "notice") return;
			const notice = inner.entry.notice;
			if (notice.kind !== "budget") return;
			if (!this.#wanted("budget")) return;
			const data = notice.data ?? {};
			const amounts =
				typeof data.spent === "number" && typeof data.limit === "number"
					? `${dollars(data.spent)} / ${dollars(data.limit)}`
					: "";
			this.#news.push({
				key: `budget:${inner.entry.id}`,
				kind: "budget",
				title: this.#name(event.sessionId),
				body: amounts,
				session: event.sessionId,
				code: String(data.code ?? ""),
				at: now,
			});
			this.#soon();
			return;
		}
		if (event.scope !== "global") return;
		const global = event.event;
		if (global.type === "approval" || global.type === "card" || global.type === "letter") {
			this.#soon();
		} else if (global.type === "sessionSummary") {
			const session = global.session;
			const before = this.#sessions.get(session.id);
			this.#remember(session);
			if (!before || session.archivedAt !== null) return;
			if (session.status !== before.status && session.status === "error") {
				this.#tell(session, "error", session.statusDetail ?? "");
			} else if (session.status !== before.status && session.status === "needs_review") {
				this.#tell(session, "review", "");
			} else if (session.kind === "task" && session.outcome && !before.outcome) {
				this.#tell(session, "task", "", session.outcome);
			}
		} else if (global.type === "schedules") {
			for (const schedule of global.schedules) {
				const before = this.#schedules.get(schedule.id);
				const run = runOf(schedule);
				this.#schedules.set(schedule.id, run);
				if (before === undefined || before === run) continue;
				if (schedule.lastStatus !== "done" && schedule.lastStatus !== "error") continue;
				if (!this.#wanted("schedule")) continue;
				this.#news.push({
					key: `schedule:${schedule.id}:${schedule.lastRunAt}`,
					kind: "schedule",
					title: schedule.name,
					body: plainLine(schedule.lastDetail ?? ""),
					session: schedule.sessionId,
					code: schedule.lastStatus,
					at: now,
				});
				this.#soon();
			}
		} else if (global.type === "sessionsDeleted") {
			for (const id of global.ids) this.#sessions.delete(id);
		}
	}

	#tell(session: Session, kind: Item["kind"], body: string, code?: string): void {
		if (!this.#wanted(kind)) return;
		this.#news.push({
			key: `${kind}:${session.id}:${this.#options.now()}`,
			kind,
			title: session.name,
			body: plainLine(body),
			session: session.id,
			...(code ? { code } : {}),
			at: this.#options.now(),
		});
		this.#soon();
	}

	#name(sessionId: string): string {
		try {
			return this.#options.store.getSession(sessionId).name;
		} catch {
			return "";
		}
	}

	#soon(ms = this.#options.settleMs): void {
		if (this.#timer) return;
		this.#timer = setTimeout(() => {
			this.#timer = null;
			this.tick();
		}, ms);
		this.#timer.unref();
	}

	/** What waits for the person in the approval center, as items. */
	#pending(): Item[] {
		const { store, mail } = this.#options;
		const now = this.#options.now();
		const items: Item[] = [];
		for (const approval of store.allPendingApprovals()) {
			items.push({
				key: `approval:${approval.id}`,
				kind: approval.kind,
				title: this.#name(approval.sessionId),
				body: askedIn(approval),
				// A question asked in a reply is answered in its session; the rest in the approval center.
				...(approval.kind === "question" ? { session: approval.sessionId } : {}),
				at: now,
			});
		}
		for (const card of mail.pendingCards()) {
			items.push({
				key: `card:${card.id}`,
				kind: "card",
				title: `#${card.number} ${card.title}`,
				body: plainLine(card.context),
				at: now,
			});
		}
		for (const letter of mail.heldLetters()) {
			items.push({
				key: `letter:${letter.id}`,
				kind: "letter",
				title: `${letter.fromName} → ${this.#name(letter.toSession)}`,
				body: letter.summary,
				at: now,
			});
		}
		return items;
	}

	/** Looks at what changed and sends what is due. Runs after events and every few seconds. */
	tick(): void {
		const now = this.#options.now();
		const pending = this.#pending();
		const open = new Set(pending.map((item) => item.key));
		for (const item of pending) {
			if (this.#known.has(item.key)) continue;
			this.#known.add(item.key);
			// Not wanted now: it stays known, so turning the kind on later does not send old items.
			if (this.#wanted(item.kind)) this.#waiting.set(item.key, item);
		}
		// Handled items: not sent any more, and their notifications come off the phone.
		const cleared: string[] = [];
		for (const key of [...this.#known]) {
			if (open.has(key)) continue;
			this.#known.delete(key);
			this.#waiting.delete(key);
			const note = this.#sent.get(key);
			if (!note) continue;
			this.#sent.delete(key);
			const left = this.#notes.get(note);
			left?.delete(key);
			if (left && left.size === 0) {
				this.#notes.delete(note);
				cleared.push(note);
			}
		}
		if (cleared.length > 0) {
			this.#options.send({ v: 1, clear: cleared, badge: open.size }, "background");
		}

		const present = now - this.#seenAt < this.#options.presenceMs;
		// At the Mac you see the news there; what needs you waits until you have left.
		if (present) this.#news = [];
		this.#news = this.#news.filter((item) => now - item.at < this.#options.keepMs);
		if (present) return;
		// A kind turned off while its items were waiting to go out is dropped here.
		for (const [key, item] of this.#waiting) {
			if (!this.#wanted(item.kind)) this.#waiting.delete(key);
		}
		this.#news = this.#news.filter((item) => this.#wanted(item.kind));
		const due = [...this.#waiting.values(), ...this.#news].filter(
			(item) => now - item.at >= this.#options.settleMs,
		);
		if (due.length === 0) {
			if (this.#waiting.size + this.#news.length > 0) this.#soon();
			return;
		}
		const wait = this.#lastSentAt + this.#options.windowMs - now;
		if (wait > 0) {
			this.#soon(wait);
			return;
		}
		const id = randomUUID();
		const first = due[0] as Item;
		const note: Note =
			due.length === 1
				? {
						v: 1,
						id,
						kind: first.kind,
						title: clip(first.title, TITLE_MAX),
						body: clip(first.body, BODY_MAX),
						...(first.session ? { session: first.session } : {}),
						...(first.code ? { code: first.code } : {}),
						badge: open.size,
					}
				: {
						v: 1,
						id,
						kind: "many",
						title: "",
						body: clip(
							due
								.map((item) => item.title)
								.filter(Boolean)
								.join(" · "),
							BODY_MAX,
						),
						n: due.length,
						badge: open.size,
					};
		if (this.#options.send(note, "alert", id) === 0) {
			// No relay or no phone right now: items that need you are tried again while they are open.
			for (const [key, item] of this.#waiting) {
				if (now - item.at >= this.#options.keepMs) this.#waiting.delete(key);
			}
			return;
		}
		this.#lastSentAt = now;
		const carried = new Set<string>();
		for (const item of due) {
			if (!this.#waiting.delete(item.key)) continue;
			this.#sent.set(item.key, id);
			carried.add(item.key);
		}
		if (carried.size > 0) this.#notes.set(id, carried);
		const gone = new Set(due.map((item) => item.key));
		this.#news = this.#news.filter((item) => !gone.has(item.key));
		if (this.#waiting.size + this.#news.length > 0) this.#soon();
	}
}

/** A scheduled task's latest run, as one value that changes when a run ends. */
const runOf = (schedule: Schedule) => `${schedule.lastRunAt ?? 0}:${schedule.lastStatus ?? ""}`;

/** One line of what an approval asks. */
function askedIn(approval: Approval): string {
	if (approval.kind === "permission")
		return plainLine((approval.request as PermissionRequest).summary);
	const request = approval.request as QuestionRequest;
	return plainLine(request.questions?.[0]?.question ?? request.question ?? "");
}
