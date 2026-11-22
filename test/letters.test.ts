import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { PostOffice } from "../src/server/mail/post.ts";
import { fauxAssistantMessage, fauxToolCall } from "../src/server/model/testing.ts";
import type { Session } from "../src/shared/types.ts";
import { harness, lastTool, textOf, toolUse, until } from "./helpers/letters.ts";
import { tempDir } from "./helpers/store.ts";

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
