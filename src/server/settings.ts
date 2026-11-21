import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	DEFAULT_RELAY_URL,
	EXTRA_DIR_ACCESS,
	type ExtraDir,
	type ExtraDirAccess,
	type FileOpener,
	normalizePermissionMode,
	type PermissionMode,
	type ThinkingLevel,
} from "../shared/types.ts";
import { invalid } from "./errors.ts";
import { resolveWorkingFolder } from "./paths.ts";
import { canonical, isInside, isSecretPath } from "./permissions/paths.ts";
import type { Store } from "./store.ts";

/** Yew's settings: what the settings menu and new sessions read, shared by the API and manage_yew. */
export interface DefaultModel {
	provider: string;
	model: string;
	thinking: ThinkingLevel;
}

/** A saved working folder, offered first when you pick a folder for a session. */
export interface Workspace {
	id: string;
	name: string;
	path: string;
}

/** Which kinds of events notify the phone. All on unless turned off. */
export const NOTIFY_KINDS = ["waiting", "error", "task", "budget"] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];
export type NotifySettings = Record<NotifyKind, boolean>;

export const SETTING_DEFAULTS = {
	defaultModel: {
		provider: "deepseek",
		model: "deepseek-v4-pro",
		thinking: "medium",
	} as DefaultModel,
	theme: "system" as "system" | "light" | "dark",
	language: "system" as "system" | "zh" | "en",
	workspaces: [] as Workspace[],
	/** The main conversation. */
	mainSessionId: null as string | null,
	/** A Markdown file each decision is added to. */
	decisionLog: null as string | null,
	/** Phones reach this Mac through the relay. */
	remote: { enabled: false, relayUrl: DEFAULT_RELAY_URL } as RemoteSettings,
	/** The most all sessions together may spend in a day, in US dollars. */
	dailyBudget: null as number | null,
	/** Folders of notes sessions may read, such as ~/memory. */
	memoryDirs: [] as string[],
	/** The permission mode new sessions start with. */
	defaultPermissionMode: "default" as PermissionMode,
	/** The saved workspace the interface preselects for a new session; null for none. */
	defaultWorkspaceId: null as string | null,
	notify: { waiting: true, error: true, task: true, budget: true } as NotifySettings,
	/** Skills switched off in the settings, each by its folder's real path. */
	disabledSkills: [] as string[],
	/** Yew in the interface: floating over the window, the opening and the rest. */
	mascot: true as boolean,
	/** Whether the opening leaves by itself once started, or waits for a click. */
	opening: "auto" as OpeningMode,
	/**
	 * Whether commands in the system sandbox may use the SSH agent and the usual credential files;
	 * off by default for security.
	 */
	sandboxCredentials: false as boolean,
	/**
	 * Folders sessions may not read, besides credentials and Yew Harness's own data: file tools refuse
	 * them, searches leave them out, and the system sandbox closes them.
	 */
	hiddenFolders: [] as string[],
	/** Additional domains all sandboxed commands may reach without asking. */
	sandboxAllowedDomains: [] as string[],
	/**
	 * Whether automatic permission review (`review` mode) may read the person's original message in the
	 * main conversation when checking a step triggered by a delegated letter.
	 */
	reviewTraceMain: true as boolean,
	/**
	 * Which browser the built-in browser server drives: the person's own Chrome through Playwright's
	 * extension, with their sign-ins, or a separate window of its own.
	 */
	browser: "own" as BrowserMode,
	/** Whether Yew Harness asks npm for a new version once a day. */
	updateCheck: true as boolean,
	/** Program used to open local file links clicked in replies (system default, VS Code, Cursor, Zed or Finder). */
	fileOpener: "system" as FileOpener,
};

export const BROWSER_MODES = ["own", "separate"] as const;
export type BrowserMode = (typeof BROWSER_MODES)[number];

export const OPENING_MODES = ["auto", "click"] as const;
export type OpeningMode = (typeof OPENING_MODES)[number];

export interface RemoteSettings {
	enabled: boolean;
	relayUrl: string;
}

export type Settings = typeof SETTING_DEFAULTS;

export function readSettings(store: Store): Settings {
	const workspaces = store.getSetting("workspaces", SETTING_DEFAULTS.workspaces);
	const defaultWorkspaceId = store.getSetting(
		"defaultWorkspaceId",
		SETTING_DEFAULTS.defaultWorkspaceId,
	);
	return {
		defaultModel: store.getSetting("defaultModel", SETTING_DEFAULTS.defaultModel),
		theme: store.getSetting("theme", SETTING_DEFAULTS.theme),
		language: store.getSetting("language", SETTING_DEFAULTS.language),
		workspaces,
		mainSessionId: store.getSetting("mainSessionId", SETTING_DEFAULTS.mainSessionId),
		decisionLog: store.getSetting("decisionLog", SETTING_DEFAULTS.decisionLog),
		remote: { ...SETTING_DEFAULTS.remote, ...store.getSetting("remote", SETTING_DEFAULTS.remote) },
		dailyBudget: store.getSetting("dailyBudget", SETTING_DEFAULTS.dailyBudget),
		memoryDirs: store.getSetting("memoryDirs", SETTING_DEFAULTS.memoryDirs),
		defaultPermissionMode:
			normalizePermissionMode(store.getSetting("defaultPermissionMode", null)) ??
			SETTING_DEFAULTS.defaultPermissionMode,
		// A workspace that was removed is no longer the default.
		defaultWorkspaceId: workspaces.some((workspace) => workspace.id === defaultWorkspaceId)
			? defaultWorkspaceId
			: null,
		notify: { ...SETTING_DEFAULTS.notify, ...store.getSetting("notify", SETTING_DEFAULTS.notify) },
		disabledSkills: store.getSetting("disabledSkills", SETTING_DEFAULTS.disabledSkills),
		mascot: store.getSetting("mascot", SETTING_DEFAULTS.mascot),
		opening: store.getSetting("opening", SETTING_DEFAULTS.opening),
		sandboxCredentials: store.getSetting("sandboxCredentials", SETTING_DEFAULTS.sandboxCredentials),
		hiddenFolders: store.getSetting("hiddenFolders", SETTING_DEFAULTS.hiddenFolders),
		sandboxAllowedDomains: store.getSetting(
			"sandboxAllowedDomains",
			SETTING_DEFAULTS.sandboxAllowedDomains,
		),
		reviewTraceMain: store.getSetting("reviewTraceMain", SETTING_DEFAULTS.reviewTraceMain),
		browser: store.getSetting("browser", SETTING_DEFAULTS.browser),
		updateCheck: store.getSetting("updateCheck", SETTING_DEFAULTS.updateCheck),
		fileOpener: store.getSetting("fileOpener", SETTING_DEFAULTS.fileOpener),
	};
}

/**
 * A folder kept from sessions, as saved: absolute, `~` expanded, links resolved where it exists. It
 * may not exist yet. The root and the home folder are refused: they would hide everything.
 */
export function resolveHiddenFolder(path: string, userHome = homedir()): string {
	const trimmed = path.trim();
	const expanded =
		trimmed === "~" || trimmed.startsWith("~/") ? join(userHome, trimmed.slice(2)) : trimmed;
	if (!isAbsolute(expanded)) {
		throw invalid("A folder kept from sessions must be an absolute path.", "hiddenFolders");
	}
	const resolved = canonical(resolve(expanded));
	if (resolved === "/" || resolved === canonical(userHome)) {
		throw invalid(`${path} would hide everything; name a folder inside it.`, "hiddenFolders");
	}
	return resolved;
}

/** The decision log must be a Markdown file in an existing folder; `~` is expanded. */
export function resolveLogFile(path: string): string {
	const expanded = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
	if (!isAbsolute(expanded))
		throw invalid("The decision log must be an absolute path.", "decisionLog");
	if (!/\.(md|markdown)$/i.test(expanded)) {
		throw invalid("The decision log must be a Markdown file (.md).", "decisionLog");
	}
	let folder: string;
	try {
		folder = realpathSync(dirname(expanded));
	} catch {
		throw invalid(`The folder ${dirname(path)} does not exist.`, "decisionLog");
	}
	const file = join(folder, basename(expanded));
	if (existsSync(file) && !statSync(file).isFile()) {
		throw invalid(`${path} is not a file.`, "decisionLog");
	}
	return file;
}

const MAX_SANDBOX_DOMAINS = 50;
const MAX_EXTRA_DIRS = 10;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const FORBIDDEN_DOMAIN_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"];

/**
 * Validates one sandbox allowlist domain (`example.com` or `*.example.com`). Refuses IPs, bare
 * wildcards, single-label wildcards (`*.com`), local/private names, schemes, ports and paths.
 */
export function validateSandboxDomain(raw: unknown, field = "sandboxAllowedDomains"): string {
	if (typeof raw !== "string") throw invalid("Each domain must be text.", field);
	const domain = raw.trim().toLowerCase().replace(/\.$/, "");
	if (!domain || domain.length > 253) {
		throw invalid(`"${String(raw)}" is not a valid domain name.`, field);
	}
	if (/[\s/:@\\[\]]/.test(domain) || domain === "*") {
		throw invalid(
			`"${domain}" must be a bare domain or wildcard like *.example.com (no protocol, port or path).`,
			field,
		);
	}
	const wildcard = domain.startsWith("*.");
	const host = wildcard ? domain.slice(2) : domain;
	if (!host || host.includes("*")) {
		throw invalid(`"${domain}" has an invalid wildcard; use *.example.com.`, field);
	}
	if (
		host === "localhost" ||
		FORBIDDEN_DOMAIN_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
		/^\d+(?:\.\d+){1,3}$/.test(host) ||
		/^(?:0x[0-9a-f]+|\d+)$/.test(host)
	) {
		throw invalid(
			`"${domain}" cannot be added: local addresses and IP literals stay blocked.`,
			field,
		);
	}
	const labels = host.split(".");
	if (labels.length < 2) {
		throw invalid(
			`"${domain}" must include at least two domain labels (for example, example.com).`,
			field,
		);
	}
	if (labels.some((label) => !DOMAIN_LABEL.test(label))) {
		throw invalid(`"${domain}" is not a valid domain name.`, field);
	}
	return wildcard ? `*.${host}` : host;
}

export function parseSandboxDomains(value: unknown[], field = "sandboxAllowedDomains"): string[] {
	if (value.length > MAX_SANDBOX_DOMAINS) {
		throw invalid(`At most ${MAX_SANDBOX_DOMAINS} domains can be allowed.`, field);
	}
	const out: string[] = [];
	for (const item of value) {
		if (typeof item === "string" && !item.trim()) continue;
		out.push(validateSandboxDomain(item, field));
	}
	return [...new Set(out)];
}

/**
 * Checks additional workspace folders for a session: existing directories only, canonicalized,
 * never `/` or the home directory, and never inside credentials, Yew's data or hidden folders.
 */
export function parseExtraDirs(
	value: unknown[],
	options: { offLimits: string[]; userHome?: string; field?: string },
): ExtraDir[] {
	const field = options.field ?? "extraDirs";
	if (value.length > MAX_EXTRA_DIRS) {
		throw invalid(`At most ${MAX_EXTRA_DIRS} additional folders can be added.`, field);
	}
	const home = canonical(options.userHome ?? homedir());
	const byPath = new Map<string, ExtraDirAccess>();
	for (const item of value) {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw invalid("Each additional folder must be an object with path and access.", field);
		}
		const fields = item as Record<string, unknown>;
		if (typeof fields.path !== "string" || !fields.path.trim()) {
			throw invalid("Each additional folder needs a path.", field);
		}
		const access = fields.access;
		if (typeof access !== "string" || !(EXTRA_DIR_ACCESS as readonly string[]).includes(access)) {
			throw invalid("access must be read or write.", field);
		}
		const raw = fields.path.trim();
		const expanded =
			raw === "~" || raw.startsWith("~/") ? join(options.userHome ?? homedir(), raw.slice(2)) : raw;
		let resolved: string;
		try {
			resolved = resolveWorkingFolder(expanded);
		} catch (error) {
			throw invalid((error as Error).message, field);
		}
		if (resolved === "/" || resolved === home) {
			throw invalid(`${raw} is too broad; pick a specific folder inside it.`, field);
		}
		// Not a protected place, not a folder that holds one (/Users or ~/.config written to would
		// reach them), not ~/Library (LaunchAgents, app data) and not a hidden folder of the home
		// folder, read-only included.
		const holdsSecret = options.offLimits.some((secret) => isInside(secret, resolved));
		const library = isInside(resolved, join(home, "Library"));
		const dotFolder =
			isInside(resolved, home) && resolved !== home && relative(home, resolved).startsWith(".");
		if (isSecretPath(resolved, options.offLimits) || holdsSecret || library || dotFolder) {
			throw invalid(`${raw} is protected or hidden and cannot be added to a session.`, field);
		}
		const existing = byPath.get(resolved);
		if (!existing || access === "write") byPath.set(resolved, access as ExtraDirAccess);
	}
	return [...byPath.entries()].map(([path, access]) => ({ path, access }));
}
