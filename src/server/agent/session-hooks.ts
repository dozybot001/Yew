import type { JsonObject } from "../../shared/messages.ts";
import type { HookEvent, HookOutcome, Hooks } from "../hooks.ts";
import type { Store } from "../store.ts";
import { notice } from "./compaction.ts";
import { hookNote, userEntry } from "./context.ts";

/**
 * The person's hooks (hooks.ts) as a session's turn meets them: what a hook prints goes to the model
 * as Yew's note, and a hook that failed is a notice for the person.
 */
export class SessionHooks {
	readonly #store: Store;
	readonly #hooks: Hooks | null;
	/** By session: what the person wrote that the UserPromptSubmit hooks have not seen yet. */
	readonly #prompts = new Map<string, string[]>();

	constructor(store: Store, hooks: Hooks | null) {
		this.#store = store;
		this.#hooks = hooks;
	}

	/** Whether any hook is set for the event, and for the tool when one is named. */
	has(event: HookEvent, tool?: string): boolean {
		return this.#hooks?.has(event, tool) ?? false;
	}

	/** What the person wrote, for the UserPromptSubmit hooks of the next step. */
	prompted(sessionId: string, texts: string[]): void {
		const wanted = texts.filter((text) => text.trim());
		if (!this.#hooks || wanted.length === 0) return;
		this.#prompts.set(sessionId, [...(this.#prompts.get(sessionId) ?? []), ...wanted]);
	}

	/** Runs one event's hooks; a hook that failed is a notice for the person. */
	async run(
		event: HookEvent,
		sessionId: string,
		fields: JsonObject,
		tool?: string,
		args?: JsonObject,
	): Promise<HookOutcome> {
		const hooks = this.#hooks;
		if (!hooks) return { block: null, context: "", errors: [] };
		const session = this.#store.getSession(sessionId);
		const outcome = await hooks.run(event, fields, {
			sessionId,
			cwd: session.cwd,
			...(tool !== undefined ? { tool } : {}),
			...(args !== undefined ? { args } : {}),
		});
		for (const error of outcome.errors) {
			notice(this.#store, sessionId, "hook", error, { event, kind: "error", text: error });
		}
		return outcome;
	}

	/**
	 * SessionStart for a session's first turn, UserPromptSubmit for each thing the person wrote.
	 * What they print goes to the model as Yew's note; true when one stopped what the person wrote.
	 */
	async beforeRequest(sessionId: string): Promise<boolean> {
		if (!this.#hooks) return false;
		const first = !this.#store
			.contextEntries(sessionId)
			.some((entry) => entry.role === "assistant");
		if (first && this.#hooks.has("SessionStart")) {
			const started = await this.run("SessionStart", sessionId, { source: "startup" });
			if (started.context) {
				this.#store.appendEntry(sessionId, userEntry(hookNote("SessionStart", started.context)));
			}
		}
		const prompts = this.#prompts.get(sessionId) ?? [];
		this.#prompts.delete(sessionId);
		if (!this.#hooks.has("UserPromptSubmit")) return false;
		for (const prompt of prompts) {
			const checked = await this.run("UserPromptSubmit", sessionId, { prompt });
			if (checked.block) {
				this.#store.appendEntry(
					sessionId,
					userEntry(
						hookNote(
							"UserPromptSubmit",
							`It stopped the message above, so that message is not to be acted on: ${checked.block}`,
						),
					),
				);
				notice(this.#store, sessionId, "hook", checked.block, {
					event: "UserPromptSubmit",
					kind: "blocked",
					text: checked.block,
				});
				return true;
			}
			if (checked.context) {
				this.#store.appendEntry(
					sessionId,
					userEntry(hookNote("UserPromptSubmit", checked.context)),
				);
			}
		}
		return false;
	}
}
