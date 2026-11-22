export const LAST_SESSION = "yew.lastSession";

export function remember(key: string, value: string | null): void {
	try {
		if (value === null) localStorage.removeItem(key);
		else localStorage.setItem(key, value);
	} catch {
		// Storage can be unavailable; it only holds conveniences.
	}
}

export function recall(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

const VIEW = "yew.view";
export const CENTER_TABS: readonly string[] = ["pending", "decided", "letters"];

/**
 * Where this tab is (a session, the approval center, the start page), so reloading the page returns
 * there. It lives as long as the tab: a new tab still opens on the main conversation.
 */
export function rememberView(view: string): void {
	try {
		sessionStorage.setItem(VIEW, view);
	} catch {
		// Storage can be unavailable; the page then opens as on a fresh start.
	}
}

export function recallView(): string | null {
	try {
		return sessionStorage.getItem(VIEW);
	} catch {
		return null;
	}
}
