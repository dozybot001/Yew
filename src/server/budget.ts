import type { Session } from "../shared/types.ts";
import type { Store } from "./store.ts";

/**
 * Daily spending limits: one per session and one for all sessions together, in
 * US dollars as estimated from the providers' prices. A day is a calendar day in this computer's time
 * zone. Models without a price cost nothing here, so a limit never stops them.
 */

/** More room the person gave for one day by continuing after a limit was reached. */
export interface BudgetExtra {
	day: string;
	amount: number;
}

/** A limit that was reached, or came within 80%: for one session or for all of them. */
export interface BudgetMark {
	scope: "session" | "all";
	spent: number;
	limit: number;
}

export const BUDGET_WARN_AT = 0.8;
export const MAX_DAILY_BUDGET = 100_000;

/** The calendar day of a moment in local time, as YYYY-MM-DD. */
export function localDay(at: number): string {
	const date = new Date(at);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The `count` local calendar days that end with the day of `now`, oldest first. */
export function lastDays(now: number, count: number): string[] {
	const end = new Date(now);
	const days: string[] = [];
	for (let back = count - 1; back >= 0; back--) {
		// Noon keeps the step clear of the hour a clock change adds or removes.
		days.push(
			localDay(new Date(end.getFullYear(), end.getMonth(), end.getDate() - back, 12).getTime()),
		);
	}
	return days;
}

/** Whether text is a calendar day written as YYYY-MM-DD. */
export function isDay(text: string): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
	if (!match) return false;
	const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
	return localDay(date.getTime()) === text;
}

/** Checks a limit: dollars above zero, or null for none. */
export function isBudget(value: unknown): value is number | null {
	return (
		value === null ||
		(typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_DAILY_BUDGET)
	);
}

function extraOn(extra: BudgetExtra | null | undefined, day: string): number {
	return extra && extra.day === day ? extra.amount : 0;
}

/** Today's limits with what was spent against each; a scope without a limit is left out. */
export function budgets(store: Store, session: Session, now: number): BudgetMark[] {
	const day = localDay(now);
	const marks: BudgetMark[] = [];
	const own = session.options.dailyBudget;
	if (own) {
		marks.push({
			scope: "session",
			spent: store.spentOn(day, session.id),
			limit: own + extraOn(session.options.budgetExtra, day),
		});
	}
	const all = store.getSetting<number | null>("dailyBudget", null);
	if (all) {
		marks.push({
			scope: "all",
			spent: store.spentOn(day),
			limit: all + extraOn(store.getSetting<BudgetExtra | null>("budgetExtra", null), day),
		});
	}
	return marks;
}

/** The first limit that is used up, the session's own before the shared one. */
export function reached(store: Store, session: Session, now: number): BudgetMark | null {
	return budgets(store, session, now).find((mark) => mark.spent >= mark.limit) ?? null;
}

/** Limits that the request which just cost `cost` took past 80%, without reaching them. */
export function crossedWarning(
	store: Store,
	session: Session,
	cost: number,
	now: number,
): BudgetMark[] {
	if (cost <= 0) return [];
	return budgets(store, session, now).filter((mark) => {
		const line = mark.limit * BUDGET_WARN_AT;
		return mark.spent - cost < line && mark.spent >= line && mark.spent < mark.limit;
	});
}

/**
 * The person continues a session that stopped at a limit: each limit that is used up gets as much
 * room again as the limit itself, for the rest of the day.
 */
export function grantMore(store: Store, session: Session, now: number): void {
	const day = localDay(now);
	for (const mark of budgets(store, session, now)) {
		if (mark.spent < mark.limit) continue;
		const extra = { day, amount: mark.spent };
		if (mark.scope === "session")
			store.updateSession(session.id, { options: { budgetExtra: extra } });
		else store.setSetting("budgetExtra", extra);
	}
}

export function dollars(amount: number): string {
	return `$${amount.toFixed(2)}`;
}
