/**
 * Where the sessions stand on the map: who opened whom, the columns and rows they are placed in, and
 * the gaps between those, which the letter lines run in.
 */

import {
	BAND_EDGE,
	COLUMN_GAP,
	COUNT_EDGE,
	COUNT_HALF,
	HEAD_H,
	INDENT,
	LANE,
	LANE_EDGE,
	LINE_EDGE,
	MAX_ROWS,
	type MapColumn,
	type MapGroup,
	type MapNode,
	type MapSession,
	NODE_H,
	NODE_W,
	type OutlineItem,
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

/** The same tree the picture draws, as nested items: the main conversation first, then by age. */
export function outline(sessions: MapSession[], mainId: string | null): OutlineItem[] {
	const { roots, children } = family(sessions);
	const item = (session: MapSession): OutlineItem => ({
		id: session.id,
		children: (children.get(session.id) ?? []).map(item),
	});
	return [
		...roots.filter((session) => session.id === mainId),
		...roots.filter((session) => session.id !== mainId),
	].map(item);
}

// --- where the sessions stand ---

interface Cell {
	session: MapSession;
	depth: number;
	parentId: string | null;
	stack: number;
	row: number;
}

/** One column of sessions as placed: a heading's, or the rest of a column that grew long. */
interface Stack {
	cells: Cell[];
	/** From the left of the stack to the right end of its widest session. */
	width: number;
}

interface Heading {
	kind: MapColumn["kind"];
	groupId: string | null;
	/** The first stack under it. */
	stack: number;
	inset: number;
}

/** The sessions in stacks and rows, before any position is worked out. */
export interface Arrangement {
	main: MapSession | null;
	stacks: Stack[];
	headings: Heading[];
	rows: number;
	cells: Map<string, Cell>;
}

export function arrange(
	sessions: MapSession[],
	groups: MapGroup[],
	mainId: string | null,
): Arrangement {
	const { roots, children } = family(sessions);
	const main = roots.find((session) => session.id === mainId) ?? null;
	const stacks: Stack[] = [];
	const headings: Heading[] = [];
	/** A session and everything under it, in the order it is listed, with each one's depth. */
	const rows = (session: MapSession, depth: number): { session: MapSession; depth: number }[] => [
		{ session, depth },
		...(children.get(session.id) ?? []).flatMap((child) => rows(child, depth + 1)),
	];

	/**
	 * One column of trees under a heading. Trees are placed whole; when the next one would pass
	 * MAX_ROWS, the column continues to the right. What the main conversation opened (`under`) stands
	 * one step in, so the line down from it runs clear, and stays in one column, so that line never
	 * has to cross another session.
	 */
	const place = (
		kind: MapColumn["kind"],
		groupId: string | null,
		trees: MapSession[],
		under: string | null,
	) => {
		if (trees.length === 0) return;
		headings.push({ kind, groupId, stack: stacks.length, inset: under ? INDENT : 0 });
		let stack: Stack = { cells: [], width: 0 };
		stacks.push(stack);
		for (const tree of trees) {
			const list = rows(tree, under ? 1 : 0);
			if (!under && stack.cells.length > 0 && stack.cells.length + list.length > MAX_ROWS) {
				stack = { cells: [], width: 0 };
				stacks.push(stack);
			}
			for (const { session, depth } of list) {
				stack.cells.push({
					session,
					depth,
					parentId: session.id === tree.id ? under : session.parentId,
					stack: stacks.length - 1,
					row: stack.cells.length,
				});
				stack.width = Math.max(stack.width, depth * INDENT + NODE_W);
			}
		}
	};

	if (main) place("main", null, children.get(main.id) ?? [], main.id);
	const rest = roots.filter((session) => session !== main);
	const known = new Set(groups.map((group) => group.id));
	const teams = [...groups].sort((a, b) => a.position - b.position || compare(a.id, b.id));
	for (const team of teams) {
		place(
			"team",
			team.id,
			rest.filter((session) => session.groupId === team.id),
			null,
		);
	}
	place(
		"none",
		null,
		rest.filter((session) => session.groupId === null || !known.has(session.groupId)),
		null,
	);
	return {
		main,
		stacks,
		headings,
		rows: Math.max(0, ...stacks.map((stack) => stack.cells.length)),
		cells: new Map(stacks.flatMap((stack) => stack.cells.map((cell) => [cell.session.id, cell]))),
	};
}

/** How wide each gap is. They start as narrow as the picture allows and grow for the lines in them. */
export interface Sizes {
	/** The gap right of each stack: before the next one, or the margin right of the last. */
	after: number[];
	/** The gap under each row: before the next one, or the margin under the last. */
	under: number[];
	/** The band between the main conversation and the headings. */
	band: number;
}

export function plainSizes(a: Arrangement): Sizes {
	return {
		after: a.stacks.map(() => COLUMN_GAP),
		under: Array.from({ length: a.rows }, (_, row) => (row === a.rows - 1 ? PAD : ROW_GAP)),
		band: 2 * ROW_GAP,
	};
}

/** Where the stacks, the rows and the sessions stand for some gaps. */
export interface Frame {
	sizes: Sizes;
	stackX: number[];
	rowY: number[];
	/** Where the headings stand. */
	top: number;
	width: number;
	height: number;
	nodes: MapNode[];
	at: Map<string, MapNode>;
}

export function frame(a: Arrangement, sizes: Sizes): Frame {
	const stackX: number[] = [];
	let x = PAD;
	for (const [i, stack] of a.stacks.entries()) {
		stackX.push(x);
		x += stack.width + (sizes.after[i] ?? COLUMN_GAP);
	}
	const top = a.main ? PAD + NODE_H + sizes.band : PAD;
	const rowY: number[] = [];
	let y = top + HEAD_H;
	for (let row = 0; row < a.rows; row++) {
		rowY.push(y);
		y += NODE_H + (sizes.under[row] ?? ROW_GAP);
	}
	const nodes: MapNode[] = [];
	if (a.main) nodes.push({ id: a.main.id, x: PAD, y: PAD, depth: 0, parentId: null });
	for (const stack of a.stacks) {
		for (const cell of stack.cells) {
			nodes.push({
				id: cell.session.id,
				x: (stackX[cell.stack] ?? PAD) + cell.depth * INDENT,
				y: rowY[cell.row] ?? top,
				depth: cell.depth,
				parentId: cell.parentId,
			});
		}
	}
	const right = Math.max(PAD + NODE_W, ...nodes.map((node) => node.x + NODE_W));
	return {
		sizes,
		stackX,
		rowY,
		top,
		// The gap right of the last column is where lines between two of its sessions go round.
		width: right + PAD + (sizes.after[a.stacks.length - 1] ?? COLUMN_GAP),
		height: a.rows > 0 ? y : (a.main ? PAD + NODE_H : PAD) + PAD,
		nodes,
		at: new Map(nodes.map((node) => [node.id, node])),
	};
}

export function headingsOf(a: Arrangement, f: Frame): MapColumn[] {
	return a.headings.map((heading) => ({
		kind: heading.kind,
		groupId: heading.groupId,
		x: (f.stackX[heading.stack] ?? PAD) + heading.inset,
		y: f.top,
		// Over its first stack only: where a column continues beside itself, lines may run between.
		width: (a.stacks[heading.stack]?.width ?? NODE_W) - heading.inset,
	}));
}

// --- the gaps the lines run in ---

/**
 * A gap is named by a letter and a number: "v3" is the upright gap right of stack 3, "h2" the level
 * gap under row 2, and "m" the band under the main conversation.
 */
export const numberOf = (gap: string) => Number(gap.slice(1));
export const upright = (gap: string) => gap.startsWith("v");

export function gapStart(a: Arrangement, f: Frame, gap: string): number {
	if (upright(gap)) {
		const stack = numberOf(gap);
		return (f.stackX[stack] ?? PAD) + (a.stacks[stack]?.width ?? 0);
	}
	return gap === "m" ? PAD + NODE_H : (f.rowY[numberOf(gap)] ?? 0) + NODE_H;
}

export function gapSize(f: Frame, gap: string): number {
	if (upright(gap)) return f.sizes.after[numberOf(gap)] ?? COLUMN_GAP;
	return gap === "m" ? f.sizes.band : (f.sizes.under[numberOf(gap)] ?? ROW_GAP);
}

export const gapMiddle = (a: Arrangement, f: Frame, gap: string) =>
	gapStart(a, f, gap) + gapSize(f, gap) / 2;

/** How many lanes a gap holds before it has to grow. */
export function lanesBefore(a: Arrangement, gap: string): number {
	if (upright(gap)) return 1 + Math.floor((COLUMN_GAP - 2 * LANE_EDGE) / LANE);
	if (gap === "m") return 1;
	return numberOf(gap) === a.rows - 1 ? 2 : 1;
}

export const edgeOf = (half: number | undefined) => (half === COUNT_HALF ? COUNT_EDGE : LINE_EDGE);

/** How tall a level gap must be for lanes taking this much room each. */
export function levelNeed(halves: number[], band: boolean): number {
	if (halves.length === 0) return 0;
	let need = (band ? BAND_EDGE : edgeOf(halves[0])) + edgeOf(halves[halves.length - 1]);
	for (let i = 1; i < halves.length; i++) need += (halves[i - 1] ?? 0) + (halves[i] ?? 0);
	return need;
}

/** On the middle of a pixel, so a one-pixel line stays sharp. */
export const snap = (value: number) => Math.floor(value) + 0.5;
