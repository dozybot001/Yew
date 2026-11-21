import { useEffect, useState } from "react";
import { t, useLang } from "../i18n.ts";
import { centerCount, MASCOT_KEY, useAppState } from "../state.ts";
import { ProductName } from "./icons.tsx";
import { Mascot } from "./mascot.tsx";

/** The opening plays once per tab: a reload in the same tab goes straight in. */
const PLAYED_KEY = "yew.opening";
/** The shortest the opening lasts, so its drawing finishes even when Yew starts at once. */
const MIN_MS = 1100;
const LEAVE_MS = 260;

function shouldPlay(): boolean {
	if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return false;
	try {
		if (localStorage.getItem(MASCOT_KEY) === "off") return false;
	} catch {
		// Storage is off; the settings decide once they arrive.
	}
	try {
		if (sessionStorage.getItem(PLAYED_KEY)) return false;
		sessionStorage.setItem(PLAYED_KEY, "1");
	} catch {
		// Without storage it plays on every load of this page.
	}
	return true;
}

// Decided once per page load: React's development double render must not decide it twice.
const PLAY = shouldPlay();
const STARTED_AT = Date.now();

function Step({ done, text }: { done: boolean; text: string }) {
	return (
		<li className={done ? "opening-step done" : "opening-step"}>
			<span className="opening-tick">{done ? "✓" : "·"}</span>
			{text}
		</li>
	);
}

/**
 * The opening: Yew's mark draws itself, Yew waves, and the real steps of the
 * start are ticked off as they finish. It leaves by itself once they are done, or, with "click to
 * enter" chosen in Personalization, waits there for a click or a key. A
 * click or any key skips it at any time; it never plays when the system asks for less motion or Yew is
 * hidden. Decoration only: screen readers skip it, and it takes no focus.
 */
export function Opening() {
	useLang();
	const [leaving, setLeaving] = useState(false);
	const [gone, setGone] = useState(!PLAY);
	const phase = useAppState((state) => state.phase);
	const booted = useAppState((state) => state.booted);
	const health = useAppState((state) => state.health);
	const settings = useAppState((state) => state.settings);
	const sessions = useAppState((state) => state.sessions);
	const waiting = useAppState((state) => centerCount(state.center));
	const finished = phase === "signin" || phase === "failed" || (phase === "ready" && booted);
	const mascotOff = settings?.mascot === false;
	// Waits for the person only once the interface is there to enter; sign-in and failure pages go on.
	const waitForClick = settings?.opening === "click" && phase === "ready";

	useEffect(() => {
		if (gone || leaving) return;
		if (mascotOff) {
			setGone(true);
			return;
		}
		if (!finished || waitForClick) return;
		const timer = setTimeout(() => setLeaving(true), Math.max(0, STARTED_AT + MIN_MS - Date.now()));
		return () => clearTimeout(timer);
	}, [finished, waitForClick, mascotOff, gone, leaving]);

	useEffect(() => {
		if (!leaving) return;
		const timer = setTimeout(() => setGone(true), LEAVE_MS);
		return () => clearTimeout(timer);
	}, [leaving]);

	useEffect(() => {
		if (gone) return;
		const skip = () => setLeaving(true);
		document.addEventListener("keydown", skip);
		document.addEventListener("pointerdown", skip);
		return () => {
			document.removeEventListener("keydown", skip);
			document.removeEventListener("pointerdown", skip);
		};
	}, [gone]);

	if (gone) return null;
	const ready = phase === "ready";
	const count = Object.values(sessions).filter((session) => session.archivedAt === null).length;
	return (
		<div className={leaving ? "opening opening-leaving" : "opening"} aria-hidden="true">
			<div className="opening-stage">
				<svg className="opening-mark" viewBox="0 0 64 64" width={88} height={88} aria-hidden="true">
					<circle className="opening-ring" cx="32" cy="32" r="30" pathLength={1} />
					{/*
					 * The mark drawn at full size reaches past the ring: the leaf's tip at the top right is
					 * 34 from the centre, the ring 30. Centred on what is drawn (3.9 to 60 across, 12.6 to
					 * 50.8 down, as the app icons place it) and scaled to three quarters, its farthest
					 * point, the leaf's tip, is 26 from the centre.
					 */}
					<g transform="translate(32 32) scale(0.75) translate(-31.95 -31.7)">
						<path
							className="opening-leaf"
							pathLength={1}
							d="M35.4 50.2C36.6 37.6 42.6 22.6 60 12.6C58.6 24.4 55.2 32.4 49.4 38.6C45 43.3 39.4 46.4 35.4 50.2Z"
						/>
						<ellipse
							className="opening-berry"
							cx="19.8"
							cy="35.4"
							rx="15.9"
							ry="15.4"
							fill="#C8323F"
						/>
						<ellipse
							className="opening-seed"
							cx="25.8"
							cy="22.6"
							rx="4.6"
							ry="3.1"
							transform="rotate(12 25.8 22.6)"
							fill="#1F3A2E"
						/>
					</g>
				</svg>
				<ProductName className="opening-word" />
				<Mascot pose="greeting" height={112} className="opening-mascot" />
			</div>
			<ol className="opening-steps">
				<Step
					done={health !== null}
					text={health ? t("boot_serverDone", { version: health.version }) : t("boot_server")}
				/>
				<Step
					done={settings !== null}
					text={settings ? t("boot_settingsDone") : t("boot_settings")}
				/>
				<Step
					done={ready}
					text={ready ? t("boot_sessionsDone", { n: count }) : t("boot_sessions")}
				/>
				<Step
					done={booted}
					text={
						!booted
							? t("boot_center")
							: waiting > 0
								? t("boot_centerWaiting", { n: waiting })
								: t("boot_centerClear")
					}
				/>
			</ol>
			{finished && waitForClick ? (
				<p className="opening-skip opening-enter">{t("boot_enter")}</p>
			) : (
				<p className="opening-skip">{t("boot_skip")}</p>
			)}
		</div>
	);
}
