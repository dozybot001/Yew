import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Group, Session } from "../../../src/shared/types.ts";
import { openArtifacts, openMap, openSchedules, openUsage } from "../actions/pages.ts";
import {
	deleteGroup,
	duplicateSession,
	exportSession,
	renameGroup,
	toggleArchived,
	updateSession,
} from "../actions/sessions.ts";
import { saveSettings } from "../actions/settings.ts";
import { openCenter, selectSession, setMainSession } from "../actions.ts";
import { api } from "../api.ts";
import { formatAgo, t, useLang } from "../i18n.ts";
import { isImeEvent } from "../ime.ts";
import { blockedSessions } from "../progress.ts";
import {
	centerCount,
	NO_TEAM,
	type SidebarSection,
	setSectionFolded,
	setSidebarCollapsed,
	setState,
	useAppState,
	type Workspace,
} from "../state.ts";
import { Snippet } from "./content.tsx";
import { ConfirmDialog, GroupDialog, NewSessionDialog, SessionSettingsDialog } from "./dialogs.tsx";
import {
	ArchiveIcon,
	ArtifactIcon,
	CenterIcon,
	ChatIcon,
	ChevronIcon,
	CloseIcon,
	CodeIcon,
	CollapseIcon,
	ComposeIcon,
	CopyIcon,
	ExpandIcon,
	ExportIcon,
	FolderIcon,
	MainIcon,
	MapIcon,
	MenuPinIcon,
	MoreIcon,
	NewTeamIcon,
	NewWorkspaceIcon,
	NoTeamIcon,
	PinIcon,
	ProductName,
	RenameIcon,
	ScheduleIcon,
	SearchIcon,
	SlidersIcon,
	TeamIcon,
	UsageIcon,
	YewMark,
} from "./icons.tsx";
import { SettingsButton } from "./settings.tsx";
import { Button, describeError, ErrorBox, Menu, type MenuEntry, useAction, useNow } from "./ui.tsx";
import { shortPath, useWorkspaces, WorkspaceDialog } from "./workspaces.tsx";

interface SearchResult {
	sessions: Session[];
	hits: { sessionId: string; entryId: string; seq: number; snippet: string }[];
}

function closeDrawer(): void {
	setState({ drawerOpen: false });
}

/** True on narrow screens, where the sidebar is a drawer instead of a column. */
export function useNarrow(): boolean {
	const query = "(max-width: 760px)";
	const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
	useEffect(() => {
		const list = window.matchMedia(query);
		const change = () => setNarrow(list.matches);
		list.addEventListener("change", change);
		return () => list.removeEventListener("change", change);
	}, []);
	return narrow;
}

/**
 * Renaming in place: the row's name becomes a field. Enter or clicking away saves, Escape cancels.
 * A renamed session keeps its id, so messages to it still arrive.
 */
function InlineRename({
	icon,
	value: initial,
	onSave,
	onDone,
}: {
	icon: React.ReactNode;
	value: string;
	onSave: (name: string) => Promise<unknown>;
	onDone: () => void;
}) {
	useLang();
	const [value, setValue] = useState(initial);
	const input = useRef<HTMLInputElement>(null);
	// Escape closes the field; the blur that follows must not save what was typed.
	const cancelled = useRef(false);
	useEffect(() => {
		input.current?.focus();
		input.current?.select();
	}, []);
	const save = useAction(async () => {
		const name = value.trim();
		if (name && name !== initial) await onSave(name);
		onDone();
	});
	return (
		<div className="session-row session-row-editing">
			<span className="session-icon" aria-hidden="true">
				{icon}
			</span>
			<input
				ref={input}
				className="row-input"
				value={value}
				maxLength={60}
				aria-label={t("rename")}
				aria-invalid={save.error ? "true" : undefined}
				onChange={(event) => setValue(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						cancelled.current = true;
						onDone();
					}
					if (event.key === "Enter" && !isImeEvent(event)) {
						event.preventDefault();
						void save.run();
					}
				}}
				onBlur={() => {
					if (!cancelled.current && !save.busy) void save.run();
				}}
			/>
			{save.error !== null && save.error !== undefined && (
				<span className="field-error row-error" role="alert">
					{describeError(save.error)}
				</span>
			)}
		</div>
	);
}

/** What a dragged session row carries: the session's id. */
const SESSION_DRAG = "application/x-yew-session";

/**
 * Lets a row take a session dragged from the sessions list: dropped on a team it joins the team, on a
 * workspace it works in that folder. The session menu and the composer do the same without dragging
 * (WCAG 2.5.7).
 */
function useSessionDrop(apply: (sessionId: string) => Promise<unknown>) {
	const [over, setOver] = useState(false);
	const drop = useAction(apply);
	const carries = (event: React.DragEvent) => event.dataTransfer.types.includes(SESSION_DRAG);
	return {
		error: drop.error,
		props: {
			"data-drop": over ? "true" : undefined,
			onDragOver: (event: React.DragEvent) => {
				if (!carries(event)) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "move";
				if (!over) setOver(true);
			},
			onDragLeave: (event: React.DragEvent) => {
				// Moving onto a part of the row is not leaving it.
				const next = event.relatedTarget as Node | null;
				if (!next || !event.currentTarget.contains(next)) setOver(false);
			},
			onDrop: (event: React.DragEvent) => {
				if (!carries(event)) return;
				event.preventDefault();
				setOver(false);
				const id = event.dataTransfer.getData(SESSION_DRAG);
				if (id) void drop.run(id);
			},
		},
	};
}

/** A saved workspace: click to start a session there, double-click or the menu to rename. */
function WorkspaceRow({ workspace, all }: { workspace: Workspace; all: Workspace[] }) {
	useLang();
	const [renaming, setRenaming] = useState(false);
	const drop = useSessionDrop((id) => updateSession(id, { cwd: workspace.path }));
	return (
		<div className="session-item" {...drop.props}>
			{renaming ? (
				<InlineRename
					icon={<FolderIcon />}
					value={workspace.name}
					onSave={(name) =>
						saveSettings({
							workspaces: all.map((w) => (w.id === workspace.id ? { ...w, name } : w)),
						})
					}
					onDone={() => setRenaming(false)}
				/>
			) : (
				<button
					type="button"
					className="session-row"
					title={workspace.path}
					onClick={() => {
						closeDrawer();
						setState({ homeFolder: workspace.path });
						void selectSession(null);
					}}
					onDoubleClick={() => setRenaming(true)}
				>
					<span className="session-icon" aria-hidden="true">
						<FolderIcon />
					</span>
					<span className="session-name">
						{workspace.name}
						<span className="visually-hidden"> · {shortPath(workspace.path)}</span>
					</span>
				</button>
			)}
			{!renaming && (
				<span className="session-row-menu">
					<Menu
						label={`${workspace.name} – ${t("more")}`}
						items={[
							{ label: t("rename"), onSelect: () => setRenaming(true) },
							{
								label: t("removeFromList"),
								onSelect: () =>
									void saveSettings({ workspaces: all.filter((w) => w.id !== workspace.id) }),
							},
						]}
					/>
				</span>
			)}
			{drop.error !== null && drop.error !== undefined && (
				<div className="row-error">
					<ErrorBox error={drop.error} />
				</div>
			)}
		</div>
	);
}

/**
 * A team: click to list only its sessions (click again for all), double-click or the menu to
 * rename. Teams, workspaces and sessions are three lists built alike.
 */
function TeamRow({
	group,
	count,
	active,
	onNewSession,
	onDelete,
}: {
	group: Group;
	count: number;
	active: boolean;
	onNewSession: () => void;
	onDelete: () => void;
}) {
	useLang();
	const [renaming, setRenaming] = useState(false);
	const drop = useSessionDrop((id) => updateSession(id, { groupId: group.id }));
	return (
		<div className="session-item" {...drop.props}>
			{renaming ? (
				<InlineRename
					icon={<TeamIcon />}
					value={group.name}
					onSave={(name) => renameGroup(group.id, name)}
					onDone={() => setRenaming(false)}
				/>
			) : (
				<button
					type="button"
					className="session-row"
					aria-pressed={active}
					onClick={() => {
						setState({ teamFilter: active ? null : group.id });
						// Choosing a team is asking for its sessions: open that list if it is folded.
						if (!active) setSectionFolded("sessions", false);
					}}
					onDoubleClick={() => setRenaming(true)}
				>
					<span className="session-icon" aria-hidden="true">
						<TeamIcon />
					</span>
					<span className="session-name">
						{group.name}
						<span className="visually-hidden"> · {t("teamCount", { n: count })}</span>
					</span>
					<span className="session-time" aria-hidden="true">
						{count}
					</span>
				</button>
			)}
			{!renaming && (
				<span className="session-row-menu">
					<Menu
						label={`${group.name} – ${t("more")}`}
						items={[
							{ label: t("newSessionHere"), onSelect: onNewSession },
							{ label: t("rename"), onSelect: () => setRenaming(true) },
							{ label: t("deleteGroup"), danger: true, onSelect: onDelete },
						]}
					/>
				</span>
			)}
			{drop.error !== null && drop.error !== undefined && (
				<div className="row-error">
					<ErrorBox error={drop.error} />
				</div>
			)}
		</div>
	);
}

/**
 * The sessions in no team, listed after the teams and chosen like one. Dropping a session here
 * takes it out of its team.
 */
function NoTeamRow({ count, active }: { count: number; active: boolean }) {
	useLang();
	const drop = useSessionDrop((id) => updateSession(id, { groupId: null }));
	return (
		<div className="session-item" {...drop.props}>
			<button
				type="button"
				className="session-row"
				aria-pressed={active}
				onClick={() => {
					setState({ teamFilter: active ? null : NO_TEAM });
					if (!active) setSectionFolded("sessions", false);
				}}
			>
				<span className="session-icon" aria-hidden="true">
					<NoTeamIcon />
				</span>
				<span className="session-name">
					{t("noTeam")}
					<span className="visually-hidden"> · {t("teamCount", { n: count })}</span>
				</span>
				<span className="session-time" aria-hidden="true">
					{count}
				</span>
			</button>
			{drop.error !== null && drop.error !== undefined && (
				<div className="row-error">
					<ErrorBox error={drop.error} />
				</div>
			)}
		</div>
	);
}

function useFolded(section: SidebarSection): boolean {
	return useAppState((state) => state.foldedSections.includes(section));
}

/** A list's heading: its name folds the list to this line or opens it again; buttons sit after it. */
function SectionHeading({
	section,
	children,
	actions,
}: {
	section: SidebarSection;
	children: ReactNode;
	actions?: ReactNode;
}) {
	const folded = useFolded(section);
	return (
		<div className="group-heading">
			<button
				type="button"
				className="heading-toggle"
				aria-expanded={!folded}
				aria-controls={`sidebar-${section}`}
				onClick={() => setSectionFolded(section, !folded)}
			>
				<span className="heading-text">{children}</span>
				<ChevronIcon />
			</button>
			{actions}
		</div>
	);
}

/** A list's rows, left out while the list is folded. */
function SectionBody({ section, children }: { section: SidebarSection; children: ReactNode }) {
	const folded = useFolded(section);
	return (
		<div id={`sidebar-${section}`} hidden={folded}>
			{!folded && children}
		</div>
	);
}

function Teams() {
	useLang();
	const groups = useAppState((state) => state.groups);
	const sessions = useAppState((state) => state.sessions);
	const filter = useAppState((state) => state.teamFilter);
	const [dialog, setDialog] = useState<
		| { kind: "create" }
		| { kind: "session"; groupId: string }
		| { kind: "delete"; group: Group }
		| null
	>(null);
	const counts = new Map<string, number>();
	let teamless = 0;
	for (const session of Object.values(sessions)) {
		if (session.archivedAt !== null) continue;
		if (session.groupId) counts.set(session.groupId, (counts.get(session.groupId) ?? 0) + 1);
		else teamless += 1;
	}
	return (
		<section aria-label={t("teams")}>
			<SectionHeading
				section="teams"
				actions={
					<Button
						variant="icon"
						className="heading-add"
						aria-label={t("newGroup")}
						title={t("newGroup")}
						onClick={() => setDialog({ kind: "create" })}
					>
						<NewTeamIcon />
					</Button>
				}
			>
				{t("teams")}
			</SectionHeading>
			<SectionBody section="teams">
				{groups.length === 0 ? (
					<p className="empty-box">{t("noTeams")}</p>
				) : (
					groups.map((group) => (
						<TeamRow
							key={group.id}
							group={group}
							count={counts.get(group.id) ?? 0}
							active={filter === group.id}
							onNewSession={() => setDialog({ kind: "session", groupId: group.id })}
							onDelete={() => setDialog({ kind: "delete", group })}
						/>
					))
				)}
				{/* With teams in use, the sessions in none are one click away too. */}
				{groups.length > 0 && teamless > 0 && (
					<NoTeamRow count={teamless} active={filter === NO_TEAM} />
				)}
			</SectionBody>
			{dialog?.kind === "create" && <GroupDialog onClose={() => setDialog(null)} />}
			{dialog?.kind === "session" && (
				<NewSessionDialog groupId={dialog.groupId} onClose={() => setDialog(null)} />
			)}
			{dialog?.kind === "delete" && (
				<ConfirmDialog
					title={t("deleteGroup")}
					body={t("deleteGroupBody")}
					confirmLabel={t("delete")}
					onConfirm={async () => {
						await deleteGroup(dialog.group.id);
						if (filter === dialog.group.id) setState({ teamFilter: null });
					}}
					onClose={() => setDialog(null)}
				/>
			)}
		</section>
	);
}

/** Saved workspaces: click one to start a session in it. */
function Workspaces() {
	useLang();
	const workspaces = useWorkspaces();
	const [creating, setCreating] = useState(false);
	return (
		<section aria-label={t("workspaces")}>
			<SectionHeading
				section="workspaces"
				actions={
					<Button
						variant="icon"
						className="heading-add"
						aria-label={t("newWorkspace")}
						title={t("newWorkspace")}
						onClick={() => setCreating(true)}
					>
						<NewWorkspaceIcon />
					</Button>
				}
			>
				{t("workspaces")}
			</SectionHeading>
			<SectionBody section="workspaces">
				{workspaces.length === 0 ? (
					<p className="empty-box">{t("noWorkspaces")}</p>
				) : (
					workspaces.map((workspace) => (
						<WorkspaceRow key={workspace.id} workspace={workspace} all={workspaces} />
					))
				)}
			</SectionBody>
			{creating && (
				<WorkspaceDialog
					onClose={() => setCreating(false)}
					onCreated={(path) => {
						closeDrawer();
						setState({ homeFolder: path });
						void selectSession(null);
					}}
				/>
			)}
		</section>
	);
}

function SessionRow({
	session,
	selected,
	groups,
	now,
	blocked = false,
	depth = 0,
}: {
	session: Session;
	selected: boolean;
	groups: Group[];
	now: number;
	/** Something of this session's waits in the approval center, whatever the session does meanwhile. */
	blocked?: boolean;
	/** Sessions opened by another are listed under it, indented. */
	depth?: number;
}) {
	useLang();
	const isMain = useAppState((state) => state.settings?.mainSessionId === session.id);
	const team = groups.find((group) => group.id === session.groupId)?.name ?? null;
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [renaming, setRenaming] = useState(false);
	const download = useAction(() => exportSession(session));
	const copy = useAction(() => duplicateSession(session.id));
	const [newTeam, setNewTeam] = useState(false);
	// "Move to team": every team, the current one checked; then leaving it, or a new team (as in Claude).
	const teams: MenuEntry[] = [
		...groups.map((group) => ({
			id: group.id,
			label: group.name,
			checked: group.id === session.groupId,
			onSelect: () => void updateSession(session.id, { groupId: group.id }),
		})),
		...(groups.length > 0 ? [{ separator: true as const, id: "teams-end" }] : []),
		...(session.groupId
			? [
					{
						label: t("removeFromGroup"),
						onSelect: () => void updateSession(session.id, { groupId: null }),
					},
				]
			: []),
		{ label: t("newTeamEllipsis"), onSelect: () => setNewTeam(true) },
	];
	return (
		<div
			className="session-item"
			style={depth > 0 ? ({ "--depth": Math.min(depth, 3) } as React.CSSProperties) : undefined}
			data-child={depth > 0 ? "true" : undefined}
		>
			{renaming ? (
				<InlineRename
					icon={session.cwd ? <CodeIcon /> : <ChatIcon />}
					value={session.name}
					onSave={(name) => updateSession(session.id, { name })}
					onDone={() => setRenaming(false)}
				/>
			) : (
				<button
					type="button"
					className="session-row"
					aria-current={selected ? "true" : undefined}
					draggable
					onDragStart={(event) => {
						event.dataTransfer.setData(SESSION_DRAG, session.id);
						event.dataTransfer.effectAllowed = "move";
					}}
					onClick={() => {
						closeDrawer();
						void selectSession(session.id);
					}}
					onDoubleClick={() => setRenaming(true)}
				>
					{/* Chat or code (with a workspace). */}
					<span className="session-icon" aria-hidden="true">
						{session.cwd ? <CodeIcon /> : <ChatIcon />}
					</span>
					<span className="session-name">
						{session.name}
						<span className="visually-hidden">
							{" "}
							· {session.cwd ? t("mode_code") : t("mode_chat")} ·{" "}
							{t(`status_${blocked && session.status === "idle" ? "waiting" : session.status}`)}
							{blocked && !["idle", "waiting"].includes(session.status)
								? ` · ${t("status_waiting")}`
								: ""}
							{isMain ? ` · ${t("mainConversation")}` : ""}
							{team ? ` · ${team}` : ""}
							{session.pinned ? ` · ${t("pinned")}` : ""}
							{session.unread > 0 ? ` · ${t("unread", { n: session.unread })}` : ""}
						</span>
					</span>
					{session.pinned && <PinIcon />}
					{/*
					 * On the right: the status while it is not idle (waiting for you comes first), else the
					 * unread count, else the time. The unread count is a plain grey number, weaker than the
					 * approval center's count of what waits for you, which keeps its chip.
					 */}
					{session.status !== "idle" ? (
						<span className={`dot row-dot dot-${session.status}`} aria-hidden="true" />
					) : blocked ? (
						// Idle, with a decision card of its own in the approval center: it waits for you too.
						<span className="dot row-dot dot-waiting" aria-hidden="true" />
					) : session.unread > 0 ? (
						<span className="unread-count" aria-hidden="true">
							{session.unread}
						</span>
					) : (
						<span className="session-time" aria-hidden="true">
							{formatAgo(session.lastActivityAt, now)}
						</span>
					)}
				</button>
			)}
			{/* While renaming, the field takes the whole row and the menu steps aside. */}
			{!renaming && (
				<span className="session-row-menu">
					<Menu
						label={`${session.name} – ${t("more")}`}
						items={[
							// The session itself.
							{
								label: session.pinned ? t("unpin") : t("pin"),
								icon: <MenuPinIcon />,
								onSelect: () => void updateSession(session.id, { pinned: !session.pinned }),
							},
							{ label: t("rename"), icon: <RenameIcon />, onSelect: () => setRenaming(true) },
							{ label: t("duplicate"), icon: <CopyIcon />, onSelect: () => void copy.run() },
							{ separator: true, id: "role" },
							// Its place and its settings.
							...(session.archivedAt === null
								? [
										{
											label: isMain ? t("unsetMain") : t("setMain"),
											icon: <MainIcon />,
											onSelect: () => void setMainSession(isMain ? null : session.id),
										},
									]
								: []),
							{
								label: t("sessionSettings"),
								icon: <SlidersIcon />,
								onSelect: () => setSettingsOpen(true),
							},
							{ separator: true, id: "move" },
							// Where it goes.
							{ label: t("moveToTeam"), icon: <TeamIcon />, items: teams },
							{
								label: t("exportAs"),
								icon: <ExportIcon />,
								items: [{ label: t("exportMarkdown"), onSelect: () => void download.run() }],
							},
							{ separator: true, id: "archive" },
							session.archivedAt
								? {
										label: t("unarchive"),
										icon: <ArchiveIcon />,
										onSelect: () => void updateSession(session.id, { archived: false }),
									}
								: {
										label: t("archive"),
										icon: <ArchiveIcon />,
										onSelect: () => void updateSession(session.id, { archived: true }),
									},
						]}
					/>
				</span>
			)}
			{settingsOpen && (
				<SessionSettingsDialog session={session} onClose={() => setSettingsOpen(false)} />
			)}
			{newTeam && (
				<GroupDialog
					onClose={() => setNewTeam(false)}
					onCreated={(group) => updateSession(session.id, { groupId: group.id })}
				/>
			)}
			{copy.error !== null && copy.error !== undefined && (
				<div className="row-error">
					<ErrorBox error={copy.error} />
				</div>
			)}
			{download.busy && (
				<p className="hint row-error" role="status">
					{t("exporting")}
				</p>
			)}
			{download.error !== null && (
				<div className="row-error">
					<ErrorBox error={download.error} />
				</div>
			)}
		</div>
	);
}

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

/**
 * The fixed entries at the top: the main conversation, the approval center and the scheduled tasks.
 */
/**
 * The pages opened less often (artifacts, the session map, usage) are in a menu that shows beside its
 * entry: the top of the sidebar stays short, and nothing under it moves when the menu opens. While one
 * of them is open the entry is the selected one and names the page.
 */
function MoreMenu({ variant }: { variant: "row" | "icon" }) {
	useLang();
	const page = useAppState((state) => state.page);
	const pages = [
		{ page: "artifacts", label: t("artifacts"), icon: <ArtifactIcon />, open: openArtifacts },
		{ page: "map", label: t("map"), icon: <MapIcon />, open: openMap },
		{ page: "usage", label: t("usage"), icon: <UsageIcon />, open: openUsage },
	];
	const current = pages.find((entry) => entry.page === page) ?? null;
	return (
		<Menu
			flyout
			label={current ? `${t("navMore")} · ${current.label}` : t("navMore")}
			items={pages.map((entry) => ({
				label: entry.label,
				icon: entry.icon,
				checked: entry === current,
				onSelect: () => entry.open(),
			}))}
			trigger={{
				className: variant === "row" ? "nav-row" : "btn btn-ghost btn-icon",
				current: current !== null,
				content:
					variant === "row" ? (
						<>
							<MoreIcon />
							<span className="nav-label">{t("navMore")}</span>
							{current && <span className="nav-detail">{current.label}</span>}
							<ChevronIcon />
						</>
					) : (
						<MoreIcon />
					),
			}}
		/>
	);
}

function FixedEntries() {
	useLang();
	const mainId = useAppState((state) => state.settings?.mainSessionId ?? null);
	const mainName = useAppState((state) => (mainId ? (state.sessions[mainId]?.name ?? null) : null));
	const selected = useAppState((state) => (state.page ? null : state.selectedId));
	const count = useAppState((state) => centerCount(state.center));
	const open = useAppState((state) => state.page === "center");
	const onSchedules = useAppState((state) => state.page === "schedules");
	return (
		<>
			{mainId && mainName && (
				<button
					type="button"
					className="nav-row"
					aria-current={selected === mainId ? "page" : undefined}
					onClick={() => {
						closeDrawer();
						void selectSession(mainId);
					}}
				>
					<MainIcon />
					<span className="nav-label">{t("mainConversation")}</span>
					<span className="nav-detail">{mainName}</span>
				</button>
			)}
			<button
				type="button"
				className="nav-row"
				aria-current={open ? "page" : undefined}
				onClick={() => openCenter("pending")}
			>
				<CenterIcon />
				<span className="nav-label">{t("approvalCenter")}</span>
				{count > 0 && (
					<>
						<span className="badge" aria-hidden="true">
							{count}
						</span>
						<span className="visually-hidden">{t("approvalCount", { n: count })}</span>
					</>
				)}
			</button>
			<button
				type="button"
				className="nav-row"
				aria-current={onSchedules ? "page" : undefined}
				onClick={() => openSchedules()}
			>
				<ScheduleIcon />
				<span className="nav-label">{t("schedules")}</span>
			</button>
			<MoreMenu variant="row" />
		</>
	);
}

function Search() {
	useLang();
	const [query, setQuery] = useState("");
	const [result, setResult] = useState<SearchResult | null>(null);
	const sessions = useAppState((state) => state.sessions);
	const groups = useAppState((state) => state.groups);
	const workspaces = useWorkspaces();
	// Teams and workspaces are few and already loaded; they are matched here, by name or folder.
	const needle = query.trim().toLowerCase();
	const teams = needle ? groups.filter((group) => group.name.toLowerCase().includes(needle)) : [];
	const places = needle
		? workspaces.filter(
				(workspace) =>
					workspace.name.toLowerCase().includes(needle) ||
					workspace.path.toLowerCase().includes(needle),
			)
		: [];
	const box = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const q = query.trim();
		if (!q) {
			setResult(null);
			return;
		}
		const timer = setTimeout(() => {
			void api<SearchResult>("GET", `/api/search?q=${encodeURIComponent(q)}&limit=20`).then(
				setResult,
				() => setResult(null),
			);
		}, 200);
		return () => clearTimeout(timer);
	}, [query]);
	useEffect(() => {
		const onDown = (event: MouseEvent) => {
			if (!box.current?.contains(event.target as Node)) setResult(null);
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, []);
	const done = () => {
		setQuery("");
		setResult(null);
		closeDrawer();
	};
	const open = (id: string) => {
		done();
		void selectSession(id);
	};
	return (
		<div className="sidebar-search" ref={box}>
			<div className="search-field">
				<SearchIcon />
				<input
					className="input"
					type="search"
					placeholder={t("search")}
					aria-label={t("search")}
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					onKeyDown={(event) => event.key === "Escape" && setQuery("")}
				/>
			</div>
			{result && (
				<section className="search-results" aria-label={t("searchResults")}>
					{result.sessions.length + result.hits.length + teams.length + places.length === 0 && (
						<p className="hint">{t("noResults")}</p>
					)}
					{teams.map((group) => (
						<button
							key={group.id}
							type="button"
							className="search-hit search-hit-row"
							onClick={() => {
								done();
								setState({ teamFilter: group.id });
							}}
						>
							<TeamIcon />
							<strong>{group.name}</strong>
							<span className="hint">{t("teams")}</span>
						</button>
					))}
					{places.map((workspace) => (
						<button
							key={workspace.id}
							type="button"
							className="search-hit search-hit-row"
							title={workspace.path}
							onClick={() => {
								done();
								setState({ homeFolder: workspace.path });
								void selectSession(null);
							}}
						>
							<FolderIcon />
							<strong>{workspace.name}</strong>
							<span className="hint">{shortPath(workspace.path)}</span>
						</button>
					))}
					{result.sessions.map((session) => (
						<button
							key={session.id}
							type="button"
							className="search-hit"
							onClick={() => open(session.id)}
						>
							<strong>{session.name}</strong>
						</button>
					))}
					{result.hits.map((hit) => (
						<button
							key={hit.entryId}
							type="button"
							className="search-hit"
							onClick={() => open(hit.sessionId)}
						>
							<span className="hint">{sessions[hit.sessionId]?.name ?? ""}</span>
							<br />
							<Snippet text={hit.snippet} />
						</button>
					))}
				</section>
			)}
		</div>
	);
}

/**
 * The folded sidebar on wide screens, as in ChatGPT: Yew's graphic on top (it turns into the
 * open button under the pointer), then the main actions as icons, settings at the bottom (a
 * collapsed navigation shows the product graphic only).
 */
export function SidebarRail() {
	useLang();
	const mainId = useAppState((state) => state.settings?.mainSessionId ?? null);
	const hasMain = useAppState((state) => (mainId ? Boolean(state.sessions[mainId]) : false));
	const count = useAppState((state) => centerCount(state.center));
	const onCenter = useAppState((state) => state.page === "center");
	const onSchedules = useAppState((state) => state.page === "schedules");
	const [dialog, setDialog] = useState<"team" | "workspace" | null>(null);
	return (
		<nav className="rail" aria-label={t("sessions")}>
			<button
				type="button"
				className="rail-brand"
				aria-label={t("expandSidebar")}
				title={t("expandSidebar")}
				onClick={() => setSidebarCollapsed(false)}
			>
				<span className="rail-mark">
					<YewMark size={22} />
				</span>
				<span className="rail-open">
					<ExpandIcon />
				</span>
			</button>
			{mainId && hasMain && (
				<Button
					variant="icon"
					aria-label={t("mainConversation")}
					title={t("mainConversation")}
					onClick={() => void selectSession(mainId)}
				>
					<MainIcon />
				</Button>
			)}
			<Button
				variant="icon"
				className="rail-center"
				aria-label={
					count > 0
						? `${t("approvalCenter")} · ${t("approvalCount", { n: count })}`
						: t("approvalCenter")
				}
				title={t("approvalCenter")}
				aria-current={onCenter ? "page" : undefined}
				onClick={() => openCenter("pending")}
			>
				<CenterIcon />
				{count > 0 && (
					<span className="rail-badge" aria-hidden="true">
						{count}
					</span>
				)}
			</Button>
			<Button
				variant="icon"
				aria-label={t("schedules")}
				title={t("schedules")}
				aria-current={onSchedules ? "page" : undefined}
				onClick={() => openSchedules()}
			>
				<ScheduleIcon />
			</Button>
			<MoreMenu variant="icon" />
			<Button
				variant="icon"
				aria-label={t("search")}
				title={t("search")}
				onClick={() => {
					setSidebarCollapsed(false);
					requestAnimationFrame(() =>
						document.querySelector<HTMLInputElement>(".sidebar-search input")?.focus(),
					);
				}}
			>
				<SearchIcon />
			</Button>
			<Button
				variant="icon"
				aria-label={t("newGroup")}
				title={t("newGroup")}
				onClick={() => setDialog("team")}
			>
				<NewTeamIcon />
			</Button>
			<Button
				variant="icon"
				aria-label={t("newWorkspace")}
				title={t("newWorkspace")}
				onClick={() => setDialog("workspace")}
			>
				<NewWorkspaceIcon />
			</Button>
			<Button
				variant="icon"
				aria-label={t("newSession")}
				title={t("newSession")}
				onClick={() => void selectSession(null)}
			>
				<ComposeIcon />
			</Button>
			<span className="rail-spacer" />
			<SettingsButton variant="icon" />
			{dialog === "team" && <GroupDialog onClose={() => setDialog(null)} />}
			{dialog === "workspace" && (
				<WorkspaceDialog
					onClose={() => setDialog(null)}
					onCreated={(path) => {
						setState({ homeFolder: path });
						void selectSession(null);
					}}
				/>
			)}
		</nav>
	);
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
