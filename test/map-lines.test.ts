import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	ARROW_LEN,
	ARROW_W,
	BAR_EDGE,
	COLUMN_GAP,
	type FlowRoute,
	LANE,
	layoutMap,
	type MapLayout,
	NODE_H,
	NODE_W,
	PAD,
	pairParts,
} from "../web/src/map-layout.ts";
import {
	bankEdges,
	boxOf,
	busy,
	busyMap,
	checkClear,
	checkCounts,
	checkLanes,
	checkLayout,
	checkStraight,
	inBanks,
	madeUp,
	name,
	session,
} from "./helpers/map.ts";

const lineOf = (layout: MapLayout, from: string, to: string): FlowRoute => {
	const flow = layout.flows.find((item) => item.from === from && item.to === to);
	assert.ok(flow, `${from}>${to} is drawn`);
	return flow;
};

/** Where a line runs upright: the x of each upright stretch. */
const uprights = (flow: FlowRoute) =>
	flow.points.slice(1).flatMap((q, i) => (flow.points[i]?.[0] === q[0] ? [q[0]] : []));

/** The gaps of the busy map, by where its banks stand: left of the left, between, right of the right. */
function gapsOf(layout: MapLayout) {
	const [left = 0, right = 0] = bankEdges(layout);
	const ends = (edge: number) =>
		inBanks(layout)
			.filter((node) => node.x >= edge && node.x < edge + NODE_W)
			.map((node) => node.x + node.width);
	return {
		leftBank: left,
		rail: [Math.max(...ends(left)), right] as const,
		rightBank: Math.max(...ends(right)),
	};
}

/** The count's two edges, as large as it is drawn. */
function countEdges(flow: FlowRoute) {
	assert.ok(flow.label, `${name(flow)} has a count`);
	const half = (String(flow.count).length * 7 + 3) / 2;
	return flow.back > 0
		? pairParts(flow.back, flow.count, flow.label.x)
		: { x0: flow.label.x - half, x1: flow.label.x + half };
}

describe("sessions map: letter lines", () => {
	test("the busy map has every kind of line, all of them drawn", () => {
		const layout = checkLayout(busy.sessions, busy.groups, "m0", busy.flows);
		assert.equal(layout.flows.length, 16);
		assert.deepEqual(layout.flows.map(name), busy.flows.map(name));
		assert.equal(bankEdges(layout).length, 2);
		assert.ok(layout.nodes.some((node) => node.depth >= 2));
	});

	test("every line is level and upright stretches, its corners slightly rounded", () => {
		checkStraight(busyMap());
	});

	test("no line passes over a session: only its ends touch the two it joins", () => {
		checkClear(busyMap());
	});

	test("lines along the same stretch of a gap run in lanes of their own", () => {
		// The map is busy enough for this to say something.
		assert.ok(checkLanes(busyMap(), 4) > 20);
	});

	test("the same sessions and lines give the same picture, in whatever order they come", () => {
		const layout = busyMap();
		assert.deepEqual(busyMap(), layout);
		const turned = layoutMap(
			[...busy.sessions].reverse(),
			[...busy.groups].reverse(),
			"m0",
			[...busy.flows].reverse(),
		);
		assert.deepEqual({ ...turned, flows: [...turned.flows].reverse() }, layout);
	});

	test("on two hundred made-up maps the lines and counts keep the same rules", () => {
		// Some of these crowd many ends onto one side of a session; there the stubs come as near as
		// 2px, which still leaves a clear pixel between two lines.
		let alongside = 0;
		for (let seed = 1; seed <= 200; seed++) {
			const { sessions, groups, mainId, flows } = madeUp(seed);
			try {
				const layout = checkLayout(sessions, groups, mainId, flows);
				assert.equal(layout.flows.length, flows.length);
				checkStraight(layout);
				checkClear(layout);
				checkCounts(layout);
				alongside += checkLanes(layout, 2);
				const turned = layoutMap(
					[...sessions].reverse(),
					[...groups].reverse(),
					mainId,
					[...flows].reverse(),
				);
				assert.deepEqual({ ...turned, flows: [...turned.flows].reverse() }, layout);
			} catch (error) {
				assert.fail(`seed ${seed}: ${error instanceof Error ? error.message : error}`);
			}
		}
		assert.ok(alongside > 200, `${alongside}`);
	});

	test("ends at one side of a session stand apart, and two that write to each other share a line", () => {
		const layout = busyMap();
		// An arrow stands where letters arrived: at the far end, and at the near one when some came back.
		const ends = layout.flows.flatMap((flow) => [
			{ id: flow.from, at: flow.points[0] ?? [0, 0], arrow: flow.back > 0, line: name(flow) },
			{
				id: flow.to,
				at: flow.points[flow.points.length - 1] ?? [0, 0],
				arrow: true,
				line: name(flow),
			},
		]);
		for (const [i, a] of ends.entries()) {
			for (const b of ends.slice(i + 1)) {
				if (a.id !== b.id || (a.at[0] !== b.at[0] && a.at[1] !== b.at[1])) continue;
				const apart = Math.abs(a.at[0] - b.at[0]) + Math.abs(a.at[1] - b.at[1]);
				const least = a.arrow && b.arrow ? ARROW_W : 4;
				assert.ok(apart >= least, `${a.line} and ${b.line} meet at ${a.id}`);
			}
		}
		const pairs: [string, string, number, number][] = [
			["m0", "a1", 12, 9],
			["m0", "b1", 7, 6],
			["b2", "c1", 4, 3],
			["a5", "b5", 1, 2],
			["d2", "c3", 1, 1],
		];
		for (const [x, y, count, back] of pairs) {
			const between = layout.flows.filter(
				(flow) => (flow.from === x && flow.to === y) || (flow.from === y && flow.to === x),
			);
			assert.deepEqual(
				between.map((flow) => [flow.from, flow.to, flow.count, flow.back]),
				[[x, y, count, back]],
			);
		}
		// A line for letters one way has nothing coming back.
		assert.equal(lineOf(layout, "m0", "d1").back, 0);
	});

	test("a line of the main conversation drops from the bar down the outer side of a bank", () => {
		const layout = busyMap();
		const bar = boxOf(layout, "m0");
		const { leftBank, rightBank } = gapsOf(layout);
		// To the left bank: left of it, into the session's left side. To the right bank: the mirror.
		const lines: [string, string, string, "left" | "right"][] = [
			["m0", "a1", "a1", "left"],
			["m0", "b1", "b1", "left"],
			["m0", "d1", "d1", "right"],
			["e1", "m0", "e1", "right"],
		];
		const lanes = new Map<string, number>();
		for (const [from, to, other, side] of lines) {
			const flow = lineOf(layout, from, to);
			// Straight down from the bar's lower edge, then one corner into the session.
			assert.equal(flow.points.length, 3, name(flow));
			const [x = 0] = uprights(flow);
			const atBar = from === "m0" ? flow.points[0] : flow.points[2];
			const atSession = from === "m0" ? flow.points[2] : flow.points[0];
			assert.deepEqual(atBar, [x, bar.y1]);
			assert.equal(
				atSession?.[0],
				side === "left" ? boxOf(layout, other).x0 : boxOf(layout, other).x1,
			);
			assert.ok(side === "left" ? x < leftBank : x > rightBank, name(flow));
			// Clear of the rounded ends of the bar.
			assert.ok(x >= bar.x0 + BAR_EDGE && x <= bar.x1 - BAR_EDGE, name(flow));
			lanes.set(other, x);
		}
		// The line that goes farther down keeps the outer lane, so the two never cross.
		assert.equal((lanes.get("a1") ?? 0) - (lanes.get("b1") ?? 0), LANE);
		assert.equal((lanes.get("e1") ?? 0) - (lanes.get("d1") ?? 0), LANE);
	});

	test("a line between two sessions runs in the rail between the banks", () => {
		const layout = busyMap();
		const { rail } = gapsOf(layout);
		const inRail = (flow: FlowRoute) => {
			const [x = 0] = uprights(flow);
			assert.equal(flow.points.length, 4, name(flow));
			assert.ok(x > rail[0] && x < rail[1], name(flow));
		};
		// From one bank to the other: out of the right side of one session, into the left of the other.
		for (const [from, to] of [
			["b2", "c1"],
			["b1", "d2"],
			["a3", "c2"],
			["b4", "e1"],
		] as const) {
			const flow = lineOf(layout, from, to);
			inRail(flow);
			assert.equal(flow.points[0]?.[0], boxOf(layout, from).x1);
			assert.equal(flow.points[3]?.[0], boxOf(layout, to).x0);
		}
		// Two sessions of the left bank: round by its right. Two of the right bank: round by its left.
		for (const [from, to, side] of [
			["a5", "b5", "x1"],
			["b3", "b5", "x1"],
			["a2", "a5", "x1"],
			["d1", "c1", "x0"],
		] as const) {
			const flow = lineOf(layout, from, to);
			inRail(flow);
			assert.equal(flow.points[0]?.[0], boxOf(layout, from)[side]);
			assert.equal(flow.points[3]?.[0], boxOf(layout, to)[side]);
		}
	});

	test("two sessions of the right bank go round its right when another session opened one of them", () => {
		const layout = busyMap();
		const { rightBank } = gapsOf(layout);
		// c3 and e2 stand under the sessions that opened them: the tree line comes in at their left.
		for (const [from, to] of [
			["e2", "d1"],
			["c2", "c3"],
			["d2", "c3"],
		] as const) {
			const flow = lineOf(layout, from, to);
			const [x = 0] = uprights(flow);
			assert.equal(flow.points.length, 4, name(flow));
			assert.ok(x > rightBank, name(flow));
			assert.equal(flow.points[0]?.[0], boxOf(layout, from).x1);
			assert.equal(flow.points[3]?.[0], boxOf(layout, to).x1);
		}
	});

	test("two sessions that face each other across the rail are joined straight", () => {
		const layout = busyMap();
		// e2 and b3 stand in the same row.
		assert.equal(boxOf(layout, "e2").y0, boxOf(layout, "b3").y0);
		const flow = lineOf(layout, "e2", "b3");
		assert.equal(flow.points.length, 2);
		assert.deepEqual(
			flow.points.map((point) => point[0]),
			[boxOf(layout, "e2").x0, boxOf(layout, "b3").x1],
		);
	});

	test("a count stands beside one of its line's two sessions, clear of the sessions and other counts", () => {
		const layout = busyMap();
		checkCounts(layout);
		for (const flow of layout.flows) {
			if (!flow.label || flow.points.length === 2) continue;
			const { x0, x1 } = countEdges(flow);
			// On the stub at one end of the line, an arrow's length and a little more from the session,
			// whether an arrow stands there or not: the counts beside the sessions of a bank line up.
			const near = [
				[flow.from, flow.points[0]] as const,
				[flow.to, flow.points[flow.points.length - 1]] as const,
			].filter(([id, point]) => id !== "m0" && point?.[1] === flow.label?.y);
			assert.equal(near.length, 1, name(flow));
			const edge = near[0]?.[1]?.[0] ?? 0;
			assert.equal(Math.min(Math.abs(x0 - edge), Math.abs(x1 - edge)), ARROW_LEN + 3, name(flow));
		}
		// Of a line's two ends the count takes the one where fewer lines end: two end at c1's left.
		const pair = lineOf(layout, "b2", "c1");
		assert.equal(pair.label?.y, pair.points[0]?.[1]);
		// The count of a line straight across the rail stands on the line.
		const across = lineOf(layout, "e2", "b3");
		assert.equal(across.label?.y, across.points[0]?.[1]);
	});

	test("a large count of the main conversation's line gets the room it needs beside its session", () => {
		const sessions = [
			session("m1"),
			session("b1", { groupId: "g1" }),
			session("b2", { groupId: "g1", parentId: "b1" }),
			session("c1", { groupId: "g2" }),
			session("c2", { groupId: "g2" }),
		];
		const groups = [
			{ id: "g1", position: 0 },
			{ id: "g2", position: 1 },
		];
		const plain = layoutMap(sessions, groups, "m1");
		for (const lines of [
			[{ from: "m1", to: "b1", count: 300 }],
			[{ from: "b2", to: "m1", count: 200, back: 150 }],
			[{ from: "m1", to: "c2", count: 200, back: 150 }],
			[
				{ from: "c1", to: "m1", count: 1, back: 200 },
				{ from: "m1", to: "c2", count: 300 },
			],
		]) {
			const layout = checkLayout(sessions, groups, "m1", lines);
			checkStraight(layout);
			checkClear(layout);
			checkCounts(layout);
			// The count stands in its line's own gap, which grew for it: outside the banks.
			const { leftBank, rightBank } = gapsOf(layout);
			for (const flow of layout.flows) {
				const { x0, x1 } = countEdges(flow);
				assert.ok(x1 < leftBank || x0 > rightBank, name(flow));
				// At the left of a session that stands in from its bank the count keeps left of the bank,
				// clear of the tree line that comes down there.
				if (flow.from === "b2") assert.equal(x1, leftBank - 3);
			}
			assert.ok(layout.width > plain.width);
			assert.equal(layout.height, plain.height);
		}
	});

	test("lines that fit in the gaps leave the map as it is; a gap that needs more lanes grows", () => {
		const sessions = [
			session("m1"),
			...["b1", "b2", "b3", "b4"].map((id) => session(id, { groupId: "g1" })),
			...["c1", "c2", "c3", "c4"].map((id) => session(id, { groupId: "g2" })),
			session("e1"),
			session("t1", { parentId: "m1" }),
			session("t2", { parentId: "m1" }),
		];
		const groups = [
			{ id: "g1", position: 0 },
			{ id: "g2", position: 1 },
		];
		const plain = layoutMap(sessions, groups, "m1");
		assert.deepEqual(layoutMap(sessions, groups, "m1", []), plain);
		// The bar reaches past the banks by a gap at each end, and the rail is as wide.
		const { leftBank, rail, rightBank } = gapsOf(plain);
		assert.deepEqual(
			[leftBank - PAD, rail[1] - rail[0], plain.width - PAD - rightBank],
			[COLUMN_GAP, COLUMN_GAP, COLUMN_GAP],
		);
		// One letter each: no counts, and a lane or two in each gap.
		const few = layoutMap(sessions, groups, "m1", [
			{ from: "m1", to: "t1", count: 1 },
			{ from: "t2", to: "m1", count: 1, back: 1 },
			{ from: "m1", to: "c2", count: 1 },
			{ from: "t2", to: "b1", count: 1 },
			{ from: "e1", to: "b3", count: 1 },
		]);
		const fixed = (layout: MapLayout) => [
			layout.nodes,
			layout.headings,
			layout.width,
			layout.height,
		];
		assert.deepEqual(fixed(few), fixed(plain));

		// Eight lines across the rail, all of them along its middle.
		const crossing = [1, 2, 3, 4].flatMap((i) => [
			{ from: `b${i}`, to: `c${5 - i}`, count: 1 },
			{ from: `c${i}`, to: `b${((i + 1) % 4) + 1}`, count: 1 },
		]);
		const many = checkLayout(sessions, groups, "m1", crossing);
		const x = (layout: MapLayout, id: string) => boxOf(layout, id).x0;
		const wider = gapsOf(many).rail[1] - gapsOf(many).rail[0] - COLUMN_GAP;
		assert.ok(wider > 0, "the rail grows");
		// By what its lanes need, not by a gap; the left bank stays, the right one moves with the rail.
		assert.ok(wider < COLUMN_GAP, `${wider}`);
		assert.equal(x(many, "b1"), x(plain, "b1"));
		assert.equal(x(many, "c1") - x(plain, "c1"), wider);
		assert.equal(many.width - plain.width, wider);
		assert.deepEqual(
			many.nodes.map((node) => node.y),
			plain.nodes.map((node) => node.y),
		);
		// The bar grows with the picture.
		assert.equal(boxOf(many, "m1").x1 - boxOf(plain, "m1").x1, wider);
		assert.equal(boxOf(many, "m1").y1 - boxOf(many, "m1").y0, NODE_H);
	});
});
