/**
 * Forking: a session opens a task session with a copy of its conversation,
 * and the person forks a session from one of its replies.
 */
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { describe, test } from "node:test";
import { Agents } from "../src/server/agent/runner.ts";
import { MemoryKeyStore } from "../src/server/keys.ts";
import { ModelGateway } from "../src/server/model/gateway.ts";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "../src/server/model/testing.ts";
import { PermissionEngine } from "../src/server/permissions/engine.ts";
import type { Entry, Session } from "../src/shared/types.ts";
import { newStore, tempDir } from "./helpers/store.ts";

type Reply = ReturnType<typeof fauxAssistantMessage>;
type Context = { messages: { role: string; content: unknown }[] };

function harness() {
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
	// Each request is answered from the script of the session that asks, found by its system prompt.
	const scripts = new Map<string, (Reply | ((context: Context) => Reply))[]>();
	const seen = new Map<string, Context[]>();
	faux.setResponses(
		Array.from({ length: 50 }, () => (context: unknown) => {
			const copy = structuredClone(context) as Context;
			const system = String(copy.messages.find((m) => m.role === "system")?.content ?? "");
			const name = /^You are "([^"]+)"/.exec(system)?.[1] ?? "";
			seen.set(name, [...(seen.get(name) ?? []), copy]);
			const step = scripts.get(name)?.shift();
			if (!step) return fauxAssistantMessage(`(${name} has no more replies)`);
			return typeof step === "function" ? step(copy) : step;
		}) as never,
	);
	const make = (name: string) =>
		store.createSession({
			name,
			kind: "standing",
			provider: faux.provider.id,
			model: faux.getModel().id,
			cwd: folder,
			thinking: "off",
			options: { permissionMode: "default" },
		});
	return { store, agents, make, scripts, seen };
}

async function until(check: () => boolean, ms = 4000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > ms) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) =>
	fauxAssistantMessage(calls, { stopReason: "toolUse" });

describe("a session opened with a copy of the conversation", () => {
	test("knows everything before the step that opened it, and who it is now", async () => {
		const { store, agents, make, scripts, seen } = harness();
		const lead = make("Lead");
		scripts.set("Lead", [
			fauxAssistantMessage("Plan: rewrite the parser, then the changelog."),
			toolUse(
				fauxToolCall(
					"open_session",
					{ name: "Changelog", brief: "Write the changelog for it.", fork: true },
					{ id: "o1" },
				),
			),
			fauxAssistantMessage("Opened the changelog session."),
		]);
		scripts.set("Changelog", [fauxAssistantMessage("Changelog written.")]);
		agents.send(lead.id, "Plan the release of version 2.");
		await agents.whenIdle(lead.id);
		agents.send(lead.id, "Split off the changelog work.");
		await until(() => (seen.get("Changelog")?.length ?? 0) > 0);

		const child = store.findSessionByName("Changelog") as Session;
		assert.equal(child.parentId, lead.id);
		const sent = JSON.stringify(seen.get("Changelog")?.[0]?.messages);
		// The opener's conversation, in order, up to the person's message that led to the fork.
		const order = [
			"Plan the release of version 2.",
			"Plan: rewrite the parser, then the changelog.",
			"Split off the changelog work.",
			'You were forked from the session \\"Lead\\"',
			"Write the changelog for it.",
		].map((text) => sent.indexOf(text));
		assert.ok(
			order.every((at) => at >= 0),
			`all parts are there: ${order.join(",")}`,
		);
		assert.deepEqual(
			[...order].sort((a, b) => a - b),
			order,
			"in this order",
		);
		// Not the half-made step that opened it.
		assert.doesNotMatch(sent, /"o1"/);
		await until(() => !agents.isRunning(child.id) && !agents.isRunning(lead.id));
		// Its report goes back to the opener as usual.
		const report = store
			.listEntries(lead.id, { limit: 50 })
			.entries.find((entry) => entry.role === "user" && "letter" in entry && entry.letter);
		assert.match(JSON.stringify(report), /Changelog written\./);
	});

	test("without fork, it starts from the brief alone", async () => {
		const { store, agents, make, scripts, seen } = harness();
		const lead = make("Lead");
		scripts.set("Lead", [
			toolUse(fauxToolCall("open_session", { name: "Notes", brief: "Write notes." }, { id: "o1" })),
			fauxAssistantMessage("Opened."),
		]);
		agents.send(lead.id, "Something private to this conversation.");
		await until(() => (seen.get("Notes")?.length ?? 0) > 0);
		const sent = JSON.stringify(seen.get("Notes")?.[0]?.messages);
		assert.doesNotMatch(sent, /Something private/);
		assert.match(sent, /Write notes\./);
		await until(() => !agents.isRunning(lead.id));
		assert.ok(store.findSessionByName("Notes"));
	});
});

describe("forking from a reply", () => {
	function conversation() {
		const { store, make } = harness();
		const source = make("Website");
		const add = (body: Parameters<typeof store.appendEntry>[1]) =>
			store.appendEntry(source.id, body);
		const asked = add({
			role: "user",
			message: { role: "user", content: "Fix the footer.", timestamp: 1 },
		});
		const call = add({
			role: "assistant",
			message: {
				...toolUse(fauxToolCall("read", { path: "footer.html" }, { id: "r1" })),
				timestamp: 1,
			},
		});
		add({
			role: "toolResult",
			message: {
				role: "toolResult",
				toolCallId: "r1",
				toolName: "read",
				content: [{ type: "text", text: "<footer>" }],
				isError: false,
				timestamp: 1,
			},
		});
		const reply = add({
			role: "assistant",
			message: { ...fauxAssistantMessage("The footer is fixed."), timestamp: 1 },
		});
		add({ role: "user", message: { role: "user", content: "Now the header.", timestamp: 1 } });
		const later = add({
			role: "assistant",
			message: { ...fauxAssistantMessage("The header is fixed."), timestamp: 1 },
		});
		return { store, make, source, asked, call, reply, later };
	}
	const texts = (entries: Entry[]) => entries.map((entry) => JSON.stringify(entry));

	test("copies the conversation up to and including that reply, and leaves the original alone", () => {
		const { store, source, reply } = conversation();
		store.setStatus(source.id, "working");
		const fork = store.forkSession(source.id, reply.id, "Website 分叉");
		const copied = store.listEntries(fork.id, { limit: 50 }).entries;
		assert.equal(copied.length, 4);
		assert.match(texts(copied).at(-1) ?? "", /The footer is fixed\./);
		assert.doesNotMatch(texts(copied).join(), /Now the header/);
		assert.equal(store.listEntries(source.id, { limit: 50 }).entries.length, 6);
		// What it writes next comes after the copy.
		const next = store.appendEntry(fork.id, {
			role: "user",
			message: { role: "user", content: "Make it blue.", timestamp: 2 },
		});
		assert.equal(next.seq, reply.seq + 1);
		assert.equal(store.getSession(fork.id).cwd, source.cwd);
		assert.equal(store.getSession(source.id).status, "working");
	});

	test("the copy's requests start with the original's system prompt, and it hears its own name", async () => {
		const { store, agents, make, scripts, seen } = harness();
		const site = make("Website");
		scripts.set("Website", [fauxAssistantMessage("Done."), fauxAssistantMessage("Blue now.")]);
		agents.send(site.id, "Fix the footer.");
		await agents.whenIdle(site.id);
		const reply = store
			.listEntries(site.id, { limit: 50 })
			.entries.find((entry) => entry.role === "assistant") as Entry;
		const fork = store.forkSession(site.id, reply.id, "Website 分叉");
		agents.send(fork.id, "Make it blue.");
		await agents.whenIdle(fork.id);
		// Both requests carry the original's name in the prompt: the provider's cache is read by its start.
		const [first, second] = seen.get("Website") ?? [];
		assert.equal(second?.messages[0]?.content, first?.messages[0]?.content);
		assert.match(JSON.stringify(second?.messages), /Your name is now \\"Website 分叉\\"/);
		assert.match(JSON.stringify(store.listEntries(fork.id, { limit: 50 }).entries), /Blue now\./);
	});

	test("from a finished reply or before a message of the person's, in that session only", () => {
		const { store, make, source, asked, call } = conversation();
		// Before the person's first message: a session with nothing in it yet.
		const empty = store.forkSession(source.id, asked.id, "Website 分叉");
		assert.equal(store.listEntries(empty.id, { limit: 50 }).entries.length, 0);
		// Not in the middle of a step: its calls would have no results.
		assert.throws(
			() => store.forkSession(source.id, call.id, "x"),
			/Pick one of the session's replies/,
		);
		const other = make("Other");
		const elsewhere = store.appendEntry(other.id, {
			role: "assistant",
			message: { ...fauxAssistantMessage("Hi."), timestamp: 1 },
		});
		assert.throws(
			() => store.forkSession(source.id, elsewhere.id, "x"),
			/Pick one of the session's replies/,
		);
	});
});

describe("taking a conversation back", () => {
	function setup() {
		const { store, agents, make, scripts, seen } = harness();
		const site = make("Website");
		return { store, agents, site, scripts, seen };
	}
	const visible = (store: ReturnType<typeof setup>["store"], id: string) =>
		store.listEntries(id, { limit: 50 }).entries.map((entry) => JSON.stringify(entry));

	test("to a reply: what came after is no longer shown or sent, and the next turn goes on from there", async () => {
		const { store, agents, site, scripts, seen } = setup();
		scripts.set("Website", [
			fauxAssistantMessage("The footer is fixed."),
			fauxAssistantMessage("The header is fixed."),
			fauxAssistantMessage("Blue it is."),
		]);
		agents.send(site.id, "Fix the footer.");
		await agents.whenIdle(site.id);
		agents.send(site.id, "Now the header.");
		await agents.whenIdle(site.id);
		const reply = store
			.listEntries(site.id, { limit: 50 })
			.entries.find((entry) => JSON.stringify(entry).includes("The footer is fixed.")) as Entry;

		assert.equal(agents.rewind(site.id, reply.id), 2);
		assert.doesNotMatch(visible(store, site.id).join(), /Now the header|header is fixed/);
		assert.equal(store.search("header").hits.length, 0);
		agents.send(site.id, "Make it blue.");
		await agents.whenIdle(site.id);
		const sent = JSON.stringify(seen.get("Website")?.at(-1)?.messages);
		assert.match(sent, /Fix the footer\..*The footer is fixed\..*Make it blue\./s);
		assert.doesNotMatch(sent, /Now the header|header is fixed/);
		// The taken-back part is left out of a fork too.
		const fork = store.forkSession(
			site.id,
			store.listEntries(site.id, { limit: 50 }).entries.at(-1)?.id as string,
			"Website 分叉",
		);
		assert.doesNotMatch(visible(store, fork.id).join(), /Now the header|header is fixed/);
	});

	test("what was taken back is deleted from the database, not only hidden", async () => {
		const { store, agents, site, scripts } = setup();
		scripts.set("Website", [
			fauxAssistantMessage("The footer is fixed."),
			toolUse(fauxToolCall("read", { path: "notes-sk-test-0042.txt" }, { id: "r1" })),
			fauxAssistantMessage("Noted sk-test-0042."),
		]);
		agents.send(site.id, "Fix the footer.");
		await agents.whenIdle(site.id);
		agents.send(site.id, "My key is sk-test-0042, keep it.");
		await agents.whenIdle(site.id);
		const reply = store
			.listEntries(site.id, { limit: 50 })
			.entries.find((entry) => JSON.stringify(entry).includes("The footer is fixed.")) as Entry;
		assert.equal(agents.rewind(site.id, reply.id), 4);
		const everything = [
			"SELECT body FROM messages",
			"SELECT args, detail FROM tool_calls",
			"SELECT data FROM session_events",
			"SELECT request, response FROM approvals",
			"SELECT text FROM message_search",
		]
			.flatMap((sql) =>
				store.db
					.prepare(sql)
					.all()
					.map((row) => JSON.stringify(row)),
			)
			.join("\n");
		assert.doesNotMatch(everything, /sk-test-0042/);
		assert.match(everything, /The footer is fixed/, "what came before stays");
	});

	test("to just before a message of yours, which can be forked from too", async () => {
		const { store, agents, site, scripts } = setup();
		scripts.set("Website", [fauxAssistantMessage("Done."), fauxAssistantMessage("Done again.")]);
		agents.send(site.id, "First.");
		await agents.whenIdle(site.id);
		agents.send(site.id, "Second.");
		await agents.whenIdle(site.id);
		const second = store
			.listEntries(site.id, { limit: 50 })
			.entries.find(
				(entry) => entry.role === "user" && JSON.stringify(entry).includes("Second."),
			) as Entry;
		const fork = store.forkSession(site.id, second.id, "Website 分叉");
		assert.equal(visible(store, fork.id).length, 2, "the first message and its reply");
		assert.equal(agents.rewind(site.id, second.id), 2);
		assert.equal(visible(store, site.id).length, 2);
		assert.equal(store.getSession(site.id).status, "idle");
	});

	test("not while it works, and not past a summary of earlier history", async () => {
		const { store, agents, site, scripts, seen } = setup();
		let release: () => void = () => {};
		scripts.set("Website", [
			fauxAssistantMessage("Done."),
			(() =>
				new Promise<Reply>((resolve) => {
					release = () => resolve(fauxAssistantMessage("Late."));
				})) as never,
		]);
		agents.send(site.id, "First.");
		await agents.whenIdle(site.id);
		const reply = store
			.listEntries(site.id, { limit: 50 })
			.entries.find((entry) => entry.role === "assistant") as Entry;
		agents.send(site.id, "Second.");
		assert.throws(() => agents.rewind(site.id, reply.id), /Stop the session first/);
		await until(() => seen.get("Website")?.length === 2);
		release();
		await agents.whenIdle(site.id);
		store.appendEntry(site.id, {
			role: "compaction",
			compaction: {
				summary: "Earlier work.",
				firstKeptSeq: reply.seq + 1,
				tokensBefore: 1,
				timestamp: 1,
			},
		});
		assert.throws(() => agents.rewind(site.id, reply.id), /summarized/);
	});

	test("restores contextTokens from surviving replies instead of resetting to zero", async () => {
		const { store, agents, site, scripts } = setup();
		scripts.set("Website", [
			fauxAssistantMessage("First answer with enough words to count."),
			fauxAssistantMessage("Second answer that adds noticeably more tokens to the context window."),
		]);

		agents.send(site.id, "Turn one.");
		await agents.whenIdle(site.id);
		const turnOneTokens = store.getSession(site.id).contextTokens;
		assert.ok(turnOneTokens > 0, "turn one should record context tokens");

		agents.send(site.id, "Turn two with extra detail to grow the context.");
		await agents.whenIdle(site.id);
		const turnTwoTokens = store.getSession(site.id).contextTokens;
		assert.ok(turnTwoTokens > turnOneTokens, "turn two should grow context tokens");

		const entries = store.listEntries(site.id, { limit: 50 }).entries;
		const turnOneUser = entries.find((e) => e.role === "user") as Entry;
		const turnOneReply = entries.find((e) => e.role === "assistant") as Entry;

		// Forking at turn one preserves turn one's context size.
		const forked = store.forkSession(site.id, turnOneReply.id, "Website 分叉");
		assert.equal(store.getSession(forked.id).contextTokens, turnOneTokens);

		// Rewinding to turn one restores turnOneTokens instead of 0.
		assert.equal(agents.rewind(site.id, turnOneReply.id), 2);
		assert.equal(store.getSession(site.id).contextTokens, turnOneTokens);

		// Rewinding before the very first message leaves no context, so it drops to 0.
		assert.equal(agents.rewind(site.id, turnOneUser.id), 2);
		assert.equal(store.getSession(site.id).contextTokens, 0);
	});
});
