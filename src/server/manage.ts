import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { JsonObject } from "../shared/messages.ts";
import {
	type ChangeStep,
	type ConfirmReason,
	type Group,
	letterQuotaOf,
	PERMISSION_MODES,
	type PermissionMode,
	permissionModeOf,
	RECEIVE_POLICIES,
	type ReceivePolicy,
	SCHEDULE_MODES,
	type ScheduleMode,
	type Session,
	THINKING_LEVELS,
	type ThinkingLevel,
} from "../shared/types.ts";
import { dollars, isBudget } from "./budget.ts";
import { invalid } from "./errors.ts";
import { resolveWorkingFolder } from "./paths.ts";
import { canonical, isInside, secretLocations } from "./permissions/paths.ts";
import type { ScheduleBook, ScheduleFields } from "./schedules.ts";
import {
	parseExtraDirs,
	parseSandboxDomains,
	readSettings,
	resolveLogFile,
	type Workspace,
} from "./settings.ts";
import { type SessionPatch, type Store, validateSessionName } from "./store.ts";

/**
 * How far a manage_yew call reaches. Yew decides, not the model: organizing
 * follows the session's permission mode, configuring asks every time unless always allowed, and
 * widening what a session may do must be confirmed every time.
 */
export type ManageTier = "organize" | "configure" | "widen";

export interface ManagePlan {
	steps: ChangeStep[];
	tier: ManageTier;
	reasons: ConfirmReason[];
	/** English lines for the session that asked, one per change. */
	summary: string[];
}

export interface ManagerDeps {
	store: Store;
	schedules: ScheduleBook;
	home?: string;
	mainId(): string | null;
	modelExists(provider: string, model: string): boolean;
	/** A session was archived: letters waiting for it are dropped. */
	onArchived(sessionId: string): void;
}

const TIER_RANK: Record<ManageTier, number> = { organize: 0, configure: 1, widen: 2 };
const MODE_RANK: Record<PermissionMode, number> = { default: 1, review: 2, skip: 3 };
const RECEIVE_RANK: Record<ReceivePolicy, number> = { refuse: 0, hold: 1, accept: 2 };
const THEMES = ["system", "light", "dark"] as const;
const LANGUAGES = ["system", "zh", "en"] as const;
const MAX_WORKSPACES = 50;

type Fields = Record<string, unknown>;

function text(fields: Fields, key: string, max: number): string | undefined {
	const value = fields[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw invalid(`${key} must be text.`, key);
	if (value.length > max) throw invalid(`${key} is longer than ${max} characters.`, key);
	return value;
}

function oneOf<T extends string>(fields: Fields, key: string, values: readonly T[]): T | undefined {
	const value = fields[key];
	if (value === undefined) return undefined;
	if (!values.includes(value as T))
		throw invalid(`${key} must be one of ${values.join(", ")}.`, key);
	return value as T;
}

function flag(fields: Fields, key: string): boolean | undefined {
	const value = fields[key];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw invalid(`${key} must be true or false.`, key);
	return value;
}

function list(value: unknown, key: string): Fields[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw invalid(`${key} must be a list.`, key);
	return value.map((item, index) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw invalid(`${key}[${index}] must be an object.`, key);
		}
		return item as Fields;
	});
}

const none = (value: string | undefined) => value === "none" || value === "";

/** A daily spending limit from a call: dollars, 0 for none; undefined when not given. */
function budgetOf(value: unknown): number | null | undefined {
	if (value === undefined) return undefined;
	if (value !== 0 && (value === null || !isBudget(value))) {
		throw invalid(
			"daily_budget must be an amount in US dollars, or 0 for no limit.",
			"daily_budget",
		);
	}
	return value === 0 ? null : (value as number);
}

/**
 * manage_yew: everything the settings interface can do, for the main conversation and the sessions the
 * person allowed. A call is planned first (checked, worded and ranked without changing anything), so
 * the permission card shows exactly what will happen; running it plans again and applies all or none.
 */
export class Manager {
	readonly #deps: ManagerDeps;

	constructor(deps: ManagerDeps) {
		this.#deps = deps;
	}

	plan(by: Session, args: JsonObject): ManagePlan {
		return this.#work(by, args, false);
	}

	/** Applies the call in one transaction and says what changed. */
	apply(by: Session, args: JsonObject): string[] {
		return this.#deps.store.tx(() => this.#work(by, args, true).summary);
	}

	#work(by: Session, args: JsonObject, commit: boolean): ManagePlan {
		const store = this.#deps.store;
		const steps: ChangeStep[] = [];
		const summary: string[] = [];
		const reasons = new Set<ConfirmReason>();
		let tier: ManageTier = "organize";
		const reach = (level: ManageTier) => {
			if (TIER_RANK[level] > TIER_RANK[tier]) tier = level;
		};
		const widen = (reason: ConfirmReason, target: Session | null) => {
			if (target?.id === by.id) {
				throw invalid(
					"Only the person can give you more room; ask them to change it in your session settings.",
					"sessions",
				);
			}
			reach("widen");
			reasons.add(reason);
		};
		const add = (step: ChangeStep, line: string) => {
			steps.push(step);
			summary.push(line);
		};

		// Teams first, so sessions in the same call can move into a team created here.
		const created = new Map<string, Group>();
		const teamRef = (ref: string): { id: string; name: string } => {
			const groups = store.listGroups();
			const byId = groups.find((group) => group.id === ref);
			if (byId) return byId;
			const named = groups.filter((group) => group.name === ref);
			if (named.length > 1)
				throw invalid(`Several teams are called "${ref}"; give its id.`, "team");
			if (named[0]) return named[0];
			const fresh = created.get(ref);
			if (fresh) return fresh;
			throw invalid(`There is no team "${ref}"; create it in teams first.`, "team");
		};
		for (const change of list(args.teams, "teams")) {
			const name = text(change, "name", 60)?.trim();
			if (!name) throw invalid("A team needs a name.", "teams");
			const ref = text(change, "team", 100);
			if (ref === undefined) {
				const group = commit
					? store.createGroup(name)
					: ({ id: `new:${name}`, name } as unknown as Group);
				created.set(name, group);
				add({ action: "create_team", name }, `Created the team "${name}" (id ${group.id}).`);
			} else {
				const group = teamRef(ref);
				if (group.name === name) continue;
				if (commit) store.updateGroup(group.id, { name });
				add(
					{ action: "rename_team", from: group.name, to: name },
					`Renamed the team "${group.name}" to "${name}".`,
				);
			}
		}

		const sessionRef = (ref: string): Session => {
			let found: Session | undefined;
			try {
				found = store.getSession(ref);
			} catch {
				found = store.findSessionByName(ref);
			}
			if (!found) throw invalid(`There is no session "${ref}".`, "session");
			return found;
		};
		const parseModel = (value: string, key: string): { provider: string; model: string } => {
			const slash = value.indexOf("/");
			if (slash <= 0 || slash === value.length - 1) {
				throw invalid(`${key} must look like "provider/model".`, key);
			}
			const provider = value.slice(0, slash);
			const model = value.slice(slash + 1);
			if (!this.#deps.modelExists(provider, model)) {
				throw invalid(`There is no model ${value}; pick one the person has set up.`, key);
			}
			return { provider, model };
		};
		const folderOf = (value: string, key: string): string => {
			try {
				return resolveWorkingFolder(value);
			} catch (error) {
				throw invalid((error as Error).message, key);
			}
		};

		const main = this.#deps.mainId();
		/**
		 * What a change asks of a session's options, against the ones it has: an existing session's, or
		 * the defaults a new one starts with. Each difference is noted and ranked the same either way.
		 */
		const optionsFor = (
			change: Fields,
			target: Session,
			note: (step: ChangeStep, line: string) => void,
		): Session["options"] => {
			const options = { ...target.options };
			const permission = oneOf(change, "permission", PERMISSION_MODES);
			const currentMode = permissionModeOf(target.options);
			if (permission !== undefined && permission !== currentMode) {
				if (MODE_RANK[permission] > MODE_RANK[currentMode]) widen("widen-permission", target);
				else reach("configure");
				options.permissionMode = permission;
				note(
					{ action: "set_permission", session: target.name, from: currentMode, to: permission },
					`Set the permission mode of "${target.name}" to ${permission}.`,
				);
			}
			const receive = oneOf(change, "receive", RECEIVE_POLICIES);
			const currentReceive = target.options.receive ?? "accept";
			if (receive !== undefined && receive !== currentReceive) {
				if (RECEIVE_RANK[receive] > RECEIVE_RANK[currentReceive]) widen("open-letters", target);
				else reach("configure");
				options.receive = receive;
				note(
					{ action: "set_receive", session: target.name, from: currentReceive, to: receive },
					`Set how "${target.name}" receives letters to ${receive}.`,
				);
			}
			const quotaValue = change.letter_quota;
			if (quotaValue !== undefined) {
				if (
					typeof quotaValue !== "number" ||
					!Number.isInteger(quotaValue) ||
					quotaValue < 0 ||
					quotaValue > 100
				) {
					throw invalid(
						"letter_quota must be a whole number from 1 to 100, or 0 for the default.",
						"letter_quota",
					);
				}
				const isMain = target.id === main;
				const from = letterQuotaOf(target.options, isMain);
				const next = quotaValue === 0 ? null : quotaValue;
				const to = letterQuotaOf({ letterQuota: next }, isMain);
				if (to !== from) {
					if (to > from) widen("raise-quota", target);
					else reach("configure");
					options.letterQuota = next;
					note(
						{ action: "set_letter_quota", session: target.name, from, to },
						`Set the letter quota of "${target.name}" to ${to}.`,
					);
				}
			}
			const budgetValue = budgetOf(change.daily_budget);
			if (budgetValue !== undefined && budgetValue !== (target.options.dailyBudget ?? null)) {
				const from = target.options.dailyBudget ?? null;
				// More room to spend, or no limit at all, is for the person to allow.
				if (budgetValue === null || (from !== null && budgetValue > from)) {
					widen("raise-budget", target);
				} else reach("configure");
				options.dailyBudget = budgetValue;
				options.budgetExtra = null;
				note(
					{ action: "set_daily_budget", session: target.name, from, to: budgetValue },
					budgetValue === null
						? `Removed the daily spending limit of "${target.name}".`
						: `Set the daily spending limit of "${target.name}" to ${dollars(budgetValue)}.`,
				);
			}
			for (const [key, right] of [
				["can_post_cards", "cards"],
				["can_manage", "manage"],
			] as const) {
				const on = flag(change, key);
				const current =
					right === "cards"
						? target.options.canPostCards === true
						: target.options.canOrganize === true;
				if (on === undefined || on === current) continue;
				if (on) widen("grant-rights", target);
				else reach("configure");
				if (right === "cards") options.canPostCards = on;
				else options.canOrganize = on;
				note(
					{ action: "set_right", session: target.name, right, on },
					`${on ? "Gave" : "Took from"} "${target.name}" the right to ${right === "cards" ? "post cards" : "manage Yew"}.`,
				);
			}
			if (change.extra_dirs !== undefined) {
				if (!Array.isArray(change.extra_dirs)) {
					throw invalid("extra_dirs must be a list of { path, access }.", "extra_dirs");
				}
				const currentSettings = readSettings(store);
				const offLimits = [
					...secretLocations(this.#deps.home ?? "/nonexistent-yew-home"),
					...currentSettings.hiddenFolders.map(canonical),
				];
				const nextDirs = parseExtraDirs(change.extra_dirs, { offLimits, field: "extra_dirs" });
				const prevDirs = target.options.extraDirs ?? [];
				if (JSON.stringify(nextDirs) !== JSON.stringify(prevDirs)) {
					const prevMap = new Map(prevDirs.map((d) => [d.path, d.access]));
					const widened = nextDirs.some((d) => {
						const before = prevMap.get(d.path);
						if (!before) return true;
						return before === "read" && d.access === "write";
					});
					if (widened) widen("change-folder", target);
					else reach("configure");
					options.extraDirs = nextDirs;
					note(
						{ action: "set_extra_dirs", session: target.name, dirs: nextDirs },
						`Set additional folders for "${target.name}" to ${nextDirs.length > 0 ? nextDirs.map((d) => `${d.path} (${d.access})`).join(", ") : "none"}.`,
					);
				}
			}
			if (change.allowed_domains !== undefined) {
				if (!Array.isArray(change.allowed_domains)) {
					throw invalid("allowed_domains must be a list of domains.", "allowed_domains");
				}
				const nextDomains = parseSandboxDomains(change.allowed_domains, "allowed_domains");
				const prevDomains = target.options.allowedDomains ?? [];
				if (JSON.stringify(nextDomains) !== JSON.stringify(prevDomains)) {
					const prevSet = new Set(prevDomains);
					if (nextDomains.some((d) => !prevSet.has(d))) widen("widen-permission", target);
					else reach("configure");
					options.allowedDomains = nextDomains;
					note(
						{ action: "set_allowed_domains", session: target.name, domains: nextDomains },
						`Set allowed domains for "${target.name}" to ${nextDomains.length > 0 ? nextDomains.join(", ") : "none"}.`,
					);
				}
			}
			return options;
		};
		for (const change of list(args.sessions, "sessions")) {
			const ref = text(change, "session", 200);
			const name = text(change, "name", 200);
			const teamValue = text(change, "team", 100);
			const role = text(change, "role", 20_000);
			const modelValue = text(change, "model", 300);
			const thinking = oneOf(change, "thinking", THINKING_LEVELS) as ThinkingLevel | undefined;
			const folderValue = text(change, "folder", 4096);

			if (ref === undefined) {
				// A new standing session: never more room than the session that creates it.
				if (!name) throw invalid("A new session needs a name.", "name");
				const valid = validateSessionName(name);
				if (store.findSessionByName(valid)) throw invalid(`"${valid}" is taken.`, "name");
				const settings = readSettings(store);
				const defaults = settings.defaultModel;
				const model = modelValue
					? parseModel(modelValue, "model")
					: { provider: defaults.provider, model: defaults.model };
				const cwd =
					folderValue === undefined || none(folderValue) ? null : folderOf(folderValue, "folder");
				const team = teamValue === undefined || none(teamValue) ? null : teamRef(teamValue);
				reach("configure");
				if (cwd && !(by.cwd && isInside(cwd, by.cwd))) widen("change-folder", null);
				// The default for new sessions, but never more than the session that creates it has.
				const mode: PermissionMode =
					MODE_RANK[permissionModeOf(by.options)] < MODE_RANK[settings.defaultPermissionMode]
						? permissionModeOf(by.options)
						: settings.defaultPermissionMode;
				if (flag(change, "archived") === true) {
					throw invalid("A new session cannot start archived.", "archived");
				}
				// What else the entry sets is checked against those defaults, as for a session that has them.
				const fresh = { id: "", name: valid, options: { permissionMode: mode } } as Session;
				const settled: [ChangeStep, string][] = [];
				const options = optionsFor(change, fresh, (step, line) => settled.push([step, line]));
				const pinned = flag(change, "pinned") === true;
				if (commit) {
					const session = store.createSession({
						name: valid,
						kind: "standing",
						groupId: team?.id ?? null,
						responsibility: role ?? "",
						cwd,
						provider: model.provider,
						model: model.model,
						thinking: thinking ?? defaults.thinking,
						rules: [],
						options,
					});
					if (pinned) store.updateSession(session.id, { pinned: true });
				}
				add(
					{
						action: "create_session",
						name: valid,
						folder: cwd,
						model: `${model.provider}/${model.model}`,
						team: team?.name ?? null,
						role: role ?? "",
					},
					`Created the standing session "${valid}".`,
				);
				for (const [step, line] of settled) add(step, line);
				if (pinned) add({ action: "pin", session: valid, on: true }, `Pinned "${valid}".`);
				continue;
			}

			const target = sessionRef(ref);
			const archived = flag(change, "archived");
			if (target.archivedAt !== null && archived !== false) {
				throw invalid(
					`"${target.name}" is archived; set archived to false to restore it.`,
					"session",
				);
			}
			const patch: SessionPatch = {};
			const changed: ChangeStep[] = [];
			const note = (step: ChangeStep, line: string) => {
				changed.push(step);
				add(step, line);
			};

			if (name !== undefined) {
				const valid = validateSessionName(name);
				const other = store.findSessionByName(valid);
				if (other && other.id !== target.id) throw invalid(`"${valid}" is taken.`, "name");
				if (valid !== target.name) {
					patch.name = valid;
					patch.options = { ...patch.options, autoName: false };
					note(
						{ action: "rename_session", from: target.name, to: valid },
						`Renamed "${target.name}" to "${valid}".`,
					);
				}
			}
			if (teamValue !== undefined) {
				const team = none(teamValue) ? null : teamRef(teamValue);
				if ((team?.id ?? null) !== target.groupId) {
					patch.groupId = team?.id ?? null;
					note(
						{ action: "move_to_team", sessions: [target.name], team: team?.name ?? null },
						team
							? `Moved "${target.name}" into the team "${team.name}".`
							: `Took "${target.name}" out of its team.`,
					);
				}
			}
			const pinned = flag(change, "pinned");
			if (pinned !== undefined && pinned !== target.pinned) {
				patch.pinned = pinned;
				note(
					{ action: "pin", session: target.name, on: pinned },
					`${pinned ? "Pinned" : "Unpinned"} "${target.name}".`,
				);
			}
			if (role !== undefined && role.trim() !== target.responsibility.trim()) {
				reach("configure");
				patch.responsibility = role;
				note(
					{ action: "set_role", session: target.name, role },
					`Changed the role of "${target.name}".`,
				);
			}
			if (modelValue !== undefined || thinking !== undefined) {
				const model = modelValue ? parseModel(modelValue, "model") : target;
				const from = `${target.provider}/${target.model}`;
				const to = `${model.provider}/${model.model}`;
				if (to !== from || (thinking && thinking !== target.thinking)) {
					reach("configure");
					patch.provider = model.provider;
					patch.model = model.model;
					if (thinking) patch.thinking = thinking;
					note(
						{
							action: "set_model",
							session: target.name,
							from,
							to: thinking ? `${to} (${thinking})` : to,
						},
						`Set the model of "${target.name}" to ${to}${thinking ? ` with ${thinking} thinking` : ""}.`,
					);
				}
			}
			if (folderValue !== undefined) {
				const cwd = none(folderValue) ? null : folderOf(folderValue, "folder");
				if (cwd !== target.cwd) {
					// No folder narrows what it can touch; any other folder is a new reach.
					if (cwd === null) reach("configure");
					else widen("change-folder", target);
					patch.cwd = cwd;
					note(
						{ action: "set_folder", session: target.name, from: target.cwd, to: cwd },
						`Set the working folder of "${target.name}" to ${cwd ?? "none (a chat)"}.`,
					);
				}
			}
			const options = optionsFor(change, target, note);
			if (archived !== undefined && archived !== (target.archivedAt !== null)) {
				if (archived && target.id === by.id)
					throw invalid("You cannot archive yourself.", "archived");
				if (archived && target.id === main) {
					throw invalid(
						"The main conversation cannot be archived; choose another one first.",
						"archived",
					);
				}
				reach("configure");
				patch.archived = archived;
				note(
					{ action: "archive", session: target.name, on: archived },
					`${archived ? "Archived" : "Restored"} "${target.name}".`,
				);
			}
			if (JSON.stringify(options) !== JSON.stringify(target.options)) {
				patch.options = { ...options, ...patch.options };
			}
			if (commit && changed.length > 0) {
				store.updateSession(target.id, patch);
				if (patch.archived === true) this.#deps.onArchived(target.id);
				store.appendEntry(target.id, {
					role: "notice",
					notice: {
						kind: "changed",
						text: `${by.name}: ${changed.length} change(s)`,
						data: {
							by: by.name,
							steps: changed as unknown as JsonObject[],
						} as unknown as JsonObject,
						timestamp: Date.now(),
					},
				});
			}
		}

		// Scheduled tasks: creating and changing one configures; a run mode wider than its session's widens.
		const book = this.#deps.schedules;
		for (const change of list(args.schedules, "schedules")) {
			const ref = text(change, "schedule", 200);
			const fields: ScheduleFields = {};
			const name = text(change, "name", 200);
			const cron = text(change, "cron", 200);
			const session = text(change, "session", 200);
			const message = text(change, "message", 20_000);
			const permission = oneOf(change, "permission", ["session", ...PERMISSION_MODES] as const);
			const scheduleMode = oneOf(change, "mode", SCHEDULE_MODES) as ScheduleMode | undefined;
			const autoArchive = flag(change, "auto_archive");
			const catchUp = flag(change, "catch_up");
			const enabled = flag(change, "enabled");
			if (name !== undefined) fields.name = name;
			if (cron !== undefined) fields.cron = cron;
			if (session !== undefined) fields.session = session;
			if (message !== undefined) fields.message = message;
			if (permission !== undefined) {
				fields.permissionMode = permission === "session" ? null : permission;
			}
			if (scheduleMode !== undefined) fields.mode = scheduleMode;
			if (autoArchive !== undefined) fields.autoArchive = autoArchive;
			if (catchUp !== undefined) fields.catchUp = catchUp;
			if (enabled !== undefined) fields.enabled = enabled;
			const current = ref === undefined ? null : book.find(ref);
			if (ref !== undefined && !current)
				throw invalid(`There is no scheduled task "${ref}".`, "schedule");
			const values = book.values(fields, current);
			const target = store.getSession(values.sessionId);
			reach("configure");
			const mode = values.permissionMode;
			if (mode && MODE_RANK[mode] > MODE_RANK[permissionModeOf(target.options)]) {
				const before = current?.permissionMode ?? null;
				// Wider than the session's own mode, and newly so: the person confirms it.
				if (!current || before !== mode || current.sessionId !== values.sessionId) {
					widen("widen-permission", target);
				}
			}
			if (!current) {
				if (commit) book.create(fields);
				add(
					{
						action: "create_schedule",
						name: values.name,
						cron: values.cron,
						session: target.name,
						message: values.message,
						permission: mode,
						...(values.mode !== "letter"
							? { mode: values.mode, autoArchive: values.autoArchive }
							: {}),
					},
					`Created the scheduled task "${values.name}" (${values.cron}, to "${target.name}").`,
				);
				continue;
			}
			const step: Extract<ChangeStep, { action: "change_schedule" }> = {
				action: "change_schedule",
				schedule: current.name,
			};
			if (values.name !== current.name) step.name = values.name;
			if (values.cron !== current.cron) step.cron = values.cron;
			if (values.sessionId !== current.sessionId) step.session = target.name;
			if (values.message !== current.message) step.message = values.message;
			if (values.permissionMode !== current.permissionMode) step.permission = values.permissionMode;
			if (values.mode !== current.mode) step.mode = values.mode;
			if (values.autoArchive !== current.autoArchive) step.autoArchive = values.autoArchive;
			if (values.catchUp !== current.catchUp) step.catchUp = values.catchUp;
			if (values.enabled !== current.enabled) step.enabled = values.enabled;
			const changed = Object.keys(step).filter((key) => key !== "action" && key !== "schedule");
			if (changed.length === 0) continue;
			if (commit) book.update(current.id, fields);
			add(
				step,
				changed.length === 1 && step.enabled !== undefined
					? `Turned ${step.enabled ? "on" : "off"} the scheduled task "${current.name}".`
					: `Changed the scheduled task "${current.name}": ${changed.join(", ")}.`,
			);
		}

		const settings = args.settings;
		if (settings !== undefined) {
			if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
				throw invalid("settings must be an object.", "settings");
			}
			const fields = settings as Fields;
			const current = readSettings(store);
			const mainValue = text(fields, "main", 200);
			if (mainValue !== undefined) {
				const target = none(mainValue) ? null : sessionRef(mainValue);
				if (target?.archivedAt)
					throw invalid("An archived session cannot be the main conversation.", "main");
				if ((target?.id ?? null) !== current.mainSessionId) {
					widen("change-main", target);
					if (commit) store.setSetting("mainSessionId", target?.id ?? null);
					let from: string | null = null;
					try {
						from = current.mainSessionId ? store.getSession(current.mainSessionId).name : null;
					} catch {
						from = null;
					}
					add(
						{ action: "set_main", from, to: target?.name ?? null },
						target
							? `Made "${target.name}" the main conversation.`
							: "Left Yew without a main conversation.",
					);
				}
			}
			const defaultModel = text(fields, "default_model", 300);
			const defaultThinking = oneOf(fields, "default_thinking", THINKING_LEVELS) as
				| ThinkingLevel
				| undefined;
			if (defaultModel !== undefined || defaultThinking !== undefined) {
				const model = defaultModel
					? parseModel(defaultModel, "default_model")
					: current.defaultModel;
				const next = {
					provider: model.provider,
					model: model.model,
					thinking: defaultThinking ?? current.defaultModel.thinking,
				};
				const from = `${current.defaultModel.provider}/${current.defaultModel.model} (${current.defaultModel.thinking})`;
				const to = `${next.provider}/${next.model} (${next.thinking})`;
				if (to !== from) {
					reach("configure");
					if (commit) store.setSetting("defaultModel", next);
					add({ action: "set_default_model", from, to }, `New sessions now use ${to}.`);
				}
			}
			const budgetValue = budgetOf(fields.daily_budget);
			if (budgetValue !== undefined && budgetValue !== current.dailyBudget) {
				const from = current.dailyBudget;
				if (budgetValue === null || (from !== null && budgetValue > from)) {
					widen("raise-budget", null);
				} else reach("configure");
				if (commit) {
					store.setSetting("dailyBudget", budgetValue);
					store.setSetting("budgetExtra", null);
				}
				add(
					{ action: "set_daily_budget", session: null, from, to: budgetValue },
					budgetValue === null
						? "Removed the daily spending limit for all sessions together."
						: `Set the daily spending limit for all sessions together to ${dollars(budgetValue)}.`,
				);
			}
			const log = text(fields, "decision_log", 4096);
			if (log !== undefined) {
				const path = none(log) ? null : resolveLogFile(log);
				if (path !== current.decisionLog) {
					widen("decision-log", null);
					if (commit) store.setSetting("decisionLog", path);
					add(
						{ action: "set_decision_log", from: current.decisionLog, to: path },
						path
							? `Decisions are now added to ${path}.`
							: "Decisions are no longer written to a file.",
					);
				}
			}
			let workspaces: Workspace[] = current.workspaces;
			const addFolder = text(fields, "add_workspace", 4096);
			if (addFolder !== undefined) {
				const path = folderOf(addFolder, "add_workspace");
				if (!workspaces.some((workspace) => workspace.path === path)) {
					if (workspaces.length >= MAX_WORKSPACES) {
						throw invalid(`Up to ${MAX_WORKSPACES} workspaces can be saved.`, "add_workspace");
					}
					workspaces = [...workspaces, { id: randomUUID(), name: basename(path) || path, path }];
					add({ action: "add_workspace", folder: path }, `Added the workspace ${path}.`);
				}
			}
			const removeFolder = text(fields, "remove_workspace", 4096);
			if (removeFolder !== undefined) {
				const found = workspaces.find(
					(workspace) => workspace.path === removeFolder || workspace.name === removeFolder,
				);
				if (!found) throw invalid(`There is no workspace "${removeFolder}".`, "remove_workspace");
				workspaces = workspaces.filter((workspace) => workspace !== found);
				add(
					{ action: "remove_workspace", folder: found.path },
					`Removed the workspace ${found.path}.`,
				);
			}
			if (commit && workspaces !== current.workspaces) store.setSetting("workspaces", workspaces);
			const theme = oneOf(fields, "theme", THEMES);
			if (theme !== undefined && theme !== current.theme) {
				if (commit) store.setSetting("theme", theme);
				add({ action: "set_theme", to: theme }, `Set the theme to ${theme}.`);
			}
			if (fields.sandbox_allowed_domains !== undefined) {
				if (!Array.isArray(fields.sandbox_allowed_domains)) {
					throw invalid(
						"sandbox_allowed_domains must be a list of domains.",
						"sandbox_allowed_domains",
					);
				}
				const nextDomains = parseSandboxDomains(
					fields.sandbox_allowed_domains,
					"sandbox_allowed_domains",
				);
				const prevDomains = current.sandboxAllowedDomains;
				if (JSON.stringify(nextDomains) !== JSON.stringify(prevDomains)) {
					const prevSet = new Set(prevDomains);
					if (nextDomains.some((d) => !prevSet.has(d))) widen("widen-permission", null);
					else reach("configure");
					if (commit) store.setSetting("sandboxAllowedDomains", nextDomains);
					add(
						{ action: "set_allowed_domains", session: null, domains: nextDomains },
						`Set global sandbox allowed domains to ${nextDomains.length > 0 ? nextDomains.join(", ") : "none"}.`,
					);
				}
			}
			const language = oneOf(fields, "language", LANGUAGES);
			if (language !== undefined && language !== current.language) {
				if (commit) store.setSetting("language", language);
				add({ action: "set_language", to: language }, `Set the interface language to ${language}.`);
			}
		}

		if (steps.length === 0)
			throw invalid("Nothing to change: everything is already as asked.", "sessions");
		return { steps, tier, reasons: [...reasons], summary };
	}
}
