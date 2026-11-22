import { useState } from "react";
import type { Group } from "../../../../src/shared/types.ts";
import { deleteGroup, renameGroup, updateSession } from "../../actions/sessions.ts";
import { saveSettings } from "../../actions/settings.ts";
import { selectSession } from "../../actions.ts";
import { t, useLang } from "../../i18n.ts";
import { NO_TEAM, setSectionFolded, setState, useAppState, type Workspace } from "../../state.ts";
import { ConfirmDialog, GroupDialog, NewSessionDialog } from "../dialogs.tsx";
import { FolderIcon, NewTeamIcon, NewWorkspaceIcon, NoTeamIcon, TeamIcon } from "../icons.tsx";
import { Menu } from "../menu.tsx";
import { Button, ErrorBox, useAction } from "../ui.tsx";
import { shortPath, useWorkspaces, WorkspaceDialog } from "../workspaces.tsx";
import { closeDrawer, InlineRename, SESSION_DRAG, SectionBody, SectionHeading } from "./parts.tsx";

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

export function Teams() {
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
export function Workspaces() {
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
