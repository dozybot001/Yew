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
	/** How many sessions stand between this one and the top of its tree. */
	depth: number;
	/** The session that opened it, when that one is on the map. */
	parentId: string | null;
}

/** A column's heading: a team, the sessions without one, or what the main conversation opened. */
export interface MapColumn {
	kind: "main" | "team" | "none";
	groupId: string | null;
	x: number;
	y: number;
	width: number;
}

/** Letters from one session to another, drawn as one line. */
export interface FlowLine {
	from: string;
	to: string;
	count: number;
}

/** A letter line as the map draws it. */
export interface FlowRoute extends FlowLine {
	/**
	 * Its corners, from the edge of the sender to the edge of the receiver. Every stretch is level or
	 * upright, and only the first and the last touch a session.
	 */
	points: [number, number][];
	/** The same line as an SVG path, its corners rounded. */
	d: string;
	/** The middle of the count, on a level stretch of the line; none for a single letter. */
	label: { x: number; y: number } | null;
}

export interface MapLayout {
	nodes: MapNode[];
	columns: MapColumn[];
	/** The letter lines asked for, in the order given. */
	flows: FlowRoute[];
	width: number;
	height: number;
}

/** One session and the sessions it opened, for the list that says the same as the picture. */
export interface OutlineItem {
	id: string;
	children: OutlineItem[];
}

export const NODE_W = 184;
export const NODE_H = 36;
export const ROW_GAP = 10;
export const INDENT = 22;
export const COLUMN_GAP = 36;
export const HEAD_H = 26;
export const PAD = 16;
/** A column holds this many rows before it continues beside itself. */
export const MAX_ROWS = 12;
/** The radius of a letter line's corners. */
export const CORNER = 4;
/** The arrow at the receiving end of a letter line: its length along the line, its width across. */
export const ARROW_LEN = 6;
export const ARROW_W = 5;

/** Upright lanes in a gap between columns: this far apart, and this far from the sessions beside it. */
export const LANE = 6;
export const LANE_EDGE = 10;
/** The room a level lane takes above and below itself, and how far it keeps from the rows. */
export const LINE_HALF = 3;
export const LINE_EDGE = 5;
/** The same for a level lane that carries a count, so the count clears its neighbours and their counts. */
export const COUNT_HALF = 6;
export const COUNT_EDGE = 6;
/** Under the main conversation the first lane keeps this far down, so an arrow and a corner fit. */
export const BAND_EDGE = 12;
/** Ends at a session's side keep this far from its corners, and take this much room each. */
export const SIDE_EDGE = 6;
export const START_ROOM = 2;
export const ARROW_ROOM = 3;
export const COUNT_ROOM = 6;
/** Ends on the lower edge of the main conversation: the first this far from its right end, then apart. */
export const LOW_EDGE = 14;
export const LOW_STEP = 8;
