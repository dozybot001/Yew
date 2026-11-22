import type { AttachmentRef } from "../../../src/shared/messages.ts";
import type {
	Approval,
	ApprovalDecision,
	Entry,
	QuestionAnswer,
	QueuedMessage,
	Session,
} from "../../../src/shared/types.ts";
import { api, uploadFile } from "../api.ts";
import { triggerReaction, updateTranscript, upsertEntry } from "../state.ts";

// --- talking to a session ---

export function uploadAttachment(sessionId: string, file: File): Promise<AttachmentRef> {
	return uploadFile<AttachmentRef>(`/api/sessions/${sessionId}/attachments`, file);
}

export async function removePendingAttachment(
	sessionId: string,
	attachmentId: string,
): Promise<void> {
	await api("DELETE", `/api/sessions/${sessionId}/attachments/${attachmentId}`);
}

export async function sendMessage(
	sessionId: string,
	text: string,
	attachmentIds?: string[],
): Promise<void> {
	const body: { text: string; attachments?: string[] } = { text };
	if (attachmentIds && attachmentIds.length > 0) body.attachments = attachmentIds;
	const result = await api<{ entry?: Entry; queued?: QueuedMessage }>(
		"POST",
		`/api/sessions/${sessionId}/messages`,
		body,
		{ idempotent: true },
	);
	if (result.entry) {
		const entry = result.entry;
		updateTranscript(sessionId, (t) => ({ entries: upsertEntry(t.entries, entry) }));
	}
	triggerReaction("paper-plane", "companion_react_sent", { ms: 2200 });
}

export const stopSession = (sessionId: string) => api("POST", `/api/sessions/${sessionId}/stop`);
export const continueSession = (sessionId: string) =>
	api("POST", `/api/sessions/${sessionId}/continue`);
export async function compactSession(sessionId: string) {
	const res = await api("POST", `/api/sessions/${sessionId}/compact`);
	triggerReaction("tidy", "companion_react_renewed");
	return res;
}

export async function renewSession(sessionId: string, summarize = true) {
	const res = await api<{ status: "done" | "nothing" | "failed"; session: Session }>(
		"POST",
		`/api/sessions/${sessionId}/renew`,
		{ summarize },
	);
	if (res.status === "done") triggerReaction("tidy", "companion_react_renewed");
	return res;
}

export interface SessionFileMatch {
	path: string;
	label: string;
	root: "cwd" | "extra";
}

export interface SessionSkillItem {
	name: string;
	description: string;
}

export async function searchSessionFiles(
	sessionId: string,
	q: string,
	limit = 20,
): Promise<SessionFileMatch[]> {
	const params = new URLSearchParams({ q, limit: String(limit) });
	const res = await api<{ items: SessionFileMatch[] }>(
		"GET",
		`/api/sessions/${sessionId}/files?${params}`,
	);
	return res.items;
}

export async function loadSessionSkills(sessionId: string): Promise<SessionSkillItem[]> {
	const res = await api<{ items: SessionSkillItem[] }>("GET", `/api/sessions/${sessionId}/skills`);
	return res.items;
}

export async function editQueued(sessionId: string, id: string, text: string): Promise<void> {
	await api("PATCH", `/api/sessions/${sessionId}/queue/${id}`, { text });
}

export async function withdrawQueued(sessionId: string, id: string): Promise<void> {
	await api("DELETE", `/api/sessions/${sessionId}/queue/${id}`);
}

export async function answerApproval(
	approvalId: string,
	answer: {
		decision?: ApprovalDecision;
		reason?: string;
		answer?: string;
		answers?: QuestionAnswer[];
	},
): Promise<Approval> {
	const res = await api<Approval>("POST", `/api/approvals/${approvalId}`, answer);
	if (answer.decision === "allow_once" || answer.decision === "allow_always") {
		triggerReaction("stamp", "companion_react_stamped", { priority: true });
	} else if (answer.decision === "deny") {
		triggerReaction("halt", "companion_react_declined", { priority: true });
	} else if (answer.answer !== undefined || answer.answers) {
		triggerReaction("paper-plane", "companion_react_sent", { ms: 2400, priority: true });
	}
	return res;
}
