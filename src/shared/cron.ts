/**
 * Cron expressions for scheduled tasks: five fields in the computer's time zone
 * (minute, hour, day of the month, month, day of the week) with `*`, lists, ranges and steps. Shared by
 * Yew's service and the web interface, which shows the next runs while the person types.
 */

export interface Cron {
	minutes: number[];
	hours: number[];
	days: Set<number>;
	months: Set<number>;
	/** 0 is Sunday; 7 is read as Sunday too. */
	weekdays: Set<number>;
	/**
	 * Whether the day of the month or the day of the week starts with `*`. When neither does, a day
	 * matching either field runs, as cron has always done.
	 */
	anyDay: boolean;
}

/** Which field is wrong, and the part of it that is, so the interface can say so in its language. */
export class CronError extends Error {
	readonly field: number | null;
	readonly part: string;

	constructor(message: string, field: number | null, part: string) {
		super(message);
		this.field = field;
		this.part = part;
	}
}

export const CRON_FIELDS = [
	{ name: "minute", min: 0, max: 59 },
	{ name: "hour", min: 0, max: 23 },
	{ name: "day of the month", min: 1, max: 31 },
	{ name: "month", min: 1, max: 12 },
	{ name: "day of the week", min: 0, max: 7 },
] as const;

function parseField(text: string, index: number): number[] {
	const { name, min, max } = CRON_FIELDS[index] as (typeof CRON_FIELDS)[number];
	const values = new Set<number>();
	for (const part of text.split(",")) {
		const match = /^(?:(\*)|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
		if (!match) throw new CronError(`"${part}" is not a valid ${name}.`, index, part);
		const [, star, from, to, stepText] = match;
		const step = stepText === undefined ? 1 : Number(stepText);
		// "5/15" counts from 5 to the end, as most cron implementations read it.
		const low = star ? min : Number(from);
		const high = star ? max : to !== undefined ? Number(to) : stepText !== undefined ? max : low;
		if (step < 1 || low < min || high > max || low > high) {
			throw new CronError(
				`"${part}" is out of range for the ${name} (${min}–${max}).`,
				index,
				part,
			);
		}
		for (let value = low; value <= high; value += step) values.add(value);
	}
	return [...values].sort((a, b) => a - b);
}

export function parseCron(text: string): Cron {
	const fields = text.trim().split(/\s+/);
	if (fields.length !== 5 || fields[0] === "") {
		throw new CronError(
			"A cron expression has five fields: minute, hour, day of the month, month and day of the week.",
			null,
			text,
		);
	}
	const [minutes, hours, days, months, weekdays] = fields.map((field, index) =>
		parseField(field, index),
	) as [number[], number[], number[], number[], number[]];
	return {
		minutes,
		hours,
		days: new Set(days),
		months: new Set(months),
		weekdays: new Set(weekdays.map((day) => day % 7)),
		anyDay: !(fields[2] as string).startsWith("*") && !(fields[4] as string).startsWith("*"),
	};
}

function dayMatches(cron: Cron, day: Date): boolean {
	if (!cron.months.has(day.getMonth() + 1)) return false;
	const date = cron.days.has(day.getDate());
	const weekday = cron.weekdays.has(day.getDay());
	return cron.anyDay ? date || weekday : date && weekday;
}

/** Far enough for any date that exists, such as February 29 on a Monday. */
const SEARCH_DAYS = 366 * 28;

/**
 * The first time after `after` (in milliseconds) that the expression names, at the start of a minute;
 * null when it names no date that exists, such as February 30. A time the clock skips when daylight
 * saving time starts does not happen that day.
 */
export function nextRun(cron: Cron, after: number): number | null {
	const start = new Date(after);
	start.setSeconds(0, 0);
	start.setMinutes(start.getMinutes() + 1);
	const earliest = start.getTime();
	for (let offset = 0; offset < SEARCH_DAYS; offset++) {
		const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset);
		if (!dayMatches(cron, day)) continue;
		for (const hour of cron.hours) {
			for (const minute of cron.minutes) {
				const time = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
				if (time.getHours() !== hour || time.getMinutes() !== minute) continue;
				if (time.getTime() >= earliest) return time.getTime();
			}
		}
	}
	return null;
}

/** The next `count` runs after `after`. */
export function nextRuns(cron: Cron, after: number, count: number): number[] {
	const runs: number[] = [];
	let from = after;
	while (runs.length < count) {
		const next = nextRun(cron, from);
		if (next === null) break;
		runs.push(next);
		from = next;
	}
	return runs;
}
