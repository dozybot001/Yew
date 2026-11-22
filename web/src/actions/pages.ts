import type {
	Artifact,
	Page,
	PermissionMode,
	Schedule,
	ScheduleMode,
	SessionMap,
	UsageDetail,
	UsageOverview,
} from "../../../src/shared/types.ts";
import { api } from "../api.ts";
import { getState, setState } from "../state.ts";
import { rememberView } from "./remembered.ts";

// --- scheduled tasks ---

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
