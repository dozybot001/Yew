/**
 * What a session has done in the turn it is working on, counted from the
 * transcript the page already has. The kinds are the ones a folded run of steps is summed up by, so
 * the line at the top and the lines in the conversation agree.
 */
import type { AssistantMessage } from "../../src/shared/messages.ts";
import type { Approval, Card, Entry } from "../../src/shared/types.ts";

export const SUMMARY_KINDS = [
	"read",
	"edit",
	"write",
	"search",
	"shell",
	"web",
	"letter",
	"session",
	"card",
	"helper",
] as const;
export type SummaryKind = (typeof SUMMARY_KINDS)[number];

export function summaryKind(tool: string): SummaryKind | null {
	if (tool === "read" || tool === "edit" || tool === "write") return tool;
	if (tool === "grep" || tool === "glob") return "search";
	if (tool === "shell" || tool === "shell_job") return "shell";
	if (tool === "web_fetch") return "web";
	if (tool === "send_letter") return "letter";
	if (tool === "open_session") return "session";
	if (tool === "post_card" || tool === "update_card" || tool === "withdraw_card") return "card";
	if (tool === "delegate") return "helper";
	return null;
}

/** Tool calls by kind, in the order the kinds are named; `others` are calls of no named kind. */
export interface Tally {
	counts: Partial<Record<SummaryKind, number>>;
	others: number;
}

export function tally(tools: string[]): Tally {
	const counts: Partial<Record<SummaryKind, number>> = {};
	let others = 0;
	for (const tool of tools) {
		const kind = summaryKind(tool);
		if (kind) counts[kind] = (counts[kind] ?? 0) + 1;
		else others++;
	}
	return { counts, others };
}

/** Yew's own notes to the model start with this; they are not the person's words and start no turn. */
export const YEW_NOTE = "[From Yew, not from the person]";

function startsTurn(entry: Entry): boolean {
	if (entry.role === "notice") {
		// After an interruption or an error the next work is a new turn, also when "continue" started it.
		return ["interrupted", "restarted", "error"].includes(entry.notice.kind);
	}
	if (entry.role !== "user") return false;
	if (entry.letter) return true;
	const content = entry.message.content;
	const text =
		typeof content === "string"
			? content
			: content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
	return !text.startsWith(YEW_NOTE);
}

export interface TurnProgress {
	/** When the turn began; null when the loaded part of the transcript does not show it. */
	startedAt: number | null;
	/** The tools called since, in order, the reply being written included. */
	tools: string[];
}

/**
 * The turn under way: everything since the last message from the person or letter. A turn started
 * with "continue" after a stop or an error counts from the first thing the session did after it.
 */
export function turnProgress(entries: Entry[], draft: AssistantMessage | null): TurnProgress {
	let at = -1;
	for (let index = entries.length - 1; index >= 0; index--) {
		if (startsTurn(entries[index] as Entry)) {
			at = index;
			break;
		}
	}
	const start = at >= 0 ? entries[at] : undefined;
	const after = entries.slice(at + 1);
	const startedAt = !start
		? null
		: start.role === "user"
			? start.createdAt
			: (after[0]?.createdAt ?? null);
	const tools: string[] = [];
	const collect = (message: AssistantMessage) => {
		for (const block of message.content) if (block.type === "toolCall") tools.push(block.name);
	};
	for (const entry of after) if (entry.role === "assistant") collect(entry.message);
	if (draft) collect(draft);
	return { startedAt, tools };
}

/** What a session waits on the person for. */
export interface Waiting {
	kind: "permission" | "question" | "decision";
	since: number;
	/** How many things wait in all; `kind` and `since` are those of the one waiting longest. */
	count: number;
}

/** The session a pending card keeps waiting: the one that asked, or the one that put it up itself. */
export function cardWaiter(card: Card): string | null {
	return card.requestedBy ?? card.createdBy;
}

/**
 * What a session waits on the person for: its pending permission requests and questions, and the
 * decision cards put up for it. The one waiting longest comes first; null when nothing waits.
 */
export function waitingOn(
	sessionId: string,
	approvals: Iterable<Approval>,
	cards: Iterable<Card>,
): Waiting | null {
	const items: { kind: Waiting["kind"]; since: number }[] = [];
	for (const approval of approvals) {
		if (approval.sessionId === sessionId && approval.status === "pending") {
			items.push({ kind: approval.kind, since: approval.createdAt });
		}
	}
	for (const card of cards) {
		if (card.status === "pending" && cardWaiter(card) === sessionId) {
			items.push({ kind: "decision", since: card.createdAt });
		}
	}
	const first = items.sort((a, b) => a.since - b.since)[0];
	return first ? { ...first, count: items.length } : null;
}

/** The sessions something in the approval center keeps waiting. */
export function blockedSessions(approvals: Iterable<Approval>, cards: Iterable<Card>): Set<string> {
	const blocked = new Set<string>();
	for (const approval of approvals)
		if (approval.status === "pending") blocked.add(approval.sessionId);
	for (const card of cards) {
		const waiter = cardWaiter(card);
		if (card.status === "pending" && waiter) blocked.add(waiter);
	}
	return blocked;
}
