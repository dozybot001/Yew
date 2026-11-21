import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Agents } from "../src/server/agent/runner.ts";
import { MemoryKeyStore } from "../src/server/keys.ts";
import { PostOffice } from "../src/server/mail/post.ts";
import { ModelGateway } from "../src/server/model/gateway.ts";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "../src/server/model/testing.ts";
import { PermissionEngine } from "../src/server/permissions/engine.ts";
import type { NewSession } from "../src/server/store.ts";
import type { Entry, Letter, PermissionRequest, Session } from "../src/shared/types.ts";
import { newStore, tempDir } from "./helpers/store.ts";

type Reply = ReturnType<typeof fauxAssistantMessage>;
type Context = { messages: { role: string; content: unknown; toolsAdded?: { name: string }[] }[] };
type Step = Reply | ((context: Context) => Reply | Promise<Reply>);

const textOf = (value: unknown) => JSON.stringify(value);
const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) =>
	fauxAssistantMessage(calls, { stopReason: "toolUse" });

/**
 * Several sessions share one scripted model. Each request is answered from the script of the session
 * that asks, found by the name its system prompt starts with, so turns can interleave freely.
 */
function harness(options: { waitMs?: number; dbPath?: string } = {}) {
	const faux = fauxProvider();
	const { store } = newStore(options.dbPath);
	const keys = new MemoryKeyStore({ [faux.provider.id]: "test-key" });
	const gateway = new ModelGateway({ keys, version: "0.0.0", providers: [faux.provider] });
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
		waitMs: options.waitMs ?? 3000,
	});
	const scripts = new Map<string, Step[]>();
	const seen = new Map<string, Context[]>();
	const router = (context: unknown): Reply | Promise<Reply> => {
		const copy = structuredClone(context) as Context;
		const system = String(copy.messages.find((m) => m.role === "system")?.content ?? "");
		const name = /^You are "([^"]+)"/.exec(system)?.[1] ?? "";
		seen.set(name, [...(seen.get(name) ?? []), copy]);
		const step = scripts.get(name)?.shift();
		if (!step) return fauxAssistantMessage(`(${name} has no more replies)`);
		return typeof step === "function" ? step(copy) : step;
	};
	faux.setResponses(Array.from({ length: 300 }, () => router) as never);
	const make = (name: string, extra: Partial<NewSession> = {}): Session =>
		store.createSession({
			name,
			kind: "standing",
			provider: faux.provider.id,
			model: faux.getModel().id,
			cwd: folder,
			thinking: "off",
			options: { permissionMode: "default" },
			...extra,
		});
	const script = (session: Session, steps: Step[]) => scripts.set(session.name, steps);
	const entries = (session: Session): Entry[] =>
		store.listEntries(session.id, { limit: 200 }).entries;
	const said = (session: Session) =>
		entries(session)
			.filter((entry) => entry.role === "assistant")
			.map((entry) => textOf(entry));
	return { faux, store, agents, make, script, seen, entries, said, folder, home };
}

async function until(check: () => boolean, ms = 4000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > ms) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

const lastTool = (context: Context | undefined) => textOf(context?.messages.at(-1));

describe("letters between sessions", () => {
	test("a request starts an idle session; its final reply comes back to the sender as a report", async () => {
		const { store, agents, make, script, entries, said } = harness();
		const a = make("产品会话");
		const b = make("平台组");
		script(a, [
			toolUse(
				fauxToolCall(
					"send_letter",
					{ to: b.id, kind: "request", summary: "数一下文件" },
					{ id: "c1" },
				),
			),
			fauxAssistantMessage("已发出"),
			fauxAssistantMessage("平台组说一共 3 个"),
		]);
		script(b, [fauxAssistantMessage("一共 3 个文件")]);
		agents.send(a.id, "去问平台组有几个文件");
		await until(() => said(a).some((text) => text.includes("平台组说一共 3 个")));
		await until(() => !agents.isRunning(a.id) && !agents.isRunning(b.id));

		const received = entries(b).find(
			(entry) => entry.role === "user" && "letter" in entry && entry.letter,
		);
		assert.ok(received && received.role === "user" && received.letter);
		assert.equal(received.letter.kind, "request");
		assert.equal(received.letter.from.sessionId, a.id);
		assert.match(
			textOf(received),
			/<letter id=\\"[^"\\]+\\" kind=\\"request\\" from=\\"产品会话\\"/,
		);
		const report = entries(a).find(
			(entry) => entry.role === "user" && entry.letter?.kind === "report",
		);
		assert.ok(report && report.role === "user");
		assert.equal(report.letter?.auto, true);
		assert.equal(report.letter?.summary, "一共 3 个文件");
		const letters = agents.post.mail.listLetters({ limit: 10 }).items;
		assert.deepEqual(
			letters.map((letter) => letter.status),
			["done", "done"],
		);
		assert.equal(store.getSession(a.id).lettersSent, 1);
		assert.equal(store.getSession(b.id).lettersSent, 0, "an automatic report is not counted");
	});

	test("with wait, the answer comes back in the same call and no report letter follows", async () => {
		const { agents, make, script, seen, said } = harness();
		const a = make("总办");
		const b = make("法务组");
		script(a, [
			toolUse(
				fauxToolCall(
					"send_letter",
					{ to: b.id, kind: "request", summary: "合同能签吗", wait: true },
					{ id: "c1" },
				),
			),
			fauxAssistantMessage("法务组说可以签"),
		]);
		script(b, [fauxAssistantMessage("可以签，第 3 条已改")]);
		agents.send(a.id, "问一下法务组");
		await until(() => said(a).some((text) => text.includes("法务组说可以签")));
		assert.match(
			lastTool(seen.get("总办")?.[1]),
			/法务组 finished its turn\. Its last reply:\\n可以签，第 3 条已改/,
		);
		await until(() => !agents.isRunning(b.id));
		const letters = agents.post.mail.listLetters({ limit: 10 }).items;
		assert.equal(letters.length, 1, "only the request; the answer came through the call");
	});

	test("a letter to a working session arrives between tool calls, after the results", async () => {
		const { store, agents, make, script, entries } = harness();
		const a = make("产品会话");
		const b = make("平台组", { options: { permissionMode: "default" } });
		script(b, [
			toolUse(fauxToolCall("shell", { command: "touch made.txt", confirm: true }, { id: "c1" })),
			fauxAssistantMessage("好的"),
		]);
		agents.send(b.id, "建个文件");
		await until(() => store.pendingApprovals(b.id).length === 1);
		const letter = agents.post.send(
			{ kind: "session", session: a },
			{ to: b.id, kind: "notice", summary: "发布推迟到周五" },
		);
		assert.equal(agents.post.mail.getLetter(letter.id).status, "queued");
		const [approval] = store.pendingApprovals(b.id);
		agents.answer(approval?.id as string, { decision: "allow_once" });
		await agents.whenIdle(b.id);
		const roles = entries(b).map((entry) =>
			entry.role === "user" && entry.letter ? "letter" : entry.role,
		);
		assert.deepEqual(roles, ["user", "assistant", "toolResult", "letter", "assistant"]);
	});

	test("letters from the command line wait until the sweep; a session that needs review waits for the person", async () => {
		const { store, agents, make, script, said } = harness();
		const b = make("平台组");
		const c = make("安全组");
		script(b, [fauxAssistantMessage("收到构建失败的通知")]);
		script(c, [fauxAssistantMessage("继续之后看到了信")]);
		// Continuing needs something to continue from.
		store.appendEntry(c.id, {
			role: "user",
			message: { role: "user", content: "早先的消息", timestamp: Date.now() },
		});
		// `yew send` runs in another process: its post office has no runner to wake anyone.
		const cli = new PostOffice(store);
		cli.send({ kind: "cli" }, { to: b.id, kind: "notice", summary: "main 上的构建失败了" });
		store.setStatus(c.id, "needs_review");
		cli.send({ kind: "cli" }, { to: c.id, kind: "notice", summary: "证书下月到期" });
		assert.equal(agents.isRunning(b.id), false);
		agents.wakeQueued();
		await until(() => said(b).length === 1);
		assert.equal(said(c).length, 0, "needs review: the person continues it first");
		agents.continue(c.id);
		await until(() => said(c).length === 1);
	});

	test("sessions do not wait for each other in a circle", async () => {
		const { agents, make, script, seen, said } = harness();
		const a = make("甲");
		const b = make("乙");
		const c = make("丙");
		script(a, [
			toolUse(
				fauxToolCall(
					"send_letter",
					{ to: b.id, kind: "request", summary: "问乙", wait: true },
					{ id: "a1" },
				),
			),
			fauxAssistantMessage("甲结束"),
		]);
		script(b, [
			toolUse(
				fauxToolCall(
					"send_letter",
					{ to: c.id, kind: "request", summary: "问丙", wait: true },
					{ id: "b1" },
				),
			),
			fauxAssistantMessage("乙结束"),
		]);
		script(c, [
			toolUse(
				fauxToolCall(
					"send_letter",
					{ to: a.id, kind: "notice", summary: "丙告诉甲", wait: true },
					{ id: "c1" },
				),
			),
			fauxAssistantMessage("丙结束"),
		]);
		agents.send(a.id, "开始");
		await until(() => said(a).some((text) => text.includes("甲结束")));
		assert.match(lastTool(seen.get("丙")?.[1]), /Not waiting: 甲 is already waiting for you/);
		assert.match(lastTool(seen.get("乙")?.[1]), /丙 finished its turn/);
		// 丙's letter reached 甲 after its call returned, in the same turn.
		assert.match(textOf(seen.get("甲")?.[1]), /丙告诉甲/);
	});
});

describe("letters across failures", () => {
	test("a report owed when Yew stopped is still sent once the session finishes", async () => {
		const { store, agents, make, script, entries } = harness();
		const a = make("产品会话");
		const b = make("平台组");
		script(b, [fauxAssistantMessage("清单看完了，没有问题")]);
		script(a, [fauxAssistantMessage("好的")]);
		// The state a restart leaves: the request was delivered, the session is marked for review, and
		// this runner never saw the delivery.
		store.appendEntry(b.id, {
			role: "user",
			message: { role: "user", content: "早先的消息", timestamp: Date.now() },
		});
		const request = agents.post.mail.addLetter({
			fromKind: "session",
			fromSession: a.id,
			fromName: a.name,
			toSession: b.id,
			kind: "request",
			summary: "请看一下发布清单",
			body: "",
			status: "queued",
			path: [a.id],
		});
		const entry = store.appendEntry(b.id, {
			role: "user",
			message: {
				role: "user",
				content: "<letter>请看一下发布清单</letter>",
				timestamp: Date.now(),
			},
		});
		agents.post.mail.setLetterStatus(request.id, "delivered", {
			entryId: entry.id,
			deliveredAt: Date.now(),
		});
		store.setStatus(b.id, "needs_review");
		agents.continue(b.id);
		await until(() => entries(a).some((e) => e.role === "user" && e.letter?.kind === "report"));
		const report = entries(a).find((e) => e.role === "user" && e.letter?.kind === "report");
		assert.equal(report?.role === "user" && report.letter?.summary, "清单看完了，没有问题");
		assert.equal(agents.post.mail.getLetter(request.id).status, "done");
		await until(() => !agents.isRunning(a.id));
	});

	test("two requests answered with the same words both get their report", async () => {
		const { agents, make, script } = harness();
		const a = make("总办");
		const b = make("平台组");
		script(b, [fauxAssistantMessage("完成。"), fauxAssistantMessage("完成。")]);
		script(a, [fauxAssistantMessage("好"), fauxAssistantMessage("好")]);
		const reports = () =>
			agents.post.mail
				.listLetters({ limit: 20 })
				.items.filter((l) => l.fromSession === b.id && l.auto && l.status !== "dropped");
		agents.post.send(
			{ kind: "session", session: a },
			{ to: b.id, kind: "request", summary: "任务一" },
		);
		await until(() => reports().length === 1 && !agents.isRunning(a.id) && !agents.isRunning(b.id));
		agents.post.send(
			{ kind: "session", session: a },
			{ to: b.id, kind: "request", summary: "任务二" },
		);
		await until(() => reports().length === 2);
	});

	test("a wait outlasts a failed turn when its letter was not read yet", async () => {
		const { agents, make, script, seen, said } = harness();
		const a = make("甲");
		const b = make("乙");
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		script(b, [
			async () => {
				await gate;
				return fauxAssistantMessage([], { stopReason: "error", errorMessage: "服务商出错" });
			},
			fauxAssistantMessage("第二轮看到了甲的信"),
		] as never);
		script(a, [
			toolUse(
				fauxToolCall(
					"send_letter",
					{ to: b.id, kind: "request", summary: "在吗", wait: true },
					{ id: "a1" },
				),
			),
			fauxAssistantMessage("甲结束"),
		]);
		agents.send(b.id, "开始");
		await until(() => agents.isRunning(b.id));
		agents.send(a.id, "问乙");
		await until(() =>
			agents.post.mail.listLetters({ limit: 5 }).items.some((l) => l.status === "queued"),
		);
		release();
		await until(() => said(a).some((text) => text.includes("甲结束")));
		assert.match(lastTool(seen.get("甲")?.[1]), /第二轮看到了甲的信/);
	});
});

describe("task sessions", () => {
	test("open_session starts a child with the parent's permissions; with wait its reply returns", async () => {
		const { store, agents, make, script, seen, said, folder } = harness();
		const parent = make("Yew · 开发", {
			options: { permissionMode: "skip" },
			rules: [{ effect: "deny", tool: "web_fetch" }],
		});
		script(parent, [
			toolUse(
				fauxToolCall(
					"open_session",
					{ name: "统计 TODO", brief: "统计仓库里的 TODO，报告数量。", wait: true },
					{ id: "p1" },
				),
			),
			fauxAssistantMessage("子任务做完了"),
		]);
		// The child's script is keyed by the name it will get.
		script({ name: "统计 TODO" } as Session, [
			toolUse(fauxToolCall("finish_task", { result: "done", next: "没有剩下的事" }, { id: "k1" })),
			fauxAssistantMessage("完成：0 个 TODO"),
		]);
		agents.send(parent.id, "开个子任务统计 TODO");
		await until(() => said(parent).some((text) => text.includes("子任务做完了")));
		const child = store.findSessionByName("统计 TODO");
		assert.ok(child);
		assert.equal(child.parentId, parent.id);
		assert.equal(child.kind, "task");
		assert.equal(child.cwd, folder);
		assert.equal(child.options.permissionMode, "skip");
		assert.deepEqual(child.rules, [{ effect: "deny", tool: "web_fetch" }]);
		assert.equal(child.outcome, "done");
		// What is left stays with the call, for an evaluation to read (PROTOCOL_VERSION 1).
		const finished = store
			.toolCallsForSession(child.id)
			.find((call) => call.tool === "finish_task");
		assert.equal(finished?.args.next, "没有剩下的事");
		assert.match(lastTool(seen.get("Yew · 开发")?.[1]), /完成：0 个 TODO/);
		const prompt = String(seen.get("统计 TODO")?.[0]?.messages[0]?.content ?? "");
		assert.match(prompt, /"Yew · 开发" \(id [^)]+\) opened you for this task/);
	});

	test("a child's folder must be inside the parent's; a parent that asks to be asked is asked first", async () => {
		const { store, agents, make, script, seen } = harness();
		const outside = realpathSync(tempDir("yew-elsewhere-"));
		const parent = make("产品会话", { options: { permissionMode: "default" } });
		mkdirSync(join(parent.cwd as string, "web"));
		script(parent, [
			toolUse(
				fauxToolCall(
					"open_session",
					{ name: "外面", brief: "x", folder: outside, confirm: true },
					{ id: "p1" },
				),
			),
			toolUse(
				fauxToolCall(
					"open_session",
					{ name: "里面", brief: "改界面", folder: "web", confirm: true },
					{ id: "p2" },
				),
			),
			fauxAssistantMessage("好"),
		]);
		agents.send(parent.id, "开子任务");
		// The parent asked to be asked: opening a session is asked about before the call runs.
		await until(() => store.pendingApprovals(parent.id).length === 1);
		const [first] = store.pendingApprovals(parent.id);
		// The card names the session to open and shows its brief.
		assert.equal((first?.request as { summary?: string } | undefined)?.summary, "外面");
		assert.equal((first?.request as { description?: string } | undefined)?.description, "x");
		agents.answer(first?.id as string, { decision: "allow_once" });
		await until(() =>
			store.pendingApprovals(parent.id).some((a) => textOf(a.request).includes("里面")),
		);
		assert.match(lastTool(seen.get("产品会话")?.[1]), /must be your working folder or inside it/);
		const [approval] = store.pendingApprovals(parent.id);
		agents.answer(approval?.id as string, { decision: "allow_once" });
		await until(() => store.findSessionByName("里面") !== undefined);
		assert.equal(store.findSessionByName("里面")?.cwd, join(parent.cwd as string, "web"));
	});
});

describe("the main conversation", () => {
	test("only it is offered card tools; the person's decision reaches the requester and it", async () => {
		const { store, agents, make, script, seen, entries, said } = harness();
		const main = make("总办");
		const product = make("Yew · 开发");
		store.setSetting("mainSessionId", main.id);
		script(main, [
			toolUse(
				fauxToolCall(
					"post_card",
					{
						title: "许可证用 MIT 吗？",
						options: [{ label: "MIT" }, { label: "Apache-2.0" }],
						recommended: 1,
						undoable: false,
						reversible: "开源后不能撤回",
						after: "Yew · 开发改 LICENSE",
						requested_by: product.id,
					},
					{ id: "m1" },
				),
			),
			fauxAssistantMessage("已放进审批中心"),
			fauxAssistantMessage("记下了 #1"),
		]);
		script(product, [fauxAssistantMessage("按 #1 改成 MIT")]);
		agents.send(main.id, "把许可证的事放进审批中心");
		await until(() => said(main).some((text) => text.includes("已放进审批中心")));
		const mainTools = (seen.get("总办")?.[0]?.messages[0]?.toolsAdded ?? []).map((t) => t.name);
		assert.ok(mainTools.includes("post_card") && mainTools.includes("list_cards"));
		assert.match(
			String(seen.get("总办")?.[0]?.messages[0]?.content),
			/You are the person's main conversation/,
		);
		const [card] = agents.post.center().cards;
		assert.equal(card?.recommended, 0);
		assert.equal(card?.requestedBy, product.id);

		agents.post.decide(card?.id as string, 0, "就用 MIT");
		await until(
			() => said(product).length === 1 && said(main).some((text) => text.includes("记下了 #1")),
		);
		const decision = entries(product).find((entry) => entry.role === "user" && entry.letter);
		assert.ok(decision?.role === "user");
		assert.equal(decision.letter?.kind, "decision");
		assert.equal(decision.letter?.decision?.choice, "MIT");
		assert.match(
			textOf(decision),
			/<decision number=\\"1\\" from=\\"the person\\" recorded-by=\\"Yew\\">/,
		);
		const productTools = (seen.get("Yew · 开发")?.[0]?.messages[0]?.toolsAdded ?? []).map(
			(t) => t.name,
		);
		assert.ok(!productTools.includes("post_card"));
		assert.match(
			String(seen.get("Yew · 开发")?.[0]?.messages[0]?.content),
			/The person's main conversation is "总办"/,
		);
	});

	test("becoming the main conversation arrives as an update; the prompt stays the same", async () => {
		const { store, agents, make, script, seen, entries } = harness();
		const s = make("总办");
		script(s, [fauxAssistantMessage("一"), fauxAssistantMessage("二")]);
		agents.send(s.id, "你好");
		await agents.whenIdle(s.id);
		store.setSetting("mainSessionId", s.id);
		agents.send(s.id, "再来");
		await agents.whenIdle(s.id);
		const [first, second] = seen.get("总办") ?? [];
		// The tools change (card tools are added); the prompt text does not.
		assert.equal(second?.messages[0]?.content, first?.messages[0]?.content);
		const update = entries(s).find((entry) => entry.role === "system");
		assert.match(textOf(update), /made you their main conversation/);
		const tools = (second?.messages[0]?.toolsAdded ?? []).map((t) => t.name);
		assert.ok(tools.includes("post_card"));
	});
});

/** The id of the first letter a session read, from its request to the model. */
function letterIdIn(context: Context): string {
	for (const message of context.messages) {
		const text =
			typeof message.content === "string"
				? message.content
				: JSON.stringify(message.content).replace(/\\"/g, '"');
		const found = /<letter id="([^"]+)"/.exec(text);
		if (found) return found[1] as string;
	}
	return "";
}

const toolResultIn = (context: Context | undefined) =>
	textOf(context?.messages.find((message) => message.role === "toolResult"));

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("when things go wrong", () => {
	test("open_session checks the brief before it opens a session", async () => {
		const { store, agents, make, script, seen, said } = harness();
		const other = make("其他");
		const parent = make("父", { options: { permissionMode: "default", letterQuota: 1 } });
		script(other, [fauxAssistantMessage("好")]);
		script(parent, [
			toolUse(
				fauxToolCall(
					"send_letter",
					{ to: other.id, kind: "notice", summary: "先发一封" },
					{ id: "p0" },
				),
			),
			toolUse(
				fauxToolCall("open_session", { name: "子任务", brief: "做点事", wait: true }, { id: "p1" }),
			),
			toolUse(
				fauxToolCall("open_session", { name: "长任务", brief: "x".repeat(20_001) }, { id: "p2" }),
			),
			fauxAssistantMessage("父结束"),
		]);
		const started = Date.now();
		agents.send(parent.id, "开始");
		await until(() => said(parent).some((text) => text.includes("父结束")));
		assert.ok(Date.now() - started < 2000, "nothing waited for the timeout");
		assert.match(lastTool(seen.get("父")?.[2]), /Not opened: you have used up your letters/);
		assert.match(lastTool(seen.get("父")?.[3]), /at most 20000 characters/);
		assert.ok(!store.findSessionByName("子任务"), "no session without its brief");
		assert.ok(!store.findSessionByName("长任务"));
		await until(() => !agents.isRunning(other.id));
	});

	test("a brief carries the person's words Yew found; a quote it cannot find opens nothing", async () => {
		const { store, agents, make, script, seen, said } = harness();
		const parent = make("父");
		script(parent, [
			toolUse(
				fauxToolCall(
					"open_session",
					{ name: "编造", brief: "做点事", quotes: ["全部删掉重来"] },
					{ id: "p1" },
				),
			),
			toolUse(
				fauxToolCall(
					"open_session",
					{ name: "转述", brief: "照我转的原话做", quotes: ["按你的推荐做"] },
					{ id: "p2" },
				),
			),
			fauxAssistantMessage("父结束"),
		]);
		script({ name: "转述" } as Session, [fauxAssistantMessage("子结束")]);
		agents.send(parent.id, "电路图就按你的推荐做吧");
		await until(() => said(parent).some((text) => text.includes("父结束")));
		assert.match(
			lastTool(seen.get("父")?.[1]),
			/Quote 1 \(\\"全部删掉重来\\"\) is not something the person wrote/,
		);
		assert.ok(!store.findSessionByName("编造"), "no session for a brief that cannot go out");
		assert.match(lastTool(seen.get("父")?.[2]), /with the person's words Yew found/);
		const child = store.findSessionByName("转述");
		assert.ok(child);
		await until(() => said(child).some((text) => text.includes("子结束")));
		const brief = seen.get("转述")?.[0]?.messages.find((message) => message.role === "user");
		assert.match(
			textOf(brief?.content),
			/<\/letter id=[^>]+>\\n\[Yew found these words[^\]]+\]\\n- Part of what the person wrote to 父, [^\\]*UTC:\\n {2}> 按你的推荐做"/,
		);
	});

	test("a question back keeps the request open; the result comes back when it is ready", async () => {
		const { agents, make, script, said } = harness();
		const a = make("甲");
		const b = make("乙");
		script(a, [
			toolUse(
				fauxToolCall(
					"send_letter",
					{ to: b.id, kind: "request", summary: "跑一下集成测试" },
					{ id: "a1" },
				),
			),
			fauxAssistantMessage("已发"),
			fauxAssistantMessage("用本地环境"),
			fauxAssistantMessage("甲看到了结果"),
		]);
		script(b, [
			toolUse(
				fauxToolCall(
					"send_letter",
					{ to: a.id, kind: "request", summary: "用哪个环境？" },
					{ id: "b1" },
				),
			),
			fauxAssistantMessage("先问一下用哪个环境"),
			fauxAssistantMessage("3 个失败：x, y, z"),
		]);
		agents.send(a.id, "让乙跑测试");
		await until(() => said(a).some((text) => text.includes("甲看到了结果")));
		await until(() => !agents.isRunning(a.id) && !agents.isRunning(b.id));
		const letters = agents.post.mail.listLetters({ limit: 20 }).items.reverse();
		assert.deepEqual(
			letters.map(
				(l) =>
					`${l.fromSession === a.id ? "甲" : "乙"} ${l.kind}${l.auto ? " auto" : ""}: ${l.summary}`,
			),
			[
				"甲 request: 跑一下集成测试",
				"乙 request: 用哪个环境？",
				"甲 report auto: 用本地环境",
				"乙 report auto: 3 个失败：x, y, z",
			],
		);
		assert.ok(letters.every((l) => l.status === "done"));
	});

	test("a wait ends only with a reply to its letter; other letters arrive as letters", async () => {
		const { store, agents, make, script, seen, said, entries } = harness();
		const a = make("等待者");
		const b = make("忙碌者");
		script(b, [
			toolUse(
				fauxToolCall("shell", { command: "touch x.txt", confirm: true }, { id: "b1" }),
				fauxToolCall(
					"send_letter",
					{ to: a.id, kind: "notice", summary: "无关通知：周五发布" },
					{ id: "b2" },
				),
			),
			fauxAssistantMessage("答复：数据库用 Postgres"),
		]);
		script(a, [
			toolUse(
				fauxToolCall(
					"send_letter",
					{ to: b.id, kind: "request", summary: "数据库用哪个？", wait: true },
					{ id: "a1" },
				),
			),
			fauxAssistantMessage("等待者结束"),
		]);
		agents.send(b.id, "先建文件再通知");
		await until(() => store.pendingApprovals(b.id).length === 1);
		agents.send(a.id, "问忙碌者");
		await until(() =>
			agents.post.mail.listLetters({ limit: 5 }).items.some((l) => l.fromSession === a.id),
		);
		const [approval] = store.pendingApprovals(b.id);
		agents.answer(approval?.id as string, { decision: "allow_once" });
		await until(() => said(a).some((text) => text.includes("等待者结束")));
		assert.match(
			toolResultIn(seen.get("等待者")?.[1]),
			/finished its turn\. Its last reply:\\n答复：数据库用 Postgres/,
		);
		assert.ok(
			entries(a).some((e) => e.role === "user" && e.letter?.summary === "无关通知：周五发布"),
		);
		await until(() => !agents.isRunning(a.id) && !agents.isRunning(b.id));
	});

	test("after an error the requester hears so, and the real result follows when the session goes on", async () => {
		const { store, agents, make, script, said } = harness();
		const parent = make("开会话方");
		script(parent, [
			toolUse(fauxToolCall("open_session", { name: "子会话甲", brief: "统计 TODO" }, { id: "p1" })),
			fauxAssistantMessage("已开"),
			fauxAssistantMessage("收到出错通知"),
			fauxAssistantMessage("收到最终结果"),
		]);
		script({ name: "子会话甲" } as Session, [
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "401 invalid api key" }),
			fauxAssistantMessage("完成：共 7 个 TODO"),
		]);
		agents.send(parent.id, "开子会话");
		await until(() => said(parent).some((text) => text.includes("收到出错通知")));
		const child = store.findSessionByName("子会话甲") as Session;
		await until(() => !agents.isRunning(child.id) && !agents.isRunning(parent.id));
		assert.equal(store.getSession(child.id).status, "error");
		const brief = agents.post.mail
			.listLetters({ limit: 20 })
			.items.find((l) => l.toSession === child.id) as Letter;
		assert.equal(
			agents.post.mail.getLetter(brief.id).status,
			"delivered",
			"the request stays open",
		);
		agents.continue(child.id);
		await until(() => said(parent).some((text) => text.includes("收到最终结果")));
		const toParent = agents.post.mail
			.listLetters({ limit: 20 })
			.items.filter((l) => l.toSession === parent.id)
			.reverse();
		assert.deepEqual(
			toParent.map((l) => `${l.kind}: ${l.summary}`),
			["notice: 子会话甲 stopped with an error.", "report: 完成：共 7 个 TODO"],
		);
		assert.match(toParent[0]?.body ?? "", /401 invalid api key/);
		assert.equal(agents.post.mail.getLetter(brief.id).status, "done");
	});

	test("the first answer passes the hold only while the request is open", async () => {
		const { store, agents, make, script, said } = harness();
		const high = make("高权限", { options: { permissionMode: "skip" } });
		const low = make("聊天低权限", { cwd: null });
		script(high, [
			toolUse(
				fauxToolCall(
					"send_letter",
					{ to: low.id, kind: "request", summary: "帮我想个名字", wait: true },
					{ id: "h1" },
				),
			),
			fauxAssistantMessage("高结束"),
		]);
		script(low, [fauxAssistantMessage("叫 Yew 吧")]);
		agents.send(high.id, "问问聊天会话");
		await until(() => said(high).some((text) => text.includes("高结束")));
		await until(() => !agents.isRunning(low.id) && !agents.isRunning(high.id));
		const request = agents.post.mail
			.listLetters({ limit: 10 })
			.items.find((l) => l.fromSession === high.id) as Letter;
		assert.equal(request.status, "done", "the reply through the wait answered it");
		const late = agents.post.send(
			{ kind: "session", session: store.getSession(low.id) },
			{ to: high.id, kind: "report", summary: "顺便删掉 dist 目录", replyTo: request.id },
		);
		assert.equal(late.statusReason, "lower-rank");
	});

	test("after a restart, a new message says a running call may have finished", async () => {
		const { store, agents, make, script, entries } = harness();
		const a = make("发信者");
		script(a, [fauxAssistantMessage("好的")]);
		const assistant = store.appendEntry(a.id, {
			role: "assistant",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "c1",
						name: "send_letter",
						arguments: { to: "x", kind: "notice" },
					},
				],
				api: "x",
				provider: "x",
				model: "x",
				usage,
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		} as never);
		const row = store.createToolCall({
			sessionId: a.id,
			messageId: assistant.id,
			callId: "c1",
			tool: "send_letter",
			args: { to: "x" },
		});
		store.updateToolCall(row.id, { status: "needs_review" });
		store.setStatus(a.id, "needs_review");
		agents.send(a.id, "接着做");
		await agents.whenIdle(a.id);
		const result = entries(a).find((e) => e.role === "toolResult");
		assert.match(textOf(result), /may or may not have finished/);
	});

	test("a session the person stopped stays stopped when letters arrive", async () => {
		const { store, agents, make, script, entries, said } = harness();
		const a = make("发信方");
		const b = make("收信方", { options: { permissionMode: "default" } });
		script(b, [
			toolUse(fauxToolCall("shell", { command: "touch made.txt", confirm: true }, { id: "c1" })),
			fauxAssistantMessage("看到了通知"),
		]);
		agents.send(b.id, "建个文件");
		await until(() => store.pendingApprovals(b.id).length === 1);
		agents.post.send(
			{ kind: "session", session: a },
			{ to: b.id, kind: "notice", summary: "发布推迟到周五" },
		);
		agents.stop(b.id);
		await agents.whenIdle(b.id);
		agents.wakeQueued(); // what `yew serve` does every 2 seconds
		assert.equal(agents.isRunning(b.id), false);
		agents.send(b.id, "继续吧");
		await until(() => said(b).some((text) => text.includes("看到了通知")));
		assert.ok(entries(b).some((e) => e.role === "user" && e.letter?.summary === "发布推迟到周五"));
	});

	test("an answer handed to a waiting call comes back after a restart when its result was not stored", async () => {
		const path = join(tempDir("yew-db-"), "yew.db");
		const first = harness({ waitMs: 5000, dbPath: path });
		const a = first.make("等待方");
		const b = first.make("回信方");
		first.script(b, [
			(context) =>
				toolUse(
					fauxToolCall(
						"send_letter",
						{ to: a.id, kind: "report", summary: "答案是 42", reply_to: letterIdIn(context) },
						{ id: "b1" },
					),
				),
			fauxAssistantMessage("乙结束"),
		]);
		first.script(a, [
			toolUse(
				fauxToolCall(
					"send_letter",
					{ to: b.id, kind: "request", summary: "答案是多少", wait: true },
					{ id: "a1" },
				),
				fauxToolCall("ask_user", { question: "继续吗？" }, { id: "a2" }),
			),
			fauxAssistantMessage("甲结束"),
		]);
		first.agents.send(a.id, "问乙");
		await until(() => first.store.pendingApprovals(a.id).length === 1);
		const answer = first.agents.post.mail
			.listLetters({ limit: 10 })
			.items.find((l) => l.fromSession === b.id && !l.auto) as Letter;
		assert.equal(answer.status, "delivered");
		// What `yew serve` does on Ctrl-C: stop everything, then close the database at once.
		first.agents.shutdown();
		first.store.db.close();

		const second = harness({ waitMs: 5000, dbPath: path });
		second.store.recoverAfterRestart();
		assert.equal(second.agents.post.mail.requeueHandedOff(), 1);
		second.script(a, [fauxAssistantMessage("重启后甲结束")]);
		second.agents.continue(a.id);
		await until(() => second.said(a).some((text) => text.includes("重启后甲结束")));
		assert.ok(
			second.entries(a).some((e) => e.role === "user" && e.letter?.summary === "答案是 42"),
		);
	});

	test("compacting a session that needs review leaves it waiting for the person", async () => {
		const { store, agents, make, said } = harness();
		const a = make("寄信人");
		const x = make("待核对会话");
		store.appendEntry(x.id, {
			role: "user",
			message: { role: "user", content: "早先的消息", timestamp: Date.now() },
		});
		store.setStatus(x.id, "needs_review", "Yew restarted while this session was working.");
		agents.post.send(
			{ kind: "session", session: a },
			{ to: x.id, kind: "notice", summary: "一封信" },
		);
		await agents.compactNow(x.id);
		assert.equal(agents.isRunning(x.id), false);
		assert.equal(store.getSession(x.id).status, "needs_review");
		assert.equal(
			store.getSession(x.id).statusDetail,
			"Yew restarted while this session was working.",
		);
		assert.equal(said(x).length, 0);
	});

	test("compaction keeps the main conversation and the opener in the prompt", async () => {
		const { store, agents, make, script } = harness();
		const main = make("总办");
		store.setSetting("mainSessionId", main.id);
		const child = make("子会话乙", { kind: "task", parentId: main.id });
		script(child, [fauxAssistantMessage("这是总结")]);
		for (const content of ["y".repeat(120_000), "继续"]) {
			store.appendEntry(child.id, {
				role: "user",
				message: { role: "user", content, timestamp: Date.now() },
			});
		}
		await agents.compactNow(child.id);
		type Snap = { main?: { id: string } | null; parent?: { id: string } | null };
		const snapshot = store.getContextSnapshot<Snap>(child.id);
		assert.equal(snapshot?.main?.id, main.id);
		assert.equal(snapshot?.parent?.id, main.id);
	});

	test("a task session tells its opener how every turn ended", async () => {
		const { store, agents, make, script, said } = harness();
		const parent = make("开会话方");
		script(parent, [
			toolUse(
				fauxToolCall("open_session", { name: "子会话丙", brief: "改一下文案" }, { id: "p1" }),
			),
			fauxAssistantMessage("已开"),
			fauxAssistantMessage("收到第一份"),
			fauxAssistantMessage("收到第二份"),
		]);
		script({ name: "子会话丙" } as Session, [
			fauxAssistantMessage("改好了"),
			fauxAssistantMessage("按你说的又改了标题"),
		]);
		agents.send(parent.id, "开");
		await until(() => said(parent).some((text) => text.includes("收到第一份")));
		const child = store.findSessionByName("子会话丙") as Session;
		await until(() => !agents.isRunning(child.id) && !agents.isRunning(parent.id));
		// The person steps into the task session.
		agents.send(child.id, "标题也改一下");
		await until(() => said(parent).some((text) => text.includes("收到第二份")));
		const reports = agents.post.mail
			.listLetters({ limit: 20 })
			.items.filter((l) => l.toSession === parent.id)
			.reverse();
		assert.deepEqual(
			reports.map((l) => `${l.kind}: ${l.summary}`),
			["report: 改好了", "report: 按你说的又改了标题"],
		);
	});

	test("archiving a session drops letters waiting for it and ends waits on them", async () => {
		const { store, agents, make, script, seen, said } = harness();
		const a = make("甲");
		const b = make("乙");
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		script(b, [
			async () => {
				await gate;
				return fauxAssistantMessage("乙结束");
			},
		]);
		script(a, [
			toolUse(
				fauxToolCall(
					"send_letter",
					{ to: b.id, kind: "request", summary: "在吗", wait: true },
					{ id: "a1" },
				),
			),
			fauxAssistantMessage("甲结束"),
		]);
		agents.send(b.id, "开始");
		await until(() => agents.isRunning(b.id));
		agents.send(a.id, "问乙");
		const request = () =>
			agents.post.mail.listLetters({ limit: 5 }).items.find((l) => l.fromSession === a.id);
		await until(() => request()?.status === "queued");
		store.updateSession(b.id, { archived: true });
		agents.archived(b.id);
		await until(() => said(a).some((text) => text.includes("甲结束")));
		assert.match(lastTool(seen.get("甲")?.[1]), /archived before it read the letter/);
		assert.equal(request()?.status, "dropped");
		assert.equal(request()?.statusReason, "archived");
		release();
		await until(() => !agents.isRunning(b.id));
	});
});

describe("organizing sessions", () => {
	test("the main conversation organizes sessions in one call; a bad call is refused before anyone is asked", async () => {
		const { store, agents, make, script, seen, said } = harness();
		const main = make("总办", {
			options: { permissionMode: "default" },
			rules: [{ effect: "ask", tool: "manage_yew" }],
		});
		const a = make("甲");
		const b = make("乙");
		store.setSetting("mainSessionId", main.id);
		script(main, [
			toolUse(
				fauxToolCall(
					"manage_yew",
					{
						teams: [{ name: "产品" }],
						sessions: [
							{ session: a.id, name: "甲 · 产品", team: "产品" },
							{ session: "乙", team: "产品" },
						],
					},
					{ id: "o1" },
				),
			),
			toolUse(
				fauxToolCall(
					"manage_yew",
					{ teams: [{ name: "临时" }], sessions: [{ session: b.id, name: "甲 · 产品" }] },
					{ id: "o2" },
				),
			),
			fauxAssistantMessage("整理好了"),
		]);
		agents.send(main.id, "把甲和乙放进产品团队");
		// Organizing follows the session's rules: here they ask, and the card lists every change by name.
		await until(() => store.pendingApprovals(main.id).length === 1);
		const [approval] = store.pendingApprovals(main.id);
		const request = approval?.request as PermissionRequest;
		assert.deepEqual(request.changes, [
			{ action: "create_team", name: "产品" },
			{ action: "rename_session", from: "甲", to: "甲 · 产品" },
			{ action: "move_to_team", sessions: ["甲"], team: "产品" },
			{ action: "move_to_team", sessions: ["乙"], team: "产品" },
		]);
		assert.deepEqual(request.rememberRules, [
			{ effect: "allow", tool: "manage_yew", pattern: "organize" },
		]);
		agents.answer(approval?.id as string, { decision: "allow_once" });
		await until(() => said(main).some((text) => text.includes("整理好了")));

		const team = store.listGroups().find((group) => group.name === "产品");
		assert.ok(team);
		assert.equal(store.getSession(a.id).name, "甲 · 产品");
		assert.equal(store.getSession(a.id).groupId, team.id);
		assert.equal(store.getSession(b.id).groupId, team.id);
		assert.match(lastTool(seen.get("总办")?.[1]), /Created the team \\"产品\\"/);
		// The second call names a taken name: refused at once, nothing created, nobody asked.
		assert.match(lastTool(seen.get("总办")?.[2]), /is taken/);
		assert.ok(!store.listGroups().some((group) => group.name === "临时"));
		assert.equal(store.getSession(b.id).name, "乙");
		const mainTools = (seen.get("总办")?.[0]?.messages[0]?.toolsAdded ?? []).map((t) => t.name);
		assert.ok(mainTools.includes("manage_yew"));
		script(b, [fauxAssistantMessage("好")]);
		agents.send(b.id, "你好");
		await until(() => said(b).length === 1);
		const otherTools = (seen.get("乙")?.[0]?.messages[0]?.toolsAdded ?? []).map((t) => t.name);
		assert.ok(!otherTools.includes("manage_yew"));
	});

	test("settings changes always ask; widening a session must be confirmed every time and leaves a trace", async () => {
		const { store, agents, make, script, said, entries } = harness();
		const main = make("总办", { options: { permissionMode: "default" } });
		const ui = make("UI", { options: { permissionMode: "default" } });
		store.setSetting("mainSessionId", main.id);
		script(main, [
			toolUse(
				fauxToolCall(
					"manage_yew",
					{ sessions: [{ session: "UI", role: "负责界面", pinned: true }] },
					{ id: "m1" },
				),
			),
			toolUse(
				fauxToolCall(
					"manage_yew",
					{ sessions: [{ session: "UI", permission: "skip", can_post_cards: true }] },
					{ id: "m2" },
				),
			),
			fauxAssistantMessage("都改好了"),
		]);
		agents.send(main.id, "UI 管界面，给它完全授权和放卡片的权利");
		// A role change asks in the default mode, and can be always allowed for this kind.
		await until(() => store.pendingApprovals(main.id).length === 1);
		const [configure] = store.pendingApprovals(main.id);
		const first = configure?.request as PermissionRequest;
		assert.equal(first.mustConfirm, false);
		assert.deepEqual(first.rememberRules, [
			{ effect: "allow", tool: "manage_yew", pattern: "configure" },
		]);
		assert.deepEqual(first.changes, [
			{ action: "pin", session: "UI", on: true },
			{ action: "set_role", session: "UI", role: "负责界面" },
		]);
		agents.answer(configure?.id as string, { decision: "allow_always" });
		// Raising the permission mode and giving a right must be confirmed, whatever was allowed.
		await until(() =>
			store.pendingApprovals(main.id).some((approval) => approval.id !== configure?.id),
		);
		const [widen] = store.pendingApprovals(main.id);
		const second = widen?.request as PermissionRequest;
		assert.equal(second.mustConfirm, true);
		assert.deepEqual(second.reasons, ["widen-permission", "grant-rights"]);
		assert.throws(
			() => agents.answer(widen?.id as string, { decision: "allow_always" }),
			/only be allowed once/,
		);
		agents.answer(widen?.id as string, { decision: "allow_once" });
		await until(() => said(main).some((text) => text.includes("都改好了")));
		const changed = store.getSession(ui.id);
		assert.equal(changed.responsibility, "负责界面");
		assert.equal(changed.pinned, true);
		assert.equal(changed.options.permissionMode, "skip");
		assert.equal(changed.options.canPostCards, true);
		const notices = entries(ui).filter((entry) => entry.role === "notice");
		assert.equal(notices.length, 2);
		assert.match(JSON.stringify(notices[1]), /"by":"总办"/);
	});

	test("a session it creates starts with the default permission mode when that is lower than its own", async () => {
		const { store, agents, make, script, said } = harness();
		const helper = make("助手", { options: { permissionMode: "skip", canOrganize: true } });
		store.setSetting("defaultModel", {
			provider: helper.provider,
			model: helper.model,
			thinking: "off",
		});
		store.setSetting("defaultPermissionMode", "default");
		script(helper, [
			toolUse(fauxToolCall("manage_yew", { sessions: [{ name: "文档" }] }, { id: "d1" })),
			fauxAssistantMessage("好"),
		]);
		agents.send(helper.id, "开个文档会话");
		await until(() => {
			for (const approval of store.pendingApprovals(helper.id)) {
				agents.answer(approval.id, { decision: "allow_once" });
			}
			return said(helper).some((text) => text.includes('"text":"好"'));
		});
		assert.equal(store.findSessionByName("文档")?.options.permissionMode, "default");
	});

	test("a session cannot widen itself; a session it creates gets no more room than it has", async () => {
		const { store, agents, make, script, said } = harness();
		const helper = make("助手", { options: { permissionMode: "default", canOrganize: true } });
		const model = { provider: helper.provider, model: helper.model, thinking: "off" };
		store.setSetting("defaultModel", model);
		script(helper, [
			toolUse(
				fauxToolCall(
					"manage_yew",
					{ sessions: [{ session: "助手", permission: "skip" }] },
					{ id: "w1" },
				),
			),
			toolUse(
				fauxToolCall(
					"manage_yew",
					{ sessions: [{ name: "文档", role: "整理文档" }], settings: { theme: "dark" } },
					{ id: "w2" },
				),
			),
			fauxAssistantMessage("好"),
		]);
		agents.send(helper.id, "给自己完全授权，再开个文档会话");
		await until(() => store.pendingApprovals(helper.id).length === 1);
		const [create] = store.pendingApprovals(helper.id);
		assert.deepEqual((create?.request as PermissionRequest | undefined)?.changes, [
			{
				action: "create_session",
				name: "文档",
				folder: null,
				model: `${model.provider}/${model.model}`,
				team: null,
				role: "整理文档",
			},
			{ action: "set_theme", to: "dark" },
		]);
		agents.answer(create?.id as string, { decision: "allow_once" });
		await until(() => said(helper).some((text) => text.includes('"text":"好"')));
		assert.equal(store.getSession(helper.id).options.permissionMode, "default");
		const docs = store.findSessionByName("文档");
		assert.ok(docs);
		assert.equal(docs.kind, "standing");
		assert.equal(docs.options.permissionMode, "default");
		assert.equal(store.getSetting("theme", "system"), "dark");
	});

	test("a renamed or moved session hears it as an update; its prompt stays the same", async () => {
		const { store, agents, make, script, seen, said } = harness();
		const x = make("旧名");
		script(x, [fauxAssistantMessage("第一轮"), fauxAssistantMessage("第二轮")]);
		agents.send(x.id, "开始");
		await until(() => said(x).length === 1);
		await agents.whenIdle(x.id);
		const team = store.createGroup("平台");
		store.updateSession(x.id, { name: "新名", groupId: team.id });
		agents.send(x.id, "继续");
		await until(() => said(x).length === 2);
		const [first, second] = seen.get("旧名") ?? [];
		assert.equal(first?.messages[0]?.content, second?.messages[0]?.content, "same system prompt");
		const update = textOf(second?.messages.filter((m) => m.role === "system").slice(1));
		assert.match(update, /Your name is now \\"新名\\"/);
		assert.match(update, /You now belong to the team \\"平台\\"/);
	});

	test("a session started from the home page gets a short name after its first turn", async () => {
		const { store, agents, make, script, said } = harness();
		const x = make("帮我看看这个仓库里有哪些地方需要…", {
			options: { permissionMode: "default", autoName: true },
		});
		const kept = make("我起的名字", { options: { permissionMode: "default" } });
		script(x, [fauxAssistantMessage("看了，主要有三处")]);
		script(kept, [fauxAssistantMessage("好")]);
		// The naming request has a system prompt of its own, without a session's name.
		script({ name: "" } as Session, [fauxAssistantMessage("「仓库体检」")]);
		agents.send(x.id, "帮我看看这个仓库里有哪些地方需要整理");
		agents.send(kept.id, "你好");
		await until(() => store.getSession(x.id).name === "仓库体检");
		assert.equal(store.getSession(x.id).options.autoName, false);
		await until(() => said(kept).length === 1);
		await agents.whenIdle(kept.id);
		assert.equal(store.getSession(kept.id).name, "我起的名字");
	});
});

describe("deleting archived sessions", () => {
	test("archived sessions go with their data; letters they sent stay; a working one is kept", async () => {
		const { store, agents, make, script } = harness();
		const kept = make("留下的");
		const gone = make("要删的");
		const busy = make("还在干活的");
		store.appendEntry(gone.id, {
			role: "user",
			message: { role: "user", content: "可以搜到的旧消息", timestamp: Date.now() },
		});
		const letter = (from: Session, to: Session) =>
			agents.post.mail.addLetter({
				fromKind: "session",
				fromSession: from.id,
				fromName: from.name,
				toSession: to.id,
				kind: "notice",
				summary: `${from.name} 写给 ${to.name}`,
				body: "",
				status: "done",
			});
		const toGone = letter(kept, gone);
		const fromGone = letter(gone, kept);
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		script(busy, [
			async () => {
				await gate;
				return fauxAssistantMessage("做完了");
			},
		]);
		agents.send(busy.id, "开始");
		await until(() => agents.isRunning(busy.id));
		store.updateSession(gone.id, { archived: true });
		store.updateSession(busy.id, { archived: true });
		assert.equal(store.search("可以搜到", 10).hits.length, 1);

		assert.deepEqual(agents.deleteArchived(), [gone.id]);
		assert.throws(() => store.getSession(gone.id));
		assert.equal(store.search("可以搜到", 10).hits.length, 0);
		assert.throws(() => agents.post.mail.getLetter(toGone.id));
		assert.equal(agents.post.mail.getLetter(fromGone.id).fromSession, null);
		assert.equal(agents.post.mail.getLetter(fromGone.id).fromName, "要删的");
		assert.equal(store.getSession(busy.id).archivedAt !== null, true, "still working, so kept");
		assert.equal(store.getSession(kept.id).name, "留下的");
		release();
		await agents.whenIdle(busy.id);
	});
});
