/** Where the ends of the letter lines stand along a side of a session that several of them share. */

import { snap } from "./grid.ts";
import { ARROW_W, LINE_HALF, NODE_H, SIDE_EDGE } from "./model.ts";
import type { Plan, Which } from "./route.ts";

/** One end, or the two ends of a straight line, at a stretch of side shared with other ends. */
export interface Member {
	plan: Plan;
	which: Which[];
	/** Where the line goes from there: -1 up, 1 down, 0 straight on. */
	dir: number;
	/** How far across the gap its lane is, counted from this side. */
	reach: number;
	room: number;
	/** It enters the session right of the gap, at its left side. */
	right: boolean;
}

/**
 * Something at a stretch of side shared by the two sessions facing each other across a gap: an end
 * on the near session (left of the gap), on the far one, or on both for a line straight across; or
 * the tree line coming into the far session.
 */
interface Mark {
	room: number;
	arrow: boolean;
	at: "near" | "far" | "both";
	tree: boolean;
}

/**
 * How close two marks may come when the side is crowded. On one session two arrows never lie over
 * each other and other lines keep a little apart; across the gap, neighbours only keep off one line.
 */
function least(a: Mark, b: Mark, next: boolean): number {
	if (a.at !== b.at && a.at !== "both" && b.at !== "both") return next ? 2 : 0;
	if (a.tree || b.tree) return a.arrow || b.arrow ? 4 : 3;
	if (a.arrow && b.arrow) return ARROW_W;
	return a.arrow || b.arrow ? 3 : 2;
}

/**
 * How far each mark stands from the first: `wanted` gives each the room it takes, `floor` brings
 * them as near as `least` allows between every two.
 */
function reach(marks: Mark[]): { wanted: number[]; floor: number[] } {
	const wanted = [0];
	const floor = [0];
	for (let k = 1; k < marks.length; k++) {
		const mark = marks[k];
		if (!mark) break;
		wanted.push((wanted[k - 1] ?? 0) + (marks[k - 1]?.room ?? 0) + mark.room);
		let low = 0;
		for (let i = 0; i < k; i++) {
			const other = marks[i];
			if (other) low = Math.max(low, (floor[i] ?? 0) + least(other, mark, i === k - 1));
		}
		floor.push(low);
	}
	return { wanted, floor };
}

/** Somewhere between the two: `share` 0 is the floor, 1 what is wanted. */
const between = (wanted: number[], floor: number[], share: number) =>
	wanted.map((value, i) => (floor[i] ?? 0) + (value - (floor[i] ?? 0)) * share);

/** The largest share of the way from `low` to `high` that stays within `room` (0 if none does). */
function shareWithin(low: number, high: number, room: number): number {
	if (high <= room) return 1;
	return low >= room ? 0 : (room - low) / (high - low);
}

/**
 * Where the ends at one side stand, in the members' order, from the top: spread around the middle
 * with the room each needs, and nearer each other where the side is crowded. `pinned` keeps the
 * middle for the tree line that comes into the far session's left side there: the ends stand above
 * and below it, split where they fit best, nearest the split between lines going up and going down.
 */
export function sideSlots(members: Member[], top: number, pinned: boolean): number[] {
	const marks: Mark[] = members.map((member) => ({
		room: member.room,
		arrow: member.which.includes("to"),
		at: member.which.length > 1 ? "both" : member.right ? "far" : "near",
		tree: false,
	}));
	const middle = top + NODE_H / 2;
	if (!pinned) {
		const { wanted, floor } = reach(marks);
		const [high, low] = [wanted.at(-1) ?? 0, floor.at(-1) ?? 0];
		const room = NODE_H - 2 * SIDE_EDGE;
		const share = shareWithin(low, high, room);
		// Crowded past the least distances: everything closer alike.
		const offsets =
			low > room ? floor.map((value) => (value * room) / low) : between(wanted, floor, share);
		const start = middle - (offsets.at(-1) ?? 0) / 2;
		return offsets.map((offset) => snap(start + offset));
	}
	const tree: Mark = { room: LINE_HALF, arrow: false, at: "far", tree: true };
	const half = NODE_H / 2 - SIDE_EDGE;
	/** The marks from the top with the tree line after the first `split`, and the room above and below. */
	const option = (split: number) => {
		const { wanted, floor } = reach([...marks.slice(0, split), tree, ...marks.slice(split)]);
		const above = (offsets: number[]) => offsets[split] ?? 0;
		const below = (offsets: number[]) => (offsets.at(-1) ?? 0) - (offsets[split] ?? 0);
		const over = (offsets: number[]) =>
			Math.max(0, above(offsets) - half) + Math.max(0, below(offsets) - half);
		return { split, wanted, floor, above, below, score: [over(floor), over(wanted)] };
	};
	const up = members.filter((member) => member.dir < 0).length;
	const natural = up + Math.floor(members.filter((member) => member.dir === 0).length / 2);
	let best = option(natural);
	for (let split = 0; split <= members.length; split++) {
		const next = option(split);
		const [a, b] = [
			[...next.score, Math.abs(split - natural)],
			[...best.score, Math.abs(best.split - natural)],
		];
		const first = a.findIndex((value, i) => value !== b[i]);
		if (first >= 0 && (a[first] ?? 0) < (b[first] ?? 0)) best = next;
	}
	const { split, wanted, floor, above, below } = best;
	const share = Math.min(
		shareWithin(above(floor), above(wanted), half),
		shareWithin(below(floor), below(wanted), half),
	);
	const offsets = between(wanted, floor, share);
	const pin = offsets[split] ?? 0;
	// Crowded past the least distances on one side of the tree line: that side closer alike.
	const squeeze = (offset: number) => {
		const away = offset - pin;
		const room = away < 0 ? above(floor) : below(floor);
		return room > half ? (away * half) / room : away;
	};
	return offsets.filter((_, i) => i !== split).map((offset) => snap(middle + squeeze(offset)));
}
