/**
 * Text typed into a message box and not sent. Yew keeps it, so it is still there after the page is
 * closed or left: one text for each session, under its id, and one for the home page, under "home".
 */

/** How the texts reach Yew: the page passes its API, the tests a stand-in. */
export interface UnsentLink {
	read(place: string): Promise<string>;
	/** `leaving`: the page is going away, so the request has to outlive it. */
	write(place: string, text: string, leaving: boolean): Promise<void>;
}

interface Kept {
	/** The newest text this page knows. */
	text: string;
	/** Changes made on this page, so that an answer on its way does not replace newer text. */
	changes: number;
	/** Changed since it was last sent. */
	unsaved: boolean;
	timer: ReturnType<typeof setTimeout> | null;
	saving: boolean;
}

export class UnsentTexts {
	readonly #link: UnsentLink;
	readonly #saveAfterMs: number;
	readonly #kept = new Map<string, Kept>();

	constructor(link: UnsentLink, saveAfterMs = 500) {
		this.#link = link;
		this.#saveAfterMs = saveAfterMs;
	}

	/** What this page last knew of a place, to show before Yew has answered. */
	known(place: string): string {
		return this.#kept.get(place)?.text ?? "";
	}

	/**
	 * Reads the saved text. Null when the box holds something newer or the text could not be read:
	 * the box keeps what it has.
	 */
	async load(place: string): Promise<string | null> {
		const kept = this.#of(place);
		if (kept.unsaved || kept.saving) return null;
		const changes = kept.changes;
		let text: string;
		try {
			text = await this.#link.read(place);
		} catch {
			return null;
		}
		if (kept.changes !== changes) return null;
		kept.text = text;
		return text;
	}

	/** Takes the box's text. It is saved a moment later; an emptied box is saved at once. */
	keep(place: string, text: string): void {
		const kept = this.#of(place);
		if (kept.text === text) return;
		kept.text = text;
		kept.changes++;
		kept.unsaved = true;
		if (text === "") this.flush(place);
		else kept.timer ??= setTimeout(() => this.flush(place), this.#saveAfterMs);
	}

	/** Saves now what is waiting: when the box goes away or, with `leaving`, the whole page. */
	flush(place: string, leaving = false): void {
		const kept = this.#kept.get(place);
		if (!kept) return;
		if (kept.timer !== null) {
			clearTimeout(kept.timer);
			kept.timer = null;
		}
		if (!kept.unsaved) return;
		if (leaving) {
			// No waiting for a save on its way: the page will not be there to send the next one.
			kept.unsaved = false;
			void this.#link.write(place, kept.text, true).catch(() => {});
		} else if (!kept.saving) {
			void this.#save(place, kept);
		}
	}

	flushAll(leaving = false): void {
		for (const place of this.#kept.keys()) this.flush(place, leaving);
	}

	/** One request at a time for a place; text changed meanwhile goes out next, so the last one stays. */
	async #save(place: string, kept: Kept): Promise<void> {
		kept.saving = true;
		try {
			while (kept.unsaved) {
				kept.unsaved = false;
				await this.#link.write(place, kept.text, false);
			}
		} catch {
			// The text is still in the box; the next change, or leaving, sends it again.
			kept.unsaved = true;
		} finally {
			kept.saving = false;
		}
	}

	#of(place: string): Kept {
		let kept = this.#kept.get(place);
		if (!kept) {
			kept = { text: "", changes: 0, unsaved: false, timer: null, saving: false };
			this.#kept.set(place, kept);
		}
		return kept;
	}
}
