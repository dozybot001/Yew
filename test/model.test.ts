import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { YewError } from "../src/server/errors.ts";
import { MemoryKeyStore } from "../src/server/keys.ts";
import { ModelGateway, SMALL_MODELS } from "../src/server/model/gateway.ts";
import { fauxAssistantMessage, fauxProvider } from "../src/server/model/testing.ts";

const base = { thinking: "off" as const, systemPrompt: "You are a test.", tools: [] };

describe("model gateway", () => {
	test("built-in catalog: Chinese providers are marked, account-login providers are hidden", () => {
		const gateway = new ModelGateway({ keys: new MemoryKeyStore(), version: "0.0.0" });
		const deepseek = gateway.provider("deepseek");
		assert.equal(deepseek?.region, "cn");
		assert.equal(gateway.provider("openai-codex"), undefined);
		assert.equal(gateway.provider("github-copilot"), undefined);
		const pro = gateway.model("deepseek", "deepseek-v4-pro");
		assert.ok(pro && pro.contextWindow >= 1_000_000);
		assert.ok(pro.cost.input > 0);
		assert.throws(
			() => gateway.check("deepseek", "nope"),
			(e) => e instanceof YewError,
		);
		assert.throws(
			() => gateway.check("nope", "x"),
			(e) => e instanceof YewError,
		);
	});

	test("anthropic catalog strips stale (latest) tags, disambiguates snapshots, and lists latest first", () => {
		const gateway = new ModelGateway({ keys: new MemoryKeyStore(), version: "0.0.0" });
		const anthropic = gateway.models("anthropic");
		const latest = anthropic.filter((m) => m.latest);
		const older = anthropic.filter((m) => !m.latest);
		assert.ok(latest.length >= 3);
		assert.ok(older.length >= 5);
		assert.equal(anthropic[0]?.id, "claude-opus-5-5");
		assert.ok(latest.some((m) => m.id === "claude-sonnet-5-5"));
		assert.ok(latest.some((m) => m.id === "claude-haiku-5-5"));
		const opus45 = anthropic.find((m) => m.id === "claude-opus-4-5");
		const opus45Dated = anthropic.find((m) => m.id === "claude-opus-4-5-20251101");
		assert.equal(opus45?.name, "Claude Opus 4.5");
		assert.equal(opus45?.latest, false);
		assert.equal(opus45Dated?.name, "Claude Opus 4.5 (2025-11-01)");
		// Latest models always come before older models in the list.
		const firstOlderIndex = anthropic.findIndex((m) => !m.latest);
		assert.ok(firstOlderIndex > 0);
		assert.ok(anthropic.slice(firstOlderIndex).every((m) => !m.latest));
	});

	test("streams drafts and resolves with the final message", async () => {
		const faux = fauxProvider();
		const gateway = new ModelGateway({
			keys: new MemoryKeyStore({ [faux.provider.id]: "test-key" }),
			version: "0.0.0",
			providers: [faux.provider],
		});
		faux.setResponses([fauxAssistantMessage("你好，世界")]);
		const drafts: string[] = [];
		const final = await gateway.stream(
			{
				...base,
				provider: faux.provider.id,
				model: faux.getModel().id,
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			(draft) => {
				const block = draft.content[0];
				if (block?.type === "text") drafts.push(block.text);
			},
		);
		assert.equal(final.stopReason, "stop");
		assert.deepEqual(final.content, [{ type: "text", text: "你好，世界" }]);
		assert.ok(drafts.length > 0);
	});

	test("refuses to call a provider without a key in the key store", async () => {
		const faux = fauxProvider();
		const gateway = new ModelGateway({
			keys: new MemoryKeyStore(),
			version: "0.0.0",
			providers: [faux.provider],
		});
		await assert.rejects(
			gateway.stream({
				...base,
				provider: faux.provider.id,
				model: faux.getModel().id,
				messages: [{ role: "user", content: "hi", timestamp: 1 }],
			}),
			(e) => e instanceof YewError && e.code === "missing-api-key",
		);
	});

	test("an OpenAI-compatible endpoint gets yew's User-Agent, the stored key and no attribution", async () => {
		const seen: IncomingHttpHeaders[] = [];
		const server = createServer((req, res) => {
			seen.push(req.headers);
			req.resume();
			req.on("end", () => {
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				const chunk = (body: object) => res.write(`data: ${JSON.stringify(body)}\n\n`);
				const meta = { id: "c1", object: "chat.completion.chunk", created: 0, model: "local" };
				chunk({
					...meta,
					choices: [
						{ index: 0, delta: { role: "assistant", content: "pong" }, finish_reason: null },
					],
				});
				chunk({
					...meta,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 },
				});
				res.end("data: [DONE]\n\n");
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		try {
			const gateway = new ModelGateway({
				keys: new MemoryKeyStore({ local: "sk-local-test" }),
				version: "9.9.9",
				providers: [],
				custom: [
					{
						id: "local",
						name: "Local",
						baseUrl: `http://127.0.0.1:${port}/v1`,
						keyRequired: true,
						models: [{ id: "local", contextWindow: 32_000, maxTokens: 4_000 }],
					},
				],
			});
			const final = await gateway.stream({
				...base,
				provider: "local",
				model: "local",
				messages: [{ role: "user", content: "ping", timestamp: 1 }],
			});
			assert.equal(final.stopReason, "stop", final.errorMessage);
			assert.deepEqual(final.content, [{ type: "text", text: "pong" }]);
			assert.equal(final.usage.input, 7);
			const headers = seen[0];
			assert.ok(headers);
			assert.equal(headers["user-agent"], "yew/9.9.9");
			assert.equal(headers.authorization, "Bearer sk-local-test");
			for (const name of ["http-referer", "x-title", "x-openrouter-categories"]) {
				assert.equal(headers[name], undefined, name);
			}
		} finally {
			server.close();
		}
	});
});

describe("small models", () => {
	test("every listed small model is a current model of its provider, with a price", () => {
		const gateway = new ModelGateway({ keys: new MemoryKeyStore(), version: "0.0.0" });
		for (const [provider, id] of Object.entries(SMALL_MODELS)) {
			const model = gateway.model(provider, id);
			assert.ok(model, `${provider} has ${id}`);
			assert.equal(model.latest, true, `${id} is a current model`);
			assert.ok(model.cost.input > 0 && model.cost.output > 0, `${id} has a price`);
		}
	});

	test("a session's small model is the provider's listed one, when it costs less", () => {
		const gateway = new ModelGateway({ keys: new MemoryKeyStore(), version: "0.0.0" });
		assert.equal(gateway.small("deepseek", "deepseek-v4-pro")?.id, "deepseek-flash");
		assert.equal(gateway.small("deepseek", "deepseek-flash"), undefined, "it is the small one");
		assert.equal(gateway.small("deepseek", "nope"), undefined, "an unknown model");
		assert.equal(gateway.small("moonshotai-cn", "kimi-k3"), undefined, "no small model is listed");
		assert.equal(gateway.small("google", "gemma-4-31b-it"), undefined, "its own model costs less");
	});

	test("a request beside the conversation writes no prompt cache and is tried again once", async () => {
		const faux = fauxProvider();
		const gateway = new ModelGateway({
			keys: new MemoryKeyStore({ [faux.provider.id]: "test-key" }),
			version: "0.0.0",
			providers: [faux.provider],
			retry: { maxRetries: 5, baseDelayMs: 1 },
		});
		const caches: unknown[] = [];
		const overloaded = (_context: unknown, options: { cacheRetention?: string } | undefined) => {
			caches.push(options?.cacheRetention);
			return fauxAssistantMessage([], { stopReason: "error", errorMessage: "529 overloaded" });
		};
		const request = {
			...base,
			provider: faux.provider.id,
			model: faux.getModel().id,
			messages: [{ role: "user" as const, content: "hi", timestamp: 1 }],
		};
		faux.setResponses([overloaded, overloaded, overloaded]);
		const failed = await gateway.stream({ ...request, side: true });
		assert.equal(failed.stopReason, "error");
		assert.deepEqual(caches, ["none", "none"], "the request and one more try");

		const own: unknown[] = [];
		faux.setResponses([
			(_context, options) => {
				own.push(options?.cacheRetention);
				return fauxAssistantMessage("hello");
			},
		]);
		await gateway.stream(request);
		assert.deepEqual(own, ["short"], "a session's own request keeps its prompt cache");
	});
});
