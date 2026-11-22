import { useState } from "react";
import type { Group, Session } from "../../../../src/shared/types.ts";
import { duplicateSession, exportSession, updateSession } from "../../actions/sessions.ts";
import { selectSession, setMainSession } from "../../actions.ts";
import { formatAgo, t, useLang } from "../../i18n.ts";
import { useAppState } from "../../state.ts";
import { GroupDialog, SessionSettingsDialog } from "../dialogs.tsx";
import {
	ArchiveIcon,
	ChatIcon,
	CodeIcon,
	CopyIcon,
	ExportIcon,
	MainIcon,
	MenuPinIcon,
	PinIcon,
	RenameIcon,
	SlidersIcon,
	TeamIcon,
} from "../icons.tsx";
import { Menu, type MenuEntry } from "../menu.tsx";
import { ErrorBox, useAction } from "../ui.tsx";
import { closeDrawer, InlineRename, SESSION_DRAG } from "./parts.tsx";

export function SessionRow({
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
