import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { openDatabase } from "../src/server/db/database.ts";
import { migrations } from "../src/server/db/migrations.ts";
import { YewError } from "../src/server/errors.ts";
import { MATCH_END, MATCH_START } from "../src/server/store.ts";
import type { EntryBody } from "../src/shared/messages.ts";
import { newStore, sessionInput, tempDir } from "./helpers/store.ts";

const user = (text: string): EntryBody => ({
	role: "user",
	message: { role: "user", content: text, timestamp: Date.now() },
});

const assistant = (text: string): EntryBody => ({
	role: "assistant",
	message: {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	},
});

function code(error: unknown): string | undefined {
	return error instanceof YewError ? error.code : undefined;
}

describe("database", () => {
	test("migrations run once and record the schema version", () => {
		const path = join(tempDir(), "yew.db");
		const first = openDatabase(path);
		const version = first.prepare("PRAGMA user_version").get() as { user_version: number };
		assert.equal(version.user_version, migrations.length);
		first.close();
		const again = openDatabase(path);
		assert.equal(
			(again.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
			migrations.length,
		);
		again.close();
	});

	test("refuses a database from a newer version", () => {
		const path = join(tempDir(), "yew.db");
		const db = openDatabase(path);
		db.exec(`PRAGMA user_version = ${migrations.length + 1}`);
		db.close();
		assert.throws(() => openDatabase(path), /newer version of Yew/);
	});
});

describe("sessions", () => {
	test("names are unique regardless of case and validated", () => {
		const { store } = newStore();
		store.createSession(sessionInput("Ops"));
		assert.throws(
			() => store.createSession(sessionInput("ops")),
			(e) => code(e) === "conflict",
		);
		assert.throws(
			() => store.createSession(sessionInput("  ")),
			(e) => code(e) === "invalid-request",
		);
		assert.throws(
			() => store.createSession(sessionInput("a@b")),
			(e) => code(e) === "invalid-request",
		);
		assert.throws(
			() => store.createSession(sessionInput("x".repeat(61))),
			(e) => code(e) === "invalid-request",
		);
	});

	test("deleting a group keeps its sessions", () => {
		const { store } = newStore();
		const group = store.createGroup("产品");
		const session = store.createSession({ ...sessionInput(), groupId: group.id });
		store.deleteGroup(group.id);
		assert.equal(store.getSession(session.id).groupId, null);
		assert.deepEqual(store.listGroups(), []);
	});

	test("lists page by cursor and separate archived sessions", () => {
		const { store } = newStore();
		for (const name of ["a", "b", "c"]) store.createSession(sessionInput(name));
		const first = store.listSessions({ limit: 2 });
		assert.deepEqual(
			first.items.map((s) => s.name),
			["a", "b"],
		);
		const second = store.listSessions({ limit: 2, cursor: first.nextCursor });
		assert.deepEqual(
			second.items.map((s) => s.name),
			["c"],
		);
		assert.equal(second.nextCursor, null);
		store.updateSession(first.items[0]?.id as string, { archived: true });
		assert.equal(store.listSessions({ limit: 10 }).items.length, 2);
		assert.equal(store.listSessions({ limit: 10, archived: true }).items.length, 1);
	});
});

describe("transcript and events", () => {
	test("entries get consecutive seqs and every change appends a durable event", () => {
		const { store } = newStore();
		const session = store.createSession(sessionInput());
		const a = store.appendEntry(session.id, user("你好"));
		const b = store.appendEntry(session.id, assistant("你好，我在。"));
		assert.deepEqual([a.seq, b.seq], [1, 2]);
		const { events, complete } = store.eventsAfter(session.id, 0);
		assert.ok(complete);
		assert.deepEqual(
			events.map((e) => e.seq),
			events.map((_, i) => i + 1),
		);
		assert.ok(events.some((e) => e.event.type === "entry"));
		assert.equal(store.getSession(session.id).eventSeq, events.at(-1)?.seq);
	});

	test("bus events go out only after the transaction commits", () => {
		const { store, events } = newStore();
		const session = store.createSession(sessionInput());
		const before = events.length;
		assert.throws(() =>
			store.tx(() => {
				store.appendEntry(session.id, user("draft"));
				throw new Error("rollback");
			}),
		);
		assert.equal(events.length, before);
		assert.equal(store.listEntries(session.id, { limit: 10 }).entries.length, 0);
	});

	test("queued messages move into the transcript once", () => {
		const { store } = newStore();
		const session = store.createSession(sessionInput());
		const q1 = store.enqueue(session.id, "first");
		store.enqueue(session.id, "second");
		store.updateQueued(session.id, q1.id, "first, edited");
		const delivered = store.deliverQueue(session.id, user);
		assert.deepEqual(
			delivered.map((e) => (e.role === "user" ? e.message.content : null)),
			["first, edited", "second"],
		);
		assert.deepEqual(store.listQueue(session.id), []);
		assert.deepEqual(store.deliverQueue(session.id, user), []);
		assert.throws(
			() => store.updateQueued(session.id, q1.id, "late"),
			(e) => code(e) === "already-delivered",
		);
	});

	test("the model sees only what follows the latest compaction", () => {
		const { store } = newStore();
		const session = store.createSession(sessionInput());
		store.appendEntry(session.id, user("old"));
		store.appendEntry(session.id, assistant("old reply"));
		const kept = store.appendEntry(session.id, user("recent"));
		store.appendEntry(session.id, {
			role: "compaction",
			compaction: { summary: "summary", firstKeptSeq: kept.seq, tokensBefore: 100, timestamp: 1 },
		});
		store.appendEntry(session.id, {
			role: "notice",
			notice: { kind: "interrupted", timestamp: 1 },
		});
		const roles = store.contextEntries(session.id).map((e) => e.role);
		assert.deepEqual(roles, ["compaction", "user"]);
	});

	test("an approval can be answered only once", () => {
		const { store } = newStore();
		const session = store.createSession(sessionInput());
		const approval = store.createApproval({
			sessionId: session.id,
			toolCallId: null,
			kind: "question",
			request: { question: "Which?" },
		});
		store.resolveApproval(approval.id, { answer: "A" });
		assert.throws(
			() => store.resolveApproval(approval.id, { answer: "B" }),
			(e) => code(e) === "already-answered",
		);
	});

	test("restart recovery keeps a question taken from a reply waiting for the person", () => {
		const { store } = newStore();
		const session = store.createSession(sessionInput());
		const approval = store.createApproval({
			sessionId: session.id,
			toolCallId: null,
			kind: "question",
			request: { questions: [{ question: "推吗？" }], fromReply: true },
		});
		store.setStatus(session.id, "waiting");
		assert.deepEqual(store.recoverAfterRestart(), []);
		assert.equal(store.getApproval(approval.id).status, "pending");
		assert.equal(store.getSession(session.id).status, "waiting");
	});

	test("restart recovery marks in-flight work for review and does not redo it", () => {
		const { store } = newStore();
		const session = store.createSession(sessionInput());
		const message = store.appendEntry(session.id, assistant("running a command"));
		const running = store.createToolCall({
			sessionId: session.id,
			messageId: message.id,
			callId: "c1",
			tool: "shell",
			args: { command: "npm test" },
			status: "running",
		});
		const waiting = store.createToolCall({
			sessionId: session.id,
			messageId: message.id,
			callId: "c2",
			tool: "shell",
			args: { command: "git push" },
			status: "waiting",
		});
		const approval = store.createApproval({
			sessionId: session.id,
			toolCallId: waiting.id,
			kind: "permission",
			request: { tool: "shell", summary: "git push", mustConfirm: true },
		});
		store.setStatus(session.id, "waiting");
		assert.deepEqual(store.recoverAfterRestart(), [session.id]);
		assert.equal(store.getSession(session.id).status, "needs_review");
		assert.equal(store.getToolCall(running.id).status, "needs_review");
		assert.equal(store.getToolCall(waiting.id).status, "pending");
		assert.equal(store.getApproval(approval.id).status, "cancelled");
	});
});

describe("search", () => {
	test("finds Chinese text by substring, with match markers", () => {
		const { store } = newStore();
		const session = store.createSession(sessionInput());
		store.appendEntry(session.id, user("请把会话导出为 Markdown 文件"));
		const long = store.search("导出为");
		assert.equal(long.hits.length, 1);
		assert.ok(long.hits[0]?.snippet.includes(`${MATCH_START}导出为${MATCH_END}`));
		const short = store.search("会话");
		assert.equal(short.hits.length, 1);
		assert.ok(short.hits[0]?.snippet.includes(`${MATCH_START}会话${MATCH_END}`));
		assert.equal(store.search("开发").sessions.length, 1);
		assert.equal(store.search('"quoted"').hits.length, 0);
	});
});
