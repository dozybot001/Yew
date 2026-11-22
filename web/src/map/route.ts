/**
 * The way of each letter line: which gap beside the banks it runs in, which sides of its two sessions
 * it leaves and enters, and which lane of the gap it keeps.
 */

import { type Arrangement, type Cell, compare, type Gap, rowTop } from "./grid.ts";
import { CORNER, type FlowLine, NODE_H, PAD, totalOf } from "./model.ts";

/** Two stretches of line this close along a gap may not share a lane. */
const NEAR = 24;

export type Which = "from" | "to";

/** One end of a line: a session and its side, or the lower edge of the main conversation's bar. */
export interface End {
	id: string;
	side: "left" | "right" | "bar";
}

/** A line's way. */
export interface Plan {
	flow: FlowLine;
	/** Its place among the lines given. */
	order: number;
	/** Its place among the lines drawn, the busiest first. */
	rank: number;
	from: End;
	to: End;
	gap: Gap;
	/** Straight across the rail, between two sessions that face each other. */
	straight: boolean;
	/** The end its count stands beside. A straight line has its count along itself. */
	host: Which | null;
}

export type Point = [number, number];

export const pointAt = (points: Point[], i: number): Point => points[i] ?? [0, 0];

/** The end of a line that is at the bar, if one is. */
export const barEnd = (plan: Plan): Which | null =>
	plan.from.side === "bar" ? "from" : plan.to.side === "bar" ? "to" : null;

/** The lower edge of the main conversation's bar, where its lines leave it. */
export const BAR_LOW = PAD + NODE_H;

/**
 * The way of every line, by where its two sessions stand. A line of the main conversation drops from
 * the bar down the outer side of the bank its session is in: left of the left bank, right of the right
 * one. A line between two sessions runs in the rail between the banks. The one exception is two
 * sessions of the right bank of which one was opened by another session: the tree line comes in at
 * that one's left side, so their line goes round the right of the bank.
 */
export function route(a: Arrangement, flows: FlowLine[]): Plan[] {
	const mainId = a.main?.id ?? null;
	const known = (id: string) => a.cells.has(id) || id === mainId;
	return flows
		.map((flow, order) => ({ flow, order }))
		.filter(({ flow }) => flow.from !== flow.to && known(flow.from) && known(flow.to))
		.sort(
			(x, y) =>
				totalOf(y.flow) - totalOf(x.flow) ||
				compare(x.flow.from, y.flow.from) ||
				compare(x.flow.to, y.flow.to) ||
				x.order - y.order,
		)
		.map(({ flow, order }, rank): Plan => {
			const p = a.cells.get(flow.from);
			const q = a.cells.get(flow.to);
			const plan = { flow, order, rank, straight: false, host: null };
			if (!p || !q) {
				const bank = (p ?? q)?.bank ?? 0;
				const gap: Gap = bank === 0 ? "left" : "right";
				const end = (id: string): End =>
					id === mainId ? { id, side: "bar" } : { id, side: bank === 0 ? "left" : "right" };
				return { ...plan, from: end(flow.from), to: end(flow.to), gap };
			}
			const round = p.bank === 1 && q.bank === 1 && (p.depth > 0 || q.depth > 0);
			const gap: Gap = round ? "right" : "rail";
			// The rail is right of the left bank and left of the right one.
			const end = (cell: Cell): End => ({
				id: cell.session.id,
				side: (gap === "rail") === (cell.bank === 0) ? "right" : "left",
			});
			return {
				...plan,
				from: end(p),
				to: end(q),
				gap,
				straight: p.bank !== q.bank && p.row === q.row,
			};
		});
}

/** The stretch a line runs along its gap, and where it goes on at each end. */
interface Run {
	plan: Plan;
	lo: number;
	hi: number;
	/** Where the line turns at the upper and the lower end: -1 toward the left, 1 toward the right, 0 not at all. */
	turnLo: number;
	turnHi: number;
}

const close = (a: Run, b: Run) => a.lo <= b.hi + NEAR && b.lo <= a.hi + NEAR;

/**
 * Lanes across a gap, numbered from its left. The order keeps crossings few: a line that turns back to
 * the same side at both ends runs nearest that side, the shorter of two such lines nearer still; one
 * that comes in from one side and leaves to the other runs in the middle, in the order that lets the
 * two pass without crossing. A line takes the first lane past every line already given a lane that
 * runs along the same stretch.
 */
function assignLanes(runs: Run[]): Lanes {
	const key = (run: Run): [number, number] => {
		const length = run.hi - run.lo;
		const middle = (run.lo + run.hi) / 2;
		if (run.turnLo + run.turnHi < 0) return [0, length];
		if (run.turnLo + run.turnHi > 0) return [3, -length];
		return run.turnLo < 0 ? [1, -middle] : [2, middle];
	};
	const sorted = [...runs].sort((a, b) => {
		const [groupA, valueA] = key(a);
		const [groupB, valueB] = key(b);
		return groupA - groupB || valueA - valueB || a.plan.rank - b.plan.rank;
	});
	const placed: { run: Run; lane: number }[] = [];
	const lane = new Map<Plan, number>();
	let count = 0;
	for (const run of sorted) {
		let index = 0;
		for (const other of placed) if (close(run, other.run)) index = Math.max(index, other.lane + 1);
		placed.push({ run, lane: index });
		lane.set(run.plan, index);
		count = Math.max(count, index + 1);
	}
	return { lane, count };
}

/** The lanes of one gap: each line's, and how many there are. */
export interface Lanes {
	lane: Map<Plan, number>;
	count: number;
}

/**
 * The lanes of every gap. A line of the main conversation runs from the bar down to its session and
 * turns once, toward the bank: the farther down it goes, the farther out its lane, so these lines
 * never cross each other.
 */
export function lanesOf(a: Arrangement, plans: Plan[]): Map<Gap, Lanes> {
	const middle = (end: End) => rowTop(a, a.cells.get(end.id)?.row ?? 0) + NODE_H / 2;
	const runs = new Map<Gap, Run[]>();
	for (const plan of plans) {
		if (plan.straight) continue;
		// Toward the bank the end is on.
		const turn = (which: Which) => (plan[which].side === "right" ? -1 : 1);
		const bar = barEnd(plan);
		let run: Run;
		if (bar) {
			const other: Which = bar === "from" ? "to" : "from";
			run = { plan, lo: BAR_LOW, hi: middle(plan[other]), turnLo: 0, turnHi: turn(other) };
		} else {
			const [from, to] = [middle(plan.from), middle(plan.to)];
			const down = from <= to;
			run = {
				plan,
				lo: Math.min(from, to),
				hi: Math.max(from, to),
				turnLo: turn(down ? "from" : "to"),
				turnHi: turn(down ? "to" : "from"),
			};
		}
		runs.set(plan.gap, [...(runs.get(plan.gap) ?? []), run]);
	}
	return new Map([...runs].map(([gap, list]) => [gap, assignLanes(list)]));
}

/** An SVG path through the corners, each corner rounded. */
export function pathOf(points: Point[]): string {
	const n = (value: number) => String(Math.round(value * 100) / 100);
	const [first] = points;
	if (!first) return "";
	let d = `M${n(first[0])} ${n(first[1])}`;
	for (let i = 1; i < points.length - 1; i++) {
		const [p, c, q] = [pointAt(points, i - 1), pointAt(points, i), pointAt(points, i + 1)];
		const r = Math.min(
			CORNER,
			(Math.abs(c[0] - p[0]) + Math.abs(c[1] - p[1])) / 2,
			(Math.abs(q[0] - c[0]) + Math.abs(q[1] - c[1])) / 2,
		);
		const a: Point = [c[0] - Math.sign(c[0] - p[0]) * r, c[1] - Math.sign(c[1] - p[1]) * r];
		const b: Point = [c[0] + Math.sign(q[0] - c[0]) * r, c[1] + Math.sign(q[1] - c[1]) * r];
		d += ` L${n(a[0])} ${n(a[1])} Q${n(c[0])} ${n(c[1])} ${n(b[0])} ${n(b[1])}`;
	}
	const last = pointAt(points, points.length - 1);
	return `${d} L${n(last[0])} ${n(last[1])}`;
}
