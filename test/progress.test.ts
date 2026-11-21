import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AssistantMessage } from "../src/shared/messages.ts";
import type { Approval, Card, Entry } from "../src/shared/types.ts";
import { blockedSessions, tally, turnProgress, waitingOn } from "../web/src/progress.ts";

const assistant = (...tools: string[]): AssistantMessage =>
	({
		role: "assistant",
		content: tools.map((name, i) => ({ type: "toolCall", id: `c${i}`, name, arguments: {} })),
		timestamp: 0,
	}) as unknown as AssistantMessage;

let seq = 0;
const entry = (body: object, createdAt: number): Entry =>
	({ id: `e${++seq}`, sessionId: "s", seq, createdAt, ...body }) as Entry;
const said = (text: string, at: number) =>
	entry({ role: "user", message: { role: "user", content: text, timestamp: at } }, at);
const did = (at: number, ...tools: string[]) =>
	entry({ role: "assistant", message: assistant(...tools) }, at);

describe("session progress", () => {
	test("counts the turn since the person's last message, the reply being written included", () => {
		const entries = [
			said("first", 100),
			did(110, "read", "read", "shell"),
			said("second", 200),
			did(210, "read", "edit"),
			entry({ role: "toolResult", message: {} }, 215),
			// Yew's own notes to the model do not start a turn.
			said("[From Yew, not from the person] a job ended", 220),
			did(230, "grep", "shell", "todo_write"),
		];
		const turn = turnProgress(entries, assistant("shell"));
		assert.equal(turn.startedAt, 200);
		assert.deepEqual(turn.tools, ["read", "edit", "grep", "shell", "todo_write", "shell"]);
		assert.deepEqual(tally(turn.tools), {
			counts: { read: 1, edit: 1, search: 1, shell: 2 },
			others: 1,
		});
		assert.deepEqual(turnProgress(entries.slice(0, 3), null), { startedAt: 200, tools: [] });
	});

	test("a letter starts a turn; after a stop the next work counts from its first step", () => {
		const letter = entry(
			{
				role: "user",
				message: { role: "user", content: "[From Yew, not from the person] letter", timestamp: 1 },
				letter: { id: "l", kind: "request", summary: "", body: "" },
			},
			300,
		);
		assert.equal(turnProgress([said("a", 100), did(110, "read"), letter], null).startedAt, 300);
		const stopped = entry({ role: "notice", notice: { kind: "interrupted", timestamp: 0 } }, 400);
		const resumed = turnProgress(
			[said("a", 100), did(110, "read"), stopped, did(500, "write")],
			null,
		);
		assert.deepEqual(resumed, { startedAt: 500, tools: ["write"] });
		assert.deepEqual(turnProgress([said("a", 100), stopped], null), { startedAt: null, tools: [] });
		// Nothing that starts a turn is loaded: the counts stand, the time is not known.
		assert.deepEqual(turnProgress([did(10, "read")], null), { startedAt: null, tools: ["read"] });
	});

	test("what a session waits for: the oldest of its requests, questions and cards", () => {
		const approval = (id: string, sessionId: string, kind: Approval["kind"], createdAt: number) =>
			({ id, sessionId, kind, status: "pending", createdAt }) as Approval;
		const card = (requestedBy: string | null, createdBy: string | null, createdAt: number) =>
			({ status: "pending", requestedBy, createdBy, createdAt }) as Card;
		const approvals = [
			approval("a1", "s1", "permission", 50),
			approval("a2", "s1", "question", 40),
			{ ...approval("a3", "s1", "question", 1), status: "resolved" } as Approval,
			approval("a4", "s2", "permission", 5),
		];
		const cards = [
			card("s3", "main", 20),
			card(null, "main", 30),
			{ ...card("s1", "main", 2), status: "decided" } as Card,
		];
		assert.deepEqual(waitingOn("s1", approvals, cards), { kind: "question", since: 40, count: 2 });
		assert.deepEqual(waitingOn("s3", approvals, cards), { kind: "decision", since: 20, count: 1 });
		// A card nobody else asked for keeps the session that put it up waiting.
		assert.deepEqual(waitingOn("main", approvals, cards), {
			kind: "decision",
			since: 30,
			count: 1,
		});
		assert.equal(waitingOn("s9", approvals, cards), null);
		assert.deepEqual([...blockedSessions(approvals, cards)].sort(), ["main", "s1", "s2", "s3"]);
	});
});
