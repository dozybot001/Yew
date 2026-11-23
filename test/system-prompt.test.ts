import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { systemPrompt } from "../src/server/agent/prompt.ts";
import { fauxAssistantMessage } from "../src/server/model/testing.ts";
import type { Session } from "../src/shared/types.ts";
import { setup } from "./helpers/agent.ts";

describe("system prompt", () => {
	const snapshot = (cwd: string | null) => ({
		date: "2026-11-08",
		platform: "test",
		shell: "/bin/sh",
		cwd,
		git: null,
		instructions: [],
		permissionMode: "default" as const,
	});
	const base = { name: "产品", responsibility: "负责 Yew 的产品设计。", cwd: "/tmp/demo" };

	test("a standing session learns its role, its team and to keep lasting facts in files", () => {
		const text = systemPrompt(
			{ ...base, kind: "standing" } as Session,
			snapshot("/tmp/demo"),
			"Tenon",
		);
		assert.match(
			text,
			/^You are "产品", one of the agent sessions that make up the person's organization in Yew\./,
		);
		assert.match(text, /You belong to the team "Tenon"\./);
		assert.match(text, /负责 Yew 的产品设计。/);
		assert.match(text, /standing session: this role is yours for the long term/);
		assert.match(text, /in files in your working folder/);
		assert.match(text, /Stop for the person only for what only they can decide or do/);
		assert.match(text, /Permission mode: default\..*set "confirm": true/);
	});

	test("the prompt keeps the name, team and role saved with the snapshot", () => {
		const text = systemPrompt(
			{ ...base, kind: "standing", name: "新名", responsibility: "新职责" } as Session,
			{ ...snapshot("/tmp/demo"), name: "产品", team: "Tenon", role: "负责 Yew 的产品设计。" },
			"别的团队",
		);
		assert.match(text, /^You are "产品"/);
		assert.match(text, /You belong to the team "Tenon"\./);
		assert.match(text, /Your role, as the person wrote it:\n负责 Yew 的产品设计。\n/);
		assert.doesNotMatch(text, /新名|新职责|别的团队/);
		const none = systemPrompt({ ...base, kind: "standing" } as Session, {
			...snapshot("/tmp/demo"),
			role: "",
		});
		assert.doesNotMatch(none, /Your role, as the person wrote it/);
	});

	test("a task session ends with a report; a chat without team or role mentions neither", () => {
		const text = systemPrompt(
			{ ...base, kind: "task", responsibility: "", cwd: null } as Session,
			snapshot(null),
		);
		assert.match(text, /task session, opened for one job/);
		assert.match(text, /the result \(done, given up or failed\)/);
		assert.doesNotMatch(text, /You belong to the team/);
		assert.doesNotMatch(text, /Your role, as the person wrote it/);
		assert.match(text, /No working folder/);
	});

	test("a session stops only for the person's decisions and makes must-confirm calls itself", () => {
		const session = {
			...base,
			id: "s1",
			kind: "task",
			options: { permissionMode: "skip" },
		} as Session;
		const alone = systemPrompt(session, { ...snapshot("/tmp/demo"), permissionMode: "skip" });
		assert.match(alone, /only they can decide or do: ask with ask_user\./);
		assert.match(alone, /take it instead of offering it; for example, commit/);
		// Skip mode asks about no call: what the role keeps for the person, the session puts to them itself.
		assert.match(
			alone,
			/Permission mode: skip\. Yew asks nothing before your calls, publishing and commands on other machines included/,
		);
		assert.match(alone, /keep for the person to approve, put to them before you do it\./);
		assert.doesNotMatch(alone, /the person's decision in every mode/);
		const asking = systemPrompt(session, { ...snapshot("/tmp/demo"), permissionMode: "default" });
		assert.match(
			asking,
			/make the call, and their answer is the confirmation any instructions ask for/,
		);
		assert.doesNotMatch(alone, /Take extra care/);
		assert.match(alone, /how you checked it, and what is left\./);
		assert.doesNotMatch(alone, /what the person needs to do/);
		// Yew catches questions left in replies, so the prompt carries no rule about them.
		assert.doesNotMatch(alone, /Never end a turn/);
		const main = { id: "m1", name: "总办" };
		const withMain = systemPrompt(session, { ...snapshot("/tmp/demo"), main });
		assert.match(withMain, /decide or do: send a request to the main conversation/);
		const asMain = systemPrompt({ ...session, id: "m1" }, { ...snapshot("/tmp/demo"), main });
		assert.match(asMain, /decide or do: put a card in the approval center with post_card/);
	});

	test("the prompt sent with a turn names the session's team", async () => {
		const { faux, store, agents, session, contexts, capture } = setup();
		const group = store.createGroup("平台组");
		store.updateSession(session.id, { groupId: group.id });
		faux.setResponses([capture(fauxAssistantMessage("好的。"))]);
		agents.send(session.id, "你好");
		await agents.whenIdle(session.id);
		// The model library hands the system prompt to the model as the first, "system" message.
		const system = contexts[0]?.messages.find((message) => message.role === "system");
		assert.match(String(system?.content ?? ""), /You belong to the team "平台组"\./);
	});
});
