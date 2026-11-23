import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { SUMMARY_HEADING, YEW_NOTE } from "../src/server/agent/context.ts";
import { instructionsUpdate, SUMMARY_PROMPT } from "../src/server/agent/prompt.ts";
import { CARD_NOTE, questionFrom } from "../src/server/agent/reply-question.ts";
import { fauxAssistantMessage, fauxToolCall } from "../src/server/model/testing.ts";
import { choicesFrom } from "../src/server/tools/misc.ts";
import { ALL_TOOLS } from "../src/server/tools/registry.ts";
import { type ToolDefinition, text } from "../src/server/tools/types.ts";
import { defaultCompactAt, type Entry, type PermissionRequest } from "../src/shared/types.ts";
import { setup } from "./helpers/agent.ts";
import { tempDir } from "./helpers/store.ts";

async function until(check: () => boolean, ms = 3000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > ms) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

const roles = (entries: Entry[]) => entries.map((entry) => entry.role);
const textOf = (value: unknown) => JSON.stringify(value);
const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) =>
	fauxAssistantMessage(calls, { stopReason: "toolUse" });

describe("agent loop", () => {
	test("a message gets a streamed reply; the session ends idle and unread", async () => {
		const { faux, store, agents, session } = setup();
		faux.setResponses([fauxAssistantMessage("你好，我在。")]);
		const sent = agents.send(session.id, "你好");
		assert.ok("entry" in sent);
		await agents.whenIdle(session.id);
		const { entries } = store.listEntries(session.id, { limit: 50 });
		assert.deepEqual(roles(entries), ["user", "assistant"]);
		const after = store.getSession(session.id);
		assert.equal(after.status, "idle");
		assert.equal(after.unread, 1);
	});

	test("tool calls run, their results go back to the model, then it answers", async () => {
		const { faux, store, agents, session, cwd, contexts, capture } = setup();
		writeFileSync(join(cwd, "a.txt"), "alpha\n");
		faux.setResponses([
			toolUse(
				fauxToolCall("read", { path: "a.txt" }, { id: "c1" }),
				fauxToolCall("glob", { pattern: "*.txt" }, { id: "c2" }),
			),
			capture(fauxAssistantMessage("It says alpha.")),
		]);
		agents.send(session.id, "What is in a.txt?");
		await agents.whenIdle(session.id);
		const { entries } = store.listEntries(session.id, { limit: 50 });
		assert.deepEqual(roles(entries), [
			"user",
			"assistant",
			"toolResult",
			"toolResult",
			"assistant",
		]);
		const last = contexts[0]?.messages ?? [];
		assert.match(textOf(last.at(-2)), /alpha/);
		const calls = store.toolCallsForMessages([entries[1]?.id as string]);
		assert.deepEqual(
			calls.map((call) => call.status),
			["done", "done"],
		);
	});

	test("a running call can ask the person for what it needs; a card whose need has passed is withdrawn", async () => {
		const answers: boolean[] = [];
		let pending: () => number = () => 0;
		const request: PermissionRequest = {
			tool: "shell",
			summary: "example.com:443",
			mustConfirm: false,
			reasons: ["connect-site"],
		};
		// Like a command in the sandbox that wants to reach a site, then another while it runs.
		const needs: ToolDefinition = {
			name: "needs_site",
			description: "Connects to two sites.",
			parameters: { type: "object", properties: {} },
			readOnly: false,
			needsFolder: false,
			subject: () => ({ kind: "none" }),
			async run(_args, ctx) {
				answers.push((await ctx.permit?.(request)) ?? false);
				const ended = new AbortController();
				const second = ctx.permit?.({ ...request, summary: "example.org:443" }, ended.signal);
				await until(() => pending() === 1);
				ended.abort();
				answers.push((await second) ?? false);
				return { content: [text("connected")] };
			},
		};
		const { faux, store, agents, session } = setup({ tools: [...ALL_TOOLS, needs] });
		pending = () => store.pendingApprovals(session.id).length;
		faux.setResponses([
			toolUse(fauxToolCall("needs_site", {}, { id: "c1" })),
			fauxAssistantMessage("Done."),
		]);
		agents.send(session.id, "connect");
		await until(() => pending() === 1);
		const [card] = store.pendingApprovals(session.id);
		assert.ok(card);
		assert.equal(card.kind, "permission");
		assert.equal((card.request as PermissionRequest).summary, "example.com:443");
		assert.equal(store.getSession(session.id).status, "waiting");
		agents.answer(card.id, { decision: "allow_once" });
		await agents.whenIdle(session.id);
		assert.deepEqual(answers, [true, false]);
		const all = store.approvalsForToolCalls([card.toolCallId as string]);
		assert.deepEqual(
			all.map((approval) => approval.status),
			["resolved", "cancelled"],
		);
		assert.equal(store.getSession(session.id).status, "idle");
	});

	test("an operation that needs approval waits; a refusal with a reason reaches the model", async () => {
		const { faux, store, agents, session, cwd, contexts, capture } = setup();
		faux.setResponses([
			toolUse(fauxToolCall("shell", { command: "touch made.txt", confirm: true }, { id: "c1" })),
			capture(fauxAssistantMessage("OK, I will not.")),
		]);
		agents.send(session.id, "make a file");
		await until(() => store.pendingApprovals(session.id).length === 1);
		assert.equal(store.getSession(session.id).status, "waiting");
		const [approval] = store.pendingApprovals(session.id);
		agents.answer(approval?.id as string, { decision: "deny", reason: "不要建文件" });
		await agents.whenIdle(session.id);
		assert.equal(existsSync(join(cwd, "made.txt")), false);
		assert.match(textOf(contexts[0]?.messages.at(-1)), /不要建文件/);
		assert.equal(store.getSession(session.id).status, "idle");
	});

	test("allow and remember adds a rule; must-confirm operations can only be allowed once", async () => {
		const { faux, store, agents, session, cwd } = setup();
		writeFileSync(join(cwd, "old.txt"), "x");
		faux.setResponses([
			toolUse(fauxToolCall("shell", { command: "touch made.txt", confirm: true }, { id: "c1" })),
			toolUse(fauxToolCall("shell", { command: "rm old.txt" }, { id: "c2" })),
			fauxAssistantMessage("Done."),
		]);
		agents.send(session.id, "go");
		await until(() => store.pendingApprovals(session.id).length === 1);
		agents.answer(store.pendingApprovals(session.id)[0]?.id as string, {
			decision: "allow_always",
		});
		await until(
			() => store.pendingApprovals(session.id).length === 1 && existsSync(join(cwd, "made.txt")),
		);
		assert.deepEqual(store.getSession(session.id).rules, [
			{ effect: "allow", tool: "shell", pattern: "touch" },
		]);
		const confirm = store.pendingApprovals(session.id)[0];
		assert.ok(confirm);
		assert.equal((confirm.request as { mustConfirm: boolean }).mustConfirm, true);
		assert.throws(
			() => agents.answer(confirm?.id as string, { decision: "allow_always" }),
			/only be allowed once/,
		);
		agents.answer(confirm?.id as string, { decision: "allow_once" });
		await agents.whenIdle(session.id);
		assert.equal(existsSync(join(cwd, "old.txt")), false);
	});

	test("in skip mode a commit and a push run on their own; the push is marked as risky", async () => {
		const { faux, store, agents, session, cwd } = setup();
		store.updateSession(session.id, { options: { permissionMode: "skip" } });
		const git = (...args: string[]) =>
			execFileSync("git", args, {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}).trim();
		const remote = realpathSync(tempDir("yew-remote-"));
		execFileSync("git", ["init", "-q", "--bare", remote]);
		git("init", "-q", "-b", "main");
		git("remote", "add", "origin", remote);
		writeFileSync(join(cwd, "a.txt"), "a\n");
		const commit =
			'git add -A && git -c user.name=Yew -c user.email=yew@example.com -c commit.gpgsign=false commit -qm "加 a.txt"';
		faux.setResponses([
			toolUse(fauxToolCall("shell", { command: commit }, { id: "c1" })),
			toolUse(fauxToolCall("shell", { command: "git push -q origin main" }, { id: "c2" })),
			fauxAssistantMessage("已提交并推送。"),
		]);
		agents.send(session.id, "改好了就提交、推送");
		await agents.whenIdle(session.id);
		assert.deepEqual(store.pendingApprovals(session.id), []);
		const pushed = execFileSync("git", ["--git-dir", remote, "rev-parse", "main"], {
			encoding: "utf8",
		}).trim();
		assert.equal(pushed, git("rev-parse", "HEAD"));
		// The row says it ran without asking and why it is risky.
		const push = store.toolCallsByStatus(session.id, ["done"]).find((call) => call.callId === "c2");
		assert.deepEqual(push?.detail?.permission, { risk: ["push"] });
	});

	test("skip mode asks about no permission: what cannot be taken back runs and is marked", async () => {
		const { faux, store, agents, session } = setup();
		store.updateSession(session.id, { options: { permissionMode: "skip" } });
		// Outside the working folder, where git cannot bring a file back.
		const elsewhere = realpathSync(tempDir("yew-elsewhere-"));
		writeFileSync(join(elsewhere, "old.txt"), "old\n");
		faux.setResponses([
			toolUse(fauxToolCall("shell", { command: `rm ${join(elsewhere, "old.txt")}` }, { id: "c1" })),
			fauxAssistantMessage("删掉了。"),
		]);
		agents.send(session.id, "把那个旧文件删了");
		await agents.whenIdle(session.id);
		assert.deepEqual(store.pendingApprovals(session.id), []);
		assert.equal(existsSync(join(elsewhere, "old.txt")), false);
		const removed = store
			.toolCallsByStatus(session.id, ["done"])
			.find((call) => call.callId === "c1");
		assert.deepEqual(removed?.detail?.permission, { risk: ["delete-outside"] });
	});

	test("in the default mode what cannot be taken back waits for the person, marked as such", async () => {
		const { faux, store, agents, session } = setup();
		store.updateSession(session.id, { options: { permissionMode: "default" } });
		faux.setResponses([
			toolUse(fauxToolCall("shell", { command: "ssh deploy@example.com true" }, { id: "c1" })),
			fauxAssistantMessage("好，不连了。"),
		]);
		agents.send(session.id, "去服务器上看看");
		await until(() => store.pendingApprovals(session.id).length === 1);
		const [card] = store.pendingApprovals(session.id);
		assert.ok(card);
		const request = card.request as PermissionRequest;
		assert.equal(request.matter, true);
		assert.deepEqual(request.reasons, ["remote-machine"]);
		agents.answer(card.id, { decision: "deny" });
		await agents.whenIdle(session.id);
	});

	test("a permission request shows what the call is for and the change it would make", async () => {
		const { faux, store, agents, session, cwd } = setup();
		store.updateSession(session.id, { options: { permissionMode: "default" } });
		writeFileSync(join(cwd, "a.txt"), "one\ntwo\n");
		// The session asks for the person's permission itself, with confirm.
		faux.setResponses([
			toolUse(fauxToolCall("read", { path: "a.txt" }, { id: "r1" })),
			toolUse(
				fauxToolCall(
					"edit",
					{ path: "a.txt", old_text: "two", new_text: "deux", confirm: true },
					{ id: "e1" },
				),
			),
			toolUse(
				fauxToolCall(
					"shell",
					{ command: "touch b.txt", description: "建一个空文件", confirm: true },
					{ id: "s1" },
				),
			),
			fauxAssistantMessage("好了"),
		]);
		agents.send(session.id, "改一下");
		await until(() => store.pendingApprovals(session.id).length === 1);
		const [edit] = store.pendingApprovals(session.id);
		assert.ok(edit);
		const request = edit.request as PermissionRequest;
		assert.equal(request.summary, "a.txt");
		// The change itself, without a file header: the card names the file above it.
		assert.match(request.diff ?? "", /^@@ -1,2 \+1,2 @@\n one\n-two\n\+deux/);
		assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "one\ntwo\n");
		agents.answer(edit.id, { decision: "allow_once" });
		await until(() => store.pendingApprovals(session.id).some((a) => a.id !== edit.id));
		const [shell] = store.pendingApprovals(session.id);
		assert.ok(shell);
		assert.equal((shell.request as PermissionRequest).description, "建一个空文件");
		agents.answer(shell.id, { decision: "allow_once" });
		await agents.whenIdle(session.id);
		assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "one\ndeux\n");
		assert.ok(existsSync(join(cwd, "b.txt")));
	});

	test("ask_user puts several questions on one card; the answer reads as options and own words", async () => {
		const { faux, store, agents, session, contexts, capture } = setup();
		faux.setResponses([
			toolUse(
				fauxToolCall(
					"ask_user",
					{
						questions: [
							{
								question: "按钮用什么颜色？",
								header: "颜色",
								options: [
									{ label: "深灰", detail: "和侧栏一致" },
									{ label: "黑色", detail: "对比最强" },
								],
								recommended: 1,
							},
							{
								question: "放在哪儿？",
								options: ["左上角", "右上角", "底部"],
								multiple: true,
							},
						],
					},
					{ id: "q1" },
				),
			),
			capture(fauxAssistantMessage("好")),
		]);
		agents.send(session.id, "做个按钮");
		await until(() => store.pendingApprovals(session.id).length === 1);
		const [card] = store.pendingApprovals(session.id);
		assert.ok(card);
		assert.deepEqual(card.request, {
			questions: [
				{
					question: "按钮用什么颜色？",
					header: "颜色",
					options: [
						{ label: "深灰", detail: "和侧栏一致" },
						{ label: "黑色", detail: "对比最强" },
					],
					recommended: 0,
				},
				{
					question: "放在哪儿？",
					options: [{ label: "左上角" }, { label: "右上角" }, { label: "底部" }],
					multiple: true,
				},
			],
		});
		const code = (fn: () => unknown) => {
			try {
				fn();
				return "ok";
			} catch (error) {
				return (error as { code?: string }).code;
			}
		};
		// Every question needs an answer; a single-choice question takes one option.
		assert.equal(
			code(() => agents.answer(card.id, { answers: [{ choices: [0] }] })),
			"invalid-request",
		);
		assert.equal(
			code(() => agents.answer(card.id, { answers: [{ choices: [0, 1] }, { choices: [0] }] })),
			"invalid-request",
		);
		assert.equal(
			code(() => agents.answer(card.id, { answers: [{ choices: [0] }, { choices: [] }] })),
			"invalid-request",
		);
		const resolved = agents.answer(card.id, {
			answers: [{ choices: [0], text: "稍微浅一点" }, { choices: [0, 2] }],
		});
		assert.deepEqual(resolved.response?.answers, [
			{ choices: [0], text: "稍微浅一点" },
			{ choices: [0, 2] },
		]);
		await agents.whenIdle(session.id);
		const result = textOf(contexts[0]?.messages.at(-1));
		assert.match(
			result,
			/The person answered:\\n1\. 按钮用什么颜色？ → 深灰; 稍微浅一点\\n2\. 放在哪儿？ → 左上角, 底部/,
		);
	});

	test("a question asked the old way still takes a plain answer", async () => {
		const { faux, store, agents, session, contexts, capture } = setup();
		faux.setResponses([
			toolUse(
				fauxToolCall("ask_user", { question: "继续吗？", options: ["继续", "停下"] }, { id: "q1" }),
			),
			capture(fauxAssistantMessage("好")),
		]);
		agents.send(session.id, "试试");
		await until(() => store.pendingApprovals(session.id).length === 1);
		const [card] = store.pendingApprovals(session.id);
		assert.ok(card);
		assert.deepEqual(card.request, {
			questions: [{ question: "继续吗？", options: [{ label: "继续" }, { label: "停下" }] }],
		});
		agents.answer(card.id, { answer: "先停一下" });
		await agents.whenIdle(session.id);
		assert.match(textOf(contexts[0]?.messages.at(-1)), /The person answered: 先停一下/);
	});

	test("what a model made of the end of a reply is checked: it asks, and says what", () => {
		assert.deepEqual(questionFrom('{"asks":true,"question":"要推到两个仓库吗？","options":[]}'), {
			question: "要推到两个仓库吗？",
		});
		assert.deepEqual(
			questionFrom(
				'```json\n{"asks":true,"question":"Push it?","options":[{"label":"Push it"},{"label":"Not now"}],"recommended":1}\n```',
			),
			{
				question: "Push it?",
				options: [{ label: "Push it" }, { label: "Not now" }],
				recommended: 0,
			},
		);
		assert.equal(questionFrom('{"asks":false}'), null);
		assert.equal(questionFrom('{"asks":false,"question":"要推吗？"}'), null);
		assert.equal(questionFrom('{"asks":true,"question":"  "}'), null);
		assert.equal(questionFrom('{"asks":"yes","question":"要推吗？"}'), null);
		assert.equal(questionFrom("收到。"), null);
		assert.equal(questionFrom('{"asks":true,"question":"要推吗'), null);
	});

	test("a question at the end of a reply goes to the approval center with choices, and the session is told; picking one continues it", async () => {
		const { faux, store, agents, session, contexts, capture } = setup({ readReplies: true });
		faux.setResponses([
			fauxAssistantMessage("改好了，检查都通过。\n\n没有推送。要推到 Gitee 和 GitHub 吗？"),
			// Apart from the conversation, a model reads the end of the reply.
			capture(
				fauxAssistantMessage(
					'{"asks":true,"question":"改好了，还没有推送。要推到 Gitee 和 GitHub 吗？","options":[{"label":"推送","detail":"推到两个仓库"},{"label":"先不推"}],"recommended":1}',
				),
			),
			capture(fauxAssistantMessage("好，推送了。")),
		]);
		agents.send(session.id, "改一下按钮");
		await agents.whenIdle(session.id);
		await until(() => store.pendingApprovals(session.id).length === 1);
		const [card] = store.pendingApprovals(session.id);
		assert.ok(card);
		assert.equal(card.toolCallId, null);
		assert.equal(store.getSession(session.id).status, "waiting");
		assert.deepEqual(card.request, {
			questions: [
				{
					question: "改好了，还没有推送。要推到 Gitee 和 GitHub 吗？",
					options: [{ label: "推送", detail: "推到两个仓库" }, { label: "先不推" }],
					recommended: 0,
				},
			],
			fromReply: true,
		});
		// It was read with the end of the reply alone, not with the conversation.
		const read = contexts[0]?.messages.filter((message) => message.role === "user") ?? [];
		assert.equal(read.length, 1);
		assert.match(textOf(read[0]), /"The end of the reply:\\n改好了，检查都通过。/);
		// The session is told, in Yew's words and not as a message of the person's.
		const told = store.contextEntries(session.id).at(-1);
		assert.equal(told?.role, "system");
		const note = told?.role === "system" ? String(told.message.content) : "";
		// In fixed words: nothing the reading model wrote is in a system message.
		assert.equal(note, CARD_NOTE);
		assert.doesNotMatch(note, /推送|Gitee|推到两个仓库/);
		agents.answer(card.id, { answers: [{ choices: [0] }] });
		await agents.whenIdle(session.id);
		const next = contexts[1]?.messages ?? [];
		assert.match(textOf(next.at(-1)), /"推送"/);
		assert.match(textOf(next.at(-2)), /approval center as a card/);
		await until(
			() => faux.getPendingResponseCount() === 0 || store.getSession(session.id).status === "idle",
		);
		assert.equal(store.pendingApprovals(session.id).length, 0);
	});

	test("a reply that asks nothing leaves no card; a question without fixed answers is answered in the person's words", async () => {
		const { faux, store, agents, session, contexts, capture } = setup({ readReplies: true });
		faux.setResponses([
			fauxAssistantMessage("做完了，测试都通过。需要别的再说。"),
			fauxAssistantMessage('{"asks":false}'),
		]);
		agents.send(session.id, "跑一下测试");
		await agents.whenIdle(session.id);
		await until(() => faux.getPendingResponseCount() === 0);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(store.pendingApprovals(session.id).length, 0);
		assert.equal(store.getSession(session.id).status, "idle");
		assert.equal(store.contextEntries(session.id).at(-1)?.role, "assistant");

		faux.setResponses([
			fauxAssistantMessage("新的会话叫什么名字？"),
			fauxAssistantMessage('{"asks":true,"question":"新的会话叫什么名字？","options":[]}'),
			capture(fauxAssistantMessage("好，建好了。")),
			fauxAssistantMessage('{"asks":false}'),
		]);
		agents.send(session.id, "建一个会话");
		await agents.whenIdle(session.id);
		await until(() => store.pendingApprovals(session.id).length === 1);
		const [card] = store.pendingApprovals(session.id);
		assert.ok(card);
		assert.deepEqual(card.request, {
			questions: [{ question: "新的会话叫什么名字？" }],
			fromReply: true,
		});
		const told = store.contextEntries(session.id).at(-1);
		assert.equal(told?.role === "system" ? told.message.content : "", CARD_NOTE);
		agents.answer(card.id, { answers: [{ choices: [], text: "官网" }] });
		await agents.whenIdle(session.id);
		assert.match(textOf(contexts[0]?.messages.at(-1)), /官网/);
		await until(() => faux.getPendingResponseCount() === 0);
		await until(() => store.getSession(session.id).status === "idle");
	});

	test("writing to the session while its reply is read stops the reading, and withdraws a card that is there", async () => {
		const { faux, store, agents, session } = setup({ readReplies: true });
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached: () => void = () => {};
		const reading = new Promise<void>((resolve) => {
			reached = resolve;
		});
		faux.setResponses([
			fauxAssistantMessage("要现在推送吗？"),
			async () => {
				reached();
				await held;
				return fauxAssistantMessage('{"asks":true,"question":"要现在推送吗？","options":[]}');
			},
			fauxAssistantMessage("好，先不推。"),
			fauxAssistantMessage('{"asks":true,"question":"那什么时候推？","options":[]}'),
			fauxAssistantMessage("明白。"),
			fauxAssistantMessage('{"asks":false}'),
		]);
		agents.send(session.id, "改一下按钮");
		await agents.whenIdle(session.id);
		// The person writes before the reading is done: no card comes of it.
		await reading;
		agents.send(session.id, "先别推");
		release();
		await agents.whenIdle(session.id);
		await until(() => store.pendingApprovals(session.id).length === 1);
		const [card] = store.pendingApprovals(session.id);
		assert.deepEqual(card?.request, {
			questions: [{ question: "那什么时候推？" }],
			fromReply: true,
		});
		// The person writes instead of answering the card: it is withdrawn.
		agents.send(session.id, "下周");
		assert.equal(store.pendingApprovals(session.id).length, 0);
		assert.equal(store.getApproval(card?.id ?? "").status, "cancelled");
		await agents.whenIdle(session.id);
		await until(() => faux.getPendingResponseCount() === 0);
	});

	test("choices a model wrote are checked: two at least, six at most, the recommended one among them", () => {
		assert.deepEqual(
			choicesFrom(
				'好的：\n```json\n{"options":["推送",{"label":" 先不推 "}],"recommended":2}\n```',
			),
			{
				options: [{ label: "推送" }, { label: "先不推" }],
				recommended: 1,
			},
		);
		assert.deepEqual(choicesFrom('{"options":["a","b"],"recommended":3}'), {
			options: [{ label: "a" }, { label: "b" }],
		});
		assert.equal(choicesFrom('{"options":["1","2","3","4","5","6","7"]}')?.options?.length, 6);
		assert.equal(choicesFrom('{"options":["只有一个"]}'), null);
		assert.equal(choicesFrom('{"options":[]}'), null);
		assert.equal(choicesFrom('{"options":["a",{"label":""}]}'), null);
		assert.equal(choicesFrom("推送，还是先不推？"), null);
		assert.equal(choicesFrom('{"options":["a","b"'), null);
	});

	test("a letter that arrives while a reply is read waits: for the person when the reply asks, else for the reading", async () => {
		const gate = () => {
			let open: () => void = () => {};
			const opened = new Promise<void>((resolve) => {
				open = resolve;
			});
			return { open, opened };
		};
		const letter = (agents: ReturnType<typeof setup>["agents"], to: string) =>
			agents.post.send({ kind: "cli" }, { to, kind: "notice", summary: "构建好了" });

		// The reply asks: the letter waits with the session until the person has answered.
		const asks = setup({ readReplies: true });
		const reading = gate();
		const held = gate();
		asks.faux.setResponses([
			fauxAssistantMessage("要现在推送吗？"),
			async () => {
				reading.open();
				await held.opened;
				return fauxAssistantMessage('{"asks":true,"question":"要现在推送吗？","options":[]}');
			},
			asks.capture(fauxAssistantMessage("推送了，也看到构建好了。")),
		]);
		asks.agents.send(asks.session.id, "改一下按钮");
		await asks.agents.whenIdle(asks.session.id);
		await reading.opened;
		letter(asks.agents, asks.session.id);
		assert.equal(
			asks.agents.isRunning(asks.session.id),
			false,
			"not started while the reply is read",
		);
		held.open();
		await until(() => asks.store.pendingApprovals(asks.session.id).length === 1);
		assert.equal(asks.agents.isRunning(asks.session.id), false);
		assert.equal(asks.agents.post.mail.queuedFor(asks.session.id).length, 1);
		const [card] = asks.store.pendingApprovals(asks.session.id);
		asks.agents.answer(card?.id ?? "", { answers: [{ choices: [], text: "推" }] });
		await asks.agents.whenIdle(asks.session.id);
		assert.match(textOf(asks.contexts[0]?.messages), /构建好了/);
		assert.equal(asks.agents.post.mail.queuedFor(asks.session.id).length, 0);

		// The reply asks nothing: the letter starts the session once that is known.
		const plain = setup({ readReplies: true });
		const reading2 = gate();
		const held2 = gate();
		plain.faux.setResponses([
			fauxAssistantMessage("做完了，测试都通过。"),
			async () => {
				reading2.open();
				await held2.opened;
				return fauxAssistantMessage('{"asks":false}');
			},
			plain.capture(fauxAssistantMessage("看到了，构建好了。")),
		]);
		plain.agents.send(plain.session.id, "跑一下测试");
		await plain.agents.whenIdle(plain.session.id);
		await reading2.opened;
		letter(plain.agents, plain.session.id);
		assert.equal(plain.agents.isRunning(plain.session.id), false);
		held2.open();
		await until(() => plain.contexts.length === 1);
		await plain.agents.whenIdle(plain.session.id);
		assert.match(textOf(plain.contexts[0]?.messages), /构建好了/);
		assert.equal(plain.store.pendingApprovals(plain.session.id).length, 0);
	});

	test("replies of a chat and of the main conversation are not read for a question", async () => {
		// A chat without a working folder talks with the person; its questions stay in the conversation.
		const chat = setup({ cwd: false, readReplies: true });
		chat.faux.setResponses([
			fauxAssistantMessage("你好！今天想聊点什么？"),
			fauxAssistantMessage('{"asks":true,"question":"今天想聊点什么？","options":[]}'),
		]);
		chat.agents.send(chat.session.id, "你好");
		await chat.agents.whenIdle(chat.session.id);
		// The main conversation asks with cards of its own.
		const main = setup({ readReplies: true });
		main.store.setSetting("mainSessionId", main.session.id);
		main.faux.setResponses([
			fauxAssistantMessage("要现在推送吗？"),
			fauxAssistantMessage('{"asks":true,"question":"要现在推送吗？","options":[]}'),
		]);
		main.agents.send(main.session.id, "改一下");
		await main.agents.whenIdle(main.session.id);
		await new Promise((resolve) => setTimeout(resolve, 20));
		for (const { faux, store, session } of [chat, main]) {
			assert.equal(faux.getPendingResponseCount(), 1, "no model was asked about the reply");
			assert.equal(store.pendingApprovals(session.id).length, 0);
			assert.equal(store.getSession(session.id).status, "idle");
		}
	});

	test("stopping while waiting cancels the approval and leaves a valid transcript", async () => {
		const { faux, store, agents, session, contexts, capture } = setup();
		faux.setResponses([
			toolUse(fauxToolCall("shell", { command: "touch x", confirm: true }, { id: "c1" })),
			capture(fauxAssistantMessage("Hello again.")),
		]);
		agents.send(session.id, "go");
		await until(() => store.pendingApprovals(session.id).length === 1);
		const approvalId = store.pendingApprovals(session.id)[0]?.id as string;
		agents.stop(session.id);
		await agents.whenIdle(session.id);
		assert.equal(store.getApproval(approvalId).status, "cancelled");
		assert.equal(store.getSession(session.id).status, "idle");
		agents.send(session.id, "hello?");
		await agents.whenIdle(session.id);
		const messages = contexts[0]?.messages.filter((m) => m.role !== "system") ?? [];
		assert.deepEqual(
			messages.map((m) => m.role),
			["user", "assistant", "toolResult", "user"],
		);
		assert.match(textOf(messages[2]), /stopped before the person decided/);
	});

	test("a message sent while the session works waits and arrives after the tool results", async () => {
		const { faux, store, agents, session, contexts, capture } = setup();
		faux.setResponses([
			toolUse(fauxToolCall("shell", { command: "touch y", confirm: true }, { id: "c1" })),
			capture(fauxAssistantMessage("Got both.")),
		]);
		agents.send(session.id, "first");
		await until(() => store.pendingApprovals(session.id).length === 1);
		const queued = agents.send(session.id, "补充一句");
		assert.ok("queued" in queued);
		agents.answer(store.pendingApprovals(session.id)[0]?.id as string, { decision: "allow_once" });
		await agents.whenIdle(session.id);
		const messages = contexts[0]?.messages.filter((m) => m.role !== "system") ?? [];
		assert.deepEqual(
			messages.map((m) => m.role),
			["user", "assistant", "toolResult", "user"],
		);
		assert.match(textOf(messages[3]), /补充一句/);
		assert.deepEqual(store.listQueue(session.id), []);
	});

	test("the default compaction threshold is 80% of the model's window, at most 200,000 tokens", () => {
		assert.equal(defaultCompactAt(128_000), 102_400);
		assert.equal(defaultCompactAt(200_000), 160_000);
		assert.equal(defaultCompactAt(375_000), 200_000);
		assert.equal(defaultCompactAt(1_000_000), 200_000);
	});

	test("near the context limit, older history is summarized and the model sees the summary", async () => {
		const { faux, store, agents, session, contexts, capture } = setup();
		store.updateSession(session.id, { options: { compactAt: 10_000 } });
		const big = "历史记录 ".repeat(25_000);
		for (let i = 0; i < 2; i++) {
			store.appendEntry(session.id, {
				role: "user",
				message: { role: "user", content: big, timestamp: 1 },
			});
			store.appendEntry(session.id, {
				role: "assistant",
				message: { ...fauxAssistantMessage("old reply"), timestamp: 1 },
			});
		}
		store.setContextTokens(session.id, 60_000);
		const asked: { context: string; cache: unknown }[] = [];
		faux.setResponses([
			(context, options) => {
				asked.push({ context: textOf(context), cache: options?.cacheRetention });
				return fauxAssistantMessage("The person asked about history.");
			},
			capture(fauxAssistantMessage("Continuing.")),
		]);
		agents.send(session.id, "继续");
		await agents.whenIdle(session.id);
		const compaction = store
			.listEntries(session.id, { limit: 50 })
			.entries.find((entry) => entry.role === "compaction");
		assert.ok(compaction?.role === "compaction");
		// The last reply is old, so the provider holds no prompt cache: the history goes as a transcript,
		// and nothing is written to the cache for a prompt that is not sent again.
		assert.equal(asked.length, 1);
		assert.ok(asked[0]?.context.includes(SUMMARY_PROMPT.slice(0, 60)));
		assert.match(asked[0]?.context ?? "", /## Person\\n历史记录/);
		assert.equal(asked[0]?.cache, "none");
		const messages = contexts[0]?.messages.filter((m) => m.role !== "system") ?? [];
		assert.match(textOf(messages[0]), new RegExp(SUMMARY_HEADING.slice(1, 20)));
		assert.match(textOf(messages.at(-1)), /继续/);
		assert.ok(store.getSession(session.id).contextTokens < 10_000);
	});

	/**
	 * A first turn with a long message and a fresh reply, then a context that is due for a summary. The
	 * model reads a cached prompt at a tenth of the price of input, unless `cost` says otherwise.
	 */
	async function dueForSummary(
		first: Parameters<ReturnType<typeof setup>["capture"]>[0],
		cost = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	) {
		const made = setup({ cost });
		const { faux, store, agents, session, capture } = made;
		store.updateSession(session.id, { options: { compactAt: 10_000 } });
		faux.setResponses([capture(first)]);
		agents.send(session.id, `读一下这些记录：${"历史记录 ".repeat(15_000)}`);
		await agents.whenIdle(session.id);
		store.setContextTokens(session.id, 60_000);
		return made;
	}

	test("while the session's prompt cache is fresh, the summary is asked for in its own conversation", async () => {
		const { faux, store, agents, session, contexts, capture } = await dueForSummary(
			fauxAssistantMessage("读完了，一共一万五千条。"),
		);
		const options: { cacheRetention?: string; sessionId?: string }[] = [];
		faux.setResponses([
			(context, asked) => {
				contexts.push(structuredClone(context) as (typeof contexts)[number]);
				options.push({ ...asked });
				return fauxAssistantMessage("<summary>\nThe person had 15,000 records read.\n</summary>");
			},
			capture(fauxAssistantMessage("接着做。")),
		]);
		agents.send(session.id, "继续");
		await agents.whenIdle(session.id);

		const [first, summary, next] = contexts;
		// The same prompt and tools, and the same conversation with what came after it: a prefix the
		// provider has in its cache. Only the last message is new.
		assert.equal(textOf(summary?.messages[0]), textOf(first?.messages[0]));
		assert.equal(textOf(summary?.messages[1]), textOf(first?.messages[1]));
		assert.deepEqual(
			summary?.messages.map((m) => m.role),
			["system", "user", "assistant", "user", "user"],
		);
		const ask = String(summary?.messages.at(-1)?.content);
		assert.ok(ask.startsWith(`${YEW_NOTE} Yew is about to remove the earlier part`));
		assert.match(ask, /call no tool/);
		assert.equal(options[0]?.cacheRetention, "short");
		assert.equal(options[0]?.sessionId, session.id);

		const entries = store.listEntries(session.id, { limit: 50 }).entries;
		const compaction = entries.find((entry) => entry.role === "compaction");
		assert.ok(compaction?.role === "compaction");
		assert.equal(compaction.compaction.summary, "The person had 15,000 records read.");
		// The instruction was part of that one request only: it is not in the record or the next request.
		assert.ok(!entries.some((entry) => textOf(entry).includes("Yew is about to remove")));
		const after = next?.messages.filter((m) => m.role !== "system") ?? [];
		assert.match(textOf(after[0]), /The person had 15,000 records read\./);
		assert.match(textOf(after.at(-1)), /继续/);
		assert.ok(!textOf(after).includes("Yew is about to remove"));
	});

	test("a reply that goes on with the work is no summary: the history then goes as a transcript", async () => {
		const goingOn = [
			toolUse(fauxToolCall("read", { path: "records.txt" }, { id: "r1" })),
			fauxAssistantMessage("我接着读 records.txt。"),
		];
		for (const reply of goingOn) {
			const { faux, store, agents, session, contexts, capture } = await dueForSummary(
				fauxAssistantMessage("读完了，一共一万五千条。"),
			);
			const caches: unknown[] = [];
			const noting =
				(answer: ReturnType<typeof fauxAssistantMessage>) =>
				(context: unknown, options: { cacheRetention?: string } | undefined) => {
					contexts.push(structuredClone(context) as (typeof contexts)[number]);
					caches.push(options?.cacheRetention);
					return answer;
				};
			faux.setResponses([
				noting(reply),
				noting(fauxAssistantMessage("The person had 15,000 records read.")),
				capture(fauxAssistantMessage("接着做。")),
			]);
			agents.send(session.id, "继续");
			await agents.whenIdle(session.id);

			const [, inPlace, transcript] = contexts;
			assert.match(String(inPlace?.messages.at(-1)?.content), /Yew is about to remove/);
			assert.ok(textOf(transcript?.messages[0]).includes(SUMMARY_PROMPT.slice(0, 60)));
			assert.match(textOf(transcript?.messages[1]), /## Person\\n读一下这些记录/);
			assert.deepEqual(caches, ["short", "none"]);
			const entries = store.listEntries(session.id, { limit: 50 }).entries;
			const compaction = entries.find((entry) => entry.role === "compaction");
			assert.ok(compaction?.role === "compaction");
			assert.equal(compaction.compaction.summary, "The person had 15,000 records read.");
			// What that reply said or called did not run and left nothing in the record.
			assert.ok(!entries.some((entry) => entry.role === "toolResult"));
			assert.ok(!textOf(entries).includes("records.txt"));
			assert.equal(store.getSession(session.id).status, "idle");
		}
	});

	test("a model without a lower price for cached prompts gets the shorter transcript", async () => {
		const { faux, store, agents, session, contexts, capture } = await dueForSummary(
			fauxAssistantMessage("读完了，一共一万五千条。"),
			{ input: 5, output: 25, cacheRead: 0, cacheWrite: 0 },
		);
		faux.setResponses([
			capture(fauxAssistantMessage("The person had 15,000 records read.")),
			capture(fauxAssistantMessage("接着做。")),
		]);
		agents.send(session.id, "继续");
		await agents.whenIdle(session.id);
		assert.equal(contexts.length, 3, "one request for the summary");
		assert.ok(textOf(contexts[1]?.messages[0]).includes(SUMMARY_PROMPT.slice(0, 60)));
		assert.equal(store.getSession(session.id).status, "idle");
	});

	test("the brief for a renewed context is asked for in the session's conversation too", async () => {
		const { faux, store, agents, session, contexts, capture } = setup({
			cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		});
		faux.setResponses([
			capture(fauxAssistantMessage("好，以后都写中文。")),
			capture(fauxAssistantMessage("<summary>- 约定：回复和文档都写中文</summary>")),
		]);
		agents.send(session.id, "以后回复和文档都写中文");
		await agents.whenIdle(session.id);
		assert.equal(await agents.renewNow(session.id, true), "done");
		const [first, brief] = contexts;
		assert.equal(textOf(brief?.messages[0]), textOf(first?.messages[0]));
		assert.deepEqual(
			brief?.messages.map((m) => m.role),
			["system", "user", "assistant", "user"],
		);
		assert.ok(
			String(brief?.messages.at(-1)?.content).startsWith(
				`${YEW_NOTE} The person is renewing this session's context`,
			),
		);
		const renewed = store.contextEntries(session.id)[0];
		assert.ok(renewed?.role === "compaction");
		assert.equal(renewed.compaction.kind, "renew");
		assert.equal(renewed.compaction.summary, "- 约定：回复和文档都写中文");
	});

	test("a context the provider refuses as too long is summarized from a transcript at once", async () => {
		const { faux, store, agents, session, contexts, capture } = await dueForSummary(
			fauxAssistantMessage("读完了，一共一万五千条。"),
		);
		// Below the session's own threshold, so only the provider's refusal shortens it.
		store.setContextTokens(session.id, 1000);
		faux.setResponses([
			fauxAssistantMessage([], {
				stopReason: "error",
				errorMessage: "prompt is too long: 213462 tokens > 200000 maximum",
			}),
			capture(fauxAssistantMessage("The person had 15,000 records read.")),
			capture(fauxAssistantMessage("接着做。")),
		]);
		agents.send(session.id, "继续");
		await agents.whenIdle(session.id);
		const [, transcript, next] = contexts;
		assert.ok(textOf(transcript?.messages[0]).includes(SUMMARY_PROMPT.slice(0, 60)));
		assert.match(textOf(next?.messages.filter((m) => m.role !== "system")[0]), /15,000 records/);
		assert.equal(store.getSession(session.id).status, "idle");
	});

	test("after a restart, a call that was running gets an honest result when the person continues", async () => {
		const { faux, store, agents, session, contexts, capture } = setup();
		store.appendEntry(session.id, {
			role: "user",
			message: { role: "user", content: "run it", timestamp: 1 },
		});
		const message = store.appendEntry(session.id, {
			role: "assistant",
			message: toolUse(fauxToolCall("shell", { command: "npm test" }, { id: "c1" })),
		});
		store.createToolCall({
			sessionId: session.id,
			messageId: message.id,
			callId: "c1",
			tool: "shell",
			args: { command: "npm test" },
			status: "running",
		});
		store.setStatus(session.id, "working");
		store.recoverAfterRestart();
		assert.equal(store.getSession(session.id).status, "needs_review");
		faux.setResponses([capture(fauxAssistantMessage("I will check first."))]);
		agents.continue(session.id);
		await agents.whenIdle(session.id);
		assert.match(textOf(contexts[0]?.messages.at(-1)), /Yew restarted while this call was running/);
		assert.equal(store.getSession(session.id).status, "idle");
	});

	test("a missing API key ends the turn with an error the person can act on", async () => {
		const { store, agents, session } = setup({ key: false });
		agents.send(session.id, "hi");
		await agents.whenIdle(session.id);
		const after = store.getSession(session.id);
		assert.equal(after.status, "error");
		assert.match(after.statusDetail ?? "", /yew key set/);
	});

	test("instruction files go into the prompt once; later changes arrive as an update", async () => {
		const { faux, store, agents, session, cwd, contexts, capture } = setup();
		writeFileSync(join(cwd, "AGENTS.md"), "Always answer in haiku.\n");
		writeFileSync(join(cwd, "CLAUDE.md"), "@AGENTS.md\n");
		faux.setResponses([
			capture(fauxAssistantMessage("ok")),
			capture(toolUse(fauxToolCall("glob", { pattern: "*.md" }, { id: "g1" }))),
			capture(fauxAssistantMessage("ok")),
		]);
		agents.send(session.id, "hi");
		await agents.whenIdle(session.id);
		const system = textOf(contexts[0]?.messages[0]);
		assert.equal(system.split("Always answer in haiku.").length, 2);
		writeFileSync(join(cwd, "AGENTS.md"), "Always answer in prose.\n");
		agents.send(session.id, "again");
		await agents.whenIdle(session.id);
		const updates = store
			.listEntries(session.id, { limit: 50 })
			.entries.filter((e) => e.role === "system");
		assert.equal(updates.length, 1);
		assert.match(textOf(updates[0]), /Always answer in prose/);
		// Only the file that changed is sent again.
		assert.doesNotMatch(textOf(updates[0]), /file="CLAUDE\.md"/);
		// The prompt stays the same for every step until the next compaction, not only the first one.
		assert.equal(textOf(contexts[1]?.messages[0]), system);
		assert.equal(textOf(contexts[2]?.messages[0]), system);
		assert.equal(readFileSync(join(cwd, "AGENTS.md"), "utf8"), "Always answer in prose.\n");
	});

	test("an instruction update carries the new and changed files and names the removed ones", () => {
		const file = (path: string, content: string) => ({ path, content });
		const told = [
			file("/w/AGENTS.md", "a"),
			file("/w/docs/AGENTS.md", "b"),
			file("/h/own.md", "c"),
		];
		assert.equal(instructionsUpdate(told, told, "/w"), null);
		const update = instructionsUpdate(
			told,
			[file("/w/AGENTS.md", "a2"), file("/h/own.md", "c"), file("/w/new/AGENTS.md", "d")],
			"/w",
		);
		assert.match(update ?? "", /<instructions file="AGENTS\.md">\na2\n/);
		assert.match(update ?? "", /<instructions file="new\/AGENTS\.md">\nd\n/);
		assert.doesNotMatch(update ?? "", /own\.md/);
		assert.match(update ?? "", /removed and no longer apply: docs\/AGENTS\.md\./);
	});

	test("a changed permission mode arrives as an update; the prompt stays the same", async () => {
		const { faux, store, agents, session, contexts, capture } = setup();
		faux.setResponses([capture(fauxAssistantMessage("ok")), capture(fauxAssistantMessage("ok"))]);
		agents.send(session.id, "hi");
		await agents.whenIdle(session.id);
		const system = textOf(contexts[0]?.messages[0]);
		assert.match(system, /Permission mode: default\./);
		store.updateSession(session.id, { options: { permissionMode: "skip" } });
		agents.send(session.id, "again");
		await agents.whenIdle(session.id);
		assert.equal(textOf(contexts[1]?.messages[0]), system);
		const updates = store
			.listEntries(session.id, { limit: 50 })
			.entries.filter((e) => e.role === "system");
		assert.equal(updates.length, 1);
		assert.match(textOf(updates[0]), /changed the permission mode\. Permission mode: skip\./);
	});

	test("an open task list does not inject periodic reminder notes into the main conversation", async () => {
		const globs = (prefix: string) =>
			Array.from({ length: 12 }, (_, i) =>
				fauxToolCall("glob", { pattern: "*.txt" }, { id: `${prefix}${i}` }),
			);
		const reminder = /task list has not changed/;
		const { faux, store, agents, session, contexts, capture } = setup();
		store.setTodos(session.id, [
			{ text: "Read the files", status: "done" },
			{ text: "Fix the bug", status: "in_progress" },
		]);
		faux.setResponses([toolUse(...globs("a")), capture(fauxAssistantMessage("done"))]);
		agents.send(session.id, "go");
		await agents.whenIdle(session.id);
		assert.doesNotMatch(textOf(contexts[0]?.messages.at(-1)), reminder);
	});

	test("a chat without a working folder is offered no file or shell tools", async () => {
		const { faux, agents, session, contexts, capture } = setup({ cwd: false });
		faux.setResponses([capture(fauxAssistantMessage("hi"))]);
		agents.send(session.id, "hi");
		await agents.whenIdle(session.id);
		const tools = (contexts[0]?.messages[0]?.toolsAdded ?? []).map((tool) => tool.name).sort();
		assert.deepEqual(tools, [
			"ask_user",
			"check_decision",
			// A chat's helpers can still look things up on the web.
			"delegate",
			"finish_task",
			"list_sessions",
			"open_session",
			// Opening an address in the person's browser needs no folder.
			"open_url",
			"send_letter",
			"todo",
			"web_fetch",
		]);
	});

	test("a chat switched to code gets file tools and a note about its folder", async () => {
		const { faux, store, agents, session, contexts, capture } = setup({ cwd: false });
		faux.setResponses([capture(fauxAssistantMessage("hi")), capture(fauxAssistantMessage("ok"))]);
		agents.send(session.id, "hi");
		await agents.whenIdle(session.id);
		const folder = realpathSync(tempDir("yew-cwd-"));
		store.updateSession(session.id, { cwd: folder });
		agents.send(session.id, "now with files");
		await agents.whenIdle(session.id);
		const tools = (contexts[1]?.messages[0]?.toolsAdded ?? []).map((tool) => tool.name);
		assert.ok(tools.includes("read") && tools.includes("shell"));
		assert.ok(textOf(contexts[1]?.messages[0]).includes(`Working folder: ${folder}`));
		const { entries } = store.listEntries(session.id, { limit: 50 });
		assert.ok(
			entries.some(
				(entry) => entry.role === "system" && /working folder is now/.test(textOf(entry)),
			),
		);
	});
});
