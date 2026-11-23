import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { nameAfterFirstTurn } from "../src/server/agent/naming.ts";
import { sideCall } from "../src/server/agent/side.ts";
import { MemoryKeyStore } from "../src/server/keys.ts";
import { ModelGateway } from "../src/server/model/gateway.ts";
import { fauxAssistantMessage, fauxProvider } from "../src/server/model/testing.ts";
import { newStore } from "./helpers/store.ts";

const price = (input: number) => ({ input, output: input * 5, cacheRead: 0, cacheWrite: 0 });

/** A provider with a large and a small model; sessions run the large one. */
function setup(options: { small?: boolean } = {}) {
	const faux = fauxProvider({
		models: [
			{ id: "tide-5-max", cost: price(4) },
			{ id: "tide-5-mini", cost: price(0.1) },
		],
	});
	const { store } = newStore();
	const gateway = new ModelGateway({
		keys: new MemoryKeyStore({ [faux.provider.id]: "test-key" }),
		version: "0.0.0",
		providers: [faux.provider],
		retry: { maxRetries: 0, baseDelayMs: 1 },
		small: options.small === false ? {} : { [faux.provider.id]: "tide-5-mini" },
	});
	const session = store.createSession({
		name: "帮我看看这个仓库…",
		kind: "task",
		provider: faux.provider.id,
		model: "tide-5-max",
		thinking: "off",
		options: { permissionMode: "default", autoName: true },
	});
	const asked: string[] = [];
	const answer =
		(reply: ReturnType<typeof fauxAssistantMessage>) =>
		(_context: unknown, _options: unknown, _state: unknown, model: { id: string }) => {
			asked.push(model.id);
			return reply;
		};
	return { faux, store, gateway, session, asked, answer };
}

const failed = fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 bad request" });

describe("requests beside a session's conversation", () => {
	test("the provider's small model answers, and what it costs counts as the session's", async () => {
		const { faux, store, gateway, session, asked, answer } = setup();
		faux.setResponses([answer(fauxAssistantMessage("仓库体检"))]);
		const said = await sideCall({
			store,
			gateway,
			session,
			systemPrompt: "Name it.",
			content: "…",
		});
		assert.equal(said, "仓库体检");
		assert.deepEqual(asked, ["tide-5-mini"]);
		assert.ok(store.getSession(session.id).usage.output > 0);
	});

	test("the session's own model answers when the small one fails", async () => {
		const { faux, store, gateway, session, asked, answer } = setup();
		faux.setResponses([answer(failed), answer(fauxAssistantMessage("仓库体检"))]);
		const said = await sideCall({
			store,
			gateway,
			session,
			systemPrompt: "Name it.",
			content: "…",
		});
		assert.equal(said, "仓库体检");
		assert.deepEqual(asked, ["tide-5-mini", "tide-5-max"]);
	});

	test("without a small model the session's own model answers; no answer is null", async () => {
		const { faux, store, gateway, session, asked, answer } = setup({ small: false });
		faux.setResponses([answer(fauxAssistantMessage("仓库体检")), answer(failed)]);
		const call = { store, gateway, session, systemPrompt: "Name it.", content: "…" };
		assert.equal(await sideCall(call), "仓库体检");
		assert.equal(await sideCall(call), null);
		assert.deepEqual(asked, ["tide-5-max", "tide-5-max"]);
	});

	test("a session is named by the small model after its first turn", async () => {
		const { faux, store, gateway, session, asked, answer } = setup();
		store.appendEntry(session.id, {
			role: "user",
			message: { role: "user", content: "帮我看看这个仓库里有哪些地方需要整理", timestamp: 1 },
		});
		faux.setResponses([answer(fauxAssistantMessage("「仓库体检」"))]);
		await nameAfterFirstTurn(store, gateway, session.id);
		assert.equal(store.getSession(session.id).name, "仓库体检");
		assert.equal(store.getSession(session.id).options.autoName, false);
		assert.deepEqual(asked, ["tide-5-mini"]);
	});
});
