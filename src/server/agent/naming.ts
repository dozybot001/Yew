import { messageText, plainLine } from "../../shared/messages.ts";
import type { Entry } from "../../shared/types.ts";
import type { ModelGateway } from "../model/gateway.ts";
import { type Store, validateSessionName } from "../store.ts";
import { clip, usageTotals } from "./context.ts";
import { freeName } from "./mailroom.ts";
import { type ContextSnapshot, NAMING_PROMPT } from "./prompt.ts";

/**
 * A session started from the home page is named after the start of its first message. After its
 * first turn its own model gives it a short name, once; a name the person or the main conversation
 * chose is kept.
 */
export async function nameAfterFirstTurn(
	store: Store,
	gateway: ModelGateway,
	sessionId: string,
): Promise<void> {
	const session = store.getSession(sessionId);
	if (!session.options.autoName) return;
	store.updateSession(sessionId, { options: { autoName: false } });
	const model = gateway.model(session.provider, session.model);
	if (!model) return;
	const entries = store.contextEntries(sessionId);
	const asked = entries.find((entry) => entry.role === "user");
	const replied = entries.find((entry) => entry.role === "assistant");
	const textOf = (entry: Entry | undefined) => {
		if (!entry) return "";
		if (entry.role === "user") {
			const raw = messageText(entry.message).trim();
			if (raw) return raw;
			return (entry.attachments ?? []).map((item) => item.name).join(", ");
		}
		if (entry.role === "assistant") return messageText(entry.message).trim();
		return "";
	};
	const first = clip(textOf(asked), 2000);
	if (!first) return;
	const reply = await gateway.stream({
		provider: session.provider,
		model: model.id,
		thinking: "off",
		systemPrompt: NAMING_PROMPT,
		messages: [
			{
				role: "user",
				content: `The person's first message:\n${first}\n\nThe start of the reply:\n${clip(textOf(replied), 500)}`,
				timestamp: Date.now(),
			},
		],
		tools: [],
		signal: new AbortController().signal,
	});
	const now = store.getSession(sessionId);
	store.addUsage(sessionId, usageTotals(reply), now.contextTokens);
	const said = reply.content
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("")
		.trim();
	const name = plainLine(said)
		.replace(/^["'“”‘’「」『』《》]+|["'“”‘’「」『』《》]+$/g, "")
		.replace(/[。.!！?？]+$/, "")
		.trim();
	// Renamed meanwhile, or nothing usable came back: keep the name it has.
	if (reply.stopReason !== "stop" || !name || now.name !== session.name) return;
	let chosen: string;
	try {
		chosen = freeName(store, validateSessionName(clip(name, 40)));
	} catch {
		return;
	}
	store.updateSession(sessionId, { name: chosen });
	// One turn in, there is little prompt cache to keep: the prompt learns the name without an update.
	const saved = store.getContextSnapshot<ContextSnapshot>(sessionId);
	if (saved) {
		store.setContextSnapshot(sessionId, {
			...saved,
			name: chosen,
			...(saved.told ? { told: { ...saved.told, name: chosen } } : {}),
		});
	}
}
