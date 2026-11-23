import type { Store } from "../store.ts";

/**
 * Sessions that are held back: ones the person stopped, and ones that stopped at a daily spending
 * limit. Kept in the database, so Yew behaves the same after a restart: a session the person stopped
 * is not started by a letter, and one at a limit goes on when the limit is raised that day. The day
 * a session stopped at a limit is on the session itself, where the interface reads it.
 */
export class Held {
	readonly #store: Store;
	readonly #paused: Set<string>;

	constructor(store: Store) {
		this.#store = store;
		this.#paused = new Set(store.getSetting<string[]>("pausedSessions", []));
	}

	isPaused(sessionId: string): boolean {
		return this.#paused.has(sessionId);
	}

	pause(sessionId: string): void {
		if (this.#paused.has(sessionId)) return;
		this.#paused.add(sessionId);
		this.#store.setSetting("pausedSessions", [...this.#paused]);
	}

	resume(sessionId: string): void {
		if (this.#paused.delete(sessionId)) this.#store.setSetting("pausedSessions", [...this.#paused]);
	}

	capped(): [string, string][] {
		return this.#store.cappedSessions();
	}

	cap(sessionId: string, day: string): void {
		this.#store.setCappedDay(sessionId, day);
	}

	uncap(sessionId: string): void {
		this.#store.setCappedDay(sessionId, null);
	}

	/** The session is gone for good. */
	forget(sessionId: string): void {
		this.resume(sessionId);
		this.uncap(sessionId);
	}
}
