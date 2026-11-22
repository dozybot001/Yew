import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createApp } from "../src/server/http/app.ts";
import { MailStore, type NewLetter } from "../src/server/mail/store.ts";
import {
	layoutMap,
	MAX_ROWS,
	type MapGroup,
	type MapSession,
	NODE_H,
	NODE_W,
	PAD,
	pickFlows,
} from "../web/src/map-layout.ts";
import { bankEdges, checkCounts, checkLayout, inBanks, session } from "./helpers/map.ts";
import { newStore, sessionInput } from "./helpers/store.ts";

const HOUR = 3600 * 1000;

function setup() {
	const { store } = newStore();
	const mail = new MailStore(store);
	const app = createApp({ store, log: () => {} });
	const letter = (from: string, to: string, extra: Partial<NewLetter> = {}) =>
		mail.addLetter({
			fromKind: "session",
			fromSession: from,
			fromName: "sender",
			toSession: to,
			kind: "notice",
			summary: "hello",
			body: "hello",
			status: "delivered",
			...extra,
		});
	/** Moves a letter into the past. */
	const age = (id: string, ms: number) =>
		store.db.prepare("UPDATE letters SET created_at = created_at - ? WHERE id = ?").run(ms, id);
	return { store, mail, app, letter, age };
}

describe("sessions map: letters", () => {
	test("letters are added up per sender and receiver, the busiest pair first", () => {
		const { store, mail, letter, age } = setup();
		const a = store.createSession(sessionInput("a"));
		const b = store.createSession(sessionInput("b"));
		const c = store.createSession(sessionInput("c"));
		letter(a.id, b.id);
		letter(a.id, b.id);
		letter(a.id, b.id, { status: "held" });
		letter(b.id, a.id);
		letter(c.id, a.id);
		// Letters that never arrived, an old one, and ones no session sent do not count.
		letter(a.id, c.id, { status: "refused" });
		letter(a.id, c.id, { status: "dropped" });
		age(letter(b.id, c.id).id, 25 * HOUR);
		letter("", a.id, { fromKind: "cli", fromSession: null });
		letter("", a.id, { fromKind: "person", fromSession: null, kind: "decision" });
		const flows = mail.letterFlows(Date.now() - 24 * HOUR);
		const rows = flows.map((flow) => [flow.from, flow.to, flow.count]);
		assert.deepEqual(rows[0], [a.id, b.id, 3]);
		assert.deepEqual(
			rows.slice(1).sort(),
			[
				[b.id, a.id, 1],
				[c.id, a.id, 1],
			].sort(),
		);
		assert.ok(flows.every((flow) => typeof flow.lastAt === "number" && flow.lastAt > 0));
		// A longer window brings the old letter back.
		assert.equal(
			mail.letterFlows(Date.now() - 48 * HOUR).some((f) => f.from === b.id && f.to === c.id),
			true,
		);
	});

	test("GET /api/map leaves archived sessions out and reads the same for a paired phone", async () => {
		const { store, app, letter } = setup();
		const a = store.createSession(sessionInput("a"));
		const b = store.createSession(sessionInput("b"));
		const gone = store.createSession(sessionInput("gone"));
		letter(a.id, b.id);
		letter(a.id, gone.id);
		letter(gone.id, b.id);
		const before = Date.now();
		const first = await app.request("/api/map");
		assert.equal(first.status, 200);
		const body = (await first.json()) as {
			since: number;
			letters: { from: string; to: string; count: number; lastAt: number }[];
		};
		assert.ok(Math.abs(body.since - (before - 24 * HOUR)) < 5000);
		assert.equal(body.letters.length, 3);
		assert.deepEqual(Object.keys(body.letters[0] ?? {}).sort(), ["count", "from", "lastAt", "to"]);

		store.updateSession(gone.id, { archived: true });
		const second = (await (await app.request("/api/map")).json()) as typeof body;
		assert.deepEqual(
			second.letters.map((flow) => [flow.from, flow.to, flow.count]),
			[[a.id, b.id, 1]],
		);

		// A phone reads sessions and letters, so it reads the map too.
		const phone = (path: string) =>
			app.fetch(new Request(`http://yew.internal${path}`), { device: "d1" });
		assert.equal((await phone("/api/sessions")).status, 200);
		assert.equal((await phone("/api/letters")).status, 200);
		const asPhone = await phone("/api/map");
		assert.equal(asPhone.status, 200);
		assert.deepEqual(((await asPhone.json()) as typeof body).letters, second.letters);
	});

	test("an empty Yew has an empty map", async () => {
		const { app } = setup();
		const body = (await (await app.request("/api/map")).json()) as { letters: unknown[] };
		assert.deepEqual(body.letters, []);
	});
});

describe("sessions map: layout", () => {
	const teams: MapGroup[] = [
		{ id: "g2", position: 1 },
		{ id: "g1", position: 0 },
	];

	test("one session", () => {
		const layout = checkLayout([session("s1")], [], null);
		assert.deepEqual(
			layout.headings.map((heading) => heading.kind),
			["none"],
		);
		// The main conversation with no other session to lie over is as wide as any session.
		const alone = checkLayout([session("s1")], [], "s1");
		assert.deepEqual(alone.headings, []);
		assert.deepEqual([alone.nodes[0]?.depth, alone.nodes[0]?.width], [0, NODE_W]);
	});

	test("no sessions", () => {
		const layout = layoutMap([], teams, null);
		assert.deepEqual([layout.nodes, layout.headings], [[], []]);
		assert.ok(layout.width > 0 && layout.height > 0);
	});

	test("the main conversation across the top, the groups in two banks, tasks under their opener", () => {
		const sessions = [
			session("s1"),
			session("s2", { groupId: "g1" }),
			session("s3", { groupId: "g2" }),
			session("s4", { groupId: "g1" }),
			session("s5", { parentId: "s2", groupId: "g1" }),
			session("s6", { parentId: "s5" }),
			session("s7", { parentId: "s1" }),
			session("s8"),
			// Its opener is not on the map (archived): it stands on its own.
			session("s9", { parentId: "archived" }),
			// A team that no longer exists counts as no team.
			session("s10", { groupId: "deleted" }),
		];
		// checkLayout sees to it that the main conversation is a bar over all the others.
		const layout = checkLayout(sessions, teams, "s1");
		const at = new Map(layout.nodes.map((node) => [node.id, node]));
		// What the main conversation opened, the teams in their order, then the sessions without one.
		assert.deepEqual(
			layout.headings.map((heading) => [heading.kind, heading.groupId]),
			[
				["main", null],
				["team", "g1"],
				["team", "g2"],
				["none", null],
			],
		);
		// The first groups in the left bank, one under the other; the rest in the right bank. The two
		// banks come out as alike in height as whole groups allow.
		const [left = 0, right = 0] = bankEdges(layout);
		const [opened, g1, g2, none] = layout.headings;
		assert.ok(opened && g1 && g2 && none && left < right);
		assert.deepEqual([opened.x, g1.x, g2.x, none.x], [left, left, right, right]);
		assert.ok(opened.y < g1.y && g2.y < none.y);
		assert.equal(opened.y, g2.y);
		// A session stands under its group's heading, in rows the two banks share.
		const under = (id: string) =>
			layout.headings.findLast((heading) => {
				const node = at.get(id);
				return node && heading.x <= node.x && node.x < heading.x + NODE_W && heading.y < node.y;
			});
		assert.deepEqual(
			["s7", "s2", "s6", "s4", "s3", "s8", "s9", "s10"].map((id) => under(id)?.kind),
			["main", "team", "team", "team", "team", "none", "none", "none"],
		);
		assert.equal(under("s6")?.groupId, "g1");
		assert.equal(at.get("s7")?.y, at.get("s3")?.y);
		// What the main conversation opened stands under a heading that says so, with no line up to
		// the bar.
		assert.deepEqual([at.get("s7")?.parentId, at.get("s7")?.depth], [null, 0]);
		assert.equal(at.get("s5")?.parentId, "s2");
		assert.equal(at.get("s6")?.depth, 2);
		assert.equal(at.get("s9")?.parentId, null);
		// s2's tree comes before s4 in the team's group.
		assert.ok((at.get("s6")?.y ?? 0) < (at.get("s4")?.y ?? 0));
	});

	test("the same sessions in any order give the same picture", () => {
		const sessions = Array.from({ length: 12 }, (_, i) =>
			session(`s${i + 1}`, {
				groupId: i % 3 === 0 ? "g1" : i % 3 === 1 ? "g2" : null,
				parentId: i >= 6 ? `s${i - 5}` : null,
			}),
		);
		const first = layoutMap(sessions, teams, "s1");
		assert.deepEqual(layoutMap([...sessions].reverse(), [...teams].reverse(), "s1"), first);
		assert.deepEqual(layoutMap(sessions, teams, "s1"), first);
		// Sessions made in the same millisecond are ordered by id.
		const twins = [session("b", {}, 5), session("a", {}, 5)];
		assert.deepEqual(layoutMap(twins, [], null), layoutMap([...twins].reverse(), [], null));
		assert.equal(layoutMap(twins, [], null).nodes[0]?.id, "a");
	});

	test("forty sessions stay apart, and a long group continues in the other bank", () => {
		const sessions: MapSession[] = [session("s1")];
		for (let i = 2; i <= 40; i++) {
			sessions.push(
				session(`s${i}`, {
					groupId: i <= 20 ? "g1" : i <= 26 ? "g2" : null,
					parentId: i > 30 ? `s${i - 29}` : i > 26 ? "s1" : null,
				}),
			);
		}
		const layout = checkLayout(sessions, teams, "s1");
		// The first team has twenty-nine sessions. Kept whole it would make one bank thirty-five rows
		// tall; divided between two of its trees, the banks are twenty-two and twenty-one.
		const [left = 0, right = 0] = bankEdges(layout);
		const rows = (edge: number) =>
			layout.headings.filter((heading) => heading.x === edge).length +
			inBanks(layout).filter((node) => node.x >= edge && node.x < edge + NODE_W).length;
		assert.deepEqual([rows(left), rows(right)], [22, 21]);
		assert.ok(rows(left) > MAX_ROWS);
		// The picture ends a margin under the last session of the taller bank.
		assert.equal(layout.height, Math.max(...layout.nodes.map((node) => node.y)) + NODE_H + PAD);
		// Its heading stands over both parts.
		assert.deepEqual(
			layout.headings.map((heading) => [heading.groupId, heading.x]),
			[
				[null, left],
				["g1", left],
				["g1", right],
				["g2", right],
			],
		);
		// A session stays with the one that opened it: a tree is never divided.
		const at = new Map(layout.nodes.map((node) => [node.id, node]));
		for (const node of layout.nodes) {
			const parent = node.parentId ? at.get(node.parentId) : undefined;
			if (parent) assert.equal(node.x - parent.x, 22, `${node.id} left its opener's bank`);
		}
		// A group that fits keeps to one bank: one tree of eight cannot be divided at all.
		const tree = checkLayout(
			Array.from({ length: 8 }, (_, i) => session(`s${i + 1}`, { parentId: i ? "s1" : null })),
			[],
			null,
		);
		assert.equal(bankEdges(tree).length, 1);
		// Fourteen sessions without a team make one bank fifteen rows tall with the heading: divided in
		// the middle, the two are eight rows each.
		const halved = checkLayout(
			Array.from({ length: 14 }, (_, i) => session(`s${i + 1}`)),
			[],
			null,
		);
		assert.equal(bankEdges(halved).length, 2);
		assert.equal(halved.nodes.filter((node) => node.x === bankEdges(halved)[0]).length, 7);
		// A tree of twelve and three sessions on their own: divided after the tree, the taller bank
		// would be thirteen rows instead of sixteen, not a third shorter, so the group stays whole.
		const lumpy = checkLayout(
			Array.from({ length: 15 }, (_, i) =>
				session(`s${i + 1}`, { parentId: i > 0 && i < 12 ? "s1" : null }),
			),
			[],
			null,
		);
		assert.equal(bankEdges(lumpy).length, 1);
	});

	test("sessions that opened each other in a loop are still placed once", () => {
		const loop = [session("s1", { parentId: "s2" }), session("s2", { parentId: "s1" })];
		const layout = checkLayout(loop, [], null);
		assert.equal(layout.nodes.length, 2);
	});

	test("letter lines: one for two sessions on the map, the busiest pairs first, capped", () => {
		const flows = [
			{ from: "s1", to: "s2", count: 5 },
			{ from: "s2", to: "gone", count: 4 },
			{ from: "s3", to: "s2", count: 3 },
			{ from: "s2", to: "s1", count: 2 },
			{ from: "s3", to: "s1", count: 1 },
		];
		const onMap = new Set(["s1", "s2", "s3"]);
		// The two ways between s1 and s2 are one line, from the one that sent more.
		const picked = pickFlows(flows, onMap, 2);
		assert.deepEqual(picked.drawn, [
			{ from: "s1", to: "s2", count: 5, back: 2 },
			{ from: "s3", to: "s2", count: 3 },
		]);
		assert.equal(picked.hidden, 1);
		assert.equal(pickFlows(flows, onMap, 24).hidden, 0);
		// What was counted each way is left as it was.
		assert.deepEqual(flows[0], { from: "s1", to: "s2", count: 5 });
		// A pair comes before another by its letters in all, whichever way they went.
		const even = [
			{ from: "s1", to: "s3", count: 4 },
			{ from: "s2", to: "s3", count: 3 },
			{ from: "s3", to: "s2", count: 3 },
		];
		assert.deepEqual(pickFlows(even, onMap, 1), {
			drawn: [{ from: "s2", to: "s3", count: 3, back: 3 }],
			hidden: 1,
		});

		const sessions = [session("s1"), session("s2"), session("s3", { groupId: "g1" })];
		const lines = [
			{ from: "s1", to: "s2", count: 5, back: 2 },
			{ from: "s3", to: "s1", count: 1 },
			{ from: "s2", to: "gone", count: 4 },
		];
		const layout = layoutMap(sessions, teams, null, lines);
		// A line to a session that is not on the map is left out; the others keep the order given.
		assert.deepEqual(
			layout.flows.map((flow) => [flow.from, flow.to, flow.count, flow.back]),
			[
				["s1", "s2", 5, 2],
				["s3", "s1", 1, 0],
			],
		);
		const [pair, single] = layout.flows;
		assert.ok(pair && single);
		// Straight stretches and rounded corners, no curves.
		for (const flow of layout.flows) assert.match(flow.d, /^M[\d.]+ [\d.]+( [LQ][\d. ]+)+$/);
		// A count where more than one letter went, inside the picture; one letter has none.
		assert.equal(single.label, null);
		const { label } = pair;
		assert.ok(label && label.x > 0 && label.x < layout.width && label.y < layout.height);
		checkCounts(layout);
	});
});
