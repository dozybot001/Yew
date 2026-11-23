import type { Session } from "../../shared/types.ts";
import type { ModelGateway, ModelInfo } from "../model/gateway.ts";
import { SETTING_DEFAULTS } from "../settings.ts";
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

/** How many times a request beside the conversation is tried again when it fails in a way that may pass. */
const SIDE_RETRIES = 1;

/**
 * The models asked for a job beside a session that runs `own`, in turn. First the model the person
 * set for these jobs, whatever it costs and whichever provider it is at, as long as that provider
 * has a key. Last the session's own model, which does the job alone when none is set or the set
 * one cannot be used.
 */
export async function sideModels(
	store: Store,
	gateway: ModelGateway,
	own: ModelInfo,
): Promise<ModelInfo[]> {
	const set = store.getSetting("sideModel", SETTING_DEFAULTS.sideModel);
	if (!set) return [own];
	const model = gateway.model(set.provider, set.model);
	if (!model || (model.provider === own.provider && model.id === own.id)) return [own];
	return (await gateway.hasKey(model.provider)) ? [model, own] : [own];
}

/**
 * One request beside a session's conversation, such as naming it. The first of `sideModels` answers,
 * and the session's own model when that one did not give a complete answer. Its prompt is not sent
 * again, so no prompt cache is written for it. What it costs counts as the session's. Returns what
 * the model wrote, or null when no complete answer came.
 */
export async function sideCall(call: SideCall): Promise<string | null> {
	const { store, gateway, session } = call;
	const own = gateway.model(session.provider, session.model);
	if (!own) return null;
	for (const model of await sideModels(store, gateway, own)) {
		if (call.signal?.aborted) return null;
		const reply = await gateway.stream({
			provider: model.provider,
			model: model.id,
			thinking: "off",
			systemPrompt: call.systemPrompt,
			messages: [{ role: "user", content: call.content, timestamp: Date.now() }],
			tools: [],
			cache: false,
			retries: SIDE_RETRIES,
			...(call.signal ? { signal: call.signal } : {}),
		});
		store.addUsage(session.id, usageTotals(reply), store.getSession(session.id).contextTokens);
		if (reply.stopReason === "stop") {
			return reply.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		}
	}
	return null;
}
