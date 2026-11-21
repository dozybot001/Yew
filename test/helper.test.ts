/**
 * Helpers: a session hands a task to a short loop of its own model, which
 * only looks, and gets back only the answer.
 */
import assert from "node:assert/strict";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { runHelper, stepLine } from "../src/server/agent/helper.ts";
import { Agents } from "../src/server/agent/runner.ts";
import { MemoryKeyStore } from "../src/server/keys.ts";
import { ModelGateway } from "../src/server/model/gateway.ts";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "../src/server/model/testing.ts";
import { PermissionEngine } from "../src/server/permissions/engine.ts";
import { readTool } from "../src/server/tools/files.ts";
import { Jobs } from "../src/server/tools/jobs.ts";
import { ReadState } from "../src/server/tools/read-state.ts";
import type { ToolContext } from "../src/server/tools/types.ts";
import type { ToolCallBlock } from "../src/shared/messages.ts";
import type { PermissionMode } from "../src/shared/types.ts";
import { newStore, tempDir } from "./helpers/store.ts";

type Reply = ReturnType<typeof fauxAssistantMessage>;
type Context = { messages: { role: string; content: unknown }[] };
type Step = Reply | ((context: Context) => Reply | Promise<Reply>);

/** One scripted model for the session and its helpers, told apart by their system prompts. */
function harness(mode: PermissionMode = "default") {
	const faux = fauxProvider();
	const { store } = newStore();
	const gateway = new ModelGateway({
		keys: new MemoryKeyStore({ [faux.provider.id]: "test-key" }),
		version: "0.0.0",
		providers: [faux.provider],
	});
	const home = realpathSync(tempDir("yew-home-"));
	const folder = realpathSync(tempDir("yew-cwd-"));
	const agents = new Agents({
		store,
		gateway,
		permissions: new PermissionEngine(home),
		home,
		version: "0.0.0",
		draftIntervalMs: 0,
		log: () => {},
	});
	const scripts = { session: [] as Step[], helper: [] as Step[] };
	const seen = { session: [] as Context[], helper: [] as Context[] };
	faux.setResponses(
		Array.from({ length: 60 }, () => (context: unknown) => {
			const copy = structuredClone(context) as Context;
			const system = String(copy.messages.find((m) => m.role === "system")?.content ?? "");
			const who = system.startsWith("You are a helper") ? "helper" : "session";
			seen[who].push(copy);
			const step = scripts[who].shift();
			if (!step) return fauxAssistantMessage(`(no more ${who} replies)`);
			return typeof step === "function" ? step(copy) : step;
		}) as never,
	);
	const session = store.createSession({
		name: "Website",
		kind: "standing",
		provider: faux.provider.id,
		model: faux.getModel().id,
		cwd: folder,
		thinking: "off",
		options: { permissionMode: mode },
	});
	return { store, agents, session, folder, scripts, seen };
}

const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) =>
	fauxAssistantMessage(calls, { stopReason: "toolUse" });

describe("helpers", () => {
	test("look things up in a context of their own and hand back only the answer", async () => {
		const { store, agents, session, folder, scripts, seen } = harness();
		writeFileSync(join(folder, "config.json"), '{ "port": 4777, "secretNote": "long details" }\n');
		scripts.session = [
			toolUse(fauxToolCall("delegate", { task: "Which port does config.json set?" }, { id: "d1" })),
			fauxAssistantMessage("It listens on 4777."),
		];
		scripts.helper = [
			toolUse(fauxToolCall("read", { path: "config.json" }, { id: "h1" })),
			fauxAssistantMessage("The port is 4777 (config.json, line 1)."),
		];
		agents.send(session.id, "What port do we use?");
		await agents.whenIdle(session.id);

		// The helper read the file in its own context, starting from the task alone.
		const helperSaw = JSON.stringify(seen.helper.at(-1)?.messages);
		assert.match(helperSaw, /secretNote/);
		assert.doesNotMatch(JSON.stringify(seen.helper[0]?.messages), /What port do we use/);
		// The session got the answer, not what the helper read.
		const sessionSaw = JSON.stringify(seen.session.at(-1)?.messages);
		assert.match(sessionSaw, /The port is 4777 \(config\.json, line 1\)\./);
		assert.doesNotMatch(sessionSaw, /secretNote/);
		const call = store
			.toolCallsByStatus(session.id, ["done"])
			.find((row) => row.tool === "delegate");
		assert.deepEqual(call?.detail, { calls: 1 });
	});

	test("cannot change anything: commands that are not only looking, writes and deletes are refused", async () => {
		const { agents, session, folder, scripts, seen } = harness("skip");
		writeFileSync(join(folder, "keep.txt"), "keep\n");
		scripts.session = [
			toolUse(fauxToolCall("delegate", { task: "Tidy the folder." }, { id: "d1" })),
			fauxAssistantMessage("Done."),
		];
		scripts.helper = [
			toolUse(
				fauxToolCall("shell", { command: "touch made.txt" }, { id: "h1" }),
				fauxToolCall("shell", { command: "rm keep.txt" }, { id: "h2" }),
				fauxToolCall("write", { path: "x.txt", content: "x" }, { id: "h3" }),
				fauxToolCall("shell", { command: "ls" }, { id: "h4" }),
			),
			fauxAssistantMessage("I could only look: keep.txt is there."),
		];
		agents.send(session.id, "Tidy up.");
		await agents.whenIdle(session.id);
		assert.equal(existsSync(join(folder, "made.txt")), false);
		assert.equal(existsSync(join(folder, "keep.txt")), true);
		assert.equal(existsSync(join(folder, "x.txt")), false);
		const results = JSON.stringify(seen.helper.at(-1)?.messages);
		assert.equal(results.match(/a helper only looks/g)?.length, 2);
		assert.match(results, /There is no tool named write/);
		assert.match(results, /keep\.txt/, "ls ran");
	});

	test("several in one step run at the same time", async () => {
		const { agents, session, scripts } = harness();
		const events: string[] = [];
		const slow = (name: string) => async () => {
			events.push(`${name} asked`);
			await new Promise((resolve) => setTimeout(resolve, 150));
			events.push(`${name} answered`);
			return fauxAssistantMessage(`${name} done.`);
		};
		scripts.session = [
			toolUse(
				fauxToolCall("delegate", { task: "One." }, { id: "d1" }),
				fauxToolCall("delegate", { task: "Two." }, { id: "d2" }),
			),
			fauxAssistantMessage("Both done."),
		];
		scripts.helper = [slow("a"), slow("b")];
		agents.send(session.id, "Do both.");
		await agents.whenIdle(session.id);
		assert.deepEqual(events.slice(0, 2), ["a asked", "b asked"]);
	});

	test("a step is shown as the tool and what it looks at", () => {
		const call = (name: string, args: Record<string, unknown>) =>
			({ type: "toolCall", id: "c", name, arguments: args }) as ToolCallBlock;
		assert.equal(stepLine(call("read", { path: "src/a.ts" })), "read src/a.ts");
		assert.equal(
			stepLine(call("shell", { command: "git log\n  --oneline" })),
			"shell git log --oneline",
		);
		assert.equal(stepLine(call("web_fetch", {})), "web_fetch");
	});

	test("synthesizes a final answer without tools when it hits its step limit", async () => {
		const faux = fauxProvider();
		const { store } = newStore();
		const gateway = new ModelGateway({
			keys: new MemoryKeyStore({ [faux.provider.id]: "test-key" }),
			version: "0.0.0",
			providers: [faux.provider],
		});
		const home = realpathSync(tempDir("yew-home-"));
		const folder = realpathSync(tempDir("yew-cwd-"));
		writeFileSync(join(folder, "a.txt"), "alpha=42\n");
		const session = store.createSession({
			name: "Exam",
			kind: "standing",
			provider: faux.provider.id,
			model: faux.getModel().id,
			cwd: folder,
			thinking: "off",
		});
		const seenMessages: unknown[][] = [];
		faux.setResponses([
			(ctx: unknown) => {
				seenMessages.push((ctx as { messages: unknown[] }).messages);
				return toolUse(fauxToolCall("read", { path: "a.txt" }, { id: "r1" }));
			},
			(ctx: unknown) => {
				seenMessages.push((ctx as { messages: unknown[] }).messages);
				return toolUse(fauxToolCall("read", { path: "a.txt" }, { id: "r2" }));
			},
			(ctx: unknown) => {
				seenMessages.push((ctx as { messages: unknown[] }).messages);
				return fauxAssistantMessage("Found alpha=42 in a.txt before step limit.");
			},
		] as never);
		const result = await runHelper({
			gateway,
			permissions: new PermissionEngine(home),
			session,
			tools: [readTool],
			lookup: {} as never,
			context: {
				session,
				signal: new AbortController().signal,
				readState: new ReadState(),
				jobs: new Jobs(() => {}),
				tmpDir: home,
				acceptsImages: false,
				version: "0.0.0",
				output: () => {},
				setTodos: () => {},
				offLimits: () => false,
				ask: async () => "",
				permit: async () => false,
				mail: {} as never,
				helper: async () => ({ text: "", calls: 0 }),
			} satisfies ToolContext,
			systemPrompt: "You are a helper.",
			task: "Read a.txt",
			signal: new AbortController().signal,
			maxSteps: 2,
		});
		assert.equal(result.stopped, undefined);
		assert.equal(result.calls, 2);
		assert.match(result.text, /alpha=42/);
		assert.equal(seenMessages.length, 3);
		assert.match(JSON.stringify(seenMessages[2]?.at(-1)), /reached your step limit/);
	});
});
