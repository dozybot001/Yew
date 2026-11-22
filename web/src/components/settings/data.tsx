import { useCallback, useEffect, useId, useState } from "react";
import type { Session } from "../../../../src/shared/types.ts";
import { deleteArchivedSessions, loadArchived } from "../../actions/sessions.ts";
import {
	cleanUpData,
	exportData,
	loadData,
	pickFolder,
	revealData,
} from "../../actions/settings.ts";
import { formatBytes, formatClock, t, useLang } from "../../i18n.ts";
import type { DataCleanup, DataExport, DataOverview } from "../../state.ts";
import { Dialog } from "../dialog.tsx";
import { ConfirmDialog } from "../dialogs.tsx";
import { ExportIcon, FolderIcon, TrashIcon } from "../icons.tsx";
import { Button, ErrorBox, SettingGroup, useAction } from "../ui.tsx";

/**
 * Data: what the data folder takes and where it is, exporting everything
 * as `yew export` does, deleting the over-long command output, and deleting archived sessions. The
 * sizes are read when the dialog opens and after each action; nothing here runs by itself.
 */
export function DataDialog({ onClose }: { onClose: () => void }) {
	useLang();
	const [data, setData] = useState<DataOverview | null>(null);
	const [loadError, setLoadError] = useState<unknown>(null);
	const [exported, setExported] = useState<DataExport | null>(null);
	const [cleaned, setCleaned] = useState<DataCleanup | null>(null);
	const [typing, setTyping] = useState(false);
	const [typed, setTyped] = useState("");
	const [confirming, setConfirming] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const pathId = useId();
	const reload = useCallback(
		() =>
			loadData().then((loaded) => {
				setData(loaded);
				setLoadError(null);
			}, setLoadError),
		[],
	);
	useEffect(() => {
		void reload();
	}, [reload]);
	const showHome = useAction(() => revealData("home"));
	const showExport = useAction(() => revealData("export"));
	const exportTo = async (folder: string) => {
		setExported(await exportData(folder));
		setTyping(false);
		setTyped("");
		await reload();
	};
	const pick = useAction(async () => {
		let folder: string | null;
		try {
			folder = await pickFolder();
		} catch (error) {
			// No picker on this computer, or it did not open: the path can be typed.
			setTyping(true);
			throw error;
		}
		if (folder) await exportTo(folder);
	});
	const exportTyped = useAction(() => exportTo(typed.trim()));
	const revealLabel = t(data?.reveal === "files" ? "skillRevealFiles" : "skillRevealFinder");
	const temp = data?.temp;
	const kept = temp ? temp.files - temp.removableFiles : 0;
	return (
		<Dialog title={t("dataTitle")} size="l" onClose={onClose}>
			{data === null && !loadError && <p className="hint">{t("loading")}</p>}
			<ErrorBox error={loadError} />
			{data && temp && (
				<>
					<SettingGroup title={t("dataStorage")}>
						<div className="setting-row data-row">
							<div className="setting-text">
								<span className="setting-label">{t("dataFolder")}</span>
								<span className="hint data-path">{data.folder}</span>
							</div>
							{data.reveal && (
								<div className="setting-control">
									<Button busy={showHome.busy} onClick={() => void showHome.run()}>
										<FolderIcon />
										{revealLabel}
									</Button>
								</div>
							)}
						</div>
						<div className="setting-row data-usage">
							<div className="data-line data-total">
								<span>{t("dataTotal")}</span>
								<span className="data-size">{formatBytes(data.totalBytes)}</span>
							</div>
							<ul className="data-parts">
								{data.parts.map((part) => (
									<li key={part.id} className="data-part">
										<div className="data-line">
											<span>{t(`dataPart_${part.id}`)}</span>
											<span className="data-size">{formatBytes(part.bytes)}</span>
										</div>
										<div className="data-bar" aria-hidden="true">
											<span
												style={{
													width: `${data.totalBytes > 0 ? (part.bytes / data.totalBytes) * 100 : 0}%`,
												}}
											/>
										</div>
									</li>
								))}
							</ul>
							<span className="hint">{t("dataReadAt", { time: formatClock(data.readAt) })}</span>
						</div>
						<ErrorBox error={showHome.error} />
					</SettingGroup>

					<SettingGroup title={t("dataExport")}>
						<div className="setting-row data-row">
							<div className="setting-text">
								<span className="setting-label">{t("dataExportLabel")}</span>
								<span className="hint">{t("dataExportHint")}</span>
							</div>
							<div className="setting-control">
								<Button busy={pick.busy} onClick={() => void pick.run()}>
									<ExportIcon />
									{t("dataExportButton")}
								</Button>
							</div>
						</div>
						{typing && (
							<div className="setting-row data-row">
								<div className="setting-text data-typed">
									<label className="setting-label" htmlFor={pathId}>
										{t("dataExportFolder")}
									</label>
									<input
										id={pathId}
										className="input mono-input"
										value={typed}
										placeholder={t("folderPath")}
										spellCheck={false}
										onChange={(event) => setTyped(event.target.value)}
									/>
								</div>
								<div className="setting-control">
									<Button
										busy={exportTyped.busy}
										disabled={!typed.trim()}
										onClick={() => void exportTyped.run()}
									>
										<ExportIcon />
										{t("dataExportTyped")}
									</Button>
								</div>
							</div>
						)}
						{exported && (
							<div className="setting-row data-row" role="status">
								<div className="setting-text">
									<span className="data-result">{t("dataExportDone", { ...exported })}</span>
								</div>
								{data.reveal && (
									<div className="setting-control">
										<Button busy={showExport.busy} onClick={() => void showExport.run()}>
											<FolderIcon />
											{revealLabel}
										</Button>
									</div>
								)}
							</div>
						)}
						<ErrorBox error={exportTyped.error ?? pick.error ?? showExport.error} />
					</SettingGroup>

					<SettingGroup title={t("dataTemp")}>
						<div className="setting-row data-row">
							<div className="setting-text">
								<span className="setting-label">{t("dataTempLabel")}</span>
								<span className="hint">
									{temp.files === 0
										? t("dataTempNone")
										: t("dataTempHint", { n: temp.files, size: formatBytes(temp.bytes) })}
									{kept > 0 && ` ${t("dataTempKept", { n: kept })}`}
								</span>
							</div>
							<div className="setting-control">
								<Button disabled={temp.removableFiles === 0} onClick={() => setConfirming(true)}>
									<TrashIcon />
									{t("dataCleanButton")}
								</Button>
							</div>
						</div>
						{cleaned && (
							<div className="setting-row data-row" role="status">
								<span className="data-result">
									{t("dataCleanDone", {
										n: cleaned.deletedFiles,
										size: formatBytes(cleaned.freedBytes),
									})}
									{cleaned.skippedFiles > 0 &&
										` ${t("dataCleanSkipped", { n: cleaned.skippedFiles })}`}
								</span>
							</div>
						)}
					</SettingGroup>

					<SettingGroup title={t("dataArchived")}>
						<div className="setting-row data-row">
							<div className="setting-text">
								<span className="setting-label">{t("deleteArchivedLabel")}</span>
								<span className="hint">{t("deleteArchivedHint")}</span>
							</div>
							<div className="setting-control">
								<Button variant="danger" onClick={() => setDeleting(true)}>
									<TrashIcon />
									{t("deleteArchivedButton")}
								</Button>
							</div>
						</div>
					</SettingGroup>
				</>
			)}
			{confirming && temp && (
				<ConfirmDialog
					title={t("dataCleanTitle")}
					body={`${t("dataCleanBody", {
						n: temp.removableFiles,
						size: formatBytes(temp.removableBytes),
					})}${kept > 0 ? ` ${t("dataCleanBodyKept", { n: kept })}` : ""}`}
					confirmLabel={t("dataCleanConfirm", { n: temp.removableFiles })}
					onConfirm={async () => {
						try {
							setCleaned(await cleanUpData());
						} finally {
							await reload();
						}
					}}
					onClose={() => setConfirming(false)}
				/>
			)}
			{deleting && (
				<DeleteArchivedDialog
					onClose={() => {
						setDeleting(false);
						void reload();
					}}
				/>
			)}
		</Dialog>
	);
}

/**
 * Deletes every archived session for good. It says how many and which first, and that this cannot be
 * undone (AGENTS.md: deleting data is confirmed by the person).
 */
function DeleteArchivedDialog({ onClose }: { onClose: () => void }) {
	useLang();
	const [archived, setArchived] = useState<Session[] | null>(null);
	const [error, setError] = useState<unknown>(null);
	useEffect(() => {
		loadArchived().then(setArchived, setError);
	}, []);
	const remove = useAction(async () => {
		await deleteArchivedSessions();
		onClose();
	});
	const count = archived?.length ?? 0;
	const names = (archived ?? []).slice(0, 5).map((session) => session.name);
	return (
		<Dialog
			title={t("deleteArchivedTitle")}
			size="s"
			onClose={onClose}
			footer={
				<>
					<Button onClick={onClose}>{t("cancel")}</Button>
					{count > 0 && (
						<Button variant="danger" busy={remove.busy} onClick={() => void remove.run()}>
							<TrashIcon />
							{t("deleteArchivedConfirm", { n: count })}
						</Button>
					)}
				</>
			}
		>
			{archived === null ? (
				<p className="hint">{t("loading")}</p>
			) : count === 0 ? (
				<p>{t("noArchived")}</p>
			) : (
				<>
					<p>{t("deleteArchivedBody", { n: count })}</p>
					<p className="hint">
						{names.join(t("listSeparator"))}
						{count > names.length ? t("andMore", { n: count - names.length }) : ""}
					</p>
				</>
			)}
			<ErrorBox error={error ?? remove.error} />
		</Dialog>
	);
}
