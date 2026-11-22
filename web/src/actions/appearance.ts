import { setLang, systemLang } from "../i18n.ts";
import { getState, MASCOT_KEY, type Settings, THEME_KEY } from "../state.ts";

// --- appearance ---

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

/** The light or dark this browser saw chosen last; "system" when none. */
function rememberedTheme(): Settings["theme"] {
	try {
		const theme = localStorage.getItem(THEME_KEY);
		return theme === "light" || theme === "dark" ? theme : "system";
	} catch {
		return "system";
	}
}

/**
 * The page's background as its `theme-color` while the person has chosen light or dark: the Mac
 * app's window (macos/) takes it for its own and opens in it next time. Following the system, there
 * is none, and the window follows the system too.
 */
function setThemeColor(color: string | null): void {
	let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
	if (!color) {
		meta?.remove();
		return;
	}
	if (!meta) {
		meta = document.createElement("meta");
		meta.name = "theme-color";
		document.head.append(meta);
	}
	if (meta.content !== color) meta.content = color;
}

export function applyAppearance(settings: Settings | null): void {
	// Before the settings arrive, the theme chosen last in this browser, so the page does not start in
	// the system's and then turn.
	const theme = settings?.theme ?? rememberedTheme();
	const dark = theme === "dark" || (theme === "system" && darkQuery.matches);
	const root = document.documentElement;
	root.dataset.theme = dark ? "dark" : "light";
	setThemeColor(
		theme === "system" ? null : getComputedStyle(root).getPropertyValue("--bg").trim() || null,
	);
	const language = settings?.language ?? "system";
	setLang(language === "system" ? systemLang() : language);
	// The opening plays before the settings arrive, so this browser remembers when the mascot is off.
	if (settings) {
		try {
			if (settings.mascot === false) localStorage.setItem(MASCOT_KEY, "off");
			else localStorage.removeItem(MASCOT_KEY);
			if (settings.theme === "system") localStorage.removeItem(THEME_KEY);
			else localStorage.setItem(THEME_KEY, settings.theme);
		} catch {
			// Storage is off in this browser; the opening then stops once the settings arrive.
		}
	}
}

darkQuery.addEventListener("change", () => applyAppearance(getState().settings));
