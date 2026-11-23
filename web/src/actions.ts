import type { AssistantMessage } from "../../src/shared/messages.ts";
import type {
	Approval,
	Artifact,
	Card,
	Device,
	Group,
	Letter,
	Page,
	Schedule,
	Session,
	SessionEvent,
	ToolCallView,
	Transcript,
} from "../../src/shared/types.ts";
import { applyAppearance } from "./actions/appearance.ts";
import {
	loadArtifacts,
	loadSchedules,
	openArtifacts,
	openMap,
	openSchedules,
	openUsage,
} from "./actions/pages.ts";
import {
	CENTER_TABS,
	LAST_SESSION,
	recall,
	recallView,
	remember,
	rememberView,
} from "./actions/remembered.ts";
import { saveSettings } from "./actions/settings.ts";
import { loadUpdates, reloadIfReplaced } from "./actions/updates.ts";
import { ApiError, all, api } from "./api.ts";
import {
	type CenterState,
	type CenterTab,
	getState,
	type ProviderSummary,
	type Settings,
	type SettingsDialogName,
	setState,
	triggerReaction,
	updateTranscript,
	upsertEntry,
} from "./state.ts";

// --- sign-in and start ---

/** Trades the one-time token from the URL fragment for a cookie, then removes it from the address bar. */
async function exchangeToken(): Promise<void> {
	const match = /[#&]t=([\w-]+)/.exec(window.location.hash);
	if (!match?.[1]) return;
	history.replaceState(null, "", window.location.pathname + window.location.search);
	try {
		await api("POST", "/api/auth/exchange", { token: match[1] });
	} catch (error) {
		// A used or expired link still leaves an existing cookie usable.
		if (!(error instanceof ApiError) || error.status !== 401) throw error;
	}
}

export async function boot(): Promise<void> {
	applyAppearance(null);
	try {
		await exchangeToken();
		const health = await api<{
			version: string;
			build?: string;
			sandbox?: "macos" | "linux" | "none";
		}>("GET", "/api/health");
		// The opening lists these steps as they finish.
		setState({
			health: {
				version: health.version,
				build: health.build ?? null,
				...(health.sandbox ? { sandbox: health.sandbox } : {}),
			},
		});
		const settings = await api<Settings>("GET", "/api/settings");
		setState({ settings });
		applyAppearance(settings);
		const [groups, sessions, providers, archived] = await Promise.all([
			all<Group>("/api/groups"),
			all<Session>("/api/sessions"),
			all<ProviderSummary>("/api/providers"),
			api<{ items: Session[] }>("GET", "/api/sessions?archived=true&limit=1"),
		]);
		setState({
			phase: "ready",
			groups,
			sessions: Object.fromEntries(sessions.map((s) => [s.id, s])),
			providers,
			hasArchived: archived.items.length > 0,
		});
		await loadCenter();
		// The About page and the floating Yew say when there is a new version.
		void loadUpdates();
		// The floating Yew is on duty while a scheduled task is on.
		void loadSchedules().catch(() => {});
		setState({ booted: true });
		// A reload stays where the tab was. Otherwise Yew opens on the main conversation; without one,
		// where you left off.
		const view = recallView();
		const tab = view?.startsWith("center:") ? view.slice("center:".length) : null;
		const viewed = view?.startsWith("session:") ? view.slice("session:".length) : null;
		const main = settings.mainSessionId;
		const last = recall(LAST_SESSION);
		if (tab && CENTER_TABS.includes(tab)) {
			connect(null, null);
			openCenter(tab as CenterTab);
		} else if (view === "schedules") {
			connect(null, null);
			openSchedules();
		} else if (view === "artifacts") {
			connect(null, null);
			openArtifacts();
		} else if (view === "usage") {
			connect(null, null);
			openUsage();
		} else if (view === "map") {
			connect(null, null);
			openMap();
		} else if (viewed && getState().sessions[viewed]) await selectSession(viewed);
		else if (view === "home") connect(null, null);
		else if (main && getState().sessions[main]) await selectSession(main);
		else if (last && getState().sessions[last]) await selectSession(last);
		else connect(null, null);
	} catch (error) {
		if (error instanceof ApiError && error.status === 401) setState({ phase: "signin" });
		else setState({ phase: "failed", failure: (error as Error).message });
	}
}

// --- event stream ---

let source: EventSource | null = null;
let connectedOnce = false;

function connect(sessionId: string | null, after: number | null): void {
	source?.close();
	const params = new URLSearchParams();
	if (sessionId) params.set("session", sessionId);
	if (after !== null) params.set("after", String(after));
	const stream = new EventSource(`/api/events?${params}`);
	source = stream;
	connectedOnce = false;
	stream.addEventListener("open", () => setState({ connection: "open" }));
	stream.addEventListener("error", () => {
		if (source !== stream) return;
		setState({ connection: "connecting" });
		if (stream.readyState === EventSource.CLOSED) void recover();
	});
	stream.addEventListener("hello", () => {
		if (connectedOnce) {
			void reloadIfReplaced();
			resync();
		}
		connectedOnce = true;
	});
	stream.addEventListener("reset", () => {
		if (source !== stream) return;
		resync();
		if (sessionId) void loadTranscript(sessionId);
	});
	stream.addEventListener("global", (message) => {
		applyGlobalEvent(JSON.parse((message as MessageEvent<string>).data) as GlobalEvent);
	});
	if (!sessionId) return;
	stream.addEventListener("session", (message) => {
		applySessionEvent(
			sessionId,
			JSON.parse((message as MessageEvent<string>).data) as SessionEvent,
		);
	});
	stream.addEventListener("live", (message) => {
		const event = JSON.parse((message as MessageEvent<string>).data) as
			| { type: "draft"; draft: AssistantMessage }
			| { type: "draftCleared" }
			| { type: "retrying"; attempt: number; of: number; seconds: number; text: string }
			| { type: "toolOutput"; toolCallId: string; output: string };
		updateTranscript(sessionId, (t) => {
			if (event.type === "draft") return { draft: event.draft, retry: null };
			if (event.type === "draftCleared") return { draft: null, retry: null };
			if (event.type === "retrying") {
				const { type: _type, ...retry } = event;
				return { draft: null, retry };
			}
			return { outputs: { ...t.outputs, [event.toolCallId]: event.output } };
		});
	});
}

/**
 * Sidebar and approval center events are not replayed, so after a break in the stream the lists are read
 * again: the decision history and the letters too once they have been opened. Otherwise a card decided
 * on the phone while this window slept never shows up in the history.
 */
function resync(): void {
	void loadUpdates();
	void reloadSessions();
	void loadCenter();
	setState((current) => ({ letterTick: current.letterTick + 1 }));
	const state = getState();
	if (state.schedules) void loadSchedules();
	if (state.artifacts) void loadArtifacts();
	if (state.decisions.loaded) void loadDecisions();
	if (state.letters.loaded) void loadLetters();
}

/** The stream closed for good: the server restarted or the cookie expired. */
async function recover(): Promise<void> {
	try {
		await api("GET", "/api/settings");
		await reloadIfReplaced();
		const selected = getState().selectedId;
		if (selected) await selectSession(selected);
		else connect(null, null);
		resync();
	} catch (error) {
		if (error instanceof ApiError && error.status === 401) setState({ phase: "signin" });
		else setTimeout(() => void recover(), 3000);
	}
}

type GlobalEvent =
	| { type: "sessionSummary"; session: Session }
	| { type: "groups"; groups: Group[] }
	| { type: "approval"; approval: Approval }
	| { type: "letter"; letter: Letter }
	| { type: "card"; card: Card }
	| { type: "sessionsDeleted"; ids: string[] }
	| { type: "devices"; devices: Device[] }
	| { type: "schedules"; schedules: Schedule[] }
	| { type: "artifact"; artifact: Artifact }
	| { type: "artifactDeleted"; id: string };

/** Drops deleted sessions from every list; a deleted session that is open closes. */
export function dropSessions(ids: string[]): void {
	const gone = new Set(ids);
	setState((current) => ({
		sessions: Object.fromEntries(Object.entries(current.sessions).filter(([id]) => !gone.has(id))),
		hasArchived: Object.values(current.sessions).some(
			(session) => session.archivedAt !== null && !gone.has(session.id),
		),
	}));
	const selected = getState().selectedId;
	if (selected && gone.has(selected)) void selectSession(null);
}

function without<T>(record: Record<string, T>, id: string): Record<string, T> {
	if (!(id in record)) return record;
	const next = { ...record };
	delete next[id];
	return next;
}

function applyGlobalEvent(event: GlobalEvent): void {
	switch (event.type) {
		case "groups":
			setState({ groups: event.groups });
			return;
		case "sessionsDeleted":
			dropSessions(event.ids);
			return;
		case "devices":
			setState((current) => ({
				phones: current.phones ? { ...current.phones, devices: event.devices } : current.phones,
			}));
			return;
		case "schedules":
			setState({ schedules: event.schedules });
			return;
		case "artifact":
			setState((current) => ({
				artifacts: current.artifacts
					? [...current.artifacts.filter((a) => a.id !== event.artifact.id), event.artifact]
					: current.artifacts,
			}));
			return;
		case "artifactDeleted":
			setState((current) => ({
				artifacts: current.artifacts?.filter((a) => a.id !== event.id) ?? null,
				artifactId: current.artifactId === event.id ? null : current.artifactId,
			}));
			return;
		case "sessionSummary": {
			const previous = getState().sessions[event.session.id];
			setState((current) => ({
				sessions: { ...current.sessions, [event.session.id]: event.session },
			}));
			if (
				previous?.status === "working" &&
				(event.session.status === "idle" || event.session.status === "needs_review") &&
				event.session.archivedAt === null
			) {
				triggerReaction("proud", "companion_react_done", {
					params: { name: event.session.name },
					ms: 3600,
				});
			}
			return;
		}
		case "approval": {
			const approval = event.approval;
			setState((current) => ({
				center: {
					...current.center,
					approvals:
						approval.status === "pending"
							? { ...current.center.approvals, [approval.id]: approval }
							: without(current.center.approvals, approval.id),
				},
			}));
			return;
		}
		case "card": {
			const card = event.card;
			setState((current) => ({
				center: {
					...current.center,
					cards:
						card.status === "pending"
							? { ...current.center.cards, [card.id]: card }
							: without(current.center.cards, card.id),
				},
				decisions:
					card.status === "decided" && current.decisions.loaded
						? {
								...current.decisions,
								items: [card, ...current.decisions.items.filter((c) => c.id !== card.id)],
							}
						: current.decisions,
			}));
			return;
		}
		case "letter": {
			const letter = event.letter;
			setState((current) => {
				const items = current.letters.items;
				const index = items.findIndex((item) => item.id === letter.id);
				const next =
					index >= 0 ? items.map((item, i) => (i === index ? letter : item)) : [letter, ...items];
				return {
					center: {
						...current.center,
						held:
							letter.status === "held"
								? { ...current.center.held, [letter.id]: letter }
								: without(current.center.held, letter.id),
					},
					letters: current.letters.loaded ? { ...current.letters, items: next } : current.letters,
					letterTick: current.letterTick + 1,
				};
			});
			return;
		}
	}
}

function applySessionEvent(sessionId: string, event: SessionEvent): void {
	if (event.type === "session") {
		setState((current) => ({
			sessions: { ...current.sessions, [event.session.id]: event.session },
		}));
		return;
	}
	updateTranscript(sessionId, (t) => {
		switch (event.type) {
			case "entry":
				return {
					entries: upsertEntry(t.entries, event.entry),
					...(event.entry.role === "assistant" ? { draft: null } : {}),
					retry: null,
				};
			case "toolCall":
				return { toolCalls: { ...t.toolCalls, [event.toolCall.id]: event.toolCall } };
			case "approval":
				return { approvals: { ...t.approvals, [event.approval.id]: event.approval } };
			case "queue":
				return { queue: event.queue };
			case "rewound":
				// The stream sends this as a reset, which loads the transcript again.
				return {};
			case "remark":
				return { remarks: { ...t.remarks, [event.remark.id]: event.remark } };
			case "remarkGone": {
				const { [event.id]: _gone, ...remarks } = t.remarks;
				return { remarks };
			}
		}
	});
}

async function reloadSessions(): Promise<void> {
	const sessions = await all<Session>("/api/sessions");
	setState((current) => {
		const archived = Object.values(current.sessions).filter((s) => s.archivedAt !== null);
		return { sessions: Object.fromEntries([...archived, ...sessions].map((s) => [s.id, s])) };
	});
}

export function indexBy<T extends { id: string }>(items: T[]): Record<string, T> {
	return Object.fromEntries(items.map((item) => [item.id, item]));
}

/** Removes something the observing Yew said; the event that follows takes it off the page. */
export async function deleteRemark(sessionId: string, id: string): Promise<void> {
	await api("DELETE", `/api/sessions/${sessionId}/remarks/${id}`);
}

export async function loadTranscript(sessionId: string): Promise<number> {
	const data = await api<Transcript>("GET", `/api/sessions/${sessionId}/transcript?limit=150`);
	// A late answer for a session you have already left must not replace the open one.
	setState((current) => ({
		sessions: { ...current.sessions, [sessionId]: data.session },
		...(current.selectedId === sessionId
			? {
					transcript: {
						sessionId,
						entries: data.entries,
						toolCalls: indexBy(data.toolCalls),
						approvals: indexBy(data.approvals),
						queue: data.queue,
						remarks: indexBy(data.remarks ?? []),
						olderCursor: data.olderCursor,
						draft: null,
						retry: null,
						outputs: {},
					},
				}
			: {}),
	}));
	return data.session.eventSeq;
}

/** Opens a settings dialog over the conversation; the conversation stays where it is. */
export function openSettings(dialog: SettingsDialogName): void {
	setState({ settingsDialog: dialog });
}

export async function selectSession(sessionId: string | null): Promise<void> {
	setState({ selectedId: sessionId, transcript: null, page: null });
	remember(LAST_SESSION, sessionId);
	rememberView(sessionId ? `session:${sessionId}` : "home");
	if (!sessionId) {
		connect(null, null);
		return;
	}
	const seq = await loadTranscript(sessionId);
	if (getState().selectedId !== sessionId) return;
	connect(sessionId, seq);
	const session = getState().sessions[sessionId];
	if (session && session.unread > 0)
		void api("PATCH", `/api/sessions/${sessionId}`, { read: true });
}

export async function loadEarlier(): Promise<void> {
	const transcript = getState().transcript;
	if (!transcript?.olderCursor) return;
	const data = await api<Transcript>(
		"GET",
		`/api/sessions/${transcript.sessionId}/transcript?limit=150&before=${transcript.olderCursor}`,
	);
	updateTranscript(transcript.sessionId, (t) => ({
		entries: [
			...data.entries,
			...t.entries.filter((e) => !data.entries.some((d) => d.id === e.id)),
		],
		toolCalls: { ...indexBy(data.toolCalls), ...t.toolCalls },
		approvals: { ...indexBy(data.approvals), ...t.approvals },
		remarks: { ...indexBy(data.remarks ?? []), ...t.remarks },
		olderCursor: data.olderCursor,
	}));
}

/** Marks the open session read when new output arrives while it is on screen. */
export function markRead(sessionId: string): void {
	const session = getState().sessions[sessionId];
	if (session && session.unread > 0 && document.visibilityState === "visible") {
		void api("PATCH", `/api/sessions/${sessionId}`, { read: true });
	}
}

// --- the approval center and letters ---

export async function loadCenter(): Promise<void> {
	const center = await api<{ approvals: Approval[]; cards: Card[]; held: Letter[] }>(
		"GET",
		"/api/center",
	);
	const next: CenterState = {
		approvals: indexBy(center.approvals),
		cards: indexBy(center.cards),
		held: indexBy(center.held),
	};
	setState({ center: next });
}

/** Opens the approval center page in place of the session. */
export function openCenter(tab: CenterTab = getState().centerTab): void {
	setState({ page: "center", centerTab: tab, drawerOpen: false });
	rememberView(`center:${tab}`);
	// Read again on every visit: the list on screen stays until the fresh one arrives.
	if (tab === "letters") void loadLetters();
	if (tab === "decided") void loadDecisions();
}

export async function loadDecisions(more = false): Promise<void> {
	const cursor = more ? getState().decisions.nextCursor : null;
	const page = await api<Page<Card>>(
		"GET",
		`/api/cards?status=decided&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
	);
	setState((current) => ({
		decisions: {
			items: more ? [...current.decisions.items, ...page.items] : page.items,
			nextCursor: page.nextCursor,
			loaded: true,
		},
	}));
}

export async function loadLetters(more = false): Promise<void> {
	const cursor = more ? getState().letters.nextCursor : null;
	const page = await api<Page<Letter>>(
		"GET",
		`/api/letters?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
	);
	setState((current) => ({
		letters: {
			items: more ? [...current.letters.items, ...page.items] : page.items,
			nextCursor: page.nextCursor,
			loaded: true,
		},
	}));
}

export async function decideCard(cardId: string, choice: number | null, note: string | null) {
	const card = await api<Card>(
		"POST",
		`/api/cards/${cardId}/decide`,
		{ choice, ...(note ? { note } : {}) },
		{ idempotent: true },
	);
	triggerReaction("stamp", "companion_react_decided", { priority: true });
	return card;
}

export async function releaseLetter(id: string) {
	const letter = await api<Letter>("POST", `/api/letters/${id}/release`);
	triggerReaction("letter-run", "companion_react_released", { priority: true });
	return letter;
}

export async function refuseLetter(id: string) {
	const letter = await api<Letter>("POST", `/api/letters/${id}/refuse`);
	triggerReaction("halt", "companion_react_declined", { priority: true });
	return letter;
}

/** Makes a session the main conversation, or none. */
export async function setMainSession(sessionId: string | null): Promise<void> {
	await saveSettings({ mainSessionId: sessionId });
}

/** Opens a local file or folder clicked in a reply using the configured opener. */
export async function openLocalFileLink(
	path: string,
	options: { sessionId?: string | null; line?: number; column?: number } = {},
): Promise<void> {
	await api("POST", "/api/open-file", {
		path,
		...(options.sessionId ? { sessionId: options.sessionId } : {}),
		...(options.line !== undefined ? { line: options.line } : {}),
		...(options.column !== undefined ? { column: options.column } : {}),
	});
}

export function toolCallFor(
	calls: Record<string, ToolCallView>,
	messageId: string,
	callId: string,
): ToolCallView | undefined {
	return Object.values(calls).find(
		(call) => call.messageId === messageId && call.callId === callId,
	);
}
