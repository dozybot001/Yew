import { useState } from "react";
import { openArtifacts, openMap, openSchedules, openUsage } from "../../actions/pages.ts";
import { openCenter, selectSession } from "../../actions.ts";
import { t, useLang } from "../../i18n.ts";
import { centerCount, setSidebarCollapsed, setState, useAppState } from "../../state.ts";
import { GroupDialog } from "../dialogs.tsx";
import {
	ArtifactIcon,
	CenterIcon,
	ChevronIcon,
	ComposeIcon,
	ExpandIcon,
	MainIcon,
	MapIcon,
	MoreIcon,
	NewTeamIcon,
	NewWorkspaceIcon,
	ScheduleIcon,
	SearchIcon,
	UsageIcon,
	YewMark,
} from "../icons.tsx";
import { Menu } from "../menu.tsx";
import { SettingsButton } from "../settings.tsx";
import { Button } from "../ui.tsx";
import { WorkspaceDialog } from "../workspaces.tsx";
import { closeDrawer } from "./parts.tsx";

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

export function FixedEntries() {
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
