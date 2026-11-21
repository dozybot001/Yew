import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { invalid } from "../errors.ts";
import type { Clear, Note } from "../push.ts";
import type { Store } from "../store.ts";
import type { AppEnv } from "./problem.ts";

const KEEPALIVE_MS = 15_000;
const MAX_QUEUE = 200;

/**
 * Notifications for phones that keep their own connection instead of a push service (the Android
 * app). What the notifier decides to tell the phone is written to every paired
 * phone that has this stream open and takes notifications, as plain JSON: the channel it travels
 * in is already end-to-end encrypted. A phone that was away reads the approval center when it is
 * back; nothing is kept for it here.
 */
export class NoteStreams {
	readonly #listeners = new Map<string, Set<(note: Note | Clear) => void>>();
	readonly #store: Store;

	constructor(store: Store) {
		this.#store = store;
	}

	/** Writes to the phones listening now; returns how many took it. */
	send(note: Note | Clear): number {
		const takes = new Set(
			this.#store
				.listDevices()
				.filter((device) => device.push)
				.map((device) => device.id),
		);
		let sent = 0;
		for (const [device, listeners] of this.#listeners) {
			if (!takes.has(device) || listeners.size === 0) continue;
			for (const listener of listeners) listener(note);
			sent += 1;
		}
		return sent;
	}

	listen(device: string, listener: (note: Note | Clear) => void): () => void {
		const listeners = this.#listeners.get(device) ?? new Set();
		this.#listeners.set(device, listeners);
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) this.#listeners.delete(device);
		};
	}
}

/** `GET /api/notes`: `hello`, then one `note` event per notification. Paired phones only. */
export function noteRoutes(streams: NoteStreams): Hono<AppEnv> {
	const app = new Hono<AppEnv>();

	app.get("/notes", (c) => {
		const device = c.env?.device;
		if (!device) throw invalid("Only a paired phone listens for notifications.", "device");
		return streamSSE(c, async (stream) => {
			const queue: string[] = [];
			let wake: (() => void) | null = null;
			const stop = streams.listen(device, (note) => {
				// A phone that does not keep up loses the oldest; it reads the approval center anyway.
				if (queue.length >= MAX_QUEUE) queue.shift();
				queue.push(JSON.stringify(note));
				wake?.();
			});
			stream.onAbort(() => {
				stop();
				wake?.();
			});
			await stream.writeSSE({ event: "hello", data: "{}" });
			const keepalive = setInterval(() => {
				void stream.write(": keepalive\n\n");
			}, KEEPALIVE_MS);
			try {
				while (!stream.aborted) {
					const data = queue.shift();
					if (data !== undefined) {
						await stream.writeSSE({ event: "note", data });
						continue;
					}
					await new Promise<void>((resolve) => {
						wake = resolve;
					});
					wake = null;
				}
			} finally {
				clearInterval(keepalive);
				stop();
			}
		});
	});

	return app;
}
