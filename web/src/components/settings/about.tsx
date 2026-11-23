import { type ReactNode, useEffect, useId, useState } from "react";
import { POLICY_VERSION } from "../../../../src/shared/policy.ts";
import { saveSettings } from "../../actions/settings.ts";
import { checkUpdates, installUpdate, loadUpdates, restartYew } from "../../actions/updates.ts";
import { formatAgo, getLang, t, useLang } from "../../i18n.ts";
import { useAppState } from "../../state.ts";
import { Dialog } from "../dialog.tsx";
import {
	ArrowUpIcon,
	CheckIcon,
	ChevronIcon,
	CodeIcon,
	CopyIcon,
	ProductName,
	RefuseIcon,
	RetryIcon,
	YewMark,
} from "../icons.tsx";
import { Mascot } from "../mascot.tsx";
import { Button, ErrorBox, Switch, Toggletip, useAction, useNow } from "../ui.tsx";

export function About() {
	useLang();
	const updates = useAppState((state) => state.updates);
	const checks = useAppState((state) => state.settings?.updateCheck !== false);
	const checkId = useId();
	const [doc, setDoc] = useState<"privacy" | "terms" | null>(null);
	const paragraphs = (body: string) =>
		body.split("\n\n").map((paragraph) => <p key={paragraph.slice(0, 24)}>{paragraph}</p>);
	return (
		<section className="settings-section about" aria-labelledby="settings-about">
			<h2 id="settings-about" className="visually-hidden">
				{t("about")}
			</h2>
			{/* In order: lockup, version, text, publisher, website, privacy policy, terms, feedback. */}
			<div className="about-head">
				{/* Full lockup on the About page, named by the product's name. */}
				<div className="about-hero">
					<Mascot pose="gift" height={112} className="about-mascot" />
					<div className="lockup about-lockup" role="img" aria-label={t("lockupName")}>
						<YewMark className="lockup-mark" size={56} />
						<ProductName />
					</div>
				</div>
				<VersionLine />
			</div>
			<div className="about-text">{paragraphs(t("aboutBody"))}</div>
			<div className="about-list">
				<div className="about-row">
					<span className="about-label">{t("publisher")}</span>
					{/* The small horizontal publisher mark, the only place with the Tenon mark. */}
					<span className="publisher-mark">
						<img src="/icons/tenon-mark.svg" alt="" width={18} height={18} />
						{t("publisherName")}
					</span>
				</div>
				<div className="about-row">
					<span className="about-label">{t("website")}</span>
					<a href="https://tenonai.cn/" target="_blank" rel="noopener noreferrer">
						tenonai.cn
					</a>
				</div>
				<button type="button" className="about-row" onClick={() => setDoc("privacy")}>
					{t("privacyPolicy")}
					<ChevronIcon />
				</button>
				<button type="button" className="about-row" onClick={() => setDoc("terms")}>
					{t("terms")}
					<ChevronIcon />
				</button>
				<div className="about-row">
					<span className="about-label">{t("feedback")}</span>
					<a href="mailto:support@tenonai.cn">support@tenonai.cn</a>
				</div>
				{updates && updates.kind !== "source" && (
					<div className="about-row">
						<span className="about-label">
							<span id={checkId}>{t("update_daily")}</span>
							<Toggletip label={t("update_daily")} text={t("update_dailyHint")} />
						</span>
						<Switch
							checked={checks}
							labelledBy={checkId}
							onChange={(on) => void saveSettings({ updateCheck: on }).catch(() => {})}
						/>
					</div>
				)}
			</div>
			{doc && (
				<Dialog
					title={doc === "privacy" ? t("privacyPolicy") : t("terms")}
					size="l"
					onClose={() => setDoc(null)}
					footer={<Button onClick={() => setDoc(null)}>{t("close")}</Button>}
				>
					<p className="hint">{t("docVersion", { v: POLICY_VERSION, date: t("policyDate") })}</p>
					{paragraphs(doc === "privacy" ? t("privacyPolicyBody") : t("termsBody"))}
				</Dialog>
			)}
		</section>
	);
}

/** Where a version's changes are listed: the release notes, in the interface's language. */
function releaseNotes(version: string): string {
	return getLang() === "zh"
		? `https://gitee.com/dozybot/yew/releases/tag/v${version}`
		: `https://github.com/dozybot001/Yew/releases/tag/v${version}`;
}

/**
 * The version on the About page as one card: an icon for how it stands, a
 * title and a line of detail, and the one button there is something to do with: check, update, or
 * restart. Where Yew Harness cannot install, the command; where an update failed, why.
 */
function VersionLine() {
	useLang();
	const health = useAppState((state) => state.health);
	const updates = useAppState((state) => state.updates);
	const [asking, setAsking] = useState(false);
	const now = useNow(60_000);
	const check = useAction(checkUpdates);
	const install = useAction(installUpdate);
	const restart = useAction(async (now: boolean) => {
		await restartYew(now);
		setAsking(false);
	});
	const copy = useAction(async (text: string) => navigator.clipboard.writeText(text));
	useEffect(() => {
		void loadUpdates();
	}, []);
	const versionText = t("version", { v: health?.version ?? "" });
	// What is installed: a newer commit that left the service's code alone is in use already.
	const build = updates?.installed.build ?? health?.build;
	const buildText = build ? t("build", { b: build }) : null;
	const join = (...parts: ReactNode[]) =>
		parts
			.filter((part) => part !== null && part !== undefined && part !== "")
			.flatMap((part, index) => (index === 0 ? [part] : [" · ", part]));
	const checkButton = (
		<Button busy={check.busy} onClick={() => void check.run()}>
			<RetryIcon />
			{t("update_check")}
		</Button>
	);
	let state = "current";
	let icon: ReactNode = <CheckIcon />;
	let title: ReactNode = versionText;
	let detail: ReactNode[] = join(buildText);
	let action: ReactNode = checkButton;
	let below: ReactNode = null;
	if (updates) {
		const { job, latest } = updates;
		const installButton =
			updates.available && latest && !updates.manual ? (
				<Button
					variant="primary"
					busy={install.busy}
					onClick={() => void install.run(latest.version)}
				>
					<ArrowUpIcon />
					{t("update_install", { v: latest.version })}
				</Button>
			) : null;
		const manualBlock = updates.manual ? (
			<div className="update-manual">
				<p className="hint">{t("update_manual")}</p>
				<div className="update-command">
					<code className="update-code">{updates.manual}</code>
					<Button
						variant="icon"
						aria-label={t("copy")}
						busy={copy.busy}
						onClick={() => void copy.run(updates.manual ?? "")}
					>
						<CopyIcon />
					</Button>
				</div>
			</div>
		) : null;
		const notes = (version: string) => (
			<a href={releaseNotes(version)} target="_blank" rel="noopener noreferrer">
				{t("update_notes")}
			</a>
		);
		if (job?.state === "installing") {
			state = "busy";
			icon = <RetryIcon />;
			title = t("update_installing", { v: job.version });
			detail = join(versionText);
			action = null;
		} else if (job?.state === "failed" && !updates.restart) {
			// What went wrong, then what can be done: the command, or trying again.
			state = "failed";
			icon = <RefuseIcon />;
			title = t("update_failed", { v: job.version });
			detail = join(versionText);
			action = installButton;
			below = (
				<>
					<details className="update-output">
						<summary>{t("update_why")}</summary>
						<pre>{job.output}</pre>
					</details>
					{manualBlock}
				</>
			);
		} else if (updates.restart || job?.state === "installed") {
			state = "ready";
			icon = <RetryIcon />;
			title =
				updates.kind === "source" && updates.installed.version === updates.version
					? t("update_sourceChangedTitle", { b: updates.installed.build ?? "" })
					: t("update_installedTitle", { v: updates.installed.version });
			detail = join(
				updates.restartPending ? t("update_restartWaiting") : t("update_restartHint"),
				versionText,
			);
			action = (
				<Button
					variant="primary"
					busy={restart.busy}
					onClick={() => (updates.busy > 0 ? setAsking(true) : void restart.run(true))}
				>
					<RetryIcon />
					{updates.restartPending ? t("update_restartNow") : t("update_restart")}
				</Button>
			);
		} else if (updates.available && latest) {
			state = "available";
			icon = <ArrowUpIcon />;
			title = t("update_available", { v: latest.version });
			detail = join(versionText, notes(latest.version));
			action = installButton;
			below = manualBlock;
		} else if (updates.kind === "source") {
			state = "source";
			icon = <CodeIcon />;
			title = t("update_source");
			detail = join(versionText, buildText);
			action = null;
		} else if (latest) {
			title = t("update_upToDate");
			detail = join(
				versionText,
				buildText,
				now - latest.checkedAt < 60_000
					? t("update_checkedNow")
					: t("update_checked", { time: formatAgo(latest.checkedAt, now) }),
			);
		}
	}
	return (
		<>
			<div className="update-card" data-state={state}>
				<span
					className={state === "busy" ? "update-icon update-spin" : "update-icon"}
					aria-hidden="true"
				>
					{icon}
				</span>
				<div className="update-text" aria-live="polite">
					<div className="update-title">{title}</div>
					{detail.length > 0 && <div className="update-detail">{detail}</div>}
				</div>
				{action && <div className="update-action">{action}</div>}
				{below && <div className="update-below">{below}</div>}
			</div>
			<ErrorBox error={check.error ?? install.error ?? restart.error ?? copy.error} />
			{asking && updates && (
				<Dialog
					title={t("update_restartTitle")}
					size="s"
					onClose={() => setAsking(false)}
					footer={
						<>
							<Button onClick={() => setAsking(false)}>{t("cancel")}</Button>
							<Button busy={restart.busy} onClick={() => void restart.run(false)}>
								{t("update_restartLater")}
							</Button>
							<Button variant="danger" busy={restart.busy} onClick={() => void restart.run(true)}>
								{t("update_restartNow")}
							</Button>
						</>
					}
				>
					<p>{t("update_restartBody", { n: updates.busy })}</p>
				</Dialog>
			)}
		</>
	);
}
