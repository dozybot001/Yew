/**
 * The way of each letter line through the gaps of the map: which sides of its two sessions it leaves
 * and enters, which gaps it runs along, and which lane it keeps in each.
 */

import {
	type Arrangement,
	compare,
	type Frame,
	gapMiddle,
	lanesBefore,
	numberOf,
	upright,
} from "./grid.ts";
import {
	ARROW_ROOM,
	arrowAt,
	CORNER,
	COUNT_HALF,
	COUNT_ROOM,
	counted,
	type FlowLine,
	LINE_HALF,
	LOW_EDGE,
	LOW_STEP,
	type MapNode,
	NODE_H,
	NODE_W,
	SIDE_EDGE,
	START_ROOM,
	totalOf,
} from "./model.ts";

/** A side holds this many ends before the router turns to another. */
const SIDE_ENDS = 5;
/**
 * What a way costs, a pixel of length counting 1: a corner, a tree line crossed, another line along
 * the same stretch of a gap, a gap made wider, an end at a side that is already full.
 */
const BEND = 20;
const TREE = 10;
const CROWD = 3;
const WIDEN = 24;
const FULL = 200;
/** Two stretches of line this close along a gap may not share a lane. */
const NEAR = 24;

type Side = "left" | "right" | "bottom";
export type Which = "from" | "to";

/** One end of a line: the session, its side, and the stretch of side it shares with other ends. */
export interface End {
	id: string;
	side: Side;
	port: string;
}

/** A line's way through the gaps. */
export interface Plan {
	flow: FlowLine;
	/** Its place among the lines given. */
	order: number;
	/** Its place in the order the lines were routed: the busiest first. */
	rank: number;
	from: End;
	to: End;
	/** The gaps it runs along between its ends; upright and level ones take turns. */
	gaps: string[];
	/** Straight across one gap, between two sessions that face each other. */
	straight: boolean;
	/** Where its count goes: on its lane in a level gap, or on the stub at one end. */
	host: { gap: string } | { end: Which } | null;
}

/** The stretch a line runs along one gap, and where it goes on at each end. */
export interface Run {
	plan: Plan;
	gap: string;
	lo: number;
	hi: number;
	/** Where the line turns at the low and the high end: -1 toward left or up, 1 toward right or down. */
	turnLo: number;
	turnHi: number;
	counted: boolean;
}

export type Point = [number, number];

export const pointAt = (points: Point[], i: number): Point => points[i] ?? [0, 0];

/**
 * The corners of a plan, given where its lanes and its ends are. Each gap adds the point where the
 * line enters it and the one where it leaves, so a corner shared by two gaps comes twice.
 */
export function corners(
	plan: Plan,
	node: (id: string) => MapNode,
	lane: (gap: string) => number,
	slot: (which: Which) => number,
): Point[] {
	const end = (which: Which): Point => {
		const { id, side } = plan[which];
		const at = node(id);
		if (side === "left") return [at.x, slot(which)];
		if (side === "right") return [at.x + NODE_W, slot(which)];
		return [slot(which), at.y + NODE_H];
	};
	const start = end("from");
	const finish = end("to");
	const out: Point[] = [start];
	let [x, y] = start;
	for (const [i, gap] of plan.gaps.entries()) {
		const next = plan.gaps[i + 1];
		if (upright(gap)) {
			const at = lane(gap);
			const to = next === undefined ? finish[1] : lane(next);
			out.push([at, y], [at, to]);
			x = at;
			y = to;
		} else {
			const at = lane(gap);
			const to = next === undefined ? finish[0] : lane(next);
			out.push([x, at], [to, at]);
			x = to;
			y = at;
		}
	}
	out.push(finish);
	return out;
}

/** The corners without repeats and without points in the middle of a straight stretch. */
export function simplify(points: Point[]): Point[] {
	const out: Point[] = [];
	for (const point of points) {
		const last = out[out.length - 1];
		if (last && last[0] === point[0] && last[1] === point[1]) continue;
		const before = out[out.length - 2];
		if (
			before &&
			last &&
			((before[0] === last[0] && last[0] === point[0]) ||
				(before[1] === last[1] && last[1] === point[1]))
		) {
			out.pop();
		}
		out.push(point);
	}
	return out;
}

/** The stretches a plan runs along its gaps, from its corners as `corners` gives them. */
export function runsOf(plan: Plan, raw: Point[]): Run[] {
	if (plan.straight) return [];
	const last = plan.gaps.length - 1;
	return plan.gaps.map((gap, i) => {
		// Along an upright gap the line moves in y and turns off in x; along a level one the other way.
		const along = (point: Point) => (upright(gap) ? point[1] : point[0]);
		const across = (point: Point) => (upright(gap) ? point[0] : point[1]);
		const before = pointAt(raw, i === 0 ? 0 : 2 * i - 1);
		const enter = pointAt(raw, 2 * i + 1);
		const leave = pointAt(raw, 2 * i + 2);
		const after = pointAt(raw, i === last ? 2 * i + 3 : 2 * i + 4);
		const turnIn = Math.sign(across(before) - across(enter));
		const turnOut = Math.sign(across(after) - across(leave));
		const forward = along(enter) <= along(leave);
		return {
			plan,
			gap,
			lo: Math.min(along(enter), along(leave)),
			hi: Math.max(along(enter), along(leave)),
			turnLo: forward ? turnIn : turnOut,
			turnHi: forward ? turnOut : turnIn,
			counted: plan.host !== null && "gap" in plan.host && plan.host.gap === gap,
		};
	});
}

const close = (a: Run, b: Run) => a.lo <= b.hi + NEAR && b.lo <= a.hi + NEAR;

/**
 * Lanes across a gap, numbered from its left or top. The order keeps crossings few: a line that turns
 * back to the same side at both ends runs nearest that side, the shorter of two such lines nearer
 * still; one that comes in from one side and leaves to the other runs in the middle, in the order
 * that lets the two pass without crossing. A line takes the first lane past every line already given
 * a lane that runs along the same stretch.
 */
export function assignLanes(runs: Run[]): {
	lane: Map<Plan, number>;
	count: number;
	halves: number[];
} {
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
	const halves: number[] = [];
	for (const run of sorted) {
		let index = 0;
		for (const other of placed) if (close(run, other.run)) index = Math.max(index, other.lane + 1);
		placed.push({ run, lane: index });
		lane.set(run.plan, index);
		halves[index] = Math.max(halves[index] ?? 0, run.counted ? COUNT_HALF : LINE_HALF);
	}
	return { lane, count: halves.length, halves };
}

/**
 * Picks the way of every line, the ones with most letters first, each the cheapest given the ones
 * before it: shortest, fewest corners, least crowding. Between two columns a line leaves the side of
 * one session and enters the side of the other through the gaps next to them, crossing the columns
 * between in a level gap; within one column it goes round by the gap on the right. The main
 * conversation's lines run right of it and then down the gap next to the other session; the ones that
 * do not fit at its right side leave from its lower edge through the band under it.
 */
export function route(a: Arrangement, f: Frame, flows: FlowLine[]): Plan[] {
	const mainId = a.main?.id ?? null;
	const none: MapNode = { id: "", x: 0, y: 0, depth: 0, parentId: null };
	const node = (id: string) => f.at.get(id) ?? none;
	const lane = (gap: string) => gapMiddle(a, f, gap);
	const slot = (end: End) => {
		const at = node(end.id);
		return end.side === "bottom" ? at.x + NODE_W - LOW_EDGE - LOW_STEP : at.y + NODE_H / 2;
	};
	const rough = (plan: Plan) => corners(plan, node, lane, (which) => slot(plan[which]));
	const levels = [
		...Array.from({ length: a.rows }, (_, row) => `h${row}`),
		...(a.main ? ["m"] : []),
	];

	const sides = (id: string): End[] => {
		const cell = a.cells.get(id);
		if (!cell) return [];
		const right: End = { id, side: "right", port: `v${cell.stack}:${cell.row}` };
		return cell.stack === 0
			? [right]
			: [right, { id, side: "left", port: `v${cell.stack - 1}:${cell.row}` }];
	};
	const gapOf = (end: End) => (a.cells.get(end.id)?.stack ?? 0) - (end.side === "left" ? 1 : 0);

	type Option = Omit<Plan, "order" | "rank" | "host">;
	const options = (flow: FlowLine): Option[] => {
		const out: Option[] = [];
		if (mainId !== null && (flow.from === mainId || flow.to === mainId)) {
			const main: End = { id: mainId, side: "right", port: "main:right" };
			for (const end of sides(flow.from === mainId ? flow.to : flow.from)) {
				const gaps = [`v${gapOf(end)}`];
				out.push(
					flow.from === mainId
						? { flow, from: main, to: end, gaps, straight: false }
						: { flow, from: end, to: main, gaps, straight: false },
				);
			}
			return out;
		}
		const p = a.cells.get(flow.from);
		const q = a.cells.get(flow.to);
		if (!p || !q) return out;
		for (const from of sides(flow.from)) {
			for (const to of sides(flow.to)) {
				// Two sessions of one column: round by the gap on its right.
				if (p.stack === q.stack && (from.side !== "right" || to.side !== "right")) continue;
				const [g, h] = [gapOf(from), gapOf(to)];
				if (g === h) out.push({ flow, from, to, gaps: [`v${g}`], straight: p.row === q.row });
				else {
					for (const level of levels) {
						out.push({ flow, from, to, gaps: [`v${g}`, level, `v${h}`], straight: false });
					}
				}
			}
		}
		return out;
	};

	const taken = new Map<string, Run[]>();
	const ends = new Map<string, number>();
	const cost = (option: Option): number => {
		const plan: Plan = { ...option, order: 0, rank: 0, host: null };
		const raw = rough(plan);
		const line = simplify(raw);
		let total = BEND * (line.length - 2);
		for (let i = 1; i < line.length; i++) {
			const [p, q] = [pointAt(line, i - 1), pointAt(line, i)];
			total += Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]);
		}
		for (const end of [plan.from, plan.to]) {
			if (end.side === "left") total += TREE * (a.cells.get(end.id)?.depth ?? 0);
			if (end.id !== mainId) total += FULL * Math.max(0, (ends.get(end.port) ?? 0) + 1 - SIDE_ENDS);
		}
		for (const run of runsOf(plan, raw)) {
			const crowd = (taken.get(run.gap) ?? []).filter((other) => close(run, other)).length;
			total += CROWD * crowd + WIDEN * Math.max(0, crowd + 1 - lanesBefore(a, run.gap));
		}
		return total;
	};

	const queue = flows
		.map((flow, order) => ({ flow, order }))
		.filter(({ flow }) => flow.from !== flow.to && f.at.has(flow.from) && f.at.has(flow.to))
		.sort(
			(x, y) =>
				totalOf(y.flow) - totalOf(x.flow) ||
				compare(x.flow.from, y.flow.from) ||
				compare(x.flow.to, y.flow.to) ||
				x.order - y.order,
		);
	const plans: Plan[] = [];
	for (const { flow, order } of queue) {
		let best: Option | null = null;
		let lowest = Number.POSITIVE_INFINITY;
		for (const option of options(flow)) {
			const value = cost(option);
			if (value < lowest) {
				best = option;
				lowest = value;
			}
		}
		if (!best) continue;
		const plan: Plan = { ...best, order, rank: plans.length, host: null };
		plans.push(plan);
		for (const run of runsOf(plan, rough(plan))) {
			taken.set(run.gap, [...(taken.get(run.gap) ?? []), run]);
		}
		for (const port of new Set([plan.from.port, plan.to.port])) {
			ends.set(port, (ends.get(port) ?? 0) + 1);
		}
	}

	// The main conversation's right side takes the lines that go farthest, as many as fit; the rest
	// leave from its lower edge. Lines from the right side then drop down past the band, never across
	// a line of the band.
	if (mainId !== null) {
		const mainGap = (plan: Plan) =>
			numberOf((plan.from.id === mainId ? plan.gaps[0] : plan.gaps[plan.gaps.length - 1]) ?? "v0");
		const touching = plans
			.filter((plan) => plan.from.id === mainId || plan.to.id === mainId)
			.sort((x, y) => mainGap(y) - mainGap(x) || x.rank - y.rank);
		let span = -1;
		let previous = 0;
		let full = false;
		for (const plan of touching) {
			const which: Which = plan.from.id === mainId ? "from" : "to";
			const room = counted(plan.flow)
				? COUNT_ROOM
				: arrowAt(plan.flow, which)
					? ARROW_ROOM
					: START_ROOM;
			const next = span < 0 ? 0 : span + previous + room;
			if (!full && next <= NODE_H - 2 * SIDE_EDGE) {
				span = next;
				previous = room;
				continue;
			}
			full = true;
			plan[which] = { id: mainId, side: "bottom", port: "main:bottom" };
			plan.gaps = which === "from" ? ["m", ...plan.gaps] : [...plan.gaps, "m"];
		}
	}

	// A count goes on its line's level stretch across a gap. A line without one has its count on the
	// stub at one of its ends, which `layoutMap` picks once the lanes are known.
	for (const plan of plans) {
		if (!counted(plan.flow)) continue;
		const level = plan.gaps.find((gap) => !upright(gap));
		plan.host = level ? { gap: level } : { end: "from" };
	}
	return plans;
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
