/**
 * What the sessions map is made of: the sessions and letters that go in, the picture that comes out,
 * and the sizes it is drawn at.
 */

export interface MapSession {
	id: string;
	groupId: string | null;
	parentId: string | null;
	createdAt: number;
}

export interface MapGroup {
	id: string;
	position: number;
}

export interface MapNode {
	id: string;
	x: number;
	y: number;
	/** NODE_W, but for the main conversation, which lies across the top as a bar. */
	width: number;
	/** How many sessions stand between this one and the top of its tree. */
	depth: number;
	/**
	 * The session above it that opened it. What the main conversation opened stands under a heading
	 * that says so, with no line up to the bar, and has none.
	 */
	parentId: string | null;
}

/**
 * The heading over a group of sessions: a team, the sessions without one, or what the main
 * conversation opened. A group that continues in the other bank has its heading there again.
 */
export interface MapHeading {
	kind: "main" | "team" | "none";
	groupId: string | null;
	x: number;
	y: number;
	width: number;
}

/**
 * The letters between two sessions, drawn as one line: `count` from `from` to `to`, and `back` the
 * other way when the two write to each other. A pair of sessions is given once.
 */
export interface FlowLine {
	from: string;
	to: string;
	count: number;
	back?: number;
}

/** The letters a line carried the other way, and all it carried. */
export const backOf = (flow: FlowLine) => flow.back ?? 0;
export const totalOf = (flow: FlowLine) => flow.count + backOf(flow);
/** A line says how many letters it carried when either way carried more than one. */
export const counted = (flow: FlowLine) => flow.count > 1 || backOf(flow) > 1;
/** An arrow stands at the end where letters arrived: at `to`, and at `from` when some came back. */
export const arrowAt = (flow: FlowLine, which: "from" | "to") => which === "to" || backOf(flow) > 0;

/** A letter line as the map draws it. */
export interface FlowRoute extends FlowLine {
	back: number;
	/**
	 * Its corners, from the edge of `from` to the edge of `to`. Every stretch is level or upright, and
	 * only the first and the last touch a session.
	 */
	points: [number, number][];
	/** The same line as an SVG path, its corners rounded. */
	d: string;
	/**
	 * The middle of the count, on a level stretch of the line; none when neither way carried more than
	 * one letter. `forward` says the line runs left to right there on its way from `from` to `to`: the
	 * letters to `to` went right, the ones back went left.
	 */
	label: { x: number; y: number; forward: boolean } | null;
}

export interface MapLayout {
	nodes: MapNode[];
	headings: MapHeading[];
	/** The letter lines asked for, in the order given. */
	flows: FlowRoute[];
	width: number;
	height: number;
}

export const NODE_W = 184;
export const NODE_H = 36;
export const ROW_GAP = 10;
export const INDENT = 22;
/** A gap beside a bank before any line needs more: left of the left bank, between the two, right of the right. */
export const COLUMN_GAP = 36;
export const HEAD_H = 26;
export const PAD = 16;
/** The band between the main conversation's bar and the first headings. */
export const BAND = 2 * ROW_GAP;
/**
 * A bank this many rows tall is long: a group is then split between the two banks if that makes the
 * taller one much shorter.
 */
export const MAX_ROWS = 12;
/** The radius of a letter line's corners. */
export const CORNER = 4;
/** The arrow at the receiving end of a letter line: its length along the line, its width across. */
export const ARROW_LEN = 6;
export const ARROW_W = 5;

/** Upright lanes in a gap: this far apart, and this far from the sessions beside it. */
export const LANE = 6;
export const LANE_EDGE = 10;
/** Lines that leave the main conversation's bar keep this far from its ends. */
export const BAR_EDGE = 11;
/** The room a tree line takes among the ends at a session's side. */
export const LINE_HALF = 3;
/** Ends at a session's side keep this far from its corners, and take this much room each. */
export const SIDE_EDGE = 6;
export const START_ROOM = 2;
export const ARROW_ROOM = 3;
export const COUNT_ROOM = 6;
