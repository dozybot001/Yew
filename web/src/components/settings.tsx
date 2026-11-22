import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { openSettings } from "../actions.ts";
import { type MessageKey, t, useLang } from "../i18n.ts";
import { type SettingsDialogName, setState, useAppState } from "../state.ts";
import {
	BackIcon,
	CloseIcon,
	DataIcon,
	GearIcon,
	InfoIcon,
	KeyIcon,
	MailIcon,
	PhoneIcon,
	PowerIcon,
	SkillsIcon,
	SlidersIcon,
	ThemeIcon,
	ToolsIcon,
} from "./icons.tsx";
import { About } from "./settings/about.tsx";
import { DataDialog } from "./settings/data.tsx";
import { DefaultsDialog } from "./settings/defaults.tsx";
import { McpDialog } from "./settings/mcp.tsx";
import { PersonalDialog } from "./settings/personal.tsx";
import { PhonesDialog } from "./settings/phones.tsx";
import { ProvidersDialog } from "./settings/providers.tsx";
import { SkillsDialog } from "./settings/skills.tsx";
import { SystemDialog } from "./settings/system.tsx";
import { useNarrow } from "./sidebar.tsx";
import { Button, Dialog, InSettingsWindow, useBackdropClose } from "./ui.tsx";

/** The settings window's sections, in order. */
const SECTIONS: { name: SettingsDialogName; label: MessageKey; icon: ReactNode }[] = [
	{ name: "personal", label: "personalMenu", icon: <ThemeIcon /> },
	{ name: "providers", label: "providersMenu", icon: <KeyIcon /> },
	{ name: "defaults", label: "defaultsMenu", icon: <SlidersIcon /> },
	{ name: "mcp", label: "mcpMenu", icon: <ToolsIcon /> },
	{ name: "skills", label: "skillsMenu", icon: <SkillsIcon /> },
	{ name: "phones", label: "phonesMenu", icon: <PhoneIcon /> },
	{ name: "system", label: "systemMenu", icon: <PowerIcon /> },
	{ name: "data", label: "dataMenu", icon: <DataIcon /> },
	{ name: "about", label: "about", icon: <InfoIcon /> },
];

/** The section the settings open on: the one last looked at in this page. */
let lastSection: SettingsDialogName = "personal";

/** The settings window, when it is open; it covers the conversation without replacing it. */
export function SettingsDialogs() {
	useLang();
	const section = useAppState((state) => state.settingsDialog);
	return section ? <SettingsWindow section={section} /> : null;
}

/**
 * The settings window: the sections on the left, the chosen one on the right.
 * A narrow window shows one level at a time: the list first, then a section with a way back.
 */
function SettingsWindow({ section }: { section: SettingsDialogName }) {
	const ref = useRef<HTMLDialogElement>(null);
	const titleId = useId();
	const narrow = useNarrow();
	const [listing, setListing] = useState(narrow);
	const close = () => setState({ settingsDialog: null });
	const backdrop = useBackdropClose(close);
	useEffect(() => {
		const dialog = ref.current;
		if (!dialog) return;
		dialog.showModal();
		document.body.classList.add("scroll-locked");
		return () => {
			document.body.classList.remove("scroll-locked");
			if (dialog.open) dialog.close();
		};
	}, []);
	useEffect(() => {
		lastSection = section;
	}, [section]);
	const choose = (name: SettingsDialogName) => {
		setState({ settingsDialog: name });
		setListing(false);
	};
	const showList = !narrow || listing;
	const showPanel = !narrow || !listing;
	return (
		<dialog
			ref={ref}
			className="dialog settings-window"
			aria-labelledby={titleId}
			onCancel={(event) => {
				// React passes a dialog's cancel on to the dialogs around it; only the top one closes.
				if (event.target !== event.currentTarget) return;
				event.preventDefault();
				close();
			}}
			{...backdrop}
		>
			<div className="settings-frame">
				{showList && (
					<nav className="settings-nav" aria-labelledby={titleId}>
						<div className="settings-nav-head">
							<h2 id={titleId}>{t("settings")}</h2>
							{narrow && (
								<Button variant="icon" aria-label={t("close")} onClick={close}>
									<CloseIcon />
								</Button>
							)}
						</div>
						<ul className="settings-nav-list">
							{SECTIONS.map(({ name, label, icon }) => (
								<li key={name}>
									<button
										type="button"
										className="settings-nav-item"
										aria-current={!narrow && name === section ? "true" : undefined}
										onClick={() => choose(name)}
									>
										{icon}
										{t(label)}
									</button>
								</li>
							))}
						</ul>
						<a className="settings-nav-item settings-feedback" href="mailto:support@tenonai.cn">
							<MailIcon />
							{t("sendFeedback")}
						</a>
					</nav>
				)}
				{showPanel && (
					<div className="settings-pane">
						{narrow && (
							<Button className="settings-back" onClick={() => setListing(true)}>
								<BackIcon />
								{t("settings")}
							</Button>
						)}
						<InSettingsWindow>
							<SettingsSection name={section} onClose={close} />
						</InSettingsWindow>
					</div>
				)}
			</div>
		</dialog>
	);
}

function SettingsSection({ name, onClose }: { name: SettingsDialogName; onClose: () => void }) {
	if (name === "personal") return <PersonalDialog onClose={onClose} />;
	if (name === "defaults") return <DefaultsDialog onClose={onClose} />;
	if (name === "phones") return <PhonesDialog onClose={onClose} />;
	if (name === "mcp") return <McpDialog onClose={onClose} />;
	if (name === "skills") return <SkillsDialog onClose={onClose} />;
	if (name === "data") return <DataDialog onClose={onClose} />;
	if (name === "system") return <SystemDialog onClose={onClose} />;
	if (name === "providers") return <ProvidersDialog onClose={onClose} />;
	return (
		<Dialog title={t("about")} size="l" onClose={onClose}>
			<About />
		</Dialog>
	);
}

/**
 * The settings entry at the bottom of the sidebar: it opens the settings window, as
 * Cmd/Ctrl+, does.
 */
export function SettingsButton({ variant }: { variant: "row" | "icon" }) {
	useLang();
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key === ",") {
				event.preventDefault();
				openSettings(lastSection);
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, []);
	if (variant === "row") {
		return (
			<button
				type="button"
				className="nav-row"
				title={`${t("settings")}（⌘,）`}
				onClick={() => openSettings(lastSection)}
			>
				<GearIcon />
				{t("settings")}
			</button>
		);
	}
	return (
		<Button
			variant="icon"
			aria-label={t("settings")}
			title={t("settings")}
			onClick={() => openSettings(lastSection)}
		>
			<GearIcon />
		</Button>
	);
}
