/**
 * Where each session stands on the sessions map, and where its letter lines run. Plain arithmetic
 * with no drawing in it, so the same sessions and letters always give the same picture and a test
 * can check it.
 *
 * The main conversation stands alone in the top row. Under it come the columns: first the sessions
 * the main conversation opened, then one column per team, then the sessions without a team. Within a
 * column each session is followed by the sessions it opened, one step lower and one step to the right,
 * so whoever opened a session is always above it. A column that grows long continues in a second one
 * beside it.
 *
 * Letter lines run like the wires of a circuit diagram: level and upright only, upright in the gaps
 * between columns and level in the gaps between rows, or in the band right of and under the main
 * conversation, which has no other session in its row. So a line never passes under a session; only
 * its two ends, at the edges of the sessions it joins, touch one. Each line keeps a lane of its own:
 * lines along the same stretch of a gap run side by side, and a gap that needs more lanes than it has
 * room for grows, as does one where a count needs more room on a short stretch of line. That is why
 * the layout is worked out together with the lines.
 *
 * This file puts the map together; its parts are in `map/`: the sizes, where the sessions stand, the
 * way of each line, where its ends stand, and where its count goes.
 */

import { countWidth, placeCounts, stretchNeed, stubNeed } from "./map/counts.ts";
import { type Member, sideSlots } from "./map/ends.ts";
import {
	arrange,
	edgeOf,
	frame,
	gapMiddle,
	gapSize,
	gapStart,
	headingsOf,
	levelNeed,
	numberOf,
	plainSizes,
	type Sizes,
	snap,
	upright,
} from "./map/grid.ts";
import {
	ARROW_LEN,
	ARROW_ROOM,
	BAND_EDGE,
	COLUMN_GAP,
	COUNT_ROOM,
	type FlowLine,
	LANE,
	LANE_EDGE,
	LOW_EDGE,
	LOW_STEP,
	type MapGroup,
	type MapLayout,
	type MapNode,
	type MapSession,
	NODE_H,
	NODE_W,
	ROW_GAP,
	START_ROOM,
} from "./map/model.ts";
import {
	assignLanes,
	corners,
	type End,
	type Plan,
	type Point,
	pathOf,
	pointAt,
	type Run,
	route,
	runsOf,
	simplify,
	type Which,
} from "./map/route.ts";

export { outline } from "./map/grid.ts";
export type {
	FlowLine,
	FlowRoute,
	MapColumn,
	MapGroup,
	MapLayout,
	MapNode,
	MapSession,
	OutlineItem,
} from "./map/model.ts";
export {
	ARROW_LEN,
	ARROW_W,
	COLUMN_GAP,
	CORNER,
	HEAD_H,
	INDENT,
	MAX_ROWS,
	NODE_H,
	NODE_W,
	PAD,
	ROW_GAP,
} from "./map/model.ts";

/** How many times the map is drawn again for counts that found no place. */
const GROW_ROUNDS = 3;

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
	const plain = frame(a, plainSizes(a));
	const plans = route(a, plain, flows);
	if (plans.length === 0) {
		const { nodes, width, height } = plain;
		return { nodes, columns: headingsOf(a, plain), flows: [], width, height };
	}
	const realMain = a.main?.id ?? null;
	const none: MapNode = { id: "", x: 0, y: 0, depth: 0, parentId: null };

	// Lanes, worked out in the gaps as they are at first: widening a gap moves things apart but never
	// changes which stretches run alongside each other. Upright gaps come first; the level stretches
	// then end where those lanes are, so the two kinds of lane are in step and cross less.
	const roughNode = (id: string) => plain.at.get(id) ?? none;
	const roughSlot = (end: End) => {
		const at = roughNode(end.id);
		return end.side === "bottom" ? at.x + NODE_W - LOW_EDGE - LOW_STEP : at.y + NODE_H / 2;
	};
	const roughly = (lane: (gap: string, plan: Plan) => number) =>
		new Map(
			plans.map((plan) => [
				plan,
				corners(
					plan,
					roughNode,
					(gap) => lane(gap, plan),
					(which) => roughSlot(plan[which]),
				),
			]),
		);
	const lanes = new Map<string, ReturnType<typeof assignLanes>>();
	const runsIn = new Map<string, Run[]>();
	const assignAll = (rough: Map<Plan, Point[]>, kind: (gap: string) => boolean) => {
		for (const plan of plans) {
			for (const run of runsOf(plan, rough.get(plan) ?? [])) {
				if (kind(run.gap)) runsIn.set(run.gap, [...(runsIn.get(run.gap) ?? []), run]);
			}
		}
		for (const [gap, runs] of runsIn) if (kind(gap)) lanes.set(gap, assignLanes(runs));
	};
	const rough = roughly((gap) => gapMiddle(a, plain, gap));
	assignAll(rough, upright);
	assignAll(
		roughly((gap, plan) => {
			const set = lanes.get(gap);
			const index = set?.lane.get(plan);
			return set && index !== undefined && upright(gap)
				? gapMiddle(a, plain, gap) + (index - (set.count - 1) / 2) * LANE
				: gapMiddle(a, plain, gap);
		}),
		(gap) => !upright(gap),
	);
	const laneIndex = (gap: string, plan: Plan) => lanes.get(gap)?.lane.get(plan) ?? 0;

	// A count with no level stretch to stand on goes on the stub at one of its ends: from the session's
	// edge to the first lane in its way, its own or a nearer one that reaches the session's row. At
	// the main conversation's right side no nearer lane is in the way, as the ends there stand in the
	// order of their lanes, the farthest on top. The end chosen is the one where the gap has to grow
	// least, given what the lines before needed; then the one with more room. A line straight across
	// a gap needs the gap to be as wide as its count and its arrow.
	const marginLeft = a.stacks.map(() => LANE_EDGE);
	const marginRight = a.stacks.map(() => LANE_EDGE);
	const across = a.stacks.map(() => 0);
	const stub = (plan: Plan, which: Which) => {
		const end = plan[which];
		const gap = (which === "from" ? plan.gaps[0] : plan.gaps[plan.gaps.length - 1]) ?? "v0";
		const set = lanes.get(gap);
		const own = laneIndex(gap, plan);
		const count = set?.count ?? 1;
		// The end is on the gap's left when it leaves or enters the right side of its session.
		const left = end.side !== "left";
		const at = roughNode(end.id);
		let clear = left ? own : count - 1 - own;
		for (const run of end.id === realMain ? [] : (runsIn.get(gap) ?? [])) {
			const index = set?.lane.get(run.plan);
			if (run.plan === plan || index === undefined) continue;
			const nearer = left ? index < own : index > own;
			if (nearer && run.lo < at.y + NODE_H && run.hi > at.y) {
				clear = Math.min(clear, left ? index : count - 1 - index);
			}
		}
		const slack = left ? gapStart(a, plain, gap) - (at.x + NODE_W) : 0;
		const need = stubNeed(plan.flow.count, which);
		const stack = numberOf(gap);
		const short = need - slack - clear * LANE;
		const margin = (left ? marginLeft : marginRight)[stack] ?? LANE_EDGE;
		return { stack, left, short, grow: Math.max(0, short - margin) };
	};
	for (const plan of plans) {
		if (plan.host === null || !("end" in plan.host)) continue;
		if (plan.straight) {
			const stack = numberOf(plan.gaps[0] ?? "v0");
			const width = countWidth(plan.flow.count) + ARROW_LEN + 6;
			across[stack] = Math.max(across[stack] ?? 0, width);
			continue;
		}
		const [from, to] = [stub(plan, "from"), stub(plan, "to")];
		const which: Which =
			to.grow < from.grow || (to.grow === from.grow && to.short < from.short) ? "to" : "from";
		plan.host = { end: which };
		const { stack, left, short } = which === "to" ? to : from;
		const margins = left ? marginLeft : marginRight;
		margins[stack] = Math.max(margins[stack] ?? LANE_EDGE, short);
	}

	// The ends at each stretch of side, in order from the top (or, under the main conversation, from
	// the right), so that lines leaving one side cross each other as little as they can.
	const ports = new Map<string, Member[]>();
	const join = (port: string, member: Member) =>
		ports.set(port, [...(ports.get(port) ?? []), member]);
	for (const plan of plans) {
		const raw = rough.get(plan) ?? [];
		const counted = (which: Which) =>
			plan.host !== null && "end" in plan.host && plan.host.end === which;
		if (plan.straight) {
			join(plan.from.port, {
				plan,
				which: ["from", "to"],
				dir: 0,
				reach: 0,
				room: counted("from") || counted("to") ? COUNT_ROOM : ARROW_ROOM,
				right: true,
			});
			continue;
		}
		for (const which of ["from", "to"] as const) {
			const end = plan[which];
			const gap = (which === "from" ? plan.gaps[0] : plan.gaps[plan.gaps.length - 1]) ?? "v0";
			const lane = laneIndex(gap, plan);
			const room = counted(which) ? COUNT_ROOM : which === "to" ? ARROW_ROOM : START_ROOM;
			if (end.side === "bottom") {
				join(end.port, { plan, which: [which], dir: 0, reach: lane, room, right: false });
				continue;
			}
			const [at, next] =
				which === "from"
					? [pointAt(raw, 1), pointAt(raw, 2)]
					: [pointAt(raw, raw.length - 2), pointAt(raw, raw.length - 3)];
			const count = lanes.get(gap)?.count ?? 1;
			const reach =
				end.id === realMain
					? numberOf(gap) * 100 + lane
					: end.side === "right"
						? lane
						: count - 1 - lane;
			join(end.port, {
				plan,
				which: [which],
				dir: Math.sign(next[1] - at[1]),
				reach,
				room,
				right: end.side === "left",
			});
		}
	}
	for (const [port, members] of ports) {
		members.sort((x, y) =>
			port === "main:bottom"
				? x.reach - y.reach || x.plan.rank - y.plan.rank
				: x.dir - y.dir ||
					(x.dir < 0 ? x.reach - y.reach : x.dir > 0 ? y.reach - x.reach : 0) ||
					x.plan.rank - y.plan.rank,
		);
	}

	// Draws the map with the gaps as wide as their lanes and the counts on stubs need.
	const draw = () => {
		const sizes: Sizes = {
			after: a.stacks.map((_, stack) => {
				const count = lanes.get(`v${stack}`)?.count ?? 0;
				const left = marginLeft[stack] ?? LANE_EDGE;
				const right = marginRight[stack] ?? LANE_EDGE;
				const lanesNeed = count > 0 ? left + (count - 1) * LANE + right : 0;
				return Math.max(COLUMN_GAP, lanesNeed, across[stack] ?? 0);
			}),
			under: plainSizes(a).under.map((size, row) =>
				Math.max(size, levelNeed(lanes.get(`h${row}`)?.halves ?? [], false)),
			),
			band: Math.max(2 * ROW_GAP, levelNeed(lanes.get("m")?.halves ?? [], true)),
		};
		const f = frame(a, sizes);
		const node = (id: string) => f.at.get(id) ?? none;

		const laneAt = (gap: string, plan: Plan): number => {
			const set = lanes.get(gap);
			const index = set?.lane.get(plan);
			// A straight line has no lane; where it would be does not matter.
			if (!set || index === undefined) return gapMiddle(a, f, gap);
			const start = gapStart(a, f, gap);
			const size = gapSize(f, gap);
			if (upright(gap)) {
				const left = marginLeft[numberOf(gap)] ?? LANE_EDGE;
				const right = marginRight[numberOf(gap)] ?? LANE_EDGE;
				const used = left + (set.count - 1) * LANE + right;
				return snap(start + left + (size - used) / 2 + index * LANE);
			}
			const band = gap === "m";
			let y =
				start +
				(band ? BAND_EDGE : edgeOf(set.halves[0])) +
				(size - levelNeed(set.halves, band)) / 2;
			for (let i = 1; i <= index; i++) y += (set.halves[i - 1] ?? 0) + (set.halves[i] ?? 0);
			return snap(y);
		};

		const slots = new Map<Plan, Partial<Record<Which, number>>>();
		for (const [port, members] of ports) {
			let values: number[];
			if (port === "main:bottom") {
				const main = node(realMain ?? "");
				const step =
					members.length > 1
						? Math.min(LOW_STEP, (NODE_W - 2 * LOW_EDGE) / (members.length - 1))
						: 0;
				values = members.map((_, i) => snap(main.x + NODE_W - LOW_EDGE - i * step));
			} else if (port === "main:right") {
				values = sideSlots(members, node(realMain ?? "").y, false);
			} else {
				const [gap = 0, row = 0] = port.slice(1).split(":").map(Number);
				const beside = a.stacks[gap + 1]?.cells[row];
				const pinned =
					beside !== undefined &&
					beside.parentId !== null &&
					members.some((member) => member.right);
				values = sideSlots(members, f.rowY[row] ?? 0, pinned);
			}
			for (const [i, member] of members.entries()) {
				const at = slots.get(member.plan) ?? {};
				for (const which of member.which) at[which] = values[i] ?? 0;
				slots.set(member.plan, at);
			}
		}

		const pointsOf = new Map<Plan, Point[]>();
		const hostOf = new Map<Plan, number>();
		for (const plan of plans) {
			const points = simplify(
				corners(
					plan,
					node,
					(gap) => laneAt(gap, plan),
					(which) => slots.get(plan)?.[which] ?? 0,
				),
			);
			pointsOf.set(plan, points);
			const host = plan.host;
			let index = 1;
			if (host && "gap" in host) {
				const y = laneAt(host.gap, plan);
				index = points.findIndex(
					(point, i) => i > 0 && point[1] === y && pointAt(points, i - 1)[1] === y,
				);
			} else if (host?.end === "to") {
				index = points.length - 1;
			}
			hostOf.set(plan, index);
		}

		const columns = headingsOf(a, f);
		return { f, columns, pointsOf, hostOf, ...placeCounts(plans, pointsOf, hostOf, f, columns) };
	};

	// Where many ends crowd one side, a count on a stub may find no place clear of the others: the gap
	// then grows by its width on that side (a line straight across makes the whole gap wider), and the
	// map is drawn again. So it is for a count under the main conversation whose line turns down the
	// first gap after a level stretch too short to hold it: that gap's lanes move right.
	let drawn = draw();
	for (let round = 0; round < GROW_ROUNDS && drawn.crowded.length > 0; round++) {
		let grown = false;
		for (const plan of drawn.crowded) {
			if (plan.host === null) continue;
			if ("gap" in plan.host) {
				const points = drawn.pointsOf.get(plan) ?? [];
				const index = drawn.hostOf.get(plan) ?? 0;
				const gap = plan.gaps[plan.gaps.indexOf("m") + (plan.from.side === "bottom" ? 1 : -1)];
				if (plan.host.gap !== "m" || index < 1 || gap === undefined) continue;
				const [p, q] = [pointAt(points, index - 1), pointAt(points, index)];
				const short = stretchNeed(plan.flow.count) - Math.abs(q[0] - p[0]);
				if (short <= 0) continue;
				// From the gap's left edge to its first lane, as drawn, and as much more as is missing.
				const first =
					Math.max(p[0], q[0]) - laneIndex(gap, plan) * LANE - gapStart(a, drawn.f, gap);
				const stack = numberOf(gap);
				marginLeft[stack] = Math.max(marginLeft[stack] ?? LANE_EDGE, Math.ceil(first + short) + 1);
				grown = true;
				continue;
			}
			const which = plan.host.end;
			const gap = (which === "from" ? plan.gaps[0] : plan.gaps[plan.gaps.length - 1]) ?? "v0";
			if (!upright(gap)) continue;
			const stack = numberOf(gap);
			const more = countWidth(plan.flow.count) + 2;
			if (plan.straight) {
				across[stack] = (drawn.f.sizes.after[stack] ?? COLUMN_GAP) + more;
			} else {
				const margins = plan[which].side === "left" ? marginRight : marginLeft;
				margins[stack] = (margins[stack] ?? LANE_EDGE) + more;
			}
			grown = true;
		}
		if (!grown) break;
		drawn = draw();
	}

	const { f, columns, pointsOf, spots } = drawn;
	return {
		nodes: f.nodes,
		columns,
		flows: [...plans]
			.sort((p, q) => p.order - q.order)
			.map((plan) => {
				const points = pointsOf.get(plan) ?? [];
				return {
					from: plan.flow.from,
					to: plan.flow.to,
					count: plan.flow.count,
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
 * The letter lines the picture draws: at most `limit`, the busiest pairs first (the order they arrive
 * in), and only between sessions that are on the map. `hidden` is how many were left out.
 */
export function pickFlows<T extends FlowLine>(
	flows: T[],
	onMap: ReadonlySet<string>,
	limit: number,
): { drawn: T[]; hidden: number } {
	const known = flows.filter((flow) => onMap.has(flow.from) && onMap.has(flow.to));
	return { drawn: known.slice(0, limit), hidden: Math.max(0, known.length - limit) };
}

/** The line from a session down to one it opened: down from under its left end, then across. */
export function openedPath(parent: MapNode, child: MapNode): string {
	const x = parent.x + 10;
	const y = child.y + NODE_H / 2;
	return `M${x} ${parent.y + NODE_H} V${y} H${child.x}`;
}
