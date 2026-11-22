/**
 * Where each session stands on the sessions map, and where its letter lines run. Plain arithmetic
 * with no drawing in it, so the same sessions and letters always give the same picture and a test
 * can check it.
 *
 * The main conversation lies across the top as a bar. Under it the other sessions stand in two banks,
 * left and right, that share one set of rows: first the sessions the main conversation opened, then
 * each team, then the sessions without a team, each group under its heading, the first groups in the
 * left bank. Within a group each session is followed by the sessions it opened, one row lower and one
 * step to the right, so whoever opened a session is always above it.
 *
 * Letter lines run like the wires of a circuit diagram: level and upright only, upright in the three
 * gaps beside the banks. A line of the main conversation drops from the bar down the outer side of
 * the bank its session is in and turns once, into the session. A line between two sessions runs in the
 * rail between the banks; two sessions of the right bank go round its right instead when one of them
 * was opened by another session. So a line never passes under a session; only its two ends, at the
 * edges of the sessions it joins, touch one. Two sessions share one line however the letters went
 * between them: an arrow stands at each end where letters arrived, and the count, beside one of the
 * two sessions, says how many went each way. Each line keeps a lane of its own, and a gap that needs
 * more lanes or more room for a count than it has grows. That is why the layout is worked out together
 * with the lines.
 *
 * This file puts the map together; its parts are in `map/`: the sizes, where the sessions stand, the
 * way of each line, where its ends stand, and where its count goes.
 */

import { acrossNeed, countWidth, type Home, homeOf, placeCounts, stubNeed } from "./map/counts.ts";
import { type Member, sideSlots } from "./map/ends.ts";
import {
	arrange,
	bankEnd,
	frame,
	type Gap,
	headingsOf,
	plainSizes,
	rowTop,
	type Sizes,
	snap,
} from "./map/grid.ts";
import {
	ARROW_ROOM,
	arrowAt,
	BAR_EDGE,
	backOf,
	COLUMN_GAP,
	COUNT_ROOM,
	counted,
	type FlowLine,
	INDENT,
	LANE,
	LANE_EDGE,
	type MapGroup,
	type MapLayout,
	type MapNode,
	type MapSession,
	NODE_H,
	NODE_W,
	PAD,
	START_ROOM,
	totalOf,
} from "./map/model.ts";
import {
	BAR_LOW,
	barEnd,
	type End,
	lanesOf,
	type Plan,
	type Point,
	pathOf,
	route,
	type Which,
} from "./map/route.ts";

export { COUNT_H, MARK_W, pairParts } from "./map/counts.ts";
export type {
	FlowLine,
	FlowRoute,
	MapGroup,
	MapHeading,
	MapLayout,
	MapNode,
	MapSession,
} from "./map/model.ts";
export {
	ARROW_LEN,
	ARROW_W,
	BAR_EDGE,
	COLUMN_GAP,
	CORNER,
	HEAD_H,
	INDENT,
	LANE,
	MAX_ROWS,
	NODE_H,
	NODE_W,
	PAD,
	ROW_GAP,
} from "./map/model.ts";

/** How many times the map is drawn again for counts that found no place. */
const GROW_ROUNDS = 3;

/**
 * The room for stubs and their counts between a bank and the nearest lane: left of the left bank, at
 * the near and the far side of the rail, right of the right bank.
 */
type Zone = "left" | "near" | "far" | "right";

/**
 * The map: where each session stands, and the way of each letter line given. Without lines, or with
 * lines that fit in the gaps as they are, the sessions stand where they would with no lines at all.
 */
export function layoutMap(
	sessions: MapSession[],
	groups: MapGroup[],
	mainId: string | null,
	flows: FlowLine[] = [],
): MapLayout {
	const a = arrange(sessions, groups, mainId);
	const plans = route(a, flows);
	if (plans.length === 0) {
		const plain = frame(a, plainSizes(a));
		const { nodes, width, height } = plain;
		return { nodes, headings: headingsOf(a, plain), flows: [], width, height };
	}
	const lanes = lanesOf(a, plans);
	const laneOf = (plan: Plan) => lanes.get(plan.gap)?.lane.get(plan) ?? 0;
	const laneCount = (gap: Gap) => lanes.get(gap)?.count ?? 0;
	const cellOf = (end: End) => a.cells.get(end.id);
	const rowOf = (end: End) => cellOf(end)?.row ?? 0;
	/** The ends of a line that are at a session: both, or the one that is not at the bar. */
	const atSessions = (plan: Plan) =>
		(["to", "from"] as const).filter((which) => plan[which].side !== "bar");
	/** A session that stands in from the left of its bank has its tree line come in at its left side. */
	const inset = (end: End) => end.side === "left" && (cellOf(end)?.depth ?? 0) > 0;

	// A count stands beside one of its line's two sessions: where fewer counts stand already, then
	// where fewer lines end. A side takes two counts before one goes to the left of a session that
	// stands in from its bank, where the count has to keep away from the session. The busiest lines
	// choose first. A line of the main conversation has its count at its session.
	const sideOf = (end: End) => `${end.id}:${end.side}`;
	const ends = new Map<string, number>();
	for (const plan of plans) {
		for (const which of atSessions(plan)) {
			ends.set(sideOf(plan[which]), (ends.get(sideOf(plan[which])) ?? 0) + 1);
		}
	}
	const hosted = new Map<string, number>();
	for (const plan of plans) {
		if (!counted(plan.flow) || plan.straight) continue;
		let best: Which | null = null;
		let lowest = Number.POSITIVE_INFINITY;
		for (const which of atSessions(plan)) {
			const side = sideOf(plan[which]);
			const value =
				10 * (hosted.get(side) ?? 0) + (inset(plan[which]) ? 15 : 0) + (ends.get(side) ?? 0);
			if (value < lowest) {
				best = which;
				lowest = value;
			}
		}
		if (!best) continue;
		plan.host = best;
		hosted.set(sideOf(plan[best]), (hosted.get(sideOf(plan[best])) ?? 0) + 1);
	}

	// Each gap is as wide as its lanes and the stubs beside them need: a stub with a count is as long
	// as the count, less what its session stands back from the edge of its bank. A line straight across
	// the rail needs the rail to be as wide as its count and its arrows.
	const zoneOf = (plan: Plan, which: Which): Zone =>
		plan.gap !== "rail" ? plan.gap : plan[which].side === "right" ? "near" : "far";
	const zone: Record<Zone, number> = {
		left: LANE_EDGE,
		near: LANE_EDGE,
		far: LANE_EDGE,
		right: LANE_EDGE,
	};
	let across = 0;
	for (const plan of plans) {
		if (plan.straight && counted(plan.flow)) across = Math.max(across, acrossNeed(plan.flow));
		if (plan.host === null) continue;
		const end = plan[plan.host];
		const cell = cellOf(end);
		if (!cell) continue;
		const back =
			end.side === "right" ? (a.banks[cell.bank] ?? 0) - cell.depth * INDENT - NODE_W : 0;
		const key = zoneOf(plan, plan.host);
		zone[key] = Math.max(zone[key], stubNeed(plan.flow, inset(end)) - back);
	}

	// The ends at each side of a session, in order from the top, so that lines leaving one side cross
	// each other as little as they can. Two sessions that face each other across the rail share a
	// stretch of it: their ends take their places together where a stub from the left reaches as far as
	// one from the right, or a line runs straight across; otherwise each side stands around its own
	// middle.
	const ports = new Map<string, Member[]>();
	const join = (port: string, member: Member) =>
		ports.set(port, [...(ports.get(port) ?? []), member]);
	for (const plan of plans) {
		if (plan.straight) {
			join(`rail:${rowOf(plan.from)}`, {
				plan,
				which: ["from", "to"],
				dir: 0,
				reach: 0,
				room: counted(plan.flow) ? COUNT_ROOM : ARROW_ROOM,
				arrow: true,
				right: true,
			});
			continue;
		}
		for (const which of atSessions(plan)) {
			const end = plan[which];
			const other = plan[which === "from" ? "to" : "from"];
			const arrow = arrowAt(plan.flow, which);
			const lane = laneOf(plan);
			join(`${plan.gap}:${rowOf(end)}`, {
				plan,
				which: [which],
				// A line of the main conversation comes down from the bar.
				dir: other.side === "bar" ? -1 : Math.sign(rowOf(other) - rowOf(end)),
				reach: end.side === "right" ? lane : laneCount(plan.gap) - 1 - lane,
				room: plan.host === which ? COUNT_ROOM : arrow ? ARROW_ROOM : START_ROOM,
				arrow,
				right: end.side === "left",
			});
		}
	}
	for (const [port, members] of [...ports]) {
		if (!port.startsWith("rail:")) continue;
		const near = members.filter((member) => !member.right);
		const far = members.filter((member) => member.right);
		if (near.length === 0 || far.length === 0) continue;
		if (members.some((member) => member.which.length > 1)) continue;
		const reachNear = Math.max(...near.map((member) => member.reach));
		const reachFar = Math.min(...far.map((member) => laneCount("rail") - 1 - member.reach));
		if (reachNear >= reachFar) continue;
		ports.set(port, near);
		ports.set(`${port}:far`, far);
	}
	const slots = new Map<Plan, Partial<Record<Which, number>>>();
	for (const [port, members] of ports) {
		members.sort(
			(x, y) =>
				x.dir - y.dir ||
				(x.dir < 0 ? x.reach - y.reach : x.dir > 0 ? y.reach - x.reach : 0) ||
				x.plan.rank - y.plan.rank,
		);
		// The tree line that comes into a session's left side keeps the middle of it.
		const pinned = members.some((member) =>
			member.which.some((which) => {
				const end = member.plan[which];
				return end.side === "left" && (cellOf(end)?.parentId ?? null) !== null;
			}),
		);
		const values = sideSlots(members, rowTop(a, Number(port.split(":")[1])), pinned);
		for (const [i, member] of members.entries()) {
			const at = slots.get(member.plan) ?? {};
			for (const which of member.which) at[which] = values[i] ?? 0;
			slots.set(member.plan, at);
		}
	}

	// Draws the map with the gaps as wide as their lanes and the counts beside them need.
	const draw = () => {
		const lanesWide = (gap: Gap) => Math.max(0, laneCount(gap) - 1) * LANE;
		const plain = plainSizes(a);
		const sizes: Sizes = {
			left: Math.max(
				plain.left,
				laneCount("left") > 0 ? BAR_EDGE + lanesWide("left") + zone.left : 0,
			),
			rail: Math.max(
				plain.rail,
				laneCount("rail") > 0 ? zone.near + lanesWide("rail") + zone.far : 0,
				across,
			),
			// A pixel more than on the left: a lane is moved right, to the middle of its pixel.
			right: Math.max(
				plain.right,
				laneCount("right") > 0
					? Math.max(COLUMN_GAP, zone.right + lanesWide("right") + BAR_EDGE + 1)
					: 0,
			),
		};
		const f = frame(a, sizes);
		const none: MapNode = { id: "", x: 0, y: 0, width: NODE_W, depth: 0, parentId: null };
		const node = (id: string) => f.at.get(id) ?? none;
		// Left of the left bank the lanes keep to the bank, the longest line outermost; right of the
		// right bank the same the other way round; in the rail they stand in its middle.
		const laneX = (plan: Plan): number => {
			const index = laneOf(plan);
			if (plan.gap === "left") {
				return snap((f.bankX[0] ?? PAD) - zone.left - (laneCount("left") - 1 - index) * LANE);
			}
			if (plan.gap === "right") return snap(bankEnd(a, f, 1) + zone.right + index * LANE);
			const spare = sizes.rail - (zone.near + lanesWide("rail") + zone.far);
			return snap(bankEnd(a, f, 0) + zone.near + spare / 2 + index * LANE);
		};
		const edge = (plan: Plan, which: Which): Point => {
			const end = plan[which];
			const at = node(end.id);
			const y = slots.get(plan)?.[which] ?? at.y + NODE_H / 2;
			return [end.side === "left" ? at.x : at.x + at.width, y];
		};

		const pointsOf = new Map<Plan, Point[]>();
		const homes = new Map<Plan, Home>();
		for (const plan of plans) {
			const bar = barEnd(plan);
			let points: Point[];
			if (plan.straight) {
				points = [edge(plan, "from"), edge(plan, "to")];
			} else if (bar) {
				const x = laneX(plan);
				const at = edge(plan, bar === "from" ? "to" : "from");
				const down: Point[] = [[x, BAR_LOW], [x, at[1]], at];
				points = bar === "from" ? down : down.reverse();
			} else {
				const x = laneX(plan);
				const [p, q] = [edge(plan, "from"), edge(plan, "to")];
				points = [p, [x, p[1]], [x, q[1]], q];
			}
			pointsOf.set(plan, points);
			if (plan.host === null) continue;
			const end = plan[plan.host];
			const bank = inset(end) ? (f.bankX[cellOf(end)?.bank ?? 0] ?? null) : null;
			homes.set(plan, homeOf(plan.flow, plan.host, points, bank));
		}
		const headings = headingsOf(a, f);
		return { f, headings, pointsOf, ...placeCounts(plans, pointsOf, homes, f, headings) };
	};

	// Where many ends crowd one side, a count may find no place clear of the others: the room beside
	// that bank then grows by the count's width (a line straight across makes the whole rail wider),
	// and the map is drawn again.
	let drawn = draw();
	for (let round = 0; round < GROW_ROUNDS && drawn.crowded.length > 0; round++) {
		const more: Partial<Record<Zone, number>> = {};
		for (const plan of drawn.crowded) {
			const width = countWidth(plan.flow) + 2;
			if (plan.straight) across = Math.max(across, drawn.f.sizes.rail + width);
			else if (plan.host !== null) {
				const key = zoneOf(plan, plan.host);
				more[key] = Math.max(more[key] ?? 0, width);
			}
		}
		for (const [key, width] of Object.entries(more) as [Zone, number][]) zone[key] += width;
		drawn = draw();
	}

	const { f, headings, pointsOf, spots } = drawn;
	return {
		nodes: f.nodes,
		headings,
		flows: [...plans]
			.sort((p, q) => p.order - q.order)
			.map((plan) => {
				const points = pointsOf.get(plan) ?? [];
				return {
					from: plan.flow.from,
					to: plan.flow.to,
					count: plan.flow.count,
					back: backOf(plan.flow),
					points,
					d: pathOf(points),
					label: spots.get(plan) ?? null,
				};
			}),
		width: f.width,
		height: f.height,
	};
}

/**
 * The letter lines the picture draws, from the letters counted each way. Two sessions that write to
 * each other share one line: it starts at the one named first, which is the one that sent more when
 * the busiest way comes first, and `back` is what came the other way. Only sessions on the map count;
 * the pairs with the most letters come first, at most `limit` of them. `hidden` is how many pairs
 * were left out.
 */
export function pickFlows(
	flows: FlowLine[],
	onMap: ReadonlySet<string>,
	limit: number,
): { drawn: FlowLine[]; hidden: number } {
	const pairs = new Map<string, Map<string, FlowLine>>();
	const lines: FlowLine[] = [];
	for (const { from, to, count } of flows) {
		if (from === to || !onMap.has(from) || !onMap.has(to)) continue;
		const other = pairs.get(to)?.get(from);
		if (other) {
			other.back = backOf(other) + count;
			continue;
		}
		const same = pairs.get(from)?.get(to);
		if (same) {
			same.count += count;
			continue;
		}
		const line: FlowLine = { from, to, count };
		pairs.set(from, (pairs.get(from) ?? new Map()).set(to, line));
		lines.push(line);
	}
	// A stable sort: pairs with as many letters keep the order they came in.
	lines.sort((p, q) => totalOf(q) - totalOf(p));
	return { drawn: lines.slice(0, limit), hidden: Math.max(0, lines.length - limit) };
}

/** The line from a session down to one it opened: down from under its left end, then across. */
export function openedPath(parent: MapNode, child: MapNode): string {
	const x = parent.x + 10;
	const y = child.y + NODE_H / 2;
	return `M${x} ${parent.y + NODE_H} V${y} H${child.x}`;
}
