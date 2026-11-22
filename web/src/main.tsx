import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { boot, openSettings } from "./actions.ts";
import { ArtifactsPage } from "./components/artifacts.tsx";
import { CenterPage } from "./components/center.tsx";
import { Companion } from "./components/companion.tsx";
import { MapPage } from "./components/map.tsx";
import { Mascot } from "./components/mascot.tsx";
import { Opening } from "./components/opening.tsx";
import { SchedulesPage } from "./components/schedules.tsx";
import { SessionView } from "./components/session.tsx";
import { SettingsDialogs } from "./components/settings.tsx";
import { SidebarRail } from "./components/sidebar/entries.tsx";
import { useNarrow } from "./components/sidebar/parts.tsx";
import { Sidebar } from "./components/sidebar.tsx";
import { Button } from "./components/ui.tsx";
import { UsagePage } from "./components/usage.tsx";
import { t, useLang } from "./i18n.ts";
import { watchInput } from "./input.ts";
import type { MascotPose } from "./poses.ts";
import { watchPresence } from "./presence.ts";
import { centerCount, setState, useAppState } from "./state.ts";
import "./styles/app.css";

function App() {
	useLang();
	const phase = useAppState((state) => state.phase);
	const failure = useAppState((state) => state.failure);
	const connection = useAppState((state) => state.connection);
	const collapsed = useAppState((state) => state.sidebarCollapsed);
	const drawerOpen = useAppState((state) => state.drawerOpen);
	const waiting = useAppState((state) => centerCount(state.center));
	const page = useAppState((state) => state.page);
	const selectedId = useAppState((state) => state.selectedId);
	const narrow = useNarrow();
	const yewOn = useAppState((state) => state.settings?.mascot !== false);
	const isWorking = useAppState((state) =>
		state.selectedId ? state.sessions[state.selectedId]?.status === "working" : false,
	);
	const centerTab = useAppState((state) => state.centerTab);
	const hasPermission = useAppState((state) =>
		Object.values(state.center.approvals).some((a) => a.kind === "permission"),
	);
	const hasEnabledSchedule = useAppState((state) =>
		Boolean(state.schedules?.some((schedule) => schedule.enabled)),
	);
	// Shown on desktop when 「界面里的 Yew」 is on: full portrait on the right for home/sessions,
	// enlarged centered Q-pose backdrop for each feature page.
	const backdrop = yewOn && !narrow;
	const isHome = page === null && !selectedId;
	const isFeature = page !== null;
	const featurePose: MascotPose | null =
		page === "center"
			? centerTab === "decided"
				? "gift"
				: centerTab === "letters"
					? "reading"
					: hasPermission
						? "permission"
						: "stamp"
			: page === "schedules"
				? hasEnabledSchedule
					? "on-duty"
					: "alarm"
				: page === "artifacts"
					? "writing"
					: page === "usage"
						? "clipboard"
						: page === "map"
							? "letter-run"
							: null;
	// The tab's title carries the approval center's count, so it shows in the tab strip.
	useEffect(() => {
		document.title = waiting > 0 ? `(${waiting}) Yew Harness` : "Yew Harness";
	}, [waiting]);
	// The drawer closes with Escape, like a dialog.
	useEffect(() => {
		if (!drawerOpen) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setState({ drawerOpen: false });
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [drawerOpen]);
	if (phase === "loading") {
		return (
			<div className="center-page" aria-busy="true">
				<p className="loading-word">{t("loading")}</p>
			</div>
		);
	}
	if (phase === "signin") {
		return (
			<div className="center-page">
				<div>
					<Mascot pose="waking" height={120} className="page-mascot" />
					<h1>{t("signInTitle")}</h1>
					<p>{t("signInBody")}</p>
				</div>
			</div>
		);
	}
	if (phase === "failed") {
		return (
			<div className="center-page">
				<div>
					<Mascot pose="sorry" height={120} className="page-mascot" />
					<h1>{t("errorTitle")}</h1>
					<p>{failure === "network" ? t("connectionLost") : failure}</p>
					<Button variant="primary" onClick={() => window.location.reload()}>
						{t("retry")}
					</Button>
				</div>
			</div>
		);
	}
	return (
		<>
			{connection === "connecting" && (
				<div className="banner" role="status">
					{t("connectionLost")}
				</div>
			)}
			<div
				className={`app${!narrow && collapsed ? " app-collapsed" : ""}${narrow && drawerOpen ? " sidebar-open" : ""}${backdrop ? " with-yew" : ""}${backdrop && isHome ? " yew-home" : ""}${backdrop && isFeature ? " yew-feature" : ""}${backdrop && !isFeature && isWorking ? " yew-working" : ""}`}
			>
				{!narrow && collapsed ? <SidebarRail /> : <Sidebar />}
				{/* Yew floats over the window; a narrow one has no room for her. */}
				{!narrow && <Companion />}
				{narrow && drawerOpen && (
					<div
						className="drawer-backdrop"
						aria-hidden="true"
						onClick={() => setState({ drawerOpen: false })}
					/>
				)}
				{backdrop && (
					<div className="yew-backdrop-layer" aria-hidden="true">
						{featurePose ? (
							<img
								key={featurePose}
								className="yew-backdrop yew-backdrop-feature"
								src={`/mascot/${featurePose}.webp`}
								alt=""
								draggable={false}
							/>
						) : (
							<img className="yew-backdrop" src="/mascot/portrait.webp" alt="" draggable={false} />
						)}
					</div>
				)}
				{page === "center" ? (
					<CenterPage />
				) : page === "schedules" ? (
					<SchedulesPage />
				) : page === "artifacts" ? (
					<ArtifactsPage />
				) : page === "usage" ? (
					<UsagePage />
				) : page === "map" ? (
					<MapPage />
				) : (
					<SessionView />
				)}
				<SettingsDialogs />
			</div>
		</>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<StrictMode>
			<App />
			<Opening />
		</StrictMode>,
	);
	watchInput();
	// After sign-in: a link's token is traded for the cookie first.
	void boot().then(watchPresence);
	// The Mac app's menu (macos/): "About Yew Harness" opens that page of the settings.
	window.addEventListener("yew-app", (event) => {
		if ((event as CustomEvent<unknown>).detail === "about") openSettings("about");
	});
}
