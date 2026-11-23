import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { nameAfterFirstTurn } from "../src/server/agent/naming.ts";
import { sideCall } from "../src/server/agent/side.ts";
import { MemoryKeyStore } from "../src/server/keys.ts";
import { ModelGateway } from "../src/server/model/gateway.ts";
import { fauxAssistantMessage, fauxProvider } from "../src/server/model/testing.ts";
import { newStore } from "./helpers/store.ts";

const price = (input: number) => ({ input, output: input * 5, cacheRead: 0, cacheWrite: 0 });

/**
 * A provider with a large and a small model; sessions run the large one. A second provider has one
 * model that costs more than both, and a key unless `otherKey` is false.
 */
function setup(options: { otherKey?: boolean } = {}) {
	const faux = fauxProvider({
		models: [
			{ id: "tide-5-max", cost: price(4) },
			{ id: "tide-5-mini", cost: price(0.1) },
		],
	});
	const other = fauxProvider({
		provider: "reef",
		api: "reef-api",
		models: [{ id: "reef-1", cost: price(9) }],
	});
	const { store } = newStore();
	const gateway = new ModelGateway({
		keys: new MemoryKeyStore({
			[faux.provider.id]: "test-key",
			...(options.otherKey === false ? {} : { reef: "test-key" }),
		}),
		version: "0.0.0",
		providers: [faux.provider, other.provider],
		retry: { maxRetries: 0, baseDelayMs: 1 },
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
	/** Sets the provider's small model for the jobs beside a conversation. */
	const setSmall = () =>
		store.setSetting("sideModel", { provider: faux.provider.id, model: "tide-5-mini" });
	return { faux, other, store, gateway, session, asked, answer, setSmall };
}

const failed = fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 bad request" });

describe("requests beside a session's conversation", () => {
	test("a small model set for these jobs answers, and what it costs counts as the session's", async () => {
		const { faux, store, gateway, session, asked, answer, setSmall } = setup();
		setSmall();
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
		const { faux, store, gateway, session, asked, answer, setSmall } = setup();
		setSmall();
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

	test("with no model set the session's own model answers; no answer is null", async () => {
		const { faux, store, gateway, session, asked, answer } = setup();
		faux.setResponses([answer(fauxAssistantMessage("仓库体检")), answer(failed)]);
		const call = { store, gateway, session, systemPrompt: "Name it.", content: "…" };
		assert.equal(await sideCall(call), "仓库体检");
		assert.equal(await sideCall(call), null);
		assert.deepEqual(asked, ["tide-5-max", "tide-5-max"]);
	});

	test("a model set for these jobs answers for a session at another provider, whatever it costs", async () => {
		const { other, store, gateway, session, asked, answer } = setup();
		store.setSetting("sideModel", { provider: "reef", model: "reef-1" });
		other.setResponses([answer(fauxAssistantMessage("仓库体检"))]);
		const call = { store, gateway, session, systemPrompt: "Name it.", content: "…" };
		assert.equal(await sideCall(call), "仓库体检");
		assert.deepEqual(asked, ["reef-1"]);
		assert.ok(store.getSession(session.id).usage.output > 0);
	});

	test("the session's own model answers when the set model fails, not the small one", async () => {
		const { faux, other, store, gateway, session, asked, answer } = setup();
		store.setSetting("sideModel", { provider: "reef", model: "reef-1" });
		other.setResponses([answer(failed)]);
		faux.setResponses([answer(fauxAssistantMessage("仓库体检"))]);
		const call = { store, gateway, session, systemPrompt: "Name it.", content: "…" };
		assert.equal(await sideCall(call), "仓库体检");
		assert.deepEqual(asked, ["reef-1", "tide-5-max"]);
	});

	test("a set model that cannot be used leaves the job to the session's own model", async () => {
		// Its provider has no key.
		const keyless = setup({ otherKey: false });
		keyless.store.setSetting("sideModel", { provider: "reef", model: "reef-1" });
		keyless.faux.setResponses([keyless.answer(fauxAssistantMessage("仓库体检"))]);
		const { store, gateway, session } = keyless;
		const call = { store, gateway, session, systemPrompt: "Name it.", content: "…" };
		assert.equal(await sideCall(call), "仓库体检");
		assert.deepEqual(keyless.asked, ["tide-5-max"]);

		// The model is no longer in the provider's list.
		const gone = setup();
		gone.store.setSetting("sideModel", { provider: "reef", model: "reef-0" });
		gone.faux.setResponses([gone.answer(fauxAssistantMessage("仓库体检"))]);
		assert.equal(
			await sideCall({ ...call, store: gone.store, gateway: gone.gateway, session: gone.session }),
			"仓库体检",
		);
		assert.deepEqual(gone.asked, ["tide-5-max"]);

		// It is the session's own model: one request, and a failure is not asked again.
		const same = setup();
		same.store.setSetting("sideModel", { provider: same.session.provider, model: "tide-5-max" });
		same.faux.setResponses([same.answer(failed)]);
		assert.equal(
			await sideCall({ ...call, store: same.store, gateway: same.gateway, session: same.session }),
			null,
		);
		assert.deepEqual(same.asked, ["tide-5-max"]);
	});

	test("a session is named by the model set for these jobs after its first turn", async () => {
		const { faux, store, gateway, session, asked, answer, setSmall } = setup();
		setSmall();
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
