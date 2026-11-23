import { all, api } from "../api.ts";
import {
	type DataCleanup,
	type DataExport,
	type DataOverview,
	getState,
	type McpServerView,
	type ModelInfo,
	type PhonesState,
	type PingResult,
	type ProviderSummary,
	type RolesFolderState,
	type SearchServiceView,
	type Settings,
	type SettingsPatch,
	type SkillList,
	type SkillView,
	type SystemStatus,
	setState,
} from "../state.ts";
import { applyAppearance } from "./appearance.ts";
import { loadUpdates } from "./updates.ts";

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

// --- search services, MCP servers, this computer ---

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

// --- phone access ---

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

export const loadRolesFolder = () => api<RolesFolderState>("GET", "/api/settings/roles-folder");

export async function saveSettings(patch: SettingsPatch): Promise<void> {
	const settings = await api<Settings>("PATCH", "/api/settings", patch);
	setState({ settings });
	applyAppearance(settings);
	if (patch.updateCheck !== undefined) void loadUpdates();
}
