import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ARROW_W, COLUMN_GAP, layoutMap, type MapLayout } from "../web/src/map-layout.ts";
import {
	boxOf,
	busy,
	busyMap,
	checkClear,
	checkCounts,
	checkLanes,
	checkLayout,
	checkStraight,
	madeUp,
	name,
	session,
} from "./helpers/map.ts";

describe("sessions map: letter lines", () => {
	test("the busy map has every kind of line, all of them drawn", () => {
		const layout = checkLayout(busy.sessions, busy.groups, "m0", busy.flows);
		assert.equal(layout.flows.length, 16);
		assert.deepEqual(layout.flows.map(name), busy.flows.map(name));
		const at = new Map(layout.nodes.map((node) => [node.id, node]));
		const columnOf = (id: string) =>
			layout.columns.findLastIndex((column) => column.x <= (at.get(id)?.x ?? 0));
		const apart = busy.flows
			.filter((flow) => flow.from !== "m0" && flow.to !== "m0")
			.map((flow) => Math.abs(columnOf(flow.from) - columnOf(flow.to)));
		// Within a column, next to each other, and two or three columns apart.
		for (const distance of [0, 1, 2, 3]) assert.ok(apart.includes(distance), `${distance}`);
		assert.ok(layout.nodes.some((node) => node.depth >= 3));
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

	test("ends at one side of a session stand apart, and two that write to each other get two lines", () => {
		const layout = busyMap();
		const ends = layout.flows.flatMap((flow) => [
			{ id: flow.from, at: flow.points[0] ?? [0, 0], arrow: false, line: name(flow) },
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
		const pairs: [string, string][] = [
			["m0", "a1"],
			["m0", "b1"],
			["b2", "c1"],
		];
		for (const [x, y] of pairs) {
			const there = layout.flows.find((flow) => flow.from === x && flow.to === y);
			const back = layout.flows.find((flow) => flow.from === y && flow.to === x);
			assert.ok(there && back);
			for (const p of there.points) {
				assert.ok(!back.points.some((q) => q[0] === p[0] && q[1] === p[1]), `${x} and ${y}`);
			}
		}
	});

	test("within one column a line goes round by the gap on the right", () => {
		const layout = busyMap();
		const within: [string, string][] = [
			["b3", "b5"],
			["c2", "c3"],
			["a2", "a5"],
		];
		for (const [from, to] of within) {
			const flow = layout.flows.find((item) => item.from === from && item.to === to);
			assert.ok(flow);
			const right = Math.max(boxOf(layout, from).x1, boxOf(layout, to).x1);
			const first = flow.points[0];
			const last = flow.points[flow.points.length - 1];
			assert.equal(first?.[0], boxOf(layout, from).x1);
			assert.equal(last?.[0], boxOf(layout, to).x1);
			const lane = Math.max(...flow.points.map((point) => point[0]));
			assert.ok(lane > right, `${from}>${to}`);
			// One way out and one way back, two corners each.
			assert.equal(flow.points.length, 4, `${from}>${to}`);
		}
	});

	test("a count stands on a level stretch of its line, clear of the sessions and other counts", () => {
		checkCounts(busyMap());
	});

	test("a count under the main conversation gets a level stretch long enough to stand on", () => {
		// The main conversation's right side is full, so its line to the next column leaves from its
		// lower edge and turns down the first gap: a short level stretch, unless that gap grows.
		const sessions = [
			session("m1"),
			session("b1", { groupId: "g1" }),
			session("c1", { groupId: "g2" }),
			session("d1", { groupId: "g3" }),
			session("d2", { groupId: "g3" }),
			session("e1"),
		];
		const groups = [
			{ id: "g1", position: 0 },
			{ id: "g2", position: 1 },
			{ id: "g3", position: 2 },
		];
		const others = [
			{ from: "d1", to: "m1", count: 300 },
			{ from: "e1", to: "m1", count: 1 },
			{ from: "m1", to: "d2", count: 1 },
		];
		for (const line of [
			{ from: "m1", to: "c1", count: 200 },
			{ from: "c1", to: "m1", count: 200 },
		]) {
			const layout = checkLayout(sessions, groups, "m1", [...others, line]);
			checkStraight(layout);
			checkClear(layout);
			checkCounts(layout);
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
		const few = layoutMap(sessions, groups, "m1", [
			{ from: "m1", to: "t1", count: 5 },
			{ from: "t1", to: "m1", count: 3 },
			{ from: "m1", to: "c2", count: 3 },
			{ from: "t2", to: "b1", count: 2 },
			{ from: "e1", to: "b3", count: 1 },
		]);
		const fixed = (layout: MapLayout) => [
			layout.nodes,
			layout.columns,
			layout.width,
			layout.height,
		];
		assert.deepEqual(fixed(few), fixed(plain));

		// Eight lines across the gap between the two teams, all of them along its middle.
		const crossing = [1, 2, 3, 4].flatMap((i) => [
			{ from: `b${i}`, to: `c${5 - i}`, count: 1 },
			{ from: `c${i}`, to: `b${5 - i}`, count: 1 },
		]);
		const many = checkLayout(sessions, groups, "m1", crossing);
		const x = (layout: MapLayout, id: string) => boxOf(layout, id).x0;
		const wider = x(many, "c1") - x(plain, "c1");
		assert.ok(wider > 0, "the gap between the teams grows");
		// By what its lanes need, not by a column; the rest stays where it was.
		assert.ok(wider < COLUMN_GAP, `${wider}`);
		assert.equal(x(many, "b1"), x(plain, "b1"));
		assert.equal(many.width - plain.width, wider);
		assert.deepEqual(
			many.nodes.map((node) => node.y),
			plain.nodes.map((node) => node.y),
		);
	});
});
