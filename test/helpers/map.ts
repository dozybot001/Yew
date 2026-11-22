/** Maps to test the sessions map with, and the rules its picture has to keep. */

import assert from "node:assert/strict";
import {
	CORNER,
	type FlowLine,
	type FlowRoute,
	INDENT,
	layoutMap,
	type MapGroup,
	type MapLayout,
	type MapSession,
	NODE_H,
	NODE_W,
	PAD,
	pairParts,
} from "../../web/src/map-layout.ts";

export const session = (
	id: string,
	extra: Partial<MapSession> = {},
	createdAt = Number(id.replace(/\D/g, "")) || 0,
): MapSession => ({ id, groupId: null, parentId: null, createdAt, ...extra });

/** The sessions under the main conversation's bar: every one but the bar itself. */
export const inBanks = (layout: MapLayout) => layout.nodes.filter((node) => node.width === NODE_W);

/** The left edges of the banks, from the left: where a session that nobody above it opened stands. */
export const bankEdges = (layout: MapLayout) =>
	[...new Set(inBanks(layout).map((node) => node.x - node.depth * INDENT))].sort((a, b) => a - b);

/**
 * Every pair of nodes stands apart, every session stands below the one that opened it, and the
 * sessions stand in two banks at most, under the main conversation's bar when there is one.
 */
export function checkLayout(
	sessions: MapSession[],
	groups: MapGroup[],
	mainId: string | null,
	flows: FlowLine[] = [],
) {
	const layout = layoutMap(sessions, groups, mainId, flows);
	assert.equal(layout.nodes.length, sessions.length);
	assert.equal(new Set(layout.nodes.map((node) => node.id)).size, sessions.length);
	const at = new Map(layout.nodes.map((node) => [node.id, node]));
	for (const [i, a] of layout.nodes.entries()) {
		assert.ok(a.x >= 0 && a.y >= 0);
		assert.ok(a.x + a.width <= layout.width && a.y + NODE_H <= layout.height);
		for (const b of layout.nodes.slice(i + 1)) {
			const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || Math.abs(a.y - b.y) >= NODE_H;
			assert.ok(apart, `${a.id} and ${b.id} overlap`);
		}
		if (a.parentId) {
			const parent = at.get(a.parentId);
			assert.ok(parent && parent.y + NODE_H <= a.y, `${a.id} is not below ${a.parentId}`);
			assert.ok(parent && parent.x < a.x, `${a.id} is not indented under ${a.parentId}`);
		}
	}
	assert.ok(bankEdges(layout).length <= 2, "more than two banks");
	// The bar lies across the whole picture, over every other session.
	for (const bar of layout.nodes.filter((node) => node.width !== NODE_W)) {
		assert.equal(bar.id, mainId);
		assert.deepEqual([bar.x, bar.y, bar.x + bar.width], [PAD, PAD, layout.width - PAD]);
		for (const node of inBanks(layout)) {
			assert.ok(node.y >= bar.y + NODE_H && node.x >= bar.x, `${node.id} is not under the bar`);
			assert.ok(node.x + node.width <= bar.x + bar.width, `${node.id} is not under the bar`);
		}
	}
	// A heading does not lie on a session.
	for (const heading of layout.headings) {
		for (const node of layout.nodes) {
			const beside = node.x >= heading.x + heading.width || node.x + node.width <= heading.x;
			assert.ok(beside || node.y >= heading.y + 20 || node.y + NODE_H <= heading.y);
		}
	}
	return layout;
}

type Point = [number, number];

interface Box {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

export const name = (flow: FlowLine) => `${flow.from}>${flow.to}`;

export function boxOf(layout: MapLayout, id: string): Box {
	const node = layout.nodes.find((item) => item.id === id);
	assert.ok(node, `${id} is on the map`);
	return { x0: node.x, y0: node.y, x1: node.x + node.width, y1: node.y + NODE_H };
}

/** Whether a level or upright stretch from p to q meets a box, its edges included. */
const meets = (p: Point, q: Point, box: Box) =>
	Math.max(p[0], q[0]) >= box.x0 &&
	Math.min(p[0], q[0]) <= box.x1 &&
	Math.max(p[1], q[1]) >= box.y0 &&
	Math.min(p[1], q[1]) <= box.y1;

const onEdge = (p: Point, box: Box) =>
	meets(p, p, box) && (p[0] === box.x0 || p[0] === box.x1 || p[1] === box.y0 || p[1] === box.y1);

/** A line's stretches, from corner to corner. */
function stretches(flow: FlowRoute): [Point, Point][] {
	return flow.points.slice(1).map((q, i) => [flow.points[i] ?? q, q]);
}

/** Half a pixel along the stretch from p toward q. */
const nudge = (p: Point, q: Point): Point => [
	p[0] + Math.sign(q[0] - p[0]) / 2,
	p[1] + Math.sign(q[1] - p[1]) / 2,
];

/**
 * Reads a line's SVG path and checks that it follows the line's corners: level or upright straight
 * stretches, and at each corner a quarter turn no wider than CORNER.
 */
function checkPath(flow: FlowRoute) {
	const tokens = flow.d.match(/[A-Za-z]|-?\d+(?:\.\d+)?/g) ?? [];
	const commands = tokens.filter((token) => /[A-Za-z]/.test(token));
	assert.ok(
		commands.every((command) => "MLQ".includes(command)),
		`${name(flow)}: ${flow.d}`,
	);
	const numbers = (from: number, count: number) =>
		tokens.slice(from, from + count).map((token) => Number(token));
	let at: Point = [Number.NaN, Number.NaN];
	const corners: Point[] = [];
	for (let i = 0; i < tokens.length; ) {
		const command = tokens[i];
		if (command === "M") {
			const [x = 0, y = 0] = numbers(i + 1, 2);
			at = [x, y];
			i += 3;
		} else if (command === "L") {
			const [x = 0, y = 0] = numbers(i + 1, 2);
			assert.ok(x === at[0] || y === at[1], `${name(flow)}: slanted from ${at} to ${x},${y}`);
			at = [x, y];
			i += 3;
		} else {
			const [cx = 0, cy = 0, x = 0, y = 0] = numbers(i + 1, 4);
			const level = cy === at[1] && cx !== at[0];
			const upright = cx === at[0] && cy !== at[1];
			assert.ok(level || upright, `${name(flow)}: no corner at ${cx},${cy}`);
			// It turns: level into upright or upright into level.
			assert.ok(level ? cx === x && cy !== y : cy === y && cx !== x, `${name(flow)}: no turn`);
			const radius = Math.abs(cx - at[0]) + Math.abs(cy - at[1]);
			assert.ok(radius <= CORNER && Math.abs(x - cx) + Math.abs(y - cy) <= CORNER);
			corners.push([cx, cy]);
			at = [x, y];
			i += 5;
		}
	}
	assert.deepEqual([tokens[0], numbers(1, 2)], ["M", flow.points[0]]);
	assert.deepEqual(at, flow.points[flow.points.length - 1]);
	assert.deepEqual(corners, flow.points.slice(1, -1));
}

/** Every stretch of every line is level or upright, and its path draws just that. */
export function checkStraight(layout: MapLayout) {
	for (const flow of layout.flows) {
		assert.ok(flow.points.length >= 2);
		for (const [p, q] of stretches(flow)) {
			// Exactly one of the two changes: no slanted stretch, no stretch of no length.
			assert.ok((p[0] === q[0]) !== (p[1] === q[1]), `${name(flow)}: ${p} to ${q}`);
		}
		checkPath(flow);
	}
}

/** A line touches no session but the two it joins, and those only at their edge with its ends. */
export function checkClear(layout: MapLayout) {
	for (const flow of layout.flows) {
		const first = flow.points[0];
		const last = flow.points[flow.points.length - 1];
		assert.ok(first && onEdge(first, boxOf(layout, flow.from)), `${name(flow)} starts apart`);
		assert.ok(last && onEdge(last, boxOf(layout, flow.to)), `${name(flow)} ends apart`);
		const all = stretches(flow);
		for (const [i, [p, q]] of all.entries()) {
			for (const node of layout.nodes) {
				// The first stretch leaves its sender's edge and the last comes in at its receiver's,
				// straight away from the edge: they touch that session at their end and nowhere else.
				const a = i === 0 && node.id === flow.from ? nudge(p, q) : p;
				const b = i === all.length - 1 && node.id === flow.to ? nudge(q, p) : q;
				assert.ok(
					!meets(a, b, boxOf(layout, node.id)),
					`${name(flow)}: ${p} to ${q} on ${node.id}`,
				);
			}
		}
	}
}

/**
 * Stretches of two lines that run alongside each other, level or upright over a common length, are
 * never on one lane: they keep at least `apart` px from each other. Gives how many such pairs there are.
 */
export function checkLanes(layout: MapLayout, apart: number): number {
	const all = layout.flows.flatMap((flow) =>
		stretches(flow).map(([p, q]) => ({ line: name(flow), p, q })),
	);
	let alongside = 0;
	for (const [i, s] of all.entries()) {
		for (const t of all.slice(i + 1)) {
			const upright = s.p[0] === s.q[0];
			if (s.line === t.line || upright !== (t.p[0] === t.q[0])) continue;
			const [along, across]: [0 | 1, 0 | 1] = upright ? [1, 0] : [0, 1];
			const span = (u: { p: Point; q: Point }) =>
				[Math.min(u.p[along], u.q[along]), Math.max(u.p[along], u.q[along])] as const;
			const [[s0, s1], [t0, t1]] = [span(s), span(t)];
			if (s1 < t0 || t1 < s0) continue;
			alongside++;
			const gap = Math.abs(s.p[across] - t.p[across]);
			assert.ok(gap >= apart, `${s.line} and ${t.line} share a lane at ${s.p} and ${t.p}`);
		}
	}
	return alongside;
}

/**
 * A line that carried more than one letter either way has its count on one of its level stretches, all
 * of it there, on no session and on no other count, and the count knows which way the line runs
 * there; a line with one letter each way, or one in all, has none.
 */
export function checkCounts(layout: MapLayout) {
	const boxes: Box[] = [];
	for (const flow of layout.flows) {
		if (flow.count < 2 && flow.back < 2) {
			assert.equal(flow.label, null);
			continue;
		}
		const { label } = flow;
		assert.ok(label, `${name(flow)} has a count`);
		// As large as it is drawn: the digits with their margin of page colour, or the ground of the
		// two counts of a line that carried letters both ways.
		const half = (String(flow.count).length * 7 + 3) / 2;
		const { x0, x1 } =
			flow.back > 0
				? pairParts(flow.back, flow.count, label.x)
				: { x0: label.x - half, x1: label.x + half };
		const box = { x0, y0: label.y - 5.5, x1, y1: label.y + 5.5 };
		const under = stretches(flow).find(
			([p, q]) =>
				p[1] === q[1] &&
				p[1] === label.y &&
				box.x0 >= Math.min(p[0], q[0]) &&
				box.x1 <= Math.max(p[0], q[0]),
		);
		assert.ok(under, `${name(flow)}: the count is not on a level stretch`);
		// The corners run from the session named first to the other one.
		assert.equal(label.forward, under[0][0] < under[1][0], `${name(flow)}: which way it runs`);
		assert.ok(box.x0 >= 0 && box.x1 <= layout.width && box.y0 >= 0 && box.y1 <= layout.height);
		for (const node of layout.nodes) {
			const on = boxOf(layout, node.id);
			const clear = box.x1 <= on.x0 || box.x0 >= on.x1 || box.y1 <= on.y0 || box.y0 >= on.y1;
			assert.ok(clear, `${name(flow)}: the count lies on ${node.id}`);
		}
		for (const other of boxes) {
			const clear =
				box.x1 <= other.x0 || box.x0 >= other.x1 || box.y1 <= other.y0 || box.y0 >= other.y1;
			assert.ok(clear, `${name(flow)}: the count lies on another`);
		}
		boxes.push(box);
	}
}

/**
 * A map made up from a seed: up to thirty sessions, some opened by others, in up to three teams, with
 * or without a main conversation, and up to sixteen lines between them, half of them for letters
 * both ways.
 */
export function madeUp(seed: number) {
	let state = seed;
	const next = () => {
		state = (Math.imul(state, 1103515245) + 12345) >>> 0;
		return state / 2 ** 32;
	};
	const sessions: MapSession[] = [];
	const size = 2 + Math.floor(next() * 29);
	const teams = Math.floor(next() * 4);
	for (let i = 0; i < size; i++) {
		sessions.push(
			session(
				`s${i}`,
				{
					parentId: i > 0 && next() < 0.45 ? `s${Math.floor(next() * i)}` : null,
					groupId: teams > 0 && next() < 0.7 ? `g${Math.floor(next() * teams)}` : null,
				},
				i,
			),
		);
	}
	const mainId = next() < 0.8 ? "s0" : null;
	const flows: FlowLine[] = [];
	const lines = Math.floor(next() * 17);
	for (let tries = 0; tries < 3 * lines && flows.length < lines; tries++) {
		const from = mainId && next() < 0.35 ? mainId : `s${Math.floor(next() * size)}`;
		const to = mainId && next() < 0.3 ? mainId : `s${Math.floor(next() * size)}`;
		const given = flows.some(
			(flow) => (flow.from === from && flow.to === to) || (flow.from === to && flow.to === from),
		);
		if (from === to || given) continue;
		const letters = () => (next() < 0.5 ? 1 : 2 + Math.floor(next() * 120));
		const count = letters();
		flows.push(next() < 0.5 ? { from, to, count } : { from, to, count, back: letters() });
	}
	const groups = Array.from({ length: teams }, (_, i) => ({ id: `g${i}`, position: i }));
	return { sessions, groups, mainId, flows };
}

/**
 * A busy map: the main conversation, the sessions it opened with one tree three deep, three teams with
 * sessions under sessions, two sessions without a team, and sixteen lines: to and from the main
 * conversation on both sides, from one bank to the other, within each bank, and five for pairs that
 * wrote to each other. What the main conversation opened and the first team stand in the left bank,
 * the other teams and the sessions without one in the right.
 */
export const busy = {
	sessions: (
		[
			["m0", {}],
			["a1", { parentId: "m0" }],
			["a2", { parentId: "m0" }],
			["a3", { parentId: "a2" }],
			["a4", { parentId: "a3" }],
			["a5", { parentId: "m0" }],
			["b1", { groupId: "g1" }],
			["b2", { groupId: "g1", parentId: "b1" }],
			["b3", { groupId: "g1" }],
			["b4", { groupId: "g1", parentId: "b3" }],
			["b5", { groupId: "g1" }],
			["c1", { groupId: "g2" }],
			["c2", { groupId: "g2" }],
			["c3", { groupId: "g2", parentId: "c2" }],
			["d1", { groupId: "g3" }],
			["d2", { groupId: "g3" }],
			["e1", {}],
			["e2", { parentId: "e1" }],
		] satisfies [string, Partial<MapSession>][]
	).map(([id, extra], i) => session(id, extra, i)),
	groups: [
		{ id: "g1", position: 0 },
		{ id: "g2", position: 1 },
		{ id: "g3", position: 2 },
	],
	flows: [
		{ from: "m0", to: "a1", count: 12, back: 9 },
		{ from: "m0", to: "b1", count: 7, back: 6 },
		{ from: "b2", to: "c1", count: 4, back: 3 },
		{ from: "m0", to: "d1", count: 5 },
		{ from: "e1", to: "m0", count: 4 },
		{ from: "b1", to: "d2", count: 3 },
		{ from: "e2", to: "d1", count: 3 },
		{ from: "a5", to: "b5", count: 1, back: 2 },
		{ from: "e2", to: "b3", count: 2 },
		{ from: "b3", to: "b5", count: 2 },
		{ from: "c2", to: "c3", count: 2 },
		{ from: "d2", to: "c3", count: 1, back: 1 },
		{ from: "a3", to: "c2", count: 1 },
		{ from: "d1", to: "c1", count: 1 },
		{ from: "a2", to: "a5", count: 1 },
		{ from: "b4", to: "e1", count: 1 },
	] satisfies FlowLine[],
};

export const busyMap = () => layoutMap(busy.sessions, busy.groups, "m0", busy.flows);
