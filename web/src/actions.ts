import type { AssistantMessage, AttachmentRef } from "../../src/shared/messages.ts";
import type {
	Approval,
	ApprovalDecision,
	Artifact,
	Card,
	Device,
	Entry,
	ExtraDir,
	Group,
	Letter,
	Page,
	PermissionMode,
	PermissionRule,
	QuestionAnswer,
	QueuedMessage,
	ReceivePolicy,
	Schedule,
	ScheduleMode,
	Session,
	SessionEvent,
	SessionKind,
	SessionMap,
	ThinkingLevel,
	ToolCallView,
	Transcript,
	UpdateState,
	UsageDetail,
	UsageOverview,
} from "../../src/shared/types.ts";
import { ApiError, all, api, downloadFile, uploadFile } from "./api.ts";
import { getLang, setLang, systemLang } from "./i18n.ts";
import {
	type CenterState,
	type CenterTab,
	type DataCleanup,
	type DataExport,
	type DataOverview,
	getState,
	MASCOT_KEY,
	type McpServerView,
	type ModelInfo,
	type PhonesState,
	type PingResult,
	type ProviderSummary,
	type SearchServiceView,
	type Settings,
	type SettingsDialogName,
	type SettingsPatch,
	type SkillList,
	type SkillView,
	type SystemStatus,
	setState,
	THEME_KEY,
	triggerReaction,
	updateTranscript,
	upsertEntry,
} from "./state.ts";

const LAST_SESSION = "yew.lastSession";

function remember(key: string, value: string | null): void {
	try {
		if (value === null) localStorage.removeItem(key);
		else localStorage.setItem(key, value);
	} catch {
		// Storage can be unavailable; it only holds conveniences.
	}
}

function recall(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

const VIEW = "yew.view";
const CENTER_TABS: readonly string[] = ["pending", "decided", "letters"];

/**
 * Where this tab is (a session, the approval center, the start page), so reloading the page returns
 * there. It lives as long as the tab: a new tab still opens on the main conversation.
 */
function rememberView(view: string): void {
	try {
		sessionStorage.setItem(VIEW, view);
	} catch {
		// Storage can be unavailable; the page then opens as on a fresh start.
	}
}

function recallView(): string | null {
	try {
		return sessionStorage.getItem(VIEW);
	} catch {
		return null;
	}
}

// --- appearance ---

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

/** The light or dark this browser saw chosen last; "system" when none. */
function rememberedTheme(): Settings["theme"] {
	try {
		const theme = localStorage.getItem(THEME_KEY);
		return theme === "light" || theme === "dark" ? theme : "system";
	} catch {
		return "system";
	}
}

/**
 * The page's background as its `theme-color` while the person has chosen light or dark: the Mac
 * app's window (macos/) takes it for its own and opens in it next time. Following the system, there
 * is none, and the window follows the system too.
 */
function setThemeColor(color: string | null): void {
	let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
	if (!color) {
		meta?.remove();
		return;
	}
	if (!meta) {
		meta = document.createElement("meta");
		meta.name = "theme-color";
		document.head.append(meta);
	}
	if (meta.content !== color) meta.content = color;
}

export function applyAppearance(settings: Settings | null): void {
	// Before the settings arrive, the theme chosen last in this browser, so the page does not start in
	// the system's and then turn.
	const theme = settings?.theme ?? rememberedTheme();
	const dark = theme === "dark" || (theme === "system" && darkQuery.matches);
	const root = document.documentElement;
	root.dataset.theme = dark ? "dark" : "light";
	setThemeColor(
		theme === "system" ? null : getComputedStyle(root).getPropertyValue("--bg").trim() || null,
	);
	const language = settings?.language ?? "system";
	setLang(language === "system" ? systemLang() : language);
	// The opening plays before the settings arrive, so this browser remembers when the mascot is off.
	if (settings) {
		try {
			if (settings.mascot === false) localStorage.setItem(MASCOT_KEY, "off");
			else localStorage.removeItem(MASCOT_KEY);
			if (settings.theme === "system") localStorage.removeItem(THEME_KEY);
			else localStorage.setItem(THEME_KEY, settings.theme);
		} catch {
			// Storage is off in this browser; the opening then stops once the settings arrive.
		}
	}
}

darkQuery.addEventListener("change", () => applyAppearance(getState().settings));

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
		// The About page and the floating Yew say when there is a new version (blueprint, "版本与更新").
		void loadUpdates();
		// The floating Yew is on duty while a scheduled task is on (blueprint, section 11).
		void loadSchedules().catch(() => {});
		setState({ booted: true });
		// A reload stays where the tab was. Otherwise Yew opens on the main conversation; without one,
		// where you left off (blueprint section 5).
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
function dropSessions(ids: string[]): void {
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

function indexBy<T extends { id: string }>(items: T[]): Record<string, T> {
	return Object.fromEntries(items.map((item) => [item.id, item]));
}

async function loadTranscript(sessionId: string): Promise<number> {
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

/** A copy of the session with its conversation, opened at once (blueprint section 8). */
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
 * at once (blueprint 6.11, item 39). Forked from your message, the message waits in its box.
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
 * the message box to be changed and sent again (blueprint 6.11, item 42).
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

/** Opens the approval center page in place of the session (blueprint section 8). */
export function openCenter(tab: CenterTab = getState().centerTab): void {
	setState({ page: "center", centerTab: tab, drawerOpen: false });
	rememberView(`center:${tab}`);
	// Read again on every visit: the list on screen stays until the fresh one arrives.
	if (tab === "letters") void loadLetters();
	if (tab === "decided") void loadDecisions();
}

// --- scheduled tasks (M3 plan, section 9) ---

/** The scheduled tasks page, in place of the session, like the approval center. */
export function openSchedules(): void {
	setState({ page: "schedules", drawerOpen: false });
	rememberView("schedules");
	if (!getState().schedules) void loadSchedules();
}

export function openArtifacts(): void {
	setState({ page: "artifacts", drawerOpen: false });
	rememberView("artifacts");
	if (!getState().artifacts) void loadArtifacts();
}

/** The usage page; it reads its own numbers each time it opens. */
export function openUsage(): void {
	setState({ page: "usage", drawerOpen: false });
	rememberView("usage");
}

/** The sessions map; it reads its letter lines each time it opens and when a letter changes. */
export function openMap(): void {
	setState({ page: "map", drawerOpen: false });
	rememberView("map");
}

/** Who wrote to whom in the last 24 hours, added up per pair, the busiest first. */
export const loadMap = () => api<SessionMap>("GET", "/api/map");

/** What all sessions together cost on each of the last days, oldest first, with the daily limit. */
export const loadUsage = (days = 30) => api<UsageOverview>("GET", `/api/usage?days=${days}`);

/** What each session used on one day (YYYY-MM-DD), the one that cost most first. */
export const loadUsageDay = (day: string) => api<UsageDetail>("GET", `/api/usage/${day}`);

/** Opens the artifacts page with one artifact showing. */
export function openArtifact(id: string): void {
	setState({ artifactId: id });
	openArtifacts();
}

export async function loadArtifacts(): Promise<void> {
	const page = await api<Page<Artifact>>("GET", "/api/artifacts?limit=500");
	setState({ artifacts: page.items });
}

export async function artifactVersions(
	id: string,
): Promise<{ version: number; size: number; createdAt: number }[]> {
	const result = await api<{ versions: { version: number; size: number; createdAt: number }[] }>(
		"GET",
		`/api/artifacts/${id}`,
	);
	return result.versions;
}

/** A version's text as it was saved. */
export async function artifactText(id: string, version: number): Promise<string> {
	const response = await fetch(`/api/artifacts/${id}/versions/${version}`, {
		credentials: "same-origin",
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return response.text();
}

export async function deleteArtifact(id: string): Promise<void> {
	await api("DELETE", `/api/artifacts/${id}`);
	setState((current) => ({
		artifacts: current.artifacts?.filter((a) => a.id !== id) ?? null,
		artifactId: current.artifactId === id ? null : current.artifactId,
	}));
}

export async function loadSchedules(): Promise<void> {
	const page = await api<Page<Schedule>>("GET", "/api/schedules");
	setState({ schedules: page.items });
}

export interface ScheduleInput {
	name: string;
	cron: string;
	session: string;
	message: string;
	permissionMode: PermissionMode | null;
	mode: ScheduleMode;
	autoArchive: boolean;
	catchUp: boolean;
}

function storeSchedule(schedule: Schedule): void {
	setState((current) => ({
		schedules: [...(current.schedules ?? []).filter((item) => item.id !== schedule.id), schedule],
	}));
}

export async function saveSchedule(
	id: string | null,
	input: Partial<ScheduleInput> & { enabled?: boolean },
): Promise<Schedule> {
	const schedule = id
		? await api<Schedule>("PATCH", `/api/schedules/${id}`, input)
		: await api<Schedule>("POST", "/api/schedules", input, { idempotent: true });
	storeSchedule(schedule);
	return schedule;
}

export async function runScheduleNow(id: string): Promise<void> {
	const result = await api<{ schedule: Schedule }>("POST", `/api/schedules/${id}/run`);
	storeSchedule(result.schedule);
}

export async function deleteSchedule(id: string): Promise<void> {
	await api("DELETE", `/api/schedules/${id}`);
	setState((current) => ({
		schedules: (current.schedules ?? []).filter((item) => item.id !== id),
	}));
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

/** Makes a session the main conversation, or none (blueprint section 5). */
export async function setMainSession(sessionId: string | null): Promise<void> {
	await saveSettings({ mainSessionId: sessionId });
}

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
	triggerReaction("books", "companion_react_renewed");
	return res;
}

export async function renewSession(sessionId: string, summarize = true) {
	const res = await api<{ status: "done" | "nothing" | "failed"; session: Session }>(
		"POST",
		`/api/sessions/${sessionId}/renew`,
		{ summarize },
	);
	if (res.status === "done") triggerReaction("books", "companion_react_renewed");
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

// --- providers, models, settings ---

export async function loadModels(provider: string): Promise<ModelInfo[]> {
	const cached = getState().models[provider];
	if (cached) return cached;
	const models = await all<ModelInfo>(`/api/providers/${encodeURIComponent(provider)}/models`);
	setState((current) => ({ models: { ...current.models, [provider]: models } }));
	return models;
}

export async function reloadProviders(): Promise<void> {
	const providers = await all<ProviderSummary>("/api/providers");
	setState({ providers, models: {} });
}

export async function saveKey(provider: string, key: string): Promise<void> {
	await api("PUT", `/api/providers/${encodeURIComponent(provider)}/key`, { key });
	await reloadProviders();
}

/** One short request with the stored key: whether it works, and how long the provider takes. */
export function testProvider(provider: string): Promise<PingResult> {
	return api<PingResult>("POST", `/api/providers/${encodeURIComponent(provider)}/test`, {});
}

export async function deleteKey(provider: string): Promise<void> {
	await api("DELETE", `/api/providers/${encodeURIComponent(provider)}/key`);
	await reloadProviders();
}

export async function saveCustomProvider(id: string, body: unknown): Promise<void> {
	await api("PUT", `/api/providers/${encodeURIComponent(id)}`, body);
	await reloadProviders();
}

export async function deleteCustomProvider(id: string): Promise<void> {
	await api("DELETE", `/api/providers/${encodeURIComponent(id)}`);
	await reloadProviders();
}

// --- search services, MCP servers, this computer (blueprint 6.10) ---

export const loadSearchServices = () => all<SearchServiceView>("/api/search-services");

export async function saveSearchKey(id: string, key: string): Promise<void> {
	await api("PUT", `/api/search-services/${encodeURIComponent(id)}/key`, { key });
}

export async function deleteSearchKey(id: string): Promise<void> {
	await api("DELETE", `/api/search-services/${encodeURIComponent(id)}/key`);
}

export const loadMcpServers = () => all<McpServerView>("/api/mcp");

export interface NewMcpServer {
	name: string;
	/** One of the presets Yew installs and runs, by its id. */
	preset?: string;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	oauth?: { clientId?: string; clientSecret?: string; scopes?: string[] };
}

/** Forgets the sign-in to an MCP server; it then waits to be signed in to again. */
export const signOutMcpServer = (name: string) =>
	api("POST", `/api/mcp/${encodeURIComponent(name)}/sign-out`);

export const addMcpServer = (server: NewMcpServer) =>
	api<McpServerView>("POST", "/api/mcp", server, { idempotent: true });

export const patchMcpServer = (
	name: string,
	patch: {
		disabled?: boolean;
		env?: Record<string, string | null>;
		headers?: Record<string, string | null>;
	},
) => api<McpServerView>("PATCH", `/api/mcp/${encodeURIComponent(name)}`, patch);

export async function removeMcpServer(name: string): Promise<void> {
	await api("DELETE", `/api/mcp/${encodeURIComponent(name)}`);
}

export const loadSkills = () => api<SkillList>("GET", "/api/skills");

export const patchSkill = (id: string, disabled: boolean) =>
	api<SkillView>("PATCH", "/api/skills", { id, disabled });

export async function revealSkill(id: string): Promise<void> {
	await api("POST", "/api/skills/reveal", { id });
}

export const loadData = () => api<DataOverview>("GET", "/api/data");

/** The system folder picker on the computer that runs Yew; null when the person cancels. */
export async function pickFolder(): Promise<string | null> {
	return (await api<{ path: string | null }>("POST", "/api/folders/pick")).path;
}

/** Writes everything Yew keeps into a new or empty folder, as `yew export` does. */
export const exportData = (folder: string) =>
	api<DataExport>("POST", "/api/data/export", { folder }, { idempotent: true });

/** Deletes the over-long command output; the person confirmed it first. */
export const cleanUpData = () =>
	api<DataCleanup>("POST", "/api/data/cleanup", undefined, { idempotent: true });

/** Shows the data folder, or the folder the last export went to, in the file manager. */
export async function revealData(target: "home" | "export"): Promise<void> {
	await api("POST", "/api/data/reveal", { target });
}

export const loadSystem = () => api<SystemStatus>("GET", "/api/system");

export const saveSystem = (patch: { startAtLogin?: boolean; launcher?: boolean }) =>
	api<SystemStatus>("PATCH", "/api/system", patch);

// --- phone access (M3 plan, section 6) ---

export async function loadPhones(): Promise<void> {
	setState({ phones: await api<PhonesState>("GET", "/api/devices") });
}

export async function setPhoneAccess(enabled: boolean): Promise<void> {
	const settings = await api<Settings>("PATCH", "/api/settings", { remote: { enabled } });
	setState({ settings });
	await loadPhones();
}

export async function createPairing(): Promise<{ link: string; svg: string; expiresAt: number }> {
	return api("POST", "/api/devices/pairing");
}

/** Whether Yew sends this phone notifications. */
export async function setDevicePush(id: string, push: boolean): Promise<void> {
	await api("PATCH", `/api/devices/${id}`, { push });
	await loadPhones();
}

export async function revokeDevice(id: string): Promise<void> {
	await api("DELETE", `/api/devices/${id}`);
	await loadPhones();
}

/** What was spent today, in US dollars: in all and by session. */
export const spentToday = () =>
	api<{ day: string; total: number; sessions: Record<string, number> }>("GET", "/api/usage/today");

export async function saveSettings(patch: SettingsPatch): Promise<void> {
	const settings = await api<Settings>("PATCH", "/api/settings", patch);
	setState({ settings });
	applyAppearance(settings);
	if (patch.updateCheck !== undefined) void loadUpdates();
}

// --- versions and updates ---

let updatesTimer: number | null = null;

/** Reads the versions and updates; while an update installs or a restart waits, again soon. */
export async function loadUpdates(): Promise<void> {
	try {
		setState({ updates: await api<UpdateState>("GET", "/api/updates") });
	} catch {
		// Not this computer's browser, or Yew Harness is restarting: nothing to show now.
	}
	followUpdates();
}

function followUpdates(): void {
	if (updatesTimer !== null) window.clearTimeout(updatesTimer);
	const updates = getState().updates;
	const soon = updates?.job?.state === "installing" || updates?.restartPending === true;
	updatesTimer = window.setTimeout(() => void loadUpdates(), soon ? 2000 : 30 * 60_000);
}

export async function checkUpdates(): Promise<void> {
	setState({ updates: await api<UpdateState>("POST", "/api/updates/check") });
	followUpdates();
}

export async function installUpdate(version: string): Promise<void> {
	setState({ updates: await api<UpdateState>("POST", "/api/updates/install", { version }) });
	followUpdates();
}

/** Restarts Yew Harness: at once, or once no session is at work. The page comes back by itself. */
export async function restartYew(now: boolean): Promise<void> {
	const answer = await api<UpdateState & { restarting: boolean }>("POST", "/api/updates/restart", {
		now,
	});
	const { restarting: _restarting, ...updates } = answer;
	setState({ updates });
	followUpdates();
}

/**
 * After the stream comes back: a Yew Harness that restarted on other code gets its page loaded
 * again, so the page matches it.
 */
async function reloadIfReplaced(): Promise<void> {
	const before = getState().health;
	if (!before) return;
	try {
		const now = await api<{ version: string; build?: string | null }>("GET", "/api/health");
		if (now.version !== before.version || (now.build ?? null) !== before.build) {
			window.location.reload();
		}
	} catch {
		// Still starting; the next reconnect asks again.
	}
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
