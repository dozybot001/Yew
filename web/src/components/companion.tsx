import { type CSSProperties, type PointerEvent, useEffect, useRef, useState } from "react";
import type { PermissionRequest } from "../../../src/shared/types.ts";
import { openCenter, openSettings, selectSession } from "../actions.ts";
import {
	type Box,
	BUBBLE_WIDTH,
	boxAt,
	bubbleSide,
	type CompanionLine,
	type CompanionMood,
	clampBox,
	companionMood,
	defaultSpot,
	EDGE,
	POSES,
	parseSpot,
	pick,
	roomBesideComposer,
	type Size,
	type Spot,
	spotOf,
	workingPose,
} from "../companion.ts";
import { t, useLang } from "../i18n.ts";
import { centerCount, setState, triggerReaction, useAppState } from "../state.ts";
import { Mascot } from "./mascot.tsx";
import { useNow } from "./ui.tsx";

/** When Yew opened in this tab: the mascot greets during the first minute. */
const OPENED_AT = Date.now();

/** Her size on screen; every pose shares one 373 by 400 canvas (poses.ts). */
const HEIGHT = 76;
const SIZE: Size = { width: Math.round((HEIGHT * 373) / 400), height: HEIGHT };
/** How far the pointer moves before a press becomes a drag instead of a click. */
const DRAG_SLOP = 4;
/**
 * The sidebar's width open and folded (`.app` in app.css), for where she stands until moved and how
 * wide the page beside it is.
 */
const SIDEBAR_WIDTH = { open: 260, folded: 56 };
const SPOT_KEY = "yew.companionSpot";

function rememberedSpot(): Spot | null {
	try {
		return parseSpot(localStorage.getItem(SPOT_KEY));
	} catch {
		return null;
	}
}

function rememberSpot(spot: Spot): void {
	try {
		localStorage.setItem(SPOT_KEY, JSON.stringify(spot));
	} catch {
		// Storage can be unavailable (private windows); she then stays there for this page only.
	}
}

function viewport(): Size {
	return {
		width: document.documentElement.clientWidth,
		height: document.documentElement.clientHeight,
	};
}

/** The window's size, kept current as it changes, so she keeps to her corner. */
function useViewport(): Size {
	const [size, setSize] = useState(viewport);
	useEffect(() => {
		const update = () => setSize(viewport());
		window.addEventListener("resize", update);
		return () => window.removeEventListener("resize", update);
	}, []);
	return size;
}

/** A press on her: where it began, and once it drags, where she is now. */
interface Press {
	id: number;
	x: number;
	y: number;
	from: Box;
	at: Box | null;
}

function lineText(line: CompanionLine): string {
	switch (line.kind) {
		case "waiting":
			return line.count === 1
				? t("companion_waiting_one")
				: t("companion_waiting", { n: line.count });
		case "clear":
			return t(line.night ? "companion_night" : "companion_clear");
		case "update":
			return t("companion_update", { v: line.version });
		case "restart":
			return t("companion_restart");
		default:
			return line.name
				? t(`companion_${line.kind}_named`, { name: line.name })
				: t(`companion_${line.kind}`, { n: line.count });
	}
}

export function moodText(mood: CompanionMood): string {
	const line = lineText(mood.line);
	return mood.greeting
		? t("companion_greet", { greeting: t(`companion_${mood.greeting}`), line })
		: line;
}

/**
 * Yew floating over the window. Her bubble says the one thing that matters
 * most now; when it names a place, the bubble is a button that goes there. She can be dragged anywhere
 * in the window, and this browser remembers where; a press that does not move is a poke, and she
 * answers it. Until moved she stands at the bottom, just right of the sidebar; a window with no room
 * for her there beside the composer does not show her. The picture is decoration and screen readers
 * skip it; a bubble that goes nowhere is skipped too, since the sidebar already says the same. Only
 * the picture and a bubble that goes somewhere take clicks; the rest of her box lets them through to
 * what is under it.
 */
export function Companion() {
	useLang();
	const enabled = useAppState((state) => state.settings?.mascot !== false);
	const sessions = useAppState((state) => state.sessions);
	const center = useAppState((state) => state.center);
	const schedules = useAppState((state) => state.schedules);
	const page = useAppState((state) => state.page);
	const selectedId = useAppState((state) => state.selectedId);
	const updates = useAppState((state) => state.updates);
	const transcript = useAppState((state) => state.transcript);
	const reaction = useAppState((state) => state.reaction);
	const folded = useAppState((state) => state.sidebarCollapsed);
	const view = useViewport();
	const [spot, setSpot] = useState<Spot | null>(rememberedSpot);
	const [drag, setDrag] = useState<Box | null>(null);
	const press = useRef<Press | null>(null);
	const dragged = useRef(false);
	// Each click moves her on to another pose (pick in companion.ts).
	const [turn, setTurn] = useState(0);
	// Often enough to end the greeting about on time and to change her pose about once a minute.
	const now = useNow(10_000);
	const sidebarWidth = folded ? SIDEBAR_WIDTH.folded : SIDEBAR_WIDTH.open;
	const fit = roomBesideComposer(view.width - sidebarWidth, SIZE);
	if (!enabled || fit === "none") return null;
	const waiting = centerCount(center);
	const liveSessions = Object.values(sessions);
	const asked = Object.values(center.approvals).filter(
		(approval) => approval.kind === "permission",
	);
	const moodInput = {
		sessions: liveSessions,
		waiting,
		permission: asked.length > 0,
		budget: asked.some((approval) =>
			(approval.request as PermissionRequest).reasons?.includes("raise-budget"),
		),
		onDuty: schedules?.some((schedule) => schedule.enabled) ?? false,
		now,
		hour: new Date(now).getHours(),
		openedAt: OPENED_AT,
		update:
			updates?.restart || updates?.job?.state === "installed"
				? { kind: "restart" as const, version: updates.installed.version }
				: updates?.available && updates.latest
					? { kind: "update" as const, version: updates.latest.version }
					: null,
	};
	const mood = companionMood({ ...moodInput, turn });
	const activeReaction =
		reaction && reaction.until > now && (waiting === 0 || reaction.priority) ? reaction : null;
	const text = activeReaction ? t(activeReaction.key, activeReaction.params) : moodText(mood);
	// Where you already are, the bubble only talks.
	const here =
		(mood.target?.kind === "center" && page === "center") ||
		(mood.target?.kind === "session" && page === null && mood.target.id === selectedId);
	const target = activeReaction || here ? null : mood.target;
	const openWorking =
		page === null && selectedId !== null && sessions[selectedId]?.status === "working";
	const liveTool = openWorking ? workingPose(transcript) : null;
	// The home page already waves at you from the middle.
	const basePose =
		mood.line.kind === "working" && liveTool
			? liveTool
			: page === null && selectedId === null && mood.pose === "greeting"
				? "happy"
				: mood.pose;
	const pose = activeReaction ? activeReaction.pose : basePose;

	const box = drag ?? boxAt(spot ?? defaultSpot(sidebarWidth), view, SIZE);
	// Where she starts in a narrower page her bubble reaches back over the sidebar, clear of the
	// composer beside her; anywhere else, and while she is dragged, toward the middle of the window.
	const { side, align } = bubbleSide(
		box,
		view,
		SIZE,
		spot === null && drag === null && fit === "mascot",
	);
	// Pinned by her own edges away from the bubble, so a longer line grows toward the middle.
	const place: CSSProperties = {
		...(side === "right" ? { left: box.left } : { right: view.width - box.left - SIZE.width }),
		...(align === "top" ? { top: box.top } : { bottom: view.height - box.top - SIZE.height }),
	};
	// The bubble stays in the window, wrapping when there is less room than its usual width.
	const room = side === "right" ? view.width - box.left - EDGE : box.left + SIZE.width - EDGE;

	const go = () => {
		setState({ drawerOpen: false });
		if (target?.kind === "center") openCenter("pending");
		else if (target?.kind === "session") void selectSession(target.id);
		else if (target?.kind === "about") openSettings("about");
	};
	// A poke moves her on to the next pose of what she says now; where that is a single pose (her
	// greeting, a new version), to one of the poses for when nothing waits.
	const poke = () => {
		const next = turn + 1;
		const after = companionMood({ ...moodInput, turn: next }).pose;
		const shown = after !== pose ? after : pick(POSES.clear, now, next);
		setTurn(next);
		const active = liveSessions.filter((session) => session.archivedAt === null);
		const busyCount = active.filter((session) => session.status === "working").length;
		const dutyCount = schedules?.filter((schedule) => schedule.enabled).length ?? 0;
		if (busyCount > 0) {
			triggerReaction(shown, "companion_poke_busy", { params: { n: busyCount }, ms: 2800 });
		} else if (dutyCount > 0) {
			triggerReaction(shown, "companion_poke_duty", { params: { n: dutyCount }, ms: 2800 });
		} else {
			triggerReaction(shown, "companion_poke_ready", { params: { n: active.length }, ms: 2800 });
		}
	};
	const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
		if (event.button !== 0) return;
		dragged.current = false;
		press.current = {
			id: event.pointerId,
			x: event.clientX,
			y: event.clientY,
			from: box,
			at: null,
		};
		event.currentTarget.setPointerCapture(event.pointerId);
	};
	const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
		const current = press.current;
		if (!current || current.id !== event.pointerId) return;
		const dx = event.clientX - current.x;
		const dy = event.clientY - current.y;
		if (!current.at && Math.hypot(dx, dy) < DRAG_SLOP) return;
		current.at = clampBox({ left: current.from.left + dx, top: current.from.top + dy }, view, SIZE);
		setDrag(current.at);
	};
	const onPointerEnd = (event: PointerEvent<HTMLButtonElement>) => {
		const current = press.current;
		if (!current || current.id !== event.pointerId) return;
		press.current = null;
		if (!current.at) return;
		dragged.current = true;
		const next = spotOf(current.at, view, SIZE);
		setSpot(next);
		rememberSpot(next);
		setDrag(null);
	};
	const onClick = () => {
		// The click that ends a drag is not a poke.
		if (dragged.current) {
			dragged.current = false;
			return;
		}
		poke();
	};
	return (
		<div
			className={`companion companion-${side} companion-${align}${drag ? " companion-dragging" : ""}`}
			style={place}
		>
			<button
				type="button"
				className="companion-mascot-btn"
				onClick={onClick}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerEnd}
				onPointerCancel={onPointerEnd}
				aria-hidden="true"
				tabIndex={-1}
			>
				<Mascot key={pose} pose={pose} height={HEIGHT} className="companion-mascot" />
			</button>
			{target ? (
				<button
					type="button"
					className="companion-bubble companion-go"
					style={{ maxWidth: Math.min(BUBBLE_WIDTH, room) }}
					onClick={go}
				>
					{text}
				</button>
			) : (
				<p
					className="companion-bubble"
					style={{ maxWidth: Math.min(BUBBLE_WIDTH, room) }}
					aria-hidden="true"
				>
					{text}
				</p>
			)}
		</div>
	);
}
