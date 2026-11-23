import type { Session } from "../../shared/types.ts";
import type { ModelGateway } from "../model/gateway.ts";
import type { Store } from "../store.ts";
import { usageTotals } from "./context.ts";

export interface SideCall {
	store: Store;
	gateway: ModelGateway;
	session: Session;
	systemPrompt: string;
	/** What the model is given to read, as one message. */
	content: string;
	signal?: AbortSignal;
}

/**
 * One request beside a session's conversation, such as naming it. The provider's small model answers
 * when the provider has one, and the session's own model when it has none or the small one did not
 * give a complete answer. What it costs counts as the session's. Returns what the model wrote, or
 * null when no complete answer came.
 */
export async function sideCall(call: SideCall): Promise<string | null> {
	const { store, gateway, session } = call;
	const own = gateway.model(session.provider, session.model);
	if (!own) return null;
	const small = gateway.small(session.provider, session.model);
	for (const model of small ? [small, own] : [own]) {
		if (call.signal?.aborted) return null;
		const reply = await gateway.stream({
			provider: session.provider,
			model: model.id,
			thinking: "off",
			systemPrompt: call.systemPrompt,
			messages: [{ role: "user", content: call.content, timestamp: Date.now() }],
			tools: [],
			side: true,
			...(call.signal ? { signal: call.signal } : {}),
		});
		store.addUsage(session.id, usageTotals(reply), store.getSession(session.id).contextTokens);
		if (reply.stopReason === "stop") {
			return reply.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		}
	}
	return null;
}
