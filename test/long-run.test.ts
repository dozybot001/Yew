/**
 * What goes wrong when a session works for a long time: requests that fail or stall, a turn of many
 * steps that outgrows the context, a turn that never ends, replies cut off at the output limit, and a
 * restart in between. The model is scripted (AGENTS.md: tests never call a real model).
 */
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { Held } from "../src/server/agent/held.ts";
import { Agents } from "../src/server/agent/runner.ts";
import { MemoryKeyStore } from "../src/server/keys.ts";
import { ModelGateway, type RetryNote } from "../src/server/model/gateway.ts";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "../src/server/model/testing.ts";
import { PermissionEngine } from "../src/server/permissions/engine.ts";
import type { Entry } from "../src/shared/types.ts";
import { newStore, tempDir } from "./helpers/store.ts";

type Context = { messages: { role: string; content: unknown; toolCallId?: string }[] };
type Reply = ReturnType<typeof fauxAssistantMessage>;

function setup(
	options: {
		retry?: { maxRetries: number; baseDelayMs: number };
		idleMs?: number;
		maxSteps?: number;
		dbPath?: string;
		name?: string;
	} = {},
) {
	const faux = fauxProvider();
	const { store } = newStore(options.dbPath);
	const keys = new MemoryKeyStore({ [faux.provider.id]: "test-key" });
	const gateway = new ModelGateway({
		keys,
		version: "0.0.0",
		providers: [faux.provider],
		retry: options.retry ?? { maxRetries: 3, baseDelayMs: 1 },
		...(options.idleMs ? { idleMs: options.idleMs } : {}),
	});
	const home = realpathSync(tempDir("yew-home-"));
	const agents = new Agents({
		store,
		gateway,
		permissions: new PermissionEngine(home),
		home,
		version: "0.0.0",
		draftIntervalMs: 0,
		log: () => {},
		...(options.maxSteps ? { maxSteps: options.maxSteps } : {}),
	});
	const make = (name: string) =>
		store.createSession({
			name,
			kind: "standing",
			provider: faux.provider.id,
			model: faux.getModel().id,
			cwd: null,
			thinking: "off",
		});
	const session = make(options.name ?? "test");
	const contexts: Context[] = [];
	const capture = (reply: Reply) => (context: unknown) => {
		contexts.push(structuredClone(context) as Context);
		return reply;
	};
	return { faux, store, agents, gateway, session, make, contexts, capture };
}

const failed = (errorMessage: string) =>
	fauxAssistantMessage([], { stopReason: "error", errorMessage });
const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) =>
	fauxAssistantMessage(calls, { stopReason: "toolUse" });
const todo = (id: string) =>
	fauxToolCall("todo", { items: [{ text: `step ${id}`, status: "pending" }] }, { id });
const entriesOf = (store: ReturnType<typeof setup>["store"], id: string): Entry[] =>
	store.listEntries(id, { limit: 500 }).entries;
const notices = (entries: Entry[]) =>
	entries.flatMap((entry) => (entry.role === "notice" ? [entry.notice] : []));
const replies = (entries: Entry[]) =>
	entries.flatMap((entry) =>
		entry.role === "assistant"
			? entry.message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
			: [],
	);

describe("model requests that fail", () => {
	test("a failure that may pass is tried again and the turn goes on", async () => {
		const { faux, store, agents, session } = setup();
		faux.setResponses([
			failed("503 overloaded"),
			failed("fetch failed"),
			fauxAssistantMessage("好了。"),
		]);
		agents.send(session.id, "你好");
		await agents.whenIdle(session.id);
		const entries = entriesOf(store, session.id);
		assert.equal(store.getSession(session.id).status, "idle");
		assert.deepEqual(replies(entries), ["好了。"]);
		assert.deepEqual(notices(entries), [], "nothing about the retries stays in the record");
	});

	test("the caller hears about each retry, and a failure that stays ends the turn", async () => {
		const { faux, store, agents, gateway, session } = setup({
			retry: { maxRetries: 2, baseDelayMs: 1 },
		});
		faux.setResponses([
			failed("529 overloaded"),
			failed("529 overloaded"),
			failed("529 overloaded"),
		]);
		const seen: RetryNote[] = [];
		const final = await gateway.stream({
			provider: session.provider,
			model: session.model,
			thinking: "off",
			systemPrompt: "",
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
			tools: [],
			onRetry: (retry) => seen.push(retry),
		});
		assert.equal(final.stopReason, "error");
		assert.deepEqual(
			seen.map((retry) => [retry.attempt, retry.of, retry.error]),
			[
				[1, 2, "529 overloaded"],
				[2, 2, "529 overloaded"],
			],
		);

		faux.setResponses([
			failed("529 overloaded"),
			failed("529 overloaded"),
			failed("529 overloaded"),
		]);
		agents.send(session.id, "你好");
		await agents.whenIdle(session.id);
		assert.equal(store.getSession(session.id).status, "error");
		assert.equal(notices(entriesOf(store, session.id)).at(-1)?.data?.code, "model-error");
	});

	test("a failure that will not pass is not tried again", async () => {
		const { faux, store, agents, session } = setup();
		let asked = 0;
		faux.setResponses([
			() => {
				asked++;
				return failed("401 invalid api key");
			},
			() => {
				asked++;
				return fauxAssistantMessage("不该走到这里");
			},
		]);
		agents.send(session.id, "你好");
		await agents.whenIdle(session.id);
		assert.equal(asked, 1);
		assert.equal(store.getSession(session.id).status, "error");
	});

	test("a response that goes quiet is given up and tried again", async () => {
		const { faux, store, agents, session } = setup({ idleMs: 40 });
		faux.setResponses([
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 400));
				return fauxAssistantMessage("太晚了");
			},
			fauxAssistantMessage("第二次答上了。"),
		] as never);
		agents.send(session.id, "你好");
		await agents.whenIdle(session.id);
		assert.equal(store.getSession(session.id).status, "idle");
		assert.deepEqual(replies(entriesOf(store, session.id)), ["第二次答上了。"]);
	});

	test("stopping while Yew waits to try again stops the turn", async () => {
		const { faux, store, agents, session } = setup({
			retry: { maxRetries: 5, baseDelayMs: 60_000 },
		});
		faux.setResponses([failed("503 overloaded"), fauxAssistantMessage("不该走到这里")]);
		agents.send(session.id, "你好");
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(agents.isRunning(session.id), true);
		agents.stop(session.id);
		await agents.whenIdle(session.id);
		assert.equal(store.getSession(session.id).status, "idle");
		assert.equal(notices(entriesOf(store, session.id)).at(-1)?.kind, "interrupted");
	});
});

describe("a long turn", () => {
	/** One message from the person, then `steps` tool calls with large results: a single long turn. */
	function longTurn(
		store: ReturnType<typeof setup>["store"],
		sessionId: string,
		steps: number,
		withMessage = true,
	) {
		if (withMessage) {
			store.appendEntry(sessionId, {
				role: "user",
				message: { role: "user", content: "把仓库里的文件都读一遍", timestamp: 1 },
			});
		}
		const batch = `${withMessage ? "a" : "b"}`;
		for (let i = 0; i < steps; i++) {
			const call = fauxToolCall("read", { path: `file-${i}.txt` }, { id: `${batch}-${i}` });
			store.appendEntry(sessionId, {
				role: "assistant",
				message: { ...toolUse(call), timestamp: 1 },
			});
			store.appendEntry(sessionId, {
				role: "toolResult",
				message: {
					role: "toolResult",
					toolCallId: `${batch}-${i}`,
					toolName: "read",
					content: [{ type: "text", text: `file ${i} `.repeat(3000) }],
					isError: false,
					timestamp: 1,
				},
			});
		}
	}

	test("is shortened inside the turn, and no tool result loses its call", async () => {
		const { faux, store, agents, session, contexts, capture } = setup();
		store.updateSession(session.id, { options: { compactAt: 10_000 } });
		longTurn(store, session.id, 30);
		store.setContextTokens(session.id, 200_000);
		faux.setResponses([
			fauxAssistantMessage("27 files are read so far."),
			capture(fauxAssistantMessage("接着读。")),
		]);
		agents.continue(session.id);
		await agents.whenIdle(session.id);

		const entries = entriesOf(store, session.id);
		const compaction = entries.find((entry) => entry.role === "compaction");
		assert.ok(compaction?.role === "compaction", "the context was shortened");
		const firstKept = entries.find((entry) => entry.seq === compaction.compaction.firstKeptSeq);
		assert.equal(firstKept?.role, "assistant", "the cut falls at a step, not at the first message");
		assert.equal(compaction.compaction.request, "把仓库里的文件都读一遍");
		assert.ok(store.getSession(session.id).contextTokens < 40_000);

		const messages = contexts[0]?.messages.filter((m) => m.role !== "system") ?? [];
		assert.match(JSON.stringify(messages[0]), /27 files are read/);
		// The request being worked on is carried over word for word, not only as the summary retells it.
		assert.match(JSON.stringify(messages[0]), /word for word.*把仓库里的文件都读一遍/);
		assert.ok(messages.length < 20, "most of the old steps are gone");
		// Every tool result follows the call that made it.
		const calls = new Set<string>();
		for (const message of messages) {
			if (message.role === "assistant") {
				for (const block of message.content as { type: string; id?: string }[]) {
					if (block.type === "toolCall" && block.id) calls.add(block.id);
				}
			}
			if (message.role === "toolResult") assert.ok(calls.has(message.toolCallId ?? ""));
		}
		assert.equal(store.getSession(session.id).status, "idle");
	});

	test("shortened a second time, it still carries the person's message word for word", async () => {
		const { faux, store, agents, session, contexts, capture } = setup();
		store.updateSession(session.id, { options: { compactAt: 10_000 } });
		longTurn(store, session.id, 30);
		store.setContextTokens(session.id, 200_000);
		faux.setResponses([fauxAssistantMessage("first summary"), fauxAssistantMessage("接着读。")]);
		agents.continue(session.id);
		await agents.whenIdle(session.id);

		longTurn(store, session.id, 30, false);
		store.setContextTokens(session.id, 200_000);
		faux.setResponses([
			fauxAssistantMessage("second summary"),
			capture(fauxAssistantMessage("读完了。")),
		]);
		agents.continue(session.id);
		await agents.whenIdle(session.id);
		const compactions = entriesOf(store, session.id).flatMap((entry) =>
			entry.role === "compaction" ? [entry.compaction] : [],
		);
		assert.deepEqual(
			compactions.map((compaction) => compaction.request),
			["把仓库里的文件都读一遍", "把仓库里的文件都读一遍"],
		);
		const first = contexts[0]?.messages.filter((m) => m.role !== "system")[0];
		assert.match(JSON.stringify(first), /second summary.*word for word.*把仓库里的文件都读一遍/);
	});

	test("stops with a reason when the context cannot be shortened", async () => {
		const { faux, store, agents, session } = setup();
		store.updateSession(session.id, { options: { compactAt: 10_000 } });
		longTurn(store, session.id, 30);
		store.setContextTokens(session.id, 200_000);
		let asked = 0;
		faux.setResponses(
			Array.from({ length: 5 }, () => () => {
				asked++;
				return failed("401 invalid api key");
			}),
		);
		agents.continue(session.id);
		await agents.whenIdle(session.id);
		assert.equal(asked, 1, "one summary request, and no request with the long context after it");
		assert.equal(store.getSession(session.id).status, "error");
		assert.equal(notices(entriesOf(store, session.id)).at(-1)?.data?.code, "compact-failed");
	});

	test("layer-1 compaction folds earlier large tool results without calling the model", async () => {
		const { faux, store, agents, session, contexts, capture } = setup();
		store.updateSession(session.id, { options: { compactAt: 10_000 } });
		store.appendEntry(session.id, {
			role: "user",
			message: { role: "user", content: "检查几份大文件", timestamp: 1 },
		});
		const big = "x".repeat(16_000);
		for (let i = 0; i < 4; i++) {
			const call = fauxToolCall("read", { path: `big-${i}.txt` }, { id: `b${i}` });
			store.appendEntry(session.id, { role: "assistant", message: toolUse(call) });
			store.appendEntry(session.id, {
				role: "toolResult",
				message: {
					role: "toolResult",
					toolCallId: call.id,
					toolName: "read",
					content: [{ type: "text", text: big }],
					isError: false,
					timestamp: 1,
				},
			});
		}
		// Keep a short recent step so the older big results fall before the tail cut.
		const recent = fauxToolCall("read", { path: "small.txt" }, { id: "small" });
		store.appendEntry(session.id, { role: "assistant", message: toolUse(recent) });
		store.appendEntry(session.id, {
			role: "toolResult",
			message: {
				role: "toolResult",
				toolCallId: recent.id,
				toolName: "read",
				content: [{ type: "text", text: "tiny recent result" }],
				isError: false,
				timestamp: 1,
			},
		});
		store.setContextTokens(session.id, 18_000);
		// Only ONE model response is needed (no Layer-2 summary call!).
		faux.setResponses([capture(fauxAssistantMessage("直接继续。"))]);
		agents.continue(session.id);
		await agents.whenIdle(session.id);

		const entries = entriesOf(store, session.id);
		assert.equal(
			entries.some((e) => e.role === "compaction"),
			false,
			"Layer-1 pruning avoids a Layer-2 semantic summary",
		);
		const prunedNotice = notices(entries).find((n) => n.kind === "compacted");
		assert.equal(prunedNotice?.data?.tier, "prune");
		const sent = JSON.stringify(contexts[0]?.messages ?? []);
		assert.match(sent, /Earlier read result folded to save context/);
		assert.match(sent, /tiny recent result/);
		assert.match(sent, /检查几份大文件/);
		assert.equal(store.getSession(session.id).status, "idle");
	});

	test("below the threshold, older tool results are folded only once the prompt cache is gone", async () => {
		const run = async (lastRequestAt: number) => {
			const { faux, store, agents, session, contexts, capture } = setup();
			store.updateSession(session.id, { options: { compactAt: 100_000 } });
			store.appendEntry(session.id, {
				role: "user",
				message: { role: "user", content: "检查几份大文件", timestamp: 1 },
			});
			const result = (id: string, text: string) => {
				const call = fauxToolCall("read", { path: `${id}.txt` }, { id });
				store.appendEntry(session.id, {
					role: "assistant",
					message: { ...toolUse(call), timestamp: lastRequestAt },
				});
				store.appendEntry(session.id, {
					role: "toolResult",
					message: {
						role: "toolResult",
						toolCallId: call.id,
						toolName: "read",
						content: [{ type: "text", text }],
						isError: false,
						timestamp: lastRequestAt,
					},
				});
			};
			for (let i = 0; i < 12; i++) result(`big-${i}`, "x".repeat(16_000));
			result("small", "tiny recent result");
			store.setContextTokens(session.id, 50_000);
			faux.setResponses([capture(fauxAssistantMessage("直接继续。"))]);
			agents.continue(session.id);
			await agents.whenIdle(session.id);
			return {
				sent: JSON.stringify(contexts[0]?.messages ?? []),
				folded: notices(entriesOf(store, session.id)).some((n) => n.data?.tier === "prune"),
			};
		};
		const stale = await run(Date.now() - 10 * 60_000);
		assert.equal(stale.folded, true);
		assert.match(stale.sent, /Earlier read result folded to save context/);
		assert.match(stale.sent, /tiny recent result/);
		const fresh = await run(Date.now());
		assert.equal(fresh.folded, false);
		assert.doesNotMatch(fresh.sent, /folded to save context/);
	});

	test("ends at the step limit and says so; continuing goes on", async () => {
		const { faux, store, agents, session } = setup({ maxSteps: 5 });
		let step = 0;
		faux.setResponses(Array.from({ length: 20 }, () => () => toolUse(todo(`s${step++}`))));
		agents.send(session.id, "一直做下去");
		await agents.whenIdle(session.id);
		assert.equal(step, 5);
		const now = store.getSession(session.id);
		assert.equal(now.status, "error");
		assert.match(now.statusDetail ?? "", /5 steps/);
		const last = notices(entriesOf(store, session.id)).at(-1);
		assert.deepEqual([last?.kind, last?.data?.code, last?.data?.steps], ["error", "step-limit", 5]);

		faux.setResponses([fauxAssistantMessage("做完了。")]);
		agents.continue(session.id);
		await agents.whenIdle(session.id);
		assert.equal(store.getSession(session.id).status, "idle");
	});

	test("many steps in one turn all run, in order", async () => {
		const { faux, store, agents, session } = setup();
		let step = 0;
		faux.setResponses([
			...Array.from({ length: 300 }, () => () => toolUse(todo(`s${step++}`))),
			fauxAssistantMessage("三百步做完了。"),
		]);
		agents.send(session.id, "做三百步");
		await agents.whenIdle(session.id);
		assert.equal(step, 300);
		assert.equal(store.getSession(session.id).status, "idle");
		const all = store.contextEntries(session.id);
		const results = all.flatMap((entry) =>
			entry.role === "toolResult" ? [entry.message.toolCallId] : [],
		);
		assert.deepEqual(
			results,
			Array.from({ length: 300 }, (_, i) => `s${i}`),
		);
		assert.deepEqual(replies(all).at(-1), "三百步做完了。");
	});
});

describe("a reply cut off at the output limit", () => {
	test("is continued by itself", async () => {
		const { faux, store, agents, session, contexts, capture } = setup();
		faux.setResponses([
			fauxAssistantMessage("第一段", { stopReason: "length" }),
			capture(fauxAssistantMessage("第二段，写完了。")),
		]);
		agents.send(session.id, "写一篇长文");
		await agents.whenIdle(session.id);
		assert.equal(store.getSession(session.id).status, "idle");
		assert.deepEqual(replies(entriesOf(store, session.id)), ["第一段", "第二段，写完了。"]);
		assert.match(JSON.stringify(contexts[0]?.messages.at(-1)), /cut off at the output limit/);
	});

	test("its tool calls do not run, and the model makes them again", async () => {
		const { faux, store, agents, session, contexts, capture } = setup();
		const cut = fauxToolCall(
			"todo",
			{ items: [{ text: "写到一半", status: "pending" }] },
			{ id: "t1" },
		);
		const whole = fauxToolCall(
			"todo",
			{ items: [{ text: "写到一半的后面还有", status: "pending" }] },
			{ id: "t2" },
		);
		faux.setResponses([
			fauxAssistantMessage([cut], { stopReason: "length" }),
			capture(toolUse(whole)),
			fauxAssistantMessage("好了。"),
		]);
		agents.send(session.id, "记个待办");
		await agents.whenIdle(session.id);
		assert.match(JSON.stringify(contexts[0]?.messages.at(-1)), /cut off at the output limit/);
		assert.deepEqual(
			store.getSession(session.id).todos.map((item) => item.text),
			["写到一半的后面还有"],
		);
		assert.equal(store.getSession(session.id).status, "idle");
	});

	test("stops with a reason when it keeps happening", async () => {
		const { faux, store, agents, session } = setup();
		faux.setResponses(
			Array.from({ length: 12 }, () => fauxAssistantMessage("又一段", { stopReason: "length" })),
		);
		agents.send(session.id, "写一篇长文");
		await agents.whenIdle(session.id);
		assert.equal(store.getSession(session.id).status, "error");
		assert.equal(replies(entriesOf(store, session.id)).length, 9);
		assert.equal(notices(entriesOf(store, session.id)).at(-1)?.data?.code, "output-cut");
	});
});

describe("after a restart", () => {
	test("a session the person stopped is still not started by a letter", async () => {
		const dbPath = `${realpathSync(tempDir("yew-db-"))}/yew.db`;
		const first = setup({ dbPath });
		const sender = first.make("来信方");
		let release: () => void = () => {};
		first.faux.setResponses([
			async () => {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return fauxAssistantMessage("没说完");
			},
		] as never);
		first.agents.send(first.session.id, "开始");
		await new Promise((resolve) => setTimeout(resolve, 30));
		first.agents.stop(first.session.id);
		release();
		await first.agents.whenIdle(first.session.id);
		assert.equal(new Held(first.store).isPaused(first.session.id), true);

		// A new service on the same database.
		const second = setup({ dbPath, name: "另一个" });
		let asked = 0;
		second.faux.setResponses([
			() => {
				asked++;
				return fauxAssistantMessage("被信叫起来了");
			},
		]);
		second.agents.post.send(
			{ kind: "session", session: sender },
			{ to: first.session.id, kind: "notice", summary: "有新消息" },
		);
		second.agents.wakeQueued();
		await second.agents.whenIdle(first.session.id);
		assert.equal(asked, 0, "the letter waits for the person");

		// The person continues it: the letter is read.
		second.agents.continue(first.session.id);
		await second.agents.whenIdle(first.session.id);
		assert.equal(asked, 1);
		assert.equal(new Held(second.store).isPaused(first.session.id), false);
	});

	test("a session at a spending limit is remembered with its day", () => {
		const { store, session } = setup();
		const held = new Held(store);
		held.cap(session.id, "2026-11-16");
		assert.deepEqual(new Held(store).capped(), [[session.id, "2026-11-16"]]);
		held.forget(session.id);
		assert.deepEqual(new Held(store).capped(), []);
	});
});

describe("over a real connection", () => {
	/** A local OpenAI-compatible endpoint whose answers the test scripts, one per request. */
	async function endpoint(script: ((res: ServerResponse) => void)[]) {
		let requests = 0;
		const server = createServer((req, res) => {
			req.resume();
			req.on("end", () => {
				const step = script[Math.min(requests, script.length - 1)];
				requests++;
				step?.(res);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		const gateway = (idleMs?: number) =>
			new ModelGateway({
				keys: new MemoryKeyStore(),
				version: "0.0.0",
				providers: [],
				retry: { maxRetries: 4, baseDelayMs: 1 },
				...(idleMs ? { idleMs } : {}),
				custom: [
					{
						id: "local",
						name: "Local",
						baseUrl: `http://127.0.0.1:${port}/v1`,
						keyRequired: false,
						models: [{ id: "local", contextWindow: 32_000, maxTokens: 4_000 }],
					},
				],
			});
		return {
			gateway,
			count: () => requests,
			close: () => {
				server.closeAllConnections();
				server.close();
			},
		};
	}
	const meta = { id: "c1", object: "chat.completion.chunk", created: 0, model: "local" };
	const begin = (res: ServerResponse, text: string) => {
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		res.write(
			`data: ${JSON.stringify({ ...meta, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`,
		);
	};
	const answer = (text: string) => (res: ServerResponse) => {
		begin(res, text);
		res.write(
			`data: ${JSON.stringify({ ...meta, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
		);
		res.end("data: [DONE]\n\n");
	};
	const status = (code: number, message: string) => (res: ServerResponse) => {
		res.writeHead(code, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: { message, type: "error" } }));
	};
	const ask = (gateway: ModelGateway, seen: RetryNote[]) =>
		gateway.stream({
			provider: "local",
			model: "local",
			thinking: "off",
			systemPrompt: "",
			messages: [{ role: "user", content: "ping", timestamp: 1 }],
			tools: [],
			onRetry: (retry) => seen.push(retry),
		});

	test("an overloaded provider, a rate limit and a dropped connection are each tried again", async () => {
		const server = await endpoint([
			status(503, "The service is overloaded"),
			status(429, "Rate limit reached"),
			(res) => {
				begin(res, "半句");
				res.destroy();
			},
			answer("pong"),
		]);
		try {
			const seen: RetryNote[] = [];
			const final = await ask(server.gateway(), seen);
			assert.equal(final.stopReason, "stop", final.errorMessage);
			assert.deepEqual(final.content, [{ type: "text", text: "pong" }]);
			assert.equal(server.count(), 4);
			assert.equal(seen.length, 3, JSON.stringify(seen));
		} finally {
			server.close();
		}
	});

	test("a refused key is not tried again", async () => {
		const server = await endpoint([status(401, "Incorrect API key provided"), answer("pong")]);
		try {
			const seen: RetryNote[] = [];
			const final = await ask(server.gateway(), seen);
			assert.equal(final.stopReason, "error");
			assert.equal(server.count(), 1);
			assert.deepEqual(seen, []);
		} finally {
			server.close();
		}
	});

	test("a response that stops arriving is given up and asked for again", async () => {
		const server = await endpoint([(res) => begin(res, "半句"), answer("pong")]);
		try {
			const seen: RetryNote[] = [];
			const final = await ask(server.gateway(80), seen);
			assert.equal(final.stopReason, "stop", final.errorMessage);
			assert.deepEqual(final.content, [{ type: "text", text: "pong" }]);
			assert.match(seen[0]?.error ?? "", /sent nothing/);
		} finally {
			server.close();
		}
	});
});
