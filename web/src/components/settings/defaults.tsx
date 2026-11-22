import { useEffect, useId, useState } from "react";
import { PERMISSION_MODES, type PermissionMode } from "../../../../src/shared/types.ts";
import { saveSettings, spentToday } from "../../actions/settings.ts";
import { formatCost, permissionHint, t, useLang } from "../../i18n.ts";
import { useAppState } from "../../state.ts";
import { Dialog } from "../dialog.tsx";
import { cleanAmount } from "../dialogs.tsx";
import { CheckIcon } from "../icons.tsx";
import { ModelPicker } from "../model-picker.tsx";
import { Select } from "../select.tsx";
import { Button, ErrorBox, Field, SettingRow, Switch, useAction } from "../ui.tsx";

/**
 * Defaults for new sessions (the model and the permission rules), and where decisions are logged;
 * saved together.
 */
export function DefaultsDialog({ onClose }: { onClose: () => void }) {
	useLang();
	const settings = useAppState((state) => state.settings);
	const [model, setModel] = useState(settings?.defaultModel);
	const savedMode = settings?.defaultPermissionMode ?? "default";
	const [mode, setMode] = useState<PermissionMode>(savedMode);
	const modeId = useId();
	const savedWorkspace = settings?.defaultWorkspaceId ?? "";
	const [workspace, setWorkspace] = useState(savedWorkspace);
	const workspaceId = useId();
	const [log, setLog] = useState(settings?.decisionLog ?? "");
	const logId = useId();
	const savedBudget = settings?.dailyBudget ? String(settings.dailyBudget) : "";
	const [budget, setBudget] = useState(savedBudget);
	const [spent, setSpent] = useState<number | null>(null);
	useEffect(() => {
		spentToday()
			.then((today) => setSpent(today.total))
			.catch(() => {});
	}, []);
	const budgetId = useId();
	const savedMemory = (settings?.memoryDirs ?? []).join("\n");
	const [memory, setMemory] = useState(savedMemory);
	const memoryId = useId();
	const savedHidden = (settings?.hiddenFolders ?? []).join("\n");
	const [hidden, setHidden] = useState(savedHidden);
	const hiddenId = useId();
	const savedDomains = (settings?.sandboxAllowedDomains ?? []).join("\n");
	const [domains, setDomains] = useState(savedDomains);
	const domainsId = useId();
	const savedTraceMain = settings?.reviewTraceMain ?? true;
	const [traceMain, setTraceMain] = useState(savedTraceMain);
	const traceMainId = useId();
	const sandbox = useAppState((state) => state.health?.sandbox ?? "none");
	const save = useAction(async () => {
		await saveSettings({
			...(model ? { defaultModel: model } : {}),
			...(mode !== savedMode ? { defaultPermissionMode: mode } : {}),
			...(workspace !== savedWorkspace ? { defaultWorkspaceId: workspace || null } : {}),
			...(memory !== savedMemory
				? {
						memoryDirs: memory
							.split("\n")
							.map((line) => line.trim())
							.filter(Boolean),
					}
				: {}),
			...(hidden !== savedHidden
				? {
						hiddenFolders: hidden
							.split("\n")
							.map((line) => line.trim())
							.filter(Boolean),
					}
				: {}),
			...(domains !== savedDomains
				? {
						sandboxAllowedDomains: domains
							.split("\n")
							.map((line) => line.trim())
							.filter(Boolean),
					}
				: {}),
			...(traceMain !== savedTraceMain ? { reviewTraceMain: traceMain } : {}),
			decisionLog: log.trim() || null,
			...(budget !== savedBudget ? { dailyBudget: Number(budget) || null } : {}),
		});
		onClose();
	});
	const dirty =
		JSON.stringify(model) !== JSON.stringify(settings?.defaultModel) ||
		mode !== savedMode ||
		workspace !== savedWorkspace ||
		log.trim() !== (settings?.decisionLog ?? "") ||
		budget !== savedBudget ||
		memory !== savedMemory ||
		hidden !== savedHidden ||
		domains !== savedDomains ||
		traceMain !== savedTraceMain;
	return (
		<Dialog
			title={t("defaultsTitle")}
			size="l"
			onClose={onClose}
			footer={
				<>
					{dirty && (
						<span className="hint unsaved" role="status">
							{t("unsavedChanges")}
						</span>
					)}
					<Button onClick={onClose}>{t("cancel")}</Button>
					<Button
						variant="primary"
						busy={save.busy}
						disabled={!dirty}
						onClick={() => void save.run()}
					>
						<CheckIcon />
						{t("save")}
					</Button>
				</>
			}
		>
			{model && (
				<Field label={t("defaultModel")} info={t("defaultModelHelp")}>
					<ModelPicker
						{...model}
						layout="grid"
						onChange={(patch) => setModel((current) => current && { ...current, ...patch })}
					/>
				</Field>
			)}
			<Field
				label={t("defaultPermission")}
				labelId={modeId}
				info={t(sandbox === "none" ? "defaultPermissionHelp" : "defaultPermissionHelpSandbox")}
			>
				<Select
					labelledBy={modeId}
					value={mode}
					options={PERMISSION_MODES.map((value) => ({
						value,
						label: t(`perm_${value}`),
						hint: permissionHint(value, sandbox !== "none"),
					}))}
					onChange={(value) => setMode(value as PermissionMode)}
				/>
			</Field>
			<div className="setting-box">
				<SettingRow
					label={t("reviewTraceMain")}
					hint={t("reviewTraceMainHint")}
					labelId={traceMainId}
				>
					<Switch checked={traceMain} labelledBy={traceMainId} onChange={setTraceMain} />
				</SettingRow>
			</div>
			<Field label={t("defaultWorkspace")} labelId={workspaceId} info={t("defaultWorkspaceHelp")}>
				<Select
					labelledBy={workspaceId}
					value={workspace}
					options={[
						{ value: "", label: t("defaultWorkspaceNone") },
						...(settings?.workspaces ?? []).map((item) => ({
							value: item.id,
							label: item.name,
							hint: item.path,
						})),
					]}
					onChange={setWorkspace}
				/>
			</Field>
			<Field label={t("decisionLog")} htmlFor={logId} info={t("decisionLogHelp")}>
				<input
					id={logId}
					className="input"
					spellCheck={false}
					placeholder={t("decisionLogPlaceholder")}
					value={log}
					onChange={(event) => setLog(event.target.value)}
				/>
			</Field>
			<Field label={t("memoryDirs")} htmlFor={memoryId} info={t("memoryDirsHelp")}>
				<textarea
					id={memoryId}
					className="textarea"
					spellCheck={false}
					rows={2}
					placeholder={t("memoryDirsPlaceholder")}
					value={memory}
					onChange={(event) => setMemory(event.target.value)}
				/>
			</Field>
			<Field
				label={t("hiddenFolders")}
				htmlFor={hiddenId}
				info={t(sandbox === "none" ? "hiddenFoldersHelp" : "hiddenFoldersHelpSandbox")}
			>
				<textarea
					id={hiddenId}
					className="textarea"
					spellCheck={false}
					rows={2}
					placeholder={t("hiddenFoldersPlaceholder")}
					value={hidden}
					onChange={(event) => setHidden(event.target.value)}
				/>
			</Field>
			<Field label={t("sandboxAllowedDomains")} htmlFor={domainsId} info={t("sandboxDomainsHelp")}>
				<textarea
					id={domainsId}
					className="textarea"
					spellCheck={false}
					rows={2}
					placeholder={t("sandboxDomainsPlaceholder")}
					value={domains}
					onChange={(event) => setDomains(event.target.value)}
				/>
			</Field>
			<Field label={t("dailyBudgetAll")} htmlFor={budgetId} info={t("dailyBudgetAllHelp")}>
				<input
					id={budgetId}
					className="input input-number"
					inputMode="decimal"
					placeholder={t("budgetNone")}
					value={budget}
					onChange={(event) => setBudget(cleanAmount(event.target.value))}
				/>
				{spent !== null && (
					<span className="hint">{t("spentToday", { n: formatCost(spent) })}</span>
				)}
			</Field>
			<ErrorBox error={save.error} />
		</Dialog>
	);
}
