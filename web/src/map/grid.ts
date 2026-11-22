/**
 * Where the sessions stand on the map: who opened whom, the two banks they are placed in and the rows
 * of those, and the gaps beside the banks, which the letter lines run in.
 */

import {
	BAND,
	COLUMN_GAP,
	HEAD_H,
	INDENT,
	MAX_ROWS,
	type MapGroup,
	type MapHeading,
	type MapNode,
	type MapSession,
	NODE_H,
	NODE_W,
	PAD,
	ROW_GAP,
} from "./model.ts";

const byAge = (a: MapSession, b: MapSession) =>
	a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Who opened whom, among the sessions given: the sessions nobody on the map opened, and each
 * session's children, oldest first. A session whose opener is missing (archived, deleted) stands on its
 * own; one that would open itself through a loop does too.
 */
function family(sessions: MapSession[]): {
	roots: MapSession[];
	children: Map<string, MapSession[]>;
} {
	const sorted = [...sessions].sort(byAge);
	const byId = new Map(sorted.map((session) => [session.id, session]));
	const loops = (session: MapSession): boolean => {
		const seen = new Set([session.id]);
		let at = session.parentId;
		while (at !== null && byId.has(at)) {
			if (seen.has(at)) return true;
			seen.add(at);
			at = byId.get(at)?.parentId ?? null;
		}
		return false;
	};
	const roots: MapSession[] = [];
	const children = new Map<string, MapSession[]>();
	for (const session of sorted) {
		const parent = session.parentId;
		if (parent === null || !byId.has(parent) || loops(session)) roots.push(session);
		else children.set(parent, [...(children.get(parent) ?? []), session]);
	}
	return { roots, children };
}

// --- where the sessions stand ---

/** A session in its bank: how far in it stands, and its row, counted with the headings. */
export interface Cell {
	session: MapSession;
	depth: number;
	parentId: string | null;
	bank: number;
	row: number;
}

interface Heading {
	kind: MapHeading["kind"];
	groupId: string | null;
	bank: number;
	row: number;
}

/** The sessions in banks and rows, before any position across the picture is worked out. */
export interface Arrangement {
	/** The main conversation, which lies across the top; none when no session is it. */
	main: MapSession | null;
	/** How wide each bank is, from its left to the right end of its widest session: none, one or two. */
	banks: number[];
	headings: Heading[];
	/** How many rows the taller bank has, headings included. */
	rows: number;
	cells: Map<string, Cell>;
}

/** A session and everything under it, in the order it is listed. */
type Tree = Omit<Cell, "bank" | "row">[];

interface Group {
	kind: MapHeading["kind"];
	groupId: string | null;
	trees: Tree[];
}

/**
 * The groups in order: what the main conversation opened, each team, the sessions without one. Within
 * a group each session is followed by the sessions it opened, one row lower and one step in.
 */
function groupsOf(
	roots: MapSession[],
	children: Map<string, MapSession[]>,
	teams: MapGroup[],
	main: MapSession | null,
): Group[] {
	const tree = (session: MapSession, depth: number, parentId: string | null): Tree => [
		{ session, depth, parentId },
		...(children.get(session.id) ?? []).flatMap((child) => tree(child, depth + 1, session.id)),
	];
	const out: Group[] = [];
	const add = (kind: Group["kind"], groupId: string | null, tops: MapSession[]) => {
		if (tops.length > 0) out.push({ kind, groupId, trees: tops.map((top) => tree(top, 0, null)) });
	};
	if (main) add("main", null, children.get(main.id) ?? []);
	const rest = roots.filter((session) => session !== main);
	const known = new Set(teams.map((team) => team.id));
	for (const team of [...teams].sort((a, b) => a.position - b.position || compare(a.id, b.id))) {
		add(
			"team",
			team.id,
			rest.filter((session) => session.groupId === team.id),
		);
	}
	add(
		"none",
		null,
		rest.filter((session) => session.groupId === null || !known.has(session.groupId)),
	);
	return out;
}

/**
 * Where the groups are divided between the banks: before tree `tree` of group `group`. The groups keep
 * their order, the first ones on the left, and the banks come out as alike in height as whole groups
 * allow; of two places as good, the later one, so the left bank is the taller. Where a bank is still
 * long, a group is divided between two of its trees instead, if that makes the taller bank a third
 * shorter.
 */
function divide(groups: Group[]): { group: number; tree: number } {
	const rows = groups.map((group) => 1 + group.trees.reduce((sum, tree) => sum + tree.length, 0));
	const total = rows.reduce((sum, n) => sum + n, 0);
	let whole = { group: groups.length, tree: 0, tall: total };
	let within = { group: groups.length, tree: 0, tall: Number.POSITIVE_INFINITY };
	let above = 0;
	for (const [g, group] of groups.entries()) {
		if (g > 0) {
			const tall = Math.max(above, total - above);
			if (tall <= whole.tall) whole = { group: g, tree: 0, tall };
		}
		let left = above + 1;
		for (const [t, tree] of group.trees.entries()) {
			// The group's heading stands in both banks.
			const tall = Math.max(left, total - left + 1);
			if (t > 0 && tall <= within.tall) within = { group: g, tree: t, tall };
			left += tree.length;
		}
		above += rows[g] ?? 0;
	}
	return whole.tall > MAX_ROWS && within.tall * 3 <= whole.tall * 2 ? within : whole;
}

export function arrange(
	sessions: MapSession[],
	teams: MapGroup[],
	mainId: string | null,
): Arrangement {
	const { roots, children } = family(sessions);
	const main = roots.find((session) => session.id === mainId) ?? null;
	const groups = groupsOf(roots, children, teams, main);
	const cut = divide(groups);
	const cells = new Map<string, Cell>();
	const headings: Heading[] = [];
	const rows = [0, 0];
	const widths = [0, 0];
	const put = (bank: number, group: Group, trees: Tree[]) => {
		if (trees.length === 0) return;
		let row = rows[bank] ?? 0;
		headings.push({ kind: group.kind, groupId: group.groupId, bank, row: row++ });
		for (const cell of trees.flat()) {
			cells.set(cell.session.id, { ...cell, bank, row: row++ });
			widths[bank] = Math.max(widths[bank] ?? 0, cell.depth * INDENT + NODE_W);
		}
		rows[bank] = row;
	};
	for (const [g, group] of groups.entries()) {
		const first = g < cut.group ? group.trees.length : g > cut.group ? 0 : cut.tree;
		put(0, group, group.trees.slice(0, first));
		put(1, group, group.trees.slice(first));
	}
	return {
		main,
		banks: widths.filter((_, bank) => (rows[bank] ?? 0) > 0),
		headings,
		rows: Math.max(...rows),
		cells,
	};
}

/** From the top of one row to the top of the next. */
const PITCH = NODE_H + ROW_GAP;

/** Where the headings start: under the bar when there is one. */
const topOf = (a: Arrangement) => (a.main && a.banks.length > 0 ? PAD + NODE_H + BAND : PAD);

/** The top of the sessions in a row. Both banks keep the same rows, a heading taking one. */
export const rowTop = (a: Arrangement, row: number) => topOf(a) + HEAD_H + (row - 1) * PITCH;

// --- the gaps the lines run in ---

/**
 * The gaps beside the banks: `left` of the left bank, the `rail` right of it (between the two banks
 * when there are two), and `right` of the right bank.
 */
export type Gap = "left" | "rail" | "right";

/** How wide each gap is. They start as narrow as the picture allows and grow for the lines in them. */
export type Sizes = Record<Gap, number>;

/** The main conversation's bar reaches past the banks by a gap at each end. */
export function plainSizes(a: Arrangement): Sizes {
	const bar = a.main !== null;
	return {
		left: bar && a.banks.length > 0 ? COLUMN_GAP : 0,
		rail: a.banks.length > 0 ? COLUMN_GAP : 0,
		right: bar && a.banks.length > 1 ? COLUMN_GAP : 0,
	};
}

/** Where the banks and the sessions stand for some gaps. */
export interface Frame {
	sizes: Sizes;
	/** The left edge of each bank. */
	bankX: number[];
	width: number;
	height: number;
	nodes: MapNode[];
	at: Map<string, MapNode>;
}

export function frame(a: Arrangement, sizes: Sizes): Frame {
	const [first = 0, second = 0] = a.banks;
	const bankX = [PAD + sizes.left, PAD + sizes.left + first + sizes.rail];
	const inner =
		a.banks.length === 0
			? NODE_W
			: sizes.left + first + sizes.rail + (a.banks.length > 1 ? second + sizes.right : 0);
	const nodes: MapNode[] = [];
	// With no other session to lie over, the main conversation is as wide as any session.
	if (a.main) nodes.push({ id: a.main.id, x: PAD, y: PAD, width: inner, depth: 0, parentId: null });
	for (const cell of a.cells.values()) {
		nodes.push({
			id: cell.session.id,
			x: (bankX[cell.bank] ?? PAD) + cell.depth * INDENT,
			y: rowTop(a, cell.row),
			width: NODE_W,
			depth: cell.depth,
			parentId: cell.parentId,
		});
	}
	return {
		sizes,
		bankX,
		width: inner + 2 * PAD,
		height: (a.rows > 0 ? rowTop(a, a.rows - 1) + NODE_H : a.main ? PAD + NODE_H : PAD) + PAD,
		nodes,
		at: new Map(nodes.map((node) => [node.id, node])),
	};
}

export function headingsOf(a: Arrangement, f: Frame): MapHeading[] {
	return a.headings.map((heading) => ({
		kind: heading.kind,
		groupId: heading.groupId,
		x: f.bankX[heading.bank] ?? PAD,
		y: topOf(a) + heading.row * PITCH,
		width: a.banks[heading.bank] ?? NODE_W,
	}));
}

/** The right edge of a bank, where the gap beside it starts. */
export const bankEnd = (a: Arrangement, f: Frame, bank: number) =>
	(f.bankX[bank] ?? PAD) + (a.banks[bank] ?? 0);

/** On the middle of a pixel, so a one-pixel line stays sharp. */
export const snap = (value: number) => Math.floor(value) + 0.5;
