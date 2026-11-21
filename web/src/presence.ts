import { api } from "./api.ts";

/**
 * Tells Yew that you are at the Mac: its page is in front and was used in the last two minutes. While
 * that holds, Yew does not notify your phone about things you can see here.
 */
const ACTIVE_MS = 2 * 60 * 1000;
const EVERY_MS = 30_000;

export function watchPresence(): void {
	let usedAt = Date.now();
	let toldAt = 0;
	const tell = () => {
		const now = Date.now();
		if (document.visibilityState !== "visible" || !document.hasFocus()) return;
		if (now - usedAt > ACTIVE_MS || now - toldAt < EVERY_MS) return;
		toldAt = now;
		void api("POST", "/api/presence").catch(() => {});
	};
	const used = () => {
		usedAt = Date.now();
		tell();
	};
	for (const type of ["pointerdown", "pointermove", "keydown", "wheel"] as const) {
		window.addEventListener(type, used, { passive: true });
	}
	document.addEventListener("visibilitychange", used);
	window.addEventListener("focus", used);
	window.setInterval(tell, EVERY_MS);
	tell();
}
