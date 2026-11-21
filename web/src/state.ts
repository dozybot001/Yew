import { useSyncExternalStore } from "react";
import type { AssistantMessage } from "../../src/shared/messages.ts";
import type {
	Approval,
	Artifact,
	Card,
	Device,
	Entry,
	FileOpener,
	Group,
	Letter,
	PermissionMode,
	QueuedMessage,
	Schedule,
	Session,
	ThinkingLevel,
	ToolCallView,
	UpdateState,
} from "../../src/shared/types.ts";
import type { MessageKey } from "./i18n.ts";
import type { MascotPose } from "./poses.ts";

/** Short-lived reaction shown by the floating Yew after a workbench action. */
export interface MascotReaction {
	pose: MascotPose;
	key: MessageKey;
	params?: Record<string, string | number>;
	until: number;
	/** Priority reactions (like stamping/blocking an approval) show even when more items wait. */
	priority?: boolean;
}

export interface Settings {
	defaultModel: { provider: string; model: string; thinking: ThinkingLevel };
	theme: "system" | "light" | "dark";
	language: "system" | "zh" | "en";
	workspaces: Workspace[];
	mainSessionId: string | null;
	decisionLog: string | null;
	/** Phones reach this Mac through the relay (M3 plan, section 6). */
	remote: { enabled: boolean; relayUrl: string };
	/** The most all sessions together may spend in a day, in US dollars. */
	dailyBudget: number | null;
	/** Folders of notes sessions may read, such as ~/memory. */
	memoryDirs: string[];
	/** The permission mode new sessions start with. */
	defaultPermissionMode: PermissionMode;
	/** The saved workspace preselected for a new session; null for none. */
	defaultWorkspaceId: string | null;
	/** Which kinds of events notify the phone. */
	notify: Record<NotifyKind, boolean>;
	/** Yew in the interface: floating over the window, the opening and the rest (blueprint, section 12). */
	mascot: boolean;
	/** The opening leaves by itself once started, or waits for a click (blueprint 6.10, item 45). */
	opening: "auto" | "click";
	/** Whether commands in the system sandbox may use SSH and credential files (blueprint, section 11). */
	sandboxCredentials: boolean;
	/** Folders sessions may not read: file tools refuse them, the system sandbox closes them. */
	hiddenFolders: string[];
	/** Additional domains all sandboxed commands may reach without asking. */
	sandboxAllowedDomains: string[];
	/** Whether automatic permission check may trace the person's original message in the main conversation. */
	reviewTraceMain: boolean;
	/** The built-in browser drives the person's own Chrome, or a separate window of its own. */
	browser: "own" | "separate";
	/** Yew Harness asks npm for a new version once a day (blueprint, "版本与更新"). */
	updateCheck: boolean;
	/** Default program used when clicking a local file link in replies. */
	fileOpener: FileOpener;
}

/** This browser remembers "off" here, so the opening knows before the settings arrive. */
export const MASCOT_KEY = "yew.mascot";
/** This browser remembers a chosen light or dark here, so the first frame is already in it. */
export const THEME_KEY = "yew.theme";

export const NOTIFY_KINDS = ["waiting", "error", "task", "budget"] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/** What PATCH /api/settings takes: `notify` may name some kinds, the relay may be null for the default. */
export type SettingsPatch = Partial<Omit<Settings, "notify" | "remote">> & {
	notify?: Partial<Record<NotifyKind, boolean>>;
	remote?: { enabled?: boolean; relayUrl?: string | null };
};

/** An MCP server from mcp.json with its connection; values of variables and headers never arrive. */
export interface McpServerView {
	name: string;
	kind: "stdio" | "http";
	/** Set up by Yew itself: it can be turned off, not removed. */
	builtin: boolean;
	disabled: boolean;
	command: string | null;
	args: string[];
	envNames: string[];
	url: string | null;
	headerNames: string[];
	state: "connecting" | "ready" | "error" | "disabled" | "sign-in";
	error: string | null;
	tools: string[];
	/** Yew holds a sign-in for it (blueprint 6.11, item 40). */
	signedIn: boolean;
	/** The site the browser goes to to sign in, once Yew has found it. */
	signInAt?: string;
	/** Its entry names a client of the person's to sign in with. */
	oauthClient: boolean;
	/** One of the presets Yew installs: the npm package and version it runs. */
	package?: string;
}

/** Where a skill comes from: official built-in, the global folders, or a saved workspace's. */
export type SkillSource =
	| { kind: "builtin" }
	| { kind: "global" }
	| { kind: "workspace"; name: string; path: string };

/** A skill folder Yew found; `problem` says why one could not be read, and such a row has no switch. */
export interface SkillView {
	/** The folder's real path. */
	id: string;
	name: string;
	description: string;
	dir: string;
	source: SkillSource;
	disabled: boolean;
	problem: "no-file" | "unreadable" | "bad-name" | null;
}

export interface SkillList {
	items: SkillView[];
	/** The folders read, in the order the list is grouped. */
	folders: { source: SkillSource; paths: string[] }[];
	/** Which file manager can show a folder on this computer; null when Yew knows none. */
	reveal: "finder" | "files" | null;
}

/** A web search service and whether its key is in the keychain. */
export interface SearchServiceView {
	id: string;
	name: string;
	region: "cn" | "global";
	hasKey: boolean;
	/** The one web search uses now. */
	active: boolean;
	/** It uses this model provider's key, set under Providers and keys. */
	provider: string | null;
}

/** Starting at login and the launcher icon on this computer. */
export interface SystemStatus {
	startAtLogin: { supported: boolean; on: boolean; file: string | null };
	launcher: { supported: boolean; on: boolean; path: string | null };
}

/** Paired phones and the relay connection, for the phone access dialog. */
export interface PhonesState {
	devices: Device[];
	remote: {
		enabled: boolean;
		connected: boolean;
		relayUrl: string;
		desktopId: string | null;
	} | null;
}

/** Everything waiting for the person, across sessions (M2 plan, section 5). */
export interface CenterState {
	approvals: Record<string, Approval>;
	cards: Record<string, Card>;
	held: Record<string, Letter>;
}

/** A list read a page at a time, newest first: all letters, or the decisions made. */
export interface PagedList<T> {
	items: T[];
	nextCursor: string | null;
	loaded: boolean;
}

export type CenterTab = "pending" | "decided" | "letters";

/** A saved working folder. */
export interface Workspace {
	id: string;
	name: string;
	path: string;
}

export interface ProviderSummary {
	id: string;
	name: string;
	region: "cn" | "global" | "custom";
	baseUrl: string;
	keyRequired: boolean;
	custom: boolean;
	hasKey: boolean;
	modelCount: number;
}

/** What one short request to a provider came to. */
export interface PingResult {
	ok: boolean;
	model: string;
	firstMs: number | null;
	totalMs: number;
	error?: string;
}

export interface ModelInfo {
	provider: string;
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	thinkingLevels: ThinkingLevel[];
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	latest?: boolean;
}

export interface TranscriptState {
	sessionId: string;
	entries: Entry[];
	toolCalls: Record<string, ToolCallView>;
	approvals: Record<string, Approval>;
	queue: QueuedMessage[];
	olderCursor: number | null;
	draft: AssistantMessage | null;
	/** A model request that failed and is being tried again; gone when the answer starts. */
	retry: { attempt: number; of: number; seconds: number; text: string } | null;
	outputs: Record<string, string>;
}

/** What Yew's data folder takes, by kind; `reveal` names the file manager, null where there is none. */
export type DataPartId = "database" | "artifacts" | "attachments" | "logs" | "temp" | "other";
export interface DataOverview {
	folder: string;
	totalBytes: number;
	parts: { id: DataPartId; bytes: number }[];
	/** Over-long command output: all of it, and what a cleanup would delete now. */
	temp: { files: number; bytes: number; removableFiles: number; removableBytes: number };
	reveal: "finder" | "files" | null;
	readAt: number;
}

/** What an export wrote, as `yew export --json` prints it. */
export interface DataExport {
	folder: string;
	sessions: number;
	letters: number;
	cards: number;
	schedules: number;
	artifacts: number;
	attachments: number;
	files: number;
}

export interface DataCleanup {
	deletedFiles: number;
	freedBytes: number;
	skippedFiles: number;
}

/** The settings window's sections (blueprint 6.10, item 45). */
export type SettingsDialogName =
	| "personal"
	| "providers"
	| "mcp"
	| "skills"
	| "data"
	| "defaults"
	| "phones"
	| "system"
	| "about";

export interface AppState {
	phase: "loading" | "signin" | "ready" | "failed";
	/** Set once the start has also read the approval center; the opening's last step. */
	booted: boolean;
	failure: string | null;
	connection: "open" | "connecting";
	health: {
		version: string;
		build: string | null;
		/** The system sandbox sessions' commands run in; "none" while it is off (blueprint, section 11). */
		sandbox?: "macos" | "linux" | "none";
	} | null;
	settings: Settings | null;
	/** Versions and updates; null until read, and in a browser that cannot read them. */
	updates: UpdateState | null;
	groups: Group[];
	sessions: Record<string, Session>;
	providers: ProviderSummary[];
	models: Record<string, ModelInfo[]>;
	selectedId: string | null;
	transcript: TranscriptState | null;
	showArchived: boolean;
	/** True once any session is archived; the sidebar only offers "show archived" then. */
	hasArchived: boolean;
	/** The main area shows a session, or the settings page. */
	/** A settings dialog opened from the settings menu, over the conversation. */
	settingsDialog: SettingsDialogName | null;
	phones: PhonesState | null;
	/** A folder the home page should preselect, set when you open a workspace from the sidebar. */
	homeFolder: string | null;
	/** Wide screens: the sidebar folded to a narrow rail (remembered in this browser). */
	sidebarCollapsed: boolean;
	/** The sidebar lists folded to their heading (remembered in this browser). */
	foldedSections: SidebarSection[];
	/** Conversation timeline view: false for concise (default), true for full audit notices & notes. */
	transcriptDetail: boolean;
	/** Narrow screens: the sidebar drawer is open. */
	drawerOpen: boolean;
	center: CenterState;
	letters: PagedList<Letter>;
	decisions: PagedList<Card>;
	/**
	 * The approval center is a page of its own: you go there to clear what waits across sessions, and
	 * into a session to work on one thing. Null shows the session or home.
	 */
	page: "center" | "schedules" | "artifacts" | "usage" | "map" | null;
	centerTab: CenterTab;
	/** Scheduled tasks, read when their page first opens; null until then. */
	schedules: Schedule[] | null;
	/** Artifacts, read when their page first opens; null until then. The open one's id. */
	artifacts: Artifact[] | null;
	artifactId: string | null;
	/**
	 * The sessions list shows one team's sessions, or with NO_TEAM those in no team; null shows all
	 * (blueprint section 8).
	 */
	teamFilter: string | null;
	/**
	 * Goes up with every letter that is sent or changes state, and when the event stream reconnects:
	 * the sessions map reads its letter lines again when it does.
	 */
	letterTick: number;
	/** Text to put in a session's message box when it opens: a message taken back or forked from. */
	prefill: Record<string, string>;
	/** What the floating Yew says for a moment after a workbench event. */
	reaction: MascotReaction | null;
}

/** How many things wait for the person: approvals, questions, cards and held letters. */
export function centerCount(center: CenterState): number {
	return (
		Object.keys(center.approvals).length +
		Object.keys(center.cards).length +
		Object.keys(center.held).length
	);
}

/** The sidebar's three lists; each folds to its heading on its own. */
export type SidebarSection = "teams" | "workspaces" | "sessions";

/** The team filter's value for the sessions in no team; no team's id looks like it. */
export const NO_TEAM = "(none)";

const SIDEBAR_KEY = "yew.sidebar";
const SECTIONS_KEY = "yew.sidebarFolded";
const SECTIONS: SidebarSection[] = ["teams", "workspaces", "sessions"];
const TRANSCRIPT_DETAIL_KEY = "yew.transcriptDetail";

function rememberedCollapse(): boolean {
	try {
		return localStorage.getItem(SIDEBAR_KEY) === "collapsed";
	} catch {
		return false;
	}
}

function rememberedFolded(): SidebarSection[] {
	try {
		const saved = (localStorage.getItem(SECTIONS_KEY) ?? "").split(",");
		return SECTIONS.filter((section) => saved.includes(section));
	} catch {
		return [];
	}
}

function rememberedTranscriptDetail(): boolean {
	try {
		return localStorage.getItem(TRANSCRIPT_DETAIL_KEY) === "1";
	} catch {
		return false;
	}
}

/** Folds or unfolds the sidebar on wide screens, and remembers it in this browser only. */
export function setSidebarCollapsed(collapsed: boolean): void {
	setState({ sidebarCollapsed: collapsed });
	try {
		if (collapsed) localStorage.setItem(SIDEBAR_KEY, "collapsed");
		else localStorage.removeItem(SIDEBAR_KEY);
	} catch {
		// Storage can be unavailable (private windows); the choice then lasts for this page only.
	}
}

/** Folds one sidebar list to its heading or opens it again, and remembers it in this browser only. */
export function setSectionFolded(section: SidebarSection, folded: boolean): void {
	const others = state.foldedSections.filter((name) => name !== section);
	const next = folded ? [...others, section] : others;
	setState({ foldedSections: next });
	try {
		if (next.length > 0) localStorage.setItem(SECTIONS_KEY, next.join(","));
		else localStorage.removeItem(SECTIONS_KEY);
	} catch {
		// Storage can be unavailable (private windows); the choice then lasts for this page only.
	}
}

/** Toggles between concise and detailed conversation timeline, remembered in this browser only. */
export function setTranscriptDetail(detailed: boolean): void {
	setState({ transcriptDetail: detailed });
	try {
		if (detailed) localStorage.setItem(TRANSCRIPT_DETAIL_KEY, "1");
		else localStorage.removeItem(TRANSCRIPT_DETAIL_KEY);
	} catch {
		// Storage can be unavailable (private windows); the choice then lasts for this page only.
	}
}

let state: AppState = {
	phase: "loading",
	booted: false,
	failure: null,
	// Only a stream that was open and then dropped shows the reconnecting banner.
	connection: "open",
	health: null,
	settings: null,
	updates: null,
	groups: [],
	sessions: {},
	providers: [],
	models: {},
	selectedId: null,
	transcript: null,
	showArchived: false,
	hasArchived: false,
	settingsDialog: null,
	phones: null,
	homeFolder: null,
	sidebarCollapsed: rememberedCollapse(),
	foldedSections: rememberedFolded(),
	transcriptDetail: rememberedTranscriptDetail(),
	drawerOpen: false,
	center: { approvals: {}, cards: {}, held: {} },
	letters: { items: [], nextCursor: null, loaded: false },
	decisions: { items: [], nextCursor: null, loaded: false },
	page: null,
	centerTab: "pending",
	schedules: null,
	artifacts: null,
	artifactId: null,
	teamFilter: null,
	prefill: {},
	letterTick: 0,
	reaction: null,
};

let reactionTimer: ReturnType<typeof setTimeout> | null = null;

/** Shows a brief work-state reaction from the floating Yew, then returns to live status. */
export function triggerReaction(
	pose: MascotPose,
	key: MessageKey,
	options?: {
		params?: Record<string, string | number>;
		ms?: number;
		priority?: boolean;
	},
): void {
	if (state.settings?.mascot === false) return;
	const ms = options?.ms ?? 3200;
	const until = Date.now() + ms;
	if (reactionTimer) clearTimeout(reactionTimer);
	setState({
		reaction: {
			pose,
			key,
			...(options?.params ? { params: options.params } : {}),
			...(options?.priority ? { priority: true } : {}),
			until,
		},
	});
	reactionTimer = setTimeout(() => {
		reactionTimer = null;
		if (state.reaction && state.reaction.until <= Date.now()) {
			setState({ reaction: null });
		}
	}, ms + 60);
}

const listeners = new Set<() => void>();

export function getState(): AppState {
	return state;
}

export function setState(
	update: Partial<AppState> | ((current: AppState) => Partial<AppState>),
): void {
	const patch = typeof update === "function" ? update(state) : update;
	state = { ...state, ...patch };
	for (const listener of listeners) listener();
}

/** Updates the open transcript, if it is the given session's. */
export function updateTranscript(
	sessionId: string,
	fn: (current: TranscriptState) => Partial<TranscriptState>,
): void {
	setState((current) => {
		const transcript = current.transcript;
		if (!transcript || transcript.sessionId !== sessionId) return {};
		return { transcript: { ...transcript, ...fn(transcript) } };
	});
}

/** Selectors must return values taken from the state (not new objects), so React can compare them. */
export function useAppState<T>(selector: (current: AppState) => T): T {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => selector(state),
	);
}

export function upsertEntry(entries: Entry[], entry: Entry): Entry[] {
	const index = entries.findIndex((existing) => existing.id === entry.id);
	if (index >= 0) {
		const next = entries.slice();
		next[index] = entry;
		return next;
	}
	const last = entries.at(-1);
	if (!last || last.seq < entry.seq) return [...entries, entry];
	return [...entries, entry].sort((a, b) => a.seq - b.seq);
}
