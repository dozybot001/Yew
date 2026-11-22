import type {
	ExtraDir,
	Group,
	PermissionMode,
	PermissionRule,
	ReceivePolicy,
	Session,
	SessionKind,
	ThinkingLevel,
} from "../../../src/shared/types.ts";
import { dropSessions, indexBy, loadTranscript, selectSession } from "../actions.ts";
import { all, api, downloadFile } from "../api.ts";
import { getLang } from "../i18n.ts";
import { getState, setState } from "../state.ts";
import { sendMessage, uploadAttachment } from "./messages.ts";

// --- sessions and groups ---

export interface NewSessionInput {
	name: string;
	kind: SessionKind;
	groupId: string | null;
	cwd: string | null;
	responsibility: string;
	provider: string;
	model: string;
	thinking: ThinkingLevel;
	/** Named after the first message; Yew gives it a short name after its first turn. */
	autoName?: boolean;
}

export async function createSession(input: NewSessionInput): Promise<Session> {
	const session = await api<Session>("POST", "/api/sessions", input, { idempotent: true });
	setState((current) => ({ sessions: { ...current.sessions, [session.id]: session } }));
	await selectSession(session.id);
	return session;
}

/** A copy of the session with its conversation, opened at once. */
export async function duplicateSession(sessionId: string): Promise<Session> {
	const copy = await api<Session>("POST", `/api/sessions/${sessionId}/duplicate`, undefined, {
		idempotent: true,
	});
	setState((current) => ({ sessions: { ...current.sessions, [copy.id]: copy } }));
	await selectSession(copy.id);
	return copy;
}

/**
 * A new session that goes on from a reply of this one, or from just before a message of yours, opened
 * at once. Forked from your message, the message waits in its box.
 */
export async function forkSession(
	sessionId: string,
	entryId: string,
	prefill?: string,
): Promise<Session> {
	const fork = await api<Session>(
		"POST",
		`/api/sessions/${sessionId}/fork`,
		{ entryId },
		{ idempotent: true },
	);
	setState((current) => ({
		sessions: { ...current.sessions, [fork.id]: fork },
		prefill: prefill ? { ...current.prefill, [fork.id]: prefill } : current.prefill,
	}));
	await selectSession(fork.id);
	return fork;
}

/**
 * Takes the conversation back to a reply, or to just before a message of yours, which then waits in
 * the message box to be changed and sent again.
 */
export async function rewindSession(
	sessionId: string,
	entryId: string,
	prefill?: string,
): Promise<void> {
	await api("POST", `/api/sessions/${sessionId}/rewind`, { entryId });
	if (prefill) setState((current) => ({ prefill: { ...current.prefill, [sessionId]: prefill } }));
	await loadTranscript(sessionId);
}

/** Takes the text waiting for a session's message box, once. */
export function takePrefill(sessionId: string): string | null {
	const text = getState().prefill[sessionId];
	if (text === undefined) return null;
	setState((current) => {
		const { [sessionId]: _taken, ...rest } = current.prefill;
		return { prefill: rest };
	});
	return text;
}

export type SessionPatch = Partial<{
	name: string;
	groupId: string | null;
	/** A folder makes it a code session; null makes it a chat. */
	cwd: string | null;
	responsibility: string;
	provider: string;
	model: string;
	thinking: ThinkingLevel;
	rules: PermissionRule[];
	options: {
		compactAt?: number | null;
		permissionMode?: PermissionMode;
		receive?: ReceivePolicy;
		letterQuota?: number | null;
		dailyBudget?: number | null;
		canPostCards?: boolean;
		canOrganize?: boolean;
		extraDirs?: ExtraDir[];
		allowedDomains?: string[];
	};
	pinned: boolean;
	archived: boolean;
}>;

export async function updateSession(sessionId: string, patch: SessionPatch): Promise<Session> {
	const session = await api<Session>("PATCH", `/api/sessions/${sessionId}`, patch);
	setState((current) => ({ sessions: { ...current.sessions, [session.id]: session } }));
	if (patch.archived !== undefined) {
		const archived = await api<{ items: Session[] }>("GET", "/api/sessions?archived=true&limit=1");
		setState({ hasArchived: archived.items.length > 0 });
	}
	return session;
}

/** Saves the whole session as a Markdown file, named by the server. */
export async function exportSession(session: Session): Promise<void> {
	const { blob, filename } = await downloadFile(
		`/api/sessions/${session.id}/export.md?lang=${getLang()}`,
	);
	const url = URL.createObjectURL(blob);
	try {
		const link = document.createElement("a");
		link.href = url;
		link.download = filename ?? fallbackFilename(session.name);
		document.body.append(link);
		link.click();
		link.remove();
	} finally {
		// The browser needs the URL until the download has started.
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
}

function fallbackFilename(name: string): string {
	const base = name.replace(/[\\/:*?"<>|]/g, "-").trim() || "session";
	return `${base}.md`;
}

/** A name not used by any loaded session: "聊天", then "聊天 2", "聊天 3"… */
export function freeName(base: string): string {
	const taken = new Set(Object.values(getState().sessions).map((s) => s.name.toLowerCase()));
	if (!taken.has(base.toLowerCase())) return base;
	for (let n = 2; ; n++) {
		const name = `${base} ${n}`;
		if (!taken.has(name.toLowerCase())) return name;
	}
}

/** Starts a chat (a session without a working folder) with the default model, in one click. */
/**
 * Starts a session from the home composer: creates it, sends the first message, then opens it, so a
 * failure leaves you on the home page with your text still there.
 */
export async function startSession(
	input: NewSessionInput,
	text: string,
	files?: File[],
): Promise<Session> {
	const session = await api<Session>("POST", "/api/sessions", input, { idempotent: true });
	setState((current) => ({ sessions: { ...current.sessions, [session.id]: session } }));
	const attachmentIds: string[] = [];
	if (files && files.length > 0) {
		for (const file of files) {
			const uploaded = await uploadAttachment(session.id, file);
			attachmentIds.push(uploaded.id);
		}
	}
	await sendMessage(session.id, text, attachmentIds);
	await selectSession(session.id);
	return session;
}

/** The archived sessions, all of them, for the data settings. */
export async function loadArchived(): Promise<Session[]> {
	return all<Session>("/api/sessions?archived=true");
}

/** Deletes every archived session for good; the person confirmed it first. */
export async function deleteArchivedSessions(): Promise<number> {
	const result = await api<{ deleted: string[] }>("DELETE", "/api/sessions/archived");
	dropSessions(result.deleted);
	setState({ showArchived: false });
	return result.deleted.length;
}

export async function toggleArchived(show: boolean): Promise<void> {
	setState({ showArchived: show });
	if (!show) return;
	const archived = await all<Session>("/api/sessions?archived=true");
	setState((current) => ({ sessions: { ...current.sessions, ...indexBy(archived) } }));
}

export async function createGroup(name: string): Promise<Group> {
	return api<Group>("POST", "/api/groups", { name }, { idempotent: true });
}

export async function renameGroup(groupId: string, name: string): Promise<void> {
	await api("PATCH", `/api/groups/${groupId}`, { name });
}

export async function deleteGroup(groupId: string): Promise<void> {
	await api("DELETE", `/api/groups/${groupId}`);
}
