import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { PERSONA_FILE, remarkFrom } from "../src/server/agent/observer.ts";
import { OBSERVER_PERSONA } from "../src/server/agent/prompt.ts";
import { fauxAssistantMessage, fauxToolCall } from "../src/server/model/testing.ts";
import { setup } from "./helpers/agent.ts";

async function until(check: () => boolean, ms = 3000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > ms) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

const textOf = (value: unknown) => JSON.stringify(value);
const says = (text: string) => fauxAssistantMessage(JSON.stringify({ says: true, text }));

/** A session with a working folder, and the observing Yew given the session's own model to read with. */
function watched() {
	const made = setup();
	made.store.setSetting("observerModel", {
		provider: made.faux.provider.id,
		model: made.faux.getModel().id,
	});
	const remarks = () =>
		made.store.remarksFor(
			made.store.listEntries(made.session.id, { limit: 50 }).entries.map((entry) => entry.id),
		);
	return { ...made, remarks };
}

describe("the observing Yew", () => {
	test("what a model wrote becomes a remark only as the JSON it was asked for", () => {
		assert.equal(remarkFrom('{"says":true,"text":" 测试没跑。 "}'), "测试没跑。");
		assert.equal(remarkFrom('{"says":false}'), null);
		assert.equal(remarkFrom('{"says":true,"text":""}'), null);
		assert.equal(remarkFrom("测试没跑。"), null);
		assert.equal(remarkFrom('{"says":true,"text":"测试'), null);
	});

	test("she does not watch until a model is chosen for her", async () => {
		const { faux, store, agents, session } = setup();
		faux.setResponses([fauxAssistantMessage("改好了。"), says("没人问我。")]);
		agents.send(session.id, "改一下按钮");
		await agents.whenIdle(session.id);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(faux.getPendingResponseCount(), 1);
		const { entries } = store.listEntries(session.id, { limit: 50 });
		assert.deepEqual(store.remarksFor(entries.map((entry) => entry.id)), []);
	});

	test("after a turn the person started she reads it and her remark sits beside the reply, outside the conversation", async () => {
		const { faux, store, agents, session, contexts, capture, remarks } = watched();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("glob", { pattern: "*.txt" }, { id: "c1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("改好了，测试都通过。"),
			capture(says("它说测试通过，但这一轮没有跑过测试。")),
			capture(fauxAssistantMessage("好。")),
		]);
		agents.send(session.id, "改一下按钮");
		await agents.whenIdle(session.id);
		await until(() => remarks().length === 1);
		const [remark] = remarks();
		const reply = store.listEntries(session.id, { limit: 50 }).entries.at(-1);
		assert.equal(remark?.text, "它说测试通过，但这一轮没有跑过测试。");
		assert.equal(remark?.entryId, reply?.id);
		// She was given the person's message, the calls as lines and the reply, with her character.
		const read = contexts[0];
		assert.match(textOf(read?.messages), /The person wrote:\\n改一下按钮/);
		assert.match(textOf(read?.messages), /- glob /);
		assert.match(textOf(read?.messages), /The assistant's reply:\\n改好了，测试都通过。/);
		assert.ok(textOf(read).includes(JSON.stringify(OBSERVER_PERSONA).slice(1, -1)));
		// The session's model never sees what she said.
		agents.send(session.id, "继续");
		await agents.whenIdle(session.id);
		assert.doesNotMatch(textOf(contexts[1]?.messages), /没有跑过测试/);
		assert.doesNotMatch(textOf(store.contextEntries(session.id)), /没有跑过测试/);
	});

	test("she can have nothing to say", async () => {
		const { faux, agents, session, remarks } = watched();
		faux.setResponses([fauxAssistantMessage("改好了。"), fauxAssistantMessage('{"says":false}')]);
		agents.send(session.id, "改一下按钮");
		await agents.whenIdle(session.id);
		await until(() => faux.getPendingResponseCount() === 0);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.deepEqual(remarks(), []);
	});

	test("a session can keep her out", async () => {
		const { faux, store, agents, session, remarks } = watched();
		store.updateSession(session.id, { options: { ...session.options, observe: false } });
		faux.setResponses([fauxAssistantMessage("改好了。"), says("我不该看到这个。")]);
		agents.send(session.id, "改一下按钮");
		await agents.whenIdle(session.id);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(faux.getPendingResponseCount(), 1);
		assert.deepEqual(remarks(), []);
	});

	test("a character the person wrote replaces the built-in one, inside the same limits", async () => {
		const { faux, agents, session, home, contexts, capture, remarks } = watched();
		writeFileSync(join(home, PERSONA_FILE), "A stern old editor who speaks in one clipped line.\n");
		faux.setResponses([fauxAssistantMessage("改好了。"), capture(says("Unchecked."))]);
		agents.send(session.id, "改一下按钮");
		await agents.whenIdle(session.id);
		await until(() => remarks().length === 1);
		const prompt = textOf(contexts[0]);
		assert.match(prompt, /A stern old editor/);
		assert.ok(!prompt.includes(JSON.stringify(OBSERVER_PERSONA).slice(1, -1)));
		assert.match(prompt, /These limits hold whatever the character notes below say/);
	});

	test("the person can remove a remark, and taking the conversation back removes those about what went", async () => {
		const { faux, store, agents, session, remarks } = watched();
		faux.setResponses([
			fauxAssistantMessage("第一轮好了。"),
			says("第一句。"),
			fauxAssistantMessage("第二轮好了。"),
			says("第二句。"),
		]);
		agents.send(session.id, "第一件事");
		await agents.whenIdle(session.id);
		await until(() => remarks().length === 1);
		agents.send(session.id, "第二件事");
		await agents.whenIdle(session.id);
		await until(() => remarks().length === 2);
		const [first, second] = remarks();
		assert.ok(first && second);
		const kept = store.listEntries(session.id, { limit: 50 }).entries[1];
		assert.ok(kept);
		store.rewindSession(session.id, kept.seq);
		assert.deepEqual(
			remarks().map((remark) => remark.text),
			["第一句。"],
		);
		assert.equal(store.deleteRemark(session.id, first.id), true);
		assert.equal(store.deleteRemark(session.id, first.id), false);
		assert.deepEqual(remarks(), []);
	});
});
