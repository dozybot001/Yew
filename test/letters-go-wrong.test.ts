import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "../src/server/model/testing.ts";
import type { Letter, Session } from "../src/shared/types.ts";
import { type Context, harness, lastTool, textOf, toolUse, until } from "./helpers/letters.ts";
import { tempDir } from "./helpers/store.ts";

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
