import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type JsonObject, messageText } from "../../shared/messages.ts";
import type { Entry, Session } from "../../shared/types.ts";
import { reached } from "../budget.ts";
import type { ModelGateway, ModelInfo } from "../model/gateway.ts";
import { SETTING_DEFAULTS } from "../settings.ts";
import type { Store } from "../store.ts";
import { clip } from "./context.ts";
import { OBSERVER_PERSONA, OBSERVER_PROMPT } from "./prompt.ts";
import { sideCall } from "./side.ts";

/** The file in Yew's data folder that says who she is, when the person wrote one. */
export const PERSONA_FILE = "persona.md";
const MAX_PERSONA_CHARS = 8000;
const MAX_REMARK_CHARS = 300;
const MAX_ASKED_CHARS = 2000;
const MAX_REPLY_CHARS = 4000;
const MAX_STEPS = 30;
const MAX_STEP_CHARS = 200;
/** How far back the start of the turn is looked for. */
const TURN_ENTRIES = 80;

/** What a model made of a turn (OBSERVER_PROMPT): the remark, or null when it has nothing to say. */
export function remarkFrom(text: string): string | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end < start) return null;
	let wrote: JsonObject;
	try {
		wrote = JSON.parse(text.slice(start, end + 1)) as JsonObject;
	} catch {
		return null;
	}
	const said = typeof wrote.text === "string" ? wrote.text.trim() : "";
	return wrote.says === true && said ? clip(said, MAX_REMARK_CHARS) : null;
}

/**
 * The turn that just ended, as she reads it: what the person wrote last, each call the session made
 * as one line, and its reply. Clipped, since this is sent to another model on every turn.
 */
export function turnText(entries: Entry[], said: string): string {
	// A letter from another session is a user entry too; the person's own message has no letter.
	const from = entries.findLastIndex((entry) => entry.role === "user" && !entry.letter);
	const asked = from < 0 ? null : entries[from];
	const steps: string[] = [];
	for (const entry of entries.slice(from + 1)) {
		if (entry.role !== "assistant" || typeof entry.message.content === "string") continue;
		for (const block of entry.message.content) {
			if (block.type !== "toolCall") continue;
			steps.push(`- ${clip(`${block.name} ${JSON.stringify(block.arguments)}`, MAX_STEP_CHARS)}`);
		}
	}
	const shown = steps.slice(-MAX_STEPS);
	return [
		asked?.role === "user"
			? `The person wrote:\n${clip(messageText(asked.message), MAX_ASKED_CHARS)}`
			: "",
		shown.length > 0
			? `What the assistant did${steps.length > shown.length ? ` (the last ${shown.length} of ${steps.length} calls)` : ""}:\n${shown.join("\n")}`
			: "",
		`The assistant's reply:\n${clip(said, MAX_REPLY_CHARS)}`,
	]
		.filter(Boolean)
		.join("\n\n");
}

export interface ObserverOptions {
	store: Store;
	gateway: ModelGateway;
	/** Yew's data folder, where the person's character notes are. */
	home: string;
	log: (line: string) => void;
	isRunning: (sessionId: string) => boolean;
}

/**
 * The observing Yew: after a turn the person started, a model of the person's choosing reads it and
 * may say one short thing about it, shown beside the reply. She only watches. What she says is not
 * put into the conversation, she has no tools, and she keeps nothing between turns. Off until the
 * person picks a model for her, and off for a session whose settings say so.
 */
export class Observer {
	readonly #store: Store;
	readonly #gateway: ModelGateway;
	readonly #home: string;
	readonly #log: (line: string) => void;
	readonly #isRunning: (sessionId: string) => boolean;
	/** Sessions whose last turn is being read: stopped when the person goes on. */
	readonly #reading = new Map<string, AbortController>();

	constructor(options: ObserverOptions) {
		this.#store = options.store;
		this.#gateway = options.gateway;
		this.#home = options.home;
		this.#log = options.log;
		this.#isRunning = options.isRunning;
	}

	/** The model she reads with: the one the person set, when its provider can be reached. */
	async #model(): Promise<ModelInfo | null> {
		const set = this.#store.getSetting("observerModel", SETTING_DEFAULTS.observerModel);
		const model = set ? this.#gateway.model(set.provider, set.model) : undefined;
		return model && (await this.#gateway.hasKey(model.provider)) ? model : null;
	}

	/** Her character: the person's file when there is one with something in it, else the built-in one. */
	async #persona(): Promise<string> {
		try {
			const wrote = (await readFile(join(this.#home, PERSONA_FILE), "utf8")).trim();
			if (wrote) return clip(wrote, MAX_PERSONA_CHARS);
		} catch {
			// No file: the built-in character.
		}
		return OBSERVER_PERSONA;
	}

	/** A turn the person started ended with a reply. */
	watch(session: Session, said: string): void {
		this.drop(session.id);
		if (session.options.observe === false || session.archivedAt !== null || !said.trim()) return;
		const reading = new AbortController();
		this.#reading.set(session.id, reading);
		this.#read(session, said, reading.signal)
			.catch((error: unknown) =>
				this.#log(`session ${session.id}: the turn was not observed: ${(error as Error).message}`),
			)
			.finally(() => {
				if (this.#reading.get(session.id) === reading) this.#reading.delete(session.id);
			});
	}

	async #read(session: Session, said: string, signal: AbortSignal): Promise<void> {
		const model = await this.#model();
		// What she costs counts as the session's, so a session at its limit is not read.
		if (!model || reached(this.#store, session, Date.now())) return;
		const { entries } = this.#store.listEntries(session.id, { limit: TURN_ENTRIES });
		const about = entries.findLast((entry) => entry.role === "assistant");
		if (!about) return;
		const wrote = await sideCall({
			store: this.#store,
			gateway: this.#gateway,
			session,
			systemPrompt: OBSERVER_PROMPT + (await this.#persona()),
			content: turnText(entries, said),
			signal,
			models: [model],
		});
		const remark = wrote === null ? null : remarkFrom(wrote);
		if (!remark || signal.aborted || this.#isRunning(session.id)) return;
		if (this.#store.getSession(session.id).archivedAt !== null) return;
		this.#store.addRemark(session.id, about.id, remark);
	}

	/** The person went on: a remark about the turn before would come too late. */
	drop(sessionId: string): void {
		this.#reading.get(sessionId)?.abort();
		this.#reading.delete(sessionId);
	}
}
