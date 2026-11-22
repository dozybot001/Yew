import { useState } from "react";
import type { Session } from "../../../src/shared/types.ts";
import { toggleArchived } from "../actions/sessions.ts";
import { selectSession } from "../actions.ts";
import { t, useLang } from "../i18n.ts";
import { blockedSessions } from "../progress.ts";
import { NO_TEAM, setSidebarCollapsed, setState, useAppState } from "../state.ts";
import { NewSessionDialog } from "./dialogs.tsx";
import { CloseIcon, CollapseIcon, ComposeIcon, ProductName, YewMark } from "./icons.tsx";
import { SettingsButton } from "./settings.tsx";
import { FixedEntries } from "./sidebar/entries.tsx";
import { Teams, Workspaces } from "./sidebar/groups.tsx";
import { closeDrawer, SectionBody, SectionHeading, useNarrow } from "./sidebar/parts.tsx";
import { Search } from "./sidebar/search.tsx";
import { SessionRow } from "./sidebar/session-row.tsx";
import { Button, useNow } from "./ui.tsx";

/** Pinned first, then the most recently active. */
function sortSessions(list: Session[]): Session[] {
	return [...list].sort(
		(a, b) => Number(b.pinned) - Number(a.pinned) || b.lastActivityAt - a.lastActivityAt,
	);
}

/**
 * A list with each session's children right under it, oldest child first, so a task stays next to the
 * session that handed it out. A child whose parent is not in the list stands on its own.
 */
function nest(list: Session[]): { session: Session; depth: number }[] {
	const ids = new Set(list.map((session) => session.id));
	const children = new Map<string, Session[]>();
	for (const session of list) {
		if (session.parentId && ids.has(session.parentId)) {
			children.set(session.parentId, [...(children.get(session.parentId) ?? []), session]);
		}
	}
	const out: { session: Session; depth: number }[] = [];
	const visit = (session: Session, depth: number) => {
		out.push({ session, depth });
		const kids = (children.get(session.id) ?? []).sort((a, b) => a.createdAt - b.createdAt);
		for (const child of kids) visit(child, depth + 1);
	};
	for (const session of list) {
		if (!session.parentId || !ids.has(session.parentId)) visit(session, 0);
	}
	return out;
}

export function Sidebar() {
	useLang();
	const narrow = useNarrow();
	const sessions = useAppState((state) => state.sessions);
	const groups = useAppState((state) => state.groups);
	// On the approval center page no session is the current one.
	const selectedId = useAppState((state) => (state.page ? null : state.selectedId));
	const showArchived = useAppState((state) => state.showArchived);
	const hasArchived = useAppState((state) => state.hasArchived);
	const chosen = useAppState((state) => state.teamFilter);
	const now = useNow();
	const center = useAppState((state) => state.center);
	const blocked = blockedSessions(Object.values(center.approvals), Object.values(center.cards));
	const [newSession, setNewSession] = useState<string | null>(null);

	const all = Object.values(sessions);
	const teamless = (s: Session) => s.archivedAt === null && !s.groupId;
	// A filter for a team that was deleted meanwhile shows everything; so does the one for the
	// sessions in no team once there are none, when its row is gone too.
	const filter =
		chosen === NO_TEAM
			? groups.length > 0 && all.some(teamless)
				? NO_TEAM
				: null
			: groups.some((group) => group.id === chosen)
				? chosen
				: null;
	// The team new sessions started from this list go into; none for the sessions in no team.
	const team = filter === NO_TEAM ? null : filter;
	const filterName =
		filter === NO_TEAM ? t("noTeam") : (groups.find((group) => group.id === filter)?.name ?? null);
	const archived = sortSessions(all.filter((s) => s.archivedAt !== null));
	const listed = sortSessions(
		all.filter(
			(s) =>
				s.archivedAt === null &&
				(filter === null || (filter === NO_TEAM ? !s.groupId : s.groupId === filter)),
		),
	);
	const current = selectedId;
	const row = (session: Session, depth = 0) => (
		<SessionRow
			key={session.id}
			session={session}
			selected={session.id === current}
			groups={groups}
			now={now}
			blocked={blocked.has(session.id)}
			depth={depth}
		/>
	);
	const rows = (list: Session[]) => nest(list).map(({ session, depth }) => row(session, depth));

	return (
		<nav className="sidebar" aria-label={t("sessions")}>
			<div className="sidebar-top">
				{/* The expanded sidebar carries the full lockup, named by the product's name. */}
				<button
					type="button"
					className="lockup lockup-button"
					aria-label={`${t("lockupName")}，${t("goHome")}`}
					title={t("goHome")}
					onClick={() => {
						closeDrawer();
						void selectSession(null);
					}}
				>
					<YewMark className="lockup-mark" size={22} />
					<ProductName />
				</button>
				{narrow ? (
					<Button
						variant="icon"
						aria-label={t("closeSidebar")}
						title={t("closeSidebar")}
						onClick={closeDrawer}
					>
						<CloseIcon />
					</Button>
				) : (
					<Button
						variant="icon"
						aria-label={t("collapseSidebar")}
						title={t("collapseSidebar")}
						onClick={() => setSidebarCollapsed(true)}
					>
						<CollapseIcon />
					</Button>
				)}
			</div>
			<div className="sidebar-nav">
				<FixedEntries />
				<Search />
			</div>
			<div className="sidebar-list">
				<Teams />
				<Workspaces />
				<section aria-label={filterName ? `${t("sessions")} · ${filterName}` : t("sessions")}>
					<SectionHeading
						section="sessions"
						actions={
							<>
								{filter && (
									<Button
										variant="icon"
										className="heading-add"
										aria-label={t("showAllSessions")}
										title={t("showAllSessions")}
										onClick={() => setState({ teamFilter: null })}
									>
										<CloseIcon />
									</Button>
								)}
								<Button
									variant="icon"
									className="heading-add"
									aria-label={team ? t("newSessionHere") : t("newSession")}
									title={team ? t("newSessionHere") : t("newSession")}
									onClick={() => {
										if (team) {
											setNewSession(team);
											return;
										}
										closeDrawer();
										void selectSession(null);
									}}
								>
									<ComposeIcon />
								</Button>
							</>
						}
					>
						{t("sessions")}
						{filterName && <span className="heading-filter"> · {filterName}</span>}
					</SectionHeading>
					<SectionBody section="sessions">
						{listed.length === 0 ? (
							<p className="empty-box">{filter ? t("emptyGroup") : t("emptySidebar")}</p>
						) : (
							rows(listed)
						)}
					</SectionBody>
				</section>
				{hasArchived && (
					<>
						<Button
							variant="ghost"
							className="archived-toggle"
							onClick={() => void toggleArchived(!showArchived)}
						>
							{showArchived ? t("hideArchived") : t("showArchived")}
						</Button>
						{showArchived && archived.map((session) => row(session))}
					</>
				)}
			</div>
			{/* Only the settings: Yew floats over the window. */}
			<div className="sidebar-bottom">
				<SettingsButton variant="row" />
			</div>
			{newSession && <NewSessionDialog groupId={newSession} onClose={() => setNewSession(null)} />}
		</nav>
	);
}
