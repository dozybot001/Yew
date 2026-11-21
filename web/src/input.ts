/**
 * What the person used last, a pointer or the keyboard, kept on the root element as `data-input`.
 * The focus ring is for the keyboard. WebKit, in Safari and in the Mac app's window, also
 * draws it after a click: on what a dialog or a menu focuses as it opens, and on the button focus
 * goes back to when it closes. So after a click the stylesheet leaves the ring out until a key is
 * pressed; text fields keep their focused border either way.
 */
export function watchInput(): void {
	const root = document.documentElement;
	// Only the person's own presses: the Mac app's Settings menu sends the page a made-up Command-comma.
	const used = (input: "pointer" | "keyboard") => (event: Event) => {
		if (event.isTrusted && root.dataset.input !== input) root.dataset.input = input;
	};
	document.addEventListener("pointerdown", used("pointer"), { capture: true, passive: true });
	document.addEventListener("keydown", used("keyboard"), { capture: true, passive: true });
}
