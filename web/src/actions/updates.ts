import type { UpdateState } from "../../../src/shared/types.ts";
import { api } from "../api.ts";
import { getState, setState } from "../state.ts";

// --- versions and updates ---

let updatesTimer: number | null = null;

/** Reads the versions and updates; while an update installs or a restart waits, again soon. */
export async function loadUpdates(): Promise<void> {
	try {
		setState({ updates: await api<UpdateState>("GET", "/api/updates") });
	} catch {
		// Not this computer's browser, or Yew Harness is restarting: nothing to show now.
	}
	followUpdates();
}

function followUpdates(): void {
	if (updatesTimer !== null) window.clearTimeout(updatesTimer);
	const updates = getState().updates;
	const soon = updates?.job?.state === "installing" || updates?.restartPending === true;
	updatesTimer = window.setTimeout(() => void loadUpdates(), soon ? 2000 : 30 * 60_000);
}

export async function checkUpdates(): Promise<void> {
	setState({ updates: await api<UpdateState>("POST", "/api/updates/check") });
	followUpdates();
}

export async function installUpdate(version: string): Promise<void> {
	setState({ updates: await api<UpdateState>("POST", "/api/updates/install", { version }) });
	followUpdates();
}

/** Restarts Yew Harness: at once, or once no session is at work. The page comes back by itself. */
export async function restartYew(now: boolean): Promise<void> {
	const answer = await api<UpdateState & { restarting: boolean }>("POST", "/api/updates/restart", {
		now,
	});
	const { restarting: _restarting, ...updates } = answer;
	setState({ updates });
	followUpdates();
}

/**
 * After the stream comes back: a Yew Harness that restarted on other code gets its page loaded
 * again, so the page matches it.
 */
export async function reloadIfReplaced(): Promise<void> {
	const before = getState().health;
	if (!before) return;
	try {
		const now = await api<{ version: string; build?: string | null }>("GET", "/api/health");
		if (now.version !== before.version || (now.build ?? null) !== before.build) {
			window.location.reload();
		}
	} catch {
		// Still starting; the next reconnect asks again.
	}
}
