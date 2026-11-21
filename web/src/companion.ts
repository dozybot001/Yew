/**
 * What the floating Yew says (blueprint, section 12): the one thing that matters most right now, in
 * this order: things waiting for the person, a session that failed, a session that finished and waits
 * for review, sessions at work, a new version; otherwise that nothing waits. In the first minute after
 * the interface opens she greets first. Her pose follows what she says, taken from a list for each
 * thing she can say: holding a card or asking you to look when a permission waits, and keeping watch
 * when nothing does but scheduled tasks are on (blueprint, section 11). She takes another pose from
 * the list every minute, and at once when clicked.
 * She can be dragged anywhere in the window; where she stands, and whether a window has room for her,
 * is worked out at the end of this file.
 */
import type { Session, ToolCallView } from "../../src/shared/types.ts";
import type { MascotPose } from "./poses.ts";

export type Greeting = "morning" | "afternoon" | "evening";

export type CompanionLine =
	| { kind: "waiting"; count: number }
	| { kind: "error" | "review" | "working"; count: number; name: string | null }
	/** A new version to install, or one installed that a restart takes up (blueprint, "版本与更新"). */
	| { kind: "update" | "restart"; version: string }
	| { kind: "clear"; night: boolean };

/** Where clicking the bubble goes; null when it names nothing to go to. */
export type CompanionTarget =
	| { kind: "center" }
	| { kind: "session"; id: string }
	| { kind: "about" }
	| null;

export interface CompanionMood {
	pose: MascotPose;
	greeting: Greeting | null;
	line: CompanionLine;
	target: CompanionTarget;
}

/** How long after Yew opens the mascot greets before what she says. */
export const GREETING_MS = 60_000;

/**
 * The poses each line may take, at least three each, so that she never takes the same pose twice in
 * a row (see pick). New poses join these lists.
 */
export const POSES: Record<
	"waiting" | "permission" | "error" | "review" | "working" | "duty" | "clear" | "night",
	MascotPose[]
> = {
	waiting: ["greeting", "stamp", "pointing", "halt", "pout"],
	permission: ["permission", "halt", "pointing"],
	error: ["sorry", "bow", "teary", "lost"],
	review: ["gift", "giftbox", "proud", "jump"],
	working: ["thinking", "writing", "typing", "clipboard", "magnifier", "books", "fired-up"],
	duty: ["on-duty", "alarm", "tea", "clipboard", "reading"],
	clear: ["happy", "tea", "stretch", "peek", "branch", "shush", "reading"],
	night: ["sleepy", "nap", "pajamas", "dozing"],
};

/** How long she keeps a pose before she takes another from the same list. */
export const POSE_MS = 60_000;

const GOLDEN = (Math.sqrt(5) - 1) / 2;

/**
 * Her pose from a list for this minute, moved on by `turn`, the times she has been clicked. Each step
 * goes on by the golden ratio around the list, so the order looks random and covers the whole list;
 * from a list of three or more, two steps in a row never give the same pose. The same minute and turn
 * give the same pose on every render, so she never flickers.
 */
export function pick(list: readonly MascotPose[], now: number, turn = 0): MascotPose {
	const step = Math.floor(now / POSE_MS) + turn;
	return list[Math.floor(((step * GOLDEN) % 1) * list.length)] as MascotPose;
}

export function greetingFor(hour: number): Greeting | null {
	if (hour >= 5 && hour < 12) return "morning";
	if (hour >= 12 && hour < 18) return "afternoon";
	if (hour >= 18 && hour < 23) return "evening";
	return null;
}

export function isNight(hour: number): boolean {
	return hour >= 23 || hour < 5;
}

/** Maps a live tool name to Yew's matching work pose so her actions track what the agent is doing. */
export function poseForTool(toolName: string): MascotPose {
	switch (toolName) {
		case "grep":
		case "glob":
		case "web_search":
			return "magnifier";
		case "read":
		case "read_attachment":
		case "web_fetch":
			return "reading";
		case "edit":
		case "write":
			return "writing";
		case "shell":
		case "shell_job":
			return "typing";
		case "send_letter":
			return "letter-run";
		case "todo":
		case "manage_yew":
		case "post_card":
			return "clipboard";
		case "delegate":
			return "books";
		case "ask":
			return "pointing";
		default:
			return "thinking";
	}
}

/** Picks the most recent running tool's pose in the open transcript, if any. */
export function activeToolPose(
	toolCalls: Record<string, ToolCallView> | undefined,
): MascotPose | null {
	if (!toolCalls) return null;
	let latest: ToolCallView | null = null;
	for (const call of Object.values(toolCalls)) {
		if (call.status !== "running") continue;
		const time = call.startedAt ?? call.createdAt;
		const latestTime = latest ? (latest.startedAt ?? latest.createdAt) : -1;
		if (!latest || time >= latestTime) latest = call;
	}
	return latest ? poseForTool(latest.tool) : null;
}

export function companionMood(input: {
	sessions: Iterable<Session>;
	/** Approvals, questions, decision cards and held letters waiting for the person. */
	waiting: number;
	/** Whether a permission request is among what waits. */
	permission?: boolean;
	/** Whether a scheduled task is on, so something is still watched when nothing else goes on. */
	onDuty?: boolean;
	now: number;
	/** The local hour, 0 to 23. */
	hour: number;
	/** When Yew opened in this tab. */
	openedAt: number;
	/** A version installed but not running yet, or a newer one on npm (blueprint, "版本与更新"). */
	update?: { kind: "update" | "restart"; version: string } | null;
	/** How many times she has been clicked; each click moves her on to another pose. */
	turn?: number;
}): CompanionMood {
	const { now, hour } = input;
	const turn = input.turn ?? 0;
	const greeting = now - input.openedAt < GREETING_MS ? greetingFor(hour) : null;
	if (input.waiting > 0) {
		return {
			pose: greeting
				? "greeting"
				: pick(input.permission ? POSES.permission : POSES.waiting, now, turn),
			greeting,
			line: { kind: "waiting", count: input.waiting },
			target: { kind: "center" },
		};
	}
	const live = [...input.sessions]
		.filter((session) => session.archivedAt === null)
		.sort((a, b) => b.updatedAt - a.updatedAt);
	for (const kind of ["error", "review", "working"] as const) {
		const status = kind === "review" ? "needs_review" : kind;
		const matching = live.filter((session) => session.status === status);
		const only = matching.length === 1 ? (matching[0] as Session) : null;
		if (matching.length > 0) {
			return {
				pose: pick(POSES[kind], now, turn),
				greeting,
				line: { kind, count: matching.length, name: only?.name ?? null },
				target: only ? { kind: "session", id: only.id } : null,
			};
		}
	}
	if (input.update) {
		return {
			pose: greeting ? "greeting" : input.update.kind === "update" ? "giftbox" : "waking",
			greeting,
			line: input.update,
			target: { kind: "about" },
		};
	}
	const night = isNight(hour);
	return {
		pose: greeting
			? "greeting"
			: pick(input.onDuty ? POSES.duty : night ? POSES.night : POSES.clear, now, turn),
		greeting,
		line: { kind: "clear", night },
		target: null,
	};
}

/**
 * Where the floating Yew stands, as remembered in this browser: the window edge nearer to her on each
 * axis and how far she is from it. Measured this way she keeps to her corner when the window grows or
 * shrinks.
 */
export interface Spot {
	x: "left" | "right";
	dx: number;
	y: "top" | "bottom";
	dy: number;
}

/** Her box's top left corner in the window, in CSS pixels. */
export interface Box {
	left: number;
	top: number;
}

export interface Size {
	width: number;
	height: number;
}

/** How close to the window's edges she may stand, and how far she keeps from the composer. */
export const EDGE = 8;
/** The widest her bubble gets before a line wraps. */
export const BUBBLE_WIDTH = 220;
/** The composer's widest (`.composer-inner` in app.css); it stands in the middle of the page. */
const COMPOSER_WIDTH = 760;
/** How far right of the sidebar she starts. */
const START_GAP = 16;

/** Until she is moved she stands at the bottom of the window, just right of the sidebar. */
export function defaultSpot(sidebarWidth: number): Spot {
	return { x: "left", dx: sidebarWidth + START_GAP, y: "bottom", dy: 12 };
}

/**
 * What fits where she starts, left of the composer, in a page this wide right of the sidebar: nothing
 * when she would reach under the composer, so she is not shown and the composer keeps its place; only
 * she when her bubble reaching right would cover the composer's corner, so there it reaches back over
 * the sidebar; else both. Each side of the composer then has room for her gap from the sidebar, her
 * width or her bubble's, and EDGE.
 */
export function roomBesideComposer(page: number, size: Size): "none" | "mascot" | "both" {
	const needs = (width: number) => COMPOSER_WIDTH + 2 * (START_GAP + width + EDGE);
	if (page < needs(size.width)) return "none";
	return page < needs(BUBBLE_WIDTH) ? "mascot" : "both";
}

/** Keeps her whole box inside the window; one too small for her pins her to the top left. */
export function clampBox(box: Box, view: Size, size: Size): Box {
	const maxLeft = Math.max(EDGE, view.width - size.width - EDGE);
	const maxTop = Math.max(EDGE, view.height - size.height - EDGE);
	return {
		left: Math.min(Math.max(box.left, EDGE), maxLeft),
		top: Math.min(Math.max(box.top, EDGE), maxTop),
	};
}

/** Her box in this window for a remembered spot. */
export function boxAt(spot: Spot, view: Size, size: Size): Box {
	return clampBox(
		{
			left: spot.x === "left" ? spot.dx : view.width - size.width - spot.dx,
			top: spot.y === "top" ? spot.dy : view.height - size.height - spot.dy,
		},
		view,
		size,
	);
}

/** The spot to remember for a box: on each axis, measured from the edge nearer to her middle. */
export function spotOf(box: Box, view: Size, size: Size): Spot {
	const x = box.left + size.width / 2 < view.width / 2 ? "left" : "right";
	const y = box.top + size.height / 2 < view.height / 2 ? "top" : "bottom";
	return {
		x,
		dx: Math.round(x === "left" ? box.left : view.width - size.width - box.left),
		y,
		dy: Math.round(y === "top" ? box.top : view.height - size.height - box.top),
	};
}

/**
 * Where her bubble goes: over her head in the lower half of the window and under her feet in the upper
 * half (`align` is the half she is in), reaching toward the middle (`side`), so it stays in the window
 * wherever she is, also while she is dragged. Where she starts in a page with room for her but not
 * for her bubble beside the composer (`cramped`, see roomBesideComposer), it reaches back over the
 * sidebar instead.
 */
export function bubbleSide(
	box: Box,
	view: Size,
	size: Size,
	cramped = false,
): { side: "left" | "right"; align: "top" | "bottom" } {
	return {
		side: !cramped && box.left + size.width / 2 < view.width / 2 ? "right" : "left",
		align: box.top + size.height / 2 < view.height / 2 ? "top" : "bottom",
	};
}

/** Reads a remembered spot; anything else counts as none. */
export function parseSpot(text: string | null): Spot | null {
	if (!text) return null;
	try {
		const value = JSON.parse(text) as Partial<Spot> | null;
		if (
			value &&
			(value.x === "left" || value.x === "right") &&
			(value.y === "top" || value.y === "bottom") &&
			typeof value.dx === "number" &&
			Number.isFinite(value.dx) &&
			typeof value.dy === "number" &&
			Number.isFinite(value.dy)
		) {
			return { x: value.x, dx: Math.max(0, value.dx), y: value.y, dy: Math.max(0, value.dy) };
		}
		return null;
	} catch {
		return null;
	}
}
