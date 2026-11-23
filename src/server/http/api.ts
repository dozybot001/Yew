import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { Hono } from "hono";
import { RELAY_URL } from "../../remote/protocol.ts";
import type {
	PermissionRule,
	Session,
	SessionOptions,
	Transcript,
	UsageDetail,
	UsageOverview,
} from "../../shared/types.ts";
import {
	DEFAULT_RELAY_URL,
	FILE_OPENERS,
	PERMISSION_MODES,
	RECEIVE_POLICIES,
	SESSION_KINDS,
	THINKING_LEVELS,
} from "../../shared/types.ts";
import { isBudget, isDay, lastDays, localDay } from "../budget.ts";
import { invalid, notFound, YewError } from "../errors.ts";
import { type ExportLanguage, exportFileName, sessionMarkdown } from "../export.ts";
import { pickFolder } from "../folder-picker.ts";
import { resolveWorkingFolder } from "../paths.ts";
import { canonical, isSecretPath, secretLocations } from "../permissions/paths.ts";
import { openLocalFile, type RunCommand } from "../reveal.ts";
import type { RoleFiles, RoleFilesState } from "../role-files.ts";
import {
	BROWSER_MODES,
	type DefaultModel,
	NOTIFY_KINDS,
	OPENING_MODES,
	parseExtraDirs,
	parseSandboxDomains,
	readSettings,
	resolveHiddenFolder,
	resolveLogFile,
	resolveRolesFolder,
	type SideModel,
	type Workspace,
} from "../settings.ts";
import { findSkills, resolveMemoryDir } from "../skills.ts";
import type { SessionPatch, Store } from "../store.ts";
import { listSessionFiles, resolveOpenFileTarget } from "./files.ts";
import { idempotent } from "./idempotency.ts";
import {
	type Fields,
	optArray,
	optBoolean,
	optEnum,
	optIntQuery,
	optNullableString,
	optNumber,
	optObject,
	optString,
	pageParams,
	readJson,
	reqString,
} from "./input.ts";
import type { AppEnv } from "./problem.ts";

/** Checks that a provider and model exist; supplied by the model layer. */
export type ModelCheck = (provider: string, model: string) => void;

export interface ApiDeps {
	store: Store;
	/** Yew's data directory; used when validating extraDirs and listing session skills. */
	yewHome?: string;
	/** The person's home folder; overridden in tests so they never read real ~/.claude/skills. */
	userHome?: string | null;
	checkModel?: ModelCheck;
	/** Opens the system folder picker; replaced in tests so they never open a window. */
	pickFolder?: () => Promise<string | null>;
	/** Runs the editor/file-manager command for POST /api/open-file; replaced in tests. */
	openFile?: RunCommand;
	/** Overrides process.platform for POST /api/open-file tests. */
	platform?: string;
	/** A session was archived: the runner drops letters waiting for it. */
	onArchived?: (sessionId: string) => void;
	/** Phone access was turned on or off, or the relay changed. */
	onRemoteChanged?: () => void;
	/** The built-in browser server is to drive another browser: it is started again. */
	onBrowserChanged?: () => void;
	/** Writes the roles folder (role-files.ts). */
	roleFiles?: RoleFiles;
}

const RULE_EFFECTS = ["allow", "ask", "deny"] as const;

export function parseRules(value: unknown[]): PermissionRule[] {
	return value.map((item, index) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw invalid(`Rule ${index + 1} must be an object.`, "rules");
		}
		const fields = item as Fields;
		const effect = optEnum(fields, "effect", RULE_EFFECTS);
		const tool = optString(fields, "tool", 64);
		const pattern = optString(fields, "pattern", 1000);
		if (!effect || !tool) throw invalid(`Rule ${index + 1} needs an effect and a tool.`, "rules");
		return pattern ? { effect, tool, pattern } : { effect, tool };
	});
}

const MAX_WORKSPACES = 50;
/** How far back the usage page can look. */
const MAX_USAGE_DAYS = 90;

/**
 * Checks the saved workspaces. A new or moved one must point at an existing folder; one already saved
 * with the same path is kept as it is, so a folder that has since gone away can still be renamed or
 * removed.
 */
export function parseWorkspaces(value: unknown[], saved: Workspace[]): Workspace[] {
	if (value.length > MAX_WORKSPACES) {
		throw invalid(`Up to ${MAX_WORKSPACES} workspaces can be saved.`, "workspaces");
	}
	const known = new Map(saved.map((workspace) => [workspace.id, workspace]));
	const paths = new Set<string>();
	return value.map((item, index) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw invalid(`Workspace ${index + 1} must be an object.`, "workspaces");
		}
		const fields = item as Fields;
		const id = reqString(fields, "id", 64);
		if (!/^[\w-]+$/.test(id))
			throw invalid(`Workspace ${index + 1} has an invalid id.`, "workspaces");
		const name = reqString(fields, "name", 60).trim();
		if (!name || /\p{Cc}/u.test(name)) {
			throw invalid(
				`Workspace ${index + 1} needs a name without control characters.`,
				"workspaces",
			);
		}
		const requested = reqString(fields, "path", 4096);
		const previous = known.get(id);
		let path: string;
		if (previous && previous.path === requested) {
			path = previous.path;
		} else {
			try {
				path = resolveWorkingFolder(requested);
			} catch (error) {
				throw invalid((error as Error).message, "workspaces");
			}
		}
		if (paths.has(path)) throw invalid(`${requested} is already a workspace.`, "workspaces");
		paths.add(path);
		return { id, name, path };
	});
}

/** `filename` for old clients, `filename*` for the real name (RFC 6266 and 5987). */
function contentDisposition(filename: string): string {
	const ascii = filename
		.replace(/[^\x20-\x7e]/g, "")
		.replace(/["\\]/g, "_")
		.trim();
	const fallback = ascii || "yew-session.md";
	const encoded = encodeURIComponent(filename).replace(
		/['()*]/g,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function api(deps: ApiDeps): Hono<AppEnv> {
	const { store } = deps;
	const app = new Hono<AppEnv>();
	const once = idempotent(store.db);

	// --- groups ---

	app.get("/groups", (c) => c.json({ items: store.listGroups(), nextCursor: null }));

	// The system folder picker, for choosing a workspace's folder (macOS; elsewhere a typed path).
	app.post("/folders/pick", async (c) => {
		const path = await (deps.pickFolder ?? (() => pickFolder()))();
		return c.json({ path });
	});

	app.post("/groups", once, async (c) => {
		const fields = await readJson(c);
		return c.json(store.createGroup(reqString(fields, "name", 200)), 201);
	});

	app.patch("/groups/:id", async (c) => {
		const fields = await readJson(c);
		const name = optString(fields, "name", 200);
		const position = optNumber(fields, "position");
		return c.json(
			store.updateGroup(c.req.param("id"), {
				...(name !== undefined ? { name } : {}),
				...(position !== undefined ? { position } : {}),
			}),
		);
	});

	app.delete("/groups/:id", (c) => {
		store.deleteGroup(c.req.param("id"));
		return c.body(null, 204);
	});

	// --- sessions ---

	app.get("/sessions", (c) => {
		const { limit, cursor } = pageParams(c);
		const archived = c.req.query("archived") === "true";
		return c.json(store.listSessions({ archived, cursor, limit }));
	});

	app.post("/sessions", once, async (c) => {
		const fields = await readJson(c);
		const settings = readSettings(store);
		const provider = optString(fields, "provider", 100) ?? settings.defaultModel.provider;
		const model = optString(fields, "model", 200) ?? settings.defaultModel.model;
		deps.checkModel?.(provider, model);
		const cwd = optNullableString(fields, "cwd", 4096);
		const session = store.createSession({
			name: reqString(fields, "name", 200),
			kind: optEnum(fields, "kind", SESSION_KINDS) ?? "task",
			groupId: optNullableString(fields, "groupId", 100) ?? null,
			responsibility: optString(fields, "responsibility", 20_000) ?? "",
			cwd: cwd ? resolveWorkingFolder(cwd) : null,
			provider,
			model,
			thinking: optEnum(fields, "thinking", THINKING_LEVELS) ?? settings.defaultModel.thinking,
			// New sessions start with no remembered approvals; "always allow" adds them.
			rules: [],
			// Named after the first message (the home page): Yew gives it a short name after one turn.
			options: optBoolean(fields, "autoName")
				? { permissionMode: settings.defaultPermissionMode, autoName: true }
				: { permissionMode: settings.defaultPermissionMode },
		});
		return c.json(session, 201);
	});

	app.get("/sessions/:id", (c) => c.json(store.getSession(c.req.param("id"))));

	// A copy of the session, with its conversation, under a free name ("名称 副本", "名称 副本 2"…).
	app.post("/sessions/:id/duplicate", once, (c) => {
		const source = store.getSession(c.req.param("id"));
		const english = readSettings(store).language === "en";
		const base = `${[...source.name].slice(0, 52).join("")}${english ? " copy" : " 副本"}`;
		let name = base;
		for (let n = 2; store.findSessionByName(name); n++) name = `${base} ${n}`;
		return c.json(store.duplicateSession(source.id, name), 201);
	});

	// A new session that goes on from one reply of this one ("名称 分叉", "名称 分叉 2"…).
	app.post("/sessions/:id/fork", once, async (c) => {
		const source = store.getSession(c.req.param("id"));
		const entryId = reqString(await readJson(c), "entryId", 100);
		const english = readSettings(store).language === "en";
		const base = `${[...source.name].slice(0, 52).join("")}${english ? " fork" : " 分叉"}`;
		let name = base;
		for (let n = 2; store.findSessionByName(name); n++) name = `${base} ${n}`;
		return c.json(store.forkSession(source.id, entryId, name), 201);
	});

	app.patch("/sessions/:id", async (c) => {
		const id = c.req.param("id");
		const fields = await readJson(c);
		const patch: SessionPatch = {};
		const name = optString(fields, "name", 200);
		if (name !== undefined) patch.name = name;
		const groupId = optNullableString(fields, "groupId", 100);
		if (groupId !== undefined) patch.groupId = groupId;
		const cwd = optNullableString(fields, "cwd", 4096);
		if (cwd !== undefined) patch.cwd = cwd ? resolveWorkingFolder(cwd) : null;
		const responsibility = optString(fields, "responsibility", 20_000);
		if (responsibility !== undefined) patch.responsibility = responsibility;
		const provider = optString(fields, "provider", 100);
		const model = optString(fields, "model", 200);
		if (provider !== undefined || model !== undefined) {
			const current = store.getSession(id);
			deps.checkModel?.(provider ?? current.provider, model ?? current.model);
			if (provider !== undefined) patch.provider = provider;
			if (model !== undefined) patch.model = model;
		}
		const thinking = optEnum(fields, "thinking", THINKING_LEVELS);
		if (thinking !== undefined) patch.thinking = thinking;
		const rules = optArray(fields, "rules");
		if (rules !== undefined) patch.rules = parseRules(rules);
		const options = optObject(fields, "options");
		if (options !== undefined) {
			const compactAt = options.compactAt;
			if (
				compactAt !== undefined &&
				compactAt !== null &&
				(typeof compactAt !== "number" || !Number.isInteger(compactAt) || compactAt < 10_000)
			) {
				throw invalid("compactAt must be a whole number of at least 10000, or null.", "options");
			}
			const permissionMode = optEnum(options, "permissionMode", PERMISSION_MODES);
			const receive = optEnum(options, "receive", RECEIVE_POLICIES);
			const letterQuota = options.letterQuota;
			if (
				letterQuota !== undefined &&
				letterQuota !== null &&
				(typeof letterQuota !== "number" ||
					!Number.isInteger(letterQuota) ||
					letterQuota < 1 ||
					letterQuota > 100)
			) {
				throw invalid("letterQuota must be a whole number from 1 to 100, or null.", "options");
			}
			const canPostCards = optBoolean(options, "canPostCards");
			const canOrganize = optBoolean(options, "canOrganize");
			const allowContainers = optBoolean(options, "allowContainers");
			const dailyBudget = options.dailyBudget;
			if (dailyBudget !== undefined && !isBudget(dailyBudget)) {
				throw invalid("dailyBudget must be an amount in US dollars above 0, or null.", "options");
			}
			const rawExtraDirs = optArray(options, "extraDirs");
			const extraDirs =
				rawExtraDirs === undefined
					? undefined
					: parseExtraDirs(rawExtraDirs, {
							offLimits: [
								...(deps.yewHome
									? secretLocations(deps.yewHome)
									: secretLocations("/nonexistent-yew-home")),
								...readSettings(store).hiddenFolders.map(canonical),
							],
							field: "extraDirs",
						});
			const rawAllowedDomains = optArray(options, "allowedDomains");
			const allowedDomains =
				rawAllowedDomains === undefined
					? undefined
					: parseSandboxDomains(rawAllowedDomains, "allowedDomains");
			const next: SessionOptions = {};
			if (compactAt !== undefined) next.compactAt = compactAt as number | null;
			if (permissionMode !== undefined) next.permissionMode = permissionMode;
			if (receive !== undefined) next.receive = receive;
			if (letterQuota !== undefined) next.letterQuota = letterQuota as number | null;
			if (canPostCards !== undefined) next.canPostCards = canPostCards;
			if (canOrganize !== undefined) next.canOrganize = canOrganize;
			if (allowContainers !== undefined) next.allowContainers = allowContainers;
			if (extraDirs !== undefined) next.extraDirs = extraDirs;
			if (allowedDomains !== undefined) next.allowedDomains = allowedDomains;
			// A new limit starts without the room given by continuing under the old one.
			if (dailyBudget !== undefined) {
				next.dailyBudget = dailyBudget;
				next.budgetExtra = null;
			}
			patch.options = next;
		}
		// A name the person chose is not replaced by Yew's automatic one.
		if (patch.name !== undefined) patch.options = { ...patch.options, autoName: false };
		const pinned = optBoolean(fields, "pinned");
		if (pinned !== undefined) patch.pinned = pinned;
		const archived = optBoolean(fields, "archived");
		if (archived !== undefined) patch.archived = archived;
		if (optBoolean(fields, "read") === true) patch.read = true;
		const before = store.getSession(id);
		const updated = store.updateSession(id, patch);
		if (before.archivedAt === null && updated.archivedAt !== null) deps.onArchived?.(id);
		if (updated.provider !== before.provider || updated.model !== before.model) {
			store.appendEntry(id, {
				role: "notice",
				notice: {
					kind: "model_changed",
					text: `${before.provider}/${before.model} → ${updated.provider}/${updated.model}`,
					timestamp: Date.now(),
				},
			});
			return c.json(store.getSession(id));
		}
		return c.json(updated);
	});

	app.get("/sessions/:id/transcript", (c) => {
		const session: Session = store.getSession(c.req.param("id"));
		const limit = optIntQuery(c, "limit") ?? 100;
		if (limit < 1 || limit > 500) throw invalid("limit must be from 1 to 500.", "limit");
		const before = optIntQuery(c, "before") ?? null;
		// Read everything at one point in time, so the client can resume the event stream from session.eventSeq.
		const transcript = store.tx((): Transcript => {
			const page = store.listEntries(session.id, { before, limit });
			const toolCalls = store.toolCallsForMessages(page.entries.map((entry) => entry.id));
			const approvals = store.approvalsForToolCalls(toolCalls.map((call) => call.id));
			const pending = store
				.pendingApprovals(session.id)
				.filter((approval) => !approvals.some((known) => known.id === approval.id));
			// The UI only shows "[image]" for tool-result images; strip raw base64 blobs from HTTP responses.
			const entries = page.entries.map((entry) =>
				entry.role === "toolResult" &&
				entry.message.content.some((block) => block.type === "image" && block.data.length > 0)
					? {
							...entry,
							message: {
								...entry.message,
								content: entry.message.content.map((block) =>
									block.type === "image" ? { ...block, data: "" } : block,
								),
							},
						}
					: entry,
			);
			return {
				session: store.getSession(session.id),
				entries,
				toolCalls,
				approvals: [...approvals, ...pending],
				queue: store.listQueue(session.id),
				olderCursor: page.olderCursor,
			};
		});
		return c.json(transcript);
	});

	// The whole session as one Markdown file. The language comes from the interface; without it the
	// saved interface language is used, and a system setting falls back to Chinese.
	app.get("/sessions/:id/export.md", (c) => {
		const session = store.getSession(c.req.param("id"));
		const requested = c.req.query("lang");
		if (requested !== undefined && requested !== "zh" && requested !== "en") {
			throw invalid("lang must be zh or en.", "lang");
		}
		const saved = readSettings(store).language;
		const language: ExportLanguage = requested ?? (saved === "en" ? "en" : "zh");
		const groupName = session.groupId ? store.getGroup(session.groupId).name : null;
		const markdown = sessionMarkdown({
			session,
			groupName,
			entries: store.allEntries(session.id),
			toolCalls: store.toolCallsForSession(session.id),
			language,
		});
		c.header("Content-Type", "text/markdown; charset=utf-8");
		c.header("Content-Disposition", contentDisposition(exportFileName(session.name)));
		return c.body(markdown);
	});

	app.get("/sessions/:id/queue", (c) => {
		const id = c.req.param("id");
		store.getSession(id);
		return c.json({ items: store.listQueue(id), nextCursor: null });
	});

	app.patch("/sessions/:id/queue/:queuedId", async (c) => {
		const fields = await readJson(c);
		const text = reqString(fields, "text", 100_000);
		if (text.trim().length === 0) throw invalid("The message cannot be empty.", "text");
		return c.json(store.updateQueued(c.req.param("id"), c.req.param("queuedId"), text));
	});

	app.delete("/sessions/:id/queue/:queuedId", (c) => {
		store.removeQueued(c.req.param("id"), c.req.param("queuedId"));
		return c.body(null, 204);
	});

	// Text typed into a message box and not sent, kept so it is still there when the page comes back.
	// `place` is a session's id, or "home" for the box on the home page.
	const unsentPlace = (place: string): string => {
		if (place !== "home") store.getSession(place);
		return place;
	};

	app.get("/unsent/:place", (c) =>
		c.json({ text: store.getUnsent(unsentPlace(c.req.param("place"))) }),
	);

	app.put("/unsent/:place", async (c) => {
		const place = unsentPlace(c.req.param("place"));
		store.setUnsent(place, reqString(await readJson(c), "text", 100_000));
		return c.body(null, 204);
	});

	// Fast file suggestions for the composer's `@` picker across cwd and extraDirs.
	app.get("/sessions/:id/files", async (c) => {
		const session = store.getSession(c.req.param("id"));
		const q = (c.req.query("q") ?? "").trim();
		if (q.length > 200) throw invalid("The query can be at most 200 characters.", "q");
		const limit = optIntQuery(c, "limit") ?? 30;
		if (limit < 1 || limit > 100) throw invalid("limit must be from 1 to 100.", "limit");
		const offLimits = [
			...(deps.yewHome ? secretLocations(deps.yewHome) : secretLocations("/nonexistent-yew-home")),
			...readSettings(store).hiddenFolders.map(canonical),
		];
		const items = await listSessionFiles(session, q, limit, offLimits);
		return c.json({ items });
	});

	// Enabled skills active for this session's working folder, for the composer's `/` picker.
	app.get("/sessions/:id/skills", (c) => {
		const session = store.getSession(c.req.param("id"));
		if (!deps.yewHome) return c.json({ items: [] });
		const disabled = store.getSetting<string[]>("disabledSkills", []);
		const userHome = deps.userHome === undefined ? homedir() : deps.userHome;
		const items = findSkills(session.cwd, deps.yewHome, userHome, disabled).map((skill) => ({
			name: skill.name,
			description: skill.description,
		}));
		return c.json({ items });
	});

	// --- search and settings ---

	app.get("/search", (c) => {
		const q = c.req.query("q") ?? "";
		if (q.length > 200) throw invalid("The search text can be at most 200 characters.", "q");
		const limit = optIntQuery(c, "limit") ?? 20;
		if (limit < 1 || limit > 100) throw invalid("limit must be from 1 to 100.", "limit");
		return c.json(store.search(q, limit));
	});

	app.get("/settings", (c) => c.json(readSettings(store)));

	// What is in the roles folder, and whether its changes are committed.
	app.get("/settings/roles-folder", (c) => {
		const none: RoleFilesState = { folder: null, files: 0, commits: "none", problem: null };
		return c.json(deps.roleFiles?.state() ?? none);
	});

	app.patch("/settings", async (c) => {
		const fields = await readJson(c);
		const defaultModel = optObject(fields, "defaultModel");
		if (defaultModel) {
			const value: DefaultModel = {
				provider: reqString(defaultModel, "provider", 100),
				model: reqString(defaultModel, "model", 200),
				thinking: optEnum(defaultModel, "thinking", THINKING_LEVELS) ?? "medium",
			};
			deps.checkModel?.(value.provider, value.model);
			store.setSetting("defaultModel", value);
		}
		// null goes back to the small model of each session's own provider.
		if (fields.sideModel === null) store.setSetting("sideModel", null);
		else {
			const sideModel = optObject(fields, "sideModel");
			if (sideModel) {
				const value: SideModel = {
					provider: reqString(sideModel, "provider", 100),
					model: reqString(sideModel, "model", 200),
				};
				deps.checkModel?.(value.provider, value.model);
				store.setSetting("sideModel", value);
			}
		}
		const theme = optEnum(fields, "theme", ["system", "light", "dark"] as const);
		if (theme) store.setSetting("theme", theme);
		const language = optEnum(fields, "language", ["system", "zh", "en"] as const);
		if (language) store.setSetting("language", language);
		const mascot = optBoolean(fields, "mascot");
		if (mascot !== undefined) store.setSetting("mascot", mascot);
		const opening = optEnum(fields, "opening", OPENING_MODES);
		if (opening) store.setSetting("opening", opening);
		const browser = optEnum(fields, "browser", BROWSER_MODES);
		if (browser) {
			store.setSetting("browser", browser);
			deps.onBrowserChanged?.();
		}
		const updateCheck = optBoolean(fields, "updateCheck");
		if (updateCheck !== undefined) store.setSetting("updateCheck", updateCheck);
		const fileOpener = optEnum(fields, "fileOpener", FILE_OPENERS);
		if (fileOpener) store.setSetting("fileOpener", fileOpener);
		const credentials = optBoolean(fields, "sandboxCredentials");
		if (credentials !== undefined) store.setSetting("sandboxCredentials", credentials);
		const hidden = optArray(fields, "hiddenFolders");
		if (hidden) {
			if (
				hidden.length > 20 ||
				hidden.some((dir) => typeof dir !== "string" || dir.length > 4096)
			) {
				throw invalid("hiddenFolders is a list of up to 20 folders.", "hiddenFolders");
			}
			store.setSetting("hiddenFolders", [
				...new Set(
					(hidden as string[]).filter((dir) => dir.trim()).map((dir) => resolveHiddenFolder(dir)),
				),
			]);
		}
		const sandboxDomains = optArray(fields, "sandboxAllowedDomains");
		if (sandboxDomains) {
			store.setSetting(
				"sandboxAllowedDomains",
				parseSandboxDomains(sandboxDomains, "sandboxAllowedDomains"),
			);
		}
		const reviewTraceMain = optBoolean(fields, "reviewTraceMain");
		if (reviewTraceMain !== undefined) store.setSetting("reviewTraceMain", reviewTraceMain);
		const workspaces = optArray(fields, "workspaces");
		if (workspaces) {
			store.setSetting("workspaces", parseWorkspaces(workspaces, readSettings(store).workspaces));
		}
		const main = optNullableString(fields, "mainSessionId", 100);
		if (main !== undefined) {
			if (main !== null && store.getSession(main).archivedAt !== null) {
				throw invalid("An archived session cannot be the main conversation.", "mainSessionId");
			}
			store.setSetting("mainSessionId", main);
		}
		const log = optNullableString(fields, "decisionLog", 4096);
		if (log !== undefined) store.setSetting("decisionLog", log ? resolveLogFile(log) : null);
		const roles = optNullableString(fields, "rolesFolder", 4096);
		if (roles !== undefined) {
			const folder = roles?.trim()
				? resolveRolesFolder(roles, deps.yewHome ?? "/nonexistent-yew-home")
				: null;
			if (folder !== readSettings(store).rolesFolder) {
				// Made here, by the person's own word; afterwards only what is inside it is written.
				if (folder) {
					try {
						mkdirSync(folder, { recursive: true });
					} catch (error) {
						throw invalid(
							`The folder could not be made: ${(error as Error).message}`,
							"rolesFolder",
						);
					}
				}
				store.setSetting("rolesFolder", folder);
				// The roles are written before the answer, so the settings can say how it went.
				await deps.roleFiles?.sync();
			}
		}
		const remote = optObject(fields, "remote");
		if (remote) {
			// Remote access is changed on the Mac only.
			if (c.env?.device) throw invalid("Phone access can only be changed on the Mac.", "remote");
			const enabled = optBoolean(remote, "enabled");
			// null goes back to the relay Yew comes with.
			const asked = optNullableString(remote, "relayUrl", 500);
			const relayUrl = asked === null ? DEFAULT_RELAY_URL : asked?.trim();
			if (relayUrl !== undefined && !RELAY_URL.test(relayUrl)) {
				throw invalid(
					"The relay must be a wss:// address (ws:// only inside this network).",
					"remote",
				);
			}
			const current = readSettings(store).remote;
			store.setSetting("remote", {
				enabled: enabled ?? current.enabled,
				relayUrl: relayUrl ?? current.relayUrl,
			});
			deps.onRemoteChanged?.();
		}
		const mode = optEnum(fields, "defaultPermissionMode", PERMISSION_MODES);
		if (mode) store.setSetting("defaultPermissionMode", mode);
		const defaultWorkspace = optNullableString(fields, "defaultWorkspaceId", 64);
		if (defaultWorkspace !== undefined) {
			const saved = readSettings(store).workspaces;
			if (defaultWorkspace !== null && !saved.some((item) => item.id === defaultWorkspace)) {
				throw invalid("The default workspace must be one of the saved ones.", "defaultWorkspaceId");
			}
			store.setSetting("defaultWorkspaceId", defaultWorkspace);
		}
		const notify = optObject(fields, "notify");
		if (notify) {
			const next = { ...readSettings(store).notify };
			for (const kind of NOTIFY_KINDS) next[kind] = optBoolean(notify, kind) ?? next[kind];
			store.setSetting("notify", next);
		}
		const memoryDirs = optArray(fields, "memoryDirs");
		if (memoryDirs) {
			if (memoryDirs.length > 10 || memoryDirs.some((dir) => typeof dir !== "string")) {
				throw invalid("memoryDirs is a list of up to 10 folders.", "memoryDirs");
			}
			store.setSetting("memoryDirs", [
				...new Set((memoryDirs as string[]).map((dir) => resolveMemoryDir(dir))),
			]);
		}
		if (fields.dailyBudget !== undefined) {
			if (!isBudget(fields.dailyBudget)) {
				throw invalid(
					"dailyBudget must be an amount in US dollars above 0, or null.",
					"dailyBudget",
				);
			}
			store.setSetting("dailyBudget", fields.dailyBudget);
			store.setSetting("budgetExtra", null);
		}
		return c.json(readSettings(store));
	});

	// What was spent today (this computer's calendar day), in all and by session, for the limits.
	app.get("/usage/today", (c) => {
		const day = localDay(Date.now());
		return c.json({ day, total: store.spentOn(day), sessions: store.spentBySession(day) });
	});

	// The usage page: each of the last days with what all sessions used, days without use as zeros.
	app.get("/usage", (c) => {
		const count = optIntQuery(c, "days") ?? 30;
		if (count < 1 || count > MAX_USAGE_DAYS) {
			throw invalid(`days must be a whole number from 1 to ${MAX_USAGE_DAYS}.`, "days");
		}
		const days = lastDays(Date.now(), count);
		const today = days[days.length - 1] as string;
		const used = new Map(store.usageByDay(days[0] as string, today).map((row) => [row.day, row]));
		const overview: UsageOverview = {
			today,
			budget: store.getSetting<number | null>("dailyBudget", null),
			days: days.map(
				(day) =>
					used.get(day) ?? { day, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			),
		};
		return c.json(overview);
	});

	// One day on the usage page: what each session used, the one that cost most first.
	app.get("/usage/:day", (c) => {
		const day = c.req.param("day");
		if (!isDay(day)) throw invalid("day must be a calendar day written as YYYY-MM-DD.", "day");
		const detail: UsageDetail = {
			day,
			total: store.spentOn(day),
			sessions: store.usageBySession(day),
		};
		return c.json(detail);
	});

	// Opens a local file or folder clicked from a reply, using the person's configured editor/Finder.
	// Computer-only (enforced by deviceLimits): paired phones never launch local apps.
	app.post("/open-file", async (c) => {
		if (c.env?.device) {
			throw new YewError(
				"mac-only",
				403,
				"Opening local files is only available on this computer.",
			);
		}
		const fields = await readJson(c);
		const raw = reqString(fields, "path", 4096).trim();
		const sessionId = optString(fields, "sessionId", 100);
		const line = optNumber(fields, "line");
		const column = optNumber(fields, "column");
		const opener = optEnum(fields, "opener", FILE_OPENERS) ?? readSettings(store).fileOpener;
		if (line !== undefined && (!Number.isInteger(line) || line < 1 || line > 10_000_000)) {
			throw invalid("line must be a positive integer.", "line");
		}
		if (column !== undefined && (!Number.isInteger(column) || column < 1 || column > 100_000)) {
			throw invalid("column must be a positive integer.", "column");
		}
		const homeDir = deps.userHome ?? homedir();
		const target = resolveOpenFileTarget(raw, {
			homeDir,
			session: sessionId ? store.getSession(sessionId) : null,
		});
		const settings = readSettings(store);
		const offLimits = [
			...settings.hiddenFolders,
			...(deps.yewHome ? secretLocations(deps.yewHome) : secretLocations("/nonexistent-yew-home")),
		];
		const resolved = canonical(target);
		if (isSecretPath(resolved, offLimits)) {
			throw new YewError("forbidden", 403, "That file is in a folder kept from Yew Harness.");
		}
		if (!existsSync(resolved)) {
			throw notFound("file", raw);
		}
		await openLocalFile(resolved, {
			opener,
			...(line !== undefined ? { line } : {}),
			...(column !== undefined ? { column } : {}),
			...(deps.platform ? { platform: deps.platform } : {}),
			...(deps.openFile ? { run: deps.openFile } : {}),
		});
		return c.body(null, 204);
	});

	return app;
}
