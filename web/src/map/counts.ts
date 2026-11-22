/**
 * The count on a letter line that carried more than one letter: the room it takes, and where on the
 * line it stands.
 */

import type { Frame } from "./grid.ts";
import {
	ARROW_LEN,
	arrowAt,
	backOf,
	CORNER,
	counted,
	type FlowLine,
	type MapColumn,
	NODE_H,
	NODE_W,
} from "./model.ts";
import { type Plan, type Point, pointAt, type Which } from "./route.ts";

/** The count with its margin of page colour: the width of a digit, and the height. */
const DIGIT_W = 7;
export const COUNT_H = 11;
/**
 * A line that carried letters both ways has two numbers side by side on a ground of page colour, each
 * with a small mark on its outer side that points the way those letters went: the mark's width, its
 * distance from its number, the room between the two numbers, and the ground beyond each mark, which
 * keeps a mark apart from the arrow at the line's end.
 */
export const MARK_W = 4;
const MARK_GAP = 2;
const PAIR_GAP = 8;
const PAIR_EDGE = 4;

const digits = (count: number) => String(count).length * DIGIT_W;
const halfWidth = (count: number) => MARK_W + MARK_GAP + digits(count);
const pairWidth = (one: number, other: number) =>
	halfWidth(one) + PAIR_GAP + halfWidth(other) + 2 * PAIR_EDGE;

export const countWidth = (flow: FlowLine) =>
	backOf(flow) > 0 ? pairWidth(flow.count, backOf(flow)) : digits(flow.count) + 3;

/**
 * Where the parts of a count that goes both ways stand, around its middle `x`: its ground reaches
 * from `x0` to `x1`; the number of the letters that went left ends at `leftEnd` and its mark points
 * left from `leftMark`; the number of the ones that went right starts at `rightStart` and its mark
 * points right from `rightMark`.
 */
export function pairParts(left: number, right: number, x: number) {
	const width = pairWidth(left, right);
	const x0 = x - width / 2;
	const leftEnd = x0 + PAIR_EDGE + halfWidth(left);
	const rightStart = leftEnd + PAIR_GAP;
	return {
		x0,
		x1: x0 + width,
		leftMark: x0 + PAIR_EDGE + MARK_W,
		leftEnd,
		rightStart,
		rightMark: rightStart + digits(right) + MARK_GAP,
	};
}

/**
 * The room a count takes on a stub, from the session's edge (or arrow) to the first lane, and a pixel
 * more, as the lane is moved to the middle of a pixel.
 */
export const stubNeed = (flow: FlowLine, which: Which) =>
	countWidth(flow) + (arrowAt(flow, which) ? ARROW_LEN + 2 : 2) + CORNER + 3;

/** How long a level stretch between two corners has to be for a count to stand on it. */
export const stretchNeed = (flow: FlowLine) => countWidth(flow) + 2 * (CORNER + 2);

interface Box {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

const hit = (p: Box, q: Box) => p.x0 < q.x1 && q.x0 < p.x1 && p.y0 < q.y1 && q.y0 < p.y1;

const countBox = (spot: { x: number; y: number }, width: number): Box => ({
	x0: spot.x - width / 2,
	y0: spot.y - COUNT_H / 2,
	x1: spot.x + width / 2,
	y1: spot.y + COUNT_H / 2,
});

const lineBox = (p: Point, q: Point, half: number): Box => ({
	x0: Math.min(p[0], q[0]) - half,
	y0: Math.min(p[1], q[1]) - half,
	x1: Math.max(p[0], q[0]) + half,
	y1: Math.max(p[1], q[1]) + half,
});

/** Where a count stands: its middle, and whether its line runs left to right there. */
export interface Spot {
	x: number;
	y: number;
	forward: boolean;
}

/** Places along a line's level stretches where its count may stand, the best first. */
function countSpots(points: Point[], flow: FlowLine, host: number): Spot[] {
	const width = countWidth(flow);
	const stretches: { index: number; from: number; to: number; y: number; forward: boolean }[] = [];
	for (let i = 1; i < points.length; i++) {
		const [p, q] = [pointAt(points, i - 1), pointAt(points, i)];
		if (p[1] !== q[1]) continue;
		// Clear of the corners, of the edges of the two sessions, and of the arrows there.
		const atP = i === 1 ? (arrowAt(flow, "from") ? ARROW_LEN + 2 : 2) : CORNER + 2;
		const atQ = i === points.length - 1 ? ARROW_LEN + 2 : CORNER + 2;
		const forward = p[0] < q[0];
		const [from, to] = forward
			? [p[0] + atP + width / 2, q[0] - atQ - width / 2]
			: [q[0] + atQ + width / 2, p[0] - atP - width / 2];
		if (from <= to) stretches.push({ index: i, from, to, y: p[1], forward });
	}
	stretches.sort(
		(s, t) =>
			Number(t.index === host) - Number(s.index === host) ||
			t.to - t.from - (s.to - s.from) ||
			s.index - t.index,
	);
	const spots: Spot[] = [];
	for (const { from, to, y, forward } of stretches) {
		const middle = Math.round(from + to) / 2;
		spots.push({ x: middle, y, forward });
		for (let step = 3; middle - step >= from || middle + step <= to; step += 3) {
			if (middle - step >= from) spots.push({ x: middle - step, y, forward });
			if (middle + step <= to) spots.push({ x: middle + step, y, forward });
		}
	}
	return spots;
}

/**
 * Where each count stands: on a level stretch of its line, clear of every session and every other
 * count, and if it can be, clear of other lines and of the tree lines and headings as well. Busier
 * lines choose first.
 */
export function placeCounts(
	plans: Plan[],
	pointsOf: Map<Plan, Point[]>,
	hostOf: Map<Plan, number>,
	f: Frame,
	columns: MapColumn[],
): { spots: Map<Plan, Spot>; crowded: Plan[] } {
	// What may be covered, if nothing better is free: 0 never, 1 a line crossing, 2 a line alongside or
	// an arrow, 3 a tree line or a heading.
	const blocks: { box: Box; kind: number; plan: Plan | null }[] = [];
	for (const node of f.nodes) {
		blocks.push({
			box: { x0: node.x, y0: node.y, x1: node.x + NODE_W, y1: node.y + NODE_H },
			kind: 0,
			plan: null,
		});
		const parent = node.parentId ? f.at.get(node.parentId) : undefined;
		if (parent) {
			const x = parent.x + 10;
			const y = node.y + NODE_H / 2;
			blocks.push({ box: lineBox([x, parent.y + NODE_H], [x, y], 1.5), kind: 3, plan: null });
			blocks.push({ box: lineBox([x, y], [node.x, y], 1.5), kind: 3, plan: null });
		}
	}
	for (const column of columns) {
		blocks.push({
			box: { x0: column.x, y0: column.y, x1: column.x + column.width, y1: column.y + 20 },
			kind: 3,
			plan: null,
		});
	}
	for (const plan of plans) {
		const points = pointsOf.get(plan) ?? [];
		for (let i = 1; i < points.length; i++) {
			const [p, q] = [pointAt(points, i - 1), pointAt(points, i)];
			blocks.push({ box: lineBox(p, q, 1), kind: p[0] === q[0] ? 1 : 2, plan });
		}
		const tips = arrowAt(plan.flow, "from") ? [0, points.length - 1] : [points.length - 1];
		for (const index of tips) {
			const tip = pointAt(points, index);
			blocks.push({ box: lineBox(tip, tip, ARROW_LEN), kind: 2, plan });
		}
	}
	const placed: Box[] = [];
	const spots = new Map<Plan, Spot>();
	const crowded: Plan[] = [];
	for (const plan of [...plans].sort((p, q) => p.rank - q.rank)) {
		if (!counted(plan.flow)) continue;
		const width = countWidth(plan.flow);
		const points = pointsOf.get(plan) ?? [];
		const candidates = countSpots(points, plan.flow, hostOf.get(plan) ?? 1);
		const free = (spot: Spot, allow: number) => {
			const box = countBox(spot, width);
			return (
				placed.every((other) => !hit(box, { ...other, x0: other.x0 - 2, x1: other.x1 + 2 })) &&
				blocks.every(
					(block) =>
						block.plan === plan ||
						(block.kind !== 0 && block.kind <= allow) ||
						!hit(box, block.box),
				)
			);
		};
		let chosen: Spot | undefined;
		for (let allow = 0; allow <= 3 && !chosen; allow++) {
			chosen = candidates.find((spot) => free(spot, allow));
			if (!chosen && allow === 2) crowded.push(plan);
		}
		const [p, q] = [pointAt(points, 0), pointAt(points, 1)];
		chosen ??= candidates[0] ?? {
			x: (p[0] + q[0]) / 2,
			y: (p[1] + q[1]) / 2,
			forward: p[0] <= pointAt(points, points.length - 1)[0],
		};
		placed.push(countBox(chosen, width));
		spots.set(plan, chosen);
	}
	return { spots, crowded };
}
