import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "../src/server/model/testing.ts";
import type { PermissionRequest, Session } from "../src/shared/types.ts";
import { harness, lastTool, textOf, toolUse, until } from "./helpers/letters.ts";

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

	test("a session whose role changes hears it as an update; its prompt stays the same", async () => {
		const { store, agents, make, script, seen, said } = harness();
		const x = make("文档", { responsibility: "整理文档" });
		script(x, [
			fauxAssistantMessage("第一轮"),
			fauxAssistantMessage("第二轮"),
			fauxAssistantMessage("第三轮"),
		]);
		agents.send(x.id, "开始");
		await until(() => said(x).length === 1);
		await agents.whenIdle(x.id);
		store.updateSession(x.id, { responsibility: "整理文档，并写发布说明" });
		agents.send(x.id, "继续");
		await until(() => said(x).length === 2);
		await agents.whenIdle(x.id);
		store.updateSession(x.id, { responsibility: "" });
		agents.send(x.id, "再继续");
		await until(() => said(x).length === 3);
		const [first, second, third] = seen.get("文档") ?? [];
		const prompt = String(first?.messages[0]?.content);
		assert.match(prompt, /Your role, as the person wrote it:\n整理文档\n/);
		assert.equal(second?.messages[0]?.content, prompt, "same system prompt");
		assert.equal(third?.messages[0]?.content, prompt, "same system prompt");
		const updates = (context: typeof first) =>
			textOf(context?.messages.filter((m) => m.role === "system").slice(1));
		assert.equal(updates(first), "[]");
		assert.match(
			updates(second),
			/Your role changed\. This is the current one; it replaces the earlier one\.\\n整理文档，并写发布说明/,
		);
		assert.match(updates(third), /Your role was removed\. You have no written role now\./);
		// Told once: the first change is not repeated with the second.
		assert.equal(updates(third).split("Your role changed").length, 2);
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
