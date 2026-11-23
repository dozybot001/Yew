import { useEffect, useId, useState } from "react";
import { PERMISSION_MODES, type PermissionMode } from "../../../../src/shared/types.ts";
import { loadRolesFolder, saveSettings, spentToday } from "../../actions/settings.ts";
import { formatCost, permissionHint, t, useLang } from "../../i18n.ts";
import { getState, type RolesFolderState, useAppState } from "../../state.ts";
import { Dialog } from "../dialog.tsx";
import { cleanAmount } from "../dialogs.tsx";
import { CheckIcon } from "../icons.tsx";
import { Select } from "../select.tsx";
import { Button, ErrorBox, Field, SettingRow, Switch, useAction } from "../ui.tsx";

/**
 * Defaults for new sessions (the permission rules and the workspace), and where decisions are logged
 * and roles are written; saved together. The default model is under the providers.
 */

/** What the settings say under the roles folder: what is in it, or why something did not go through. */
function rolesFolderLines(state: RolesFolderState | null): { hint?: string; error?: string } {
	if (!state?.folder) return {};
	const { problem } = state;
	if (problem?.code === "folder") return { error: t("rolesFolderProblemFolder", problem) };
	const hint = t(`rolesFolder_${state.commits}`, { n: state.files });
	if (!problem) return { hint };
	if (problem.code === "taken") return { hint, error: t("rolesFolderProblemTaken", problem) };
	if (problem.code === "busy") return { hint, error: t("rolesFolderProblemBusy") };
	return { hint, error: t("rolesFolderProblemCommit", problem) };
}
export function DefaultsDialog({ onClose }: { onClose: () => void }) {
	useLang();
	const settings = useAppState((state) => state.settings);
	const savedMode = settings?.defaultPermissionMode ?? "default";
	const [mode, setMode] = useState<PermissionMode>(savedMode);
	const modeId = useId();
	const savedWorkspace = settings?.defaultWorkspaceId ?? "";
	const [workspace, setWorkspace] = useState(savedWorkspace);
	const workspaceId = useId();
	const [log, setLog] = useState(settings?.decisionLog ?? "");
	const logId = useId();
	const savedRoles = settings?.rolesFolder ?? "";
	const [roles, setRoles] = useState(savedRoles);
	const [rolesState, setRolesState] = useState<RolesFolderState | null>(null);
	useEffect(() => {
		loadRolesFolder()
			.then(setRolesState)
			.catch(() => {});
	}, []);
	const rolesId = useId();
	const rolesErrorId = useId();
	const rolesLines = rolesFolderLines(roles.trim() === savedRoles ? rolesState : null);
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
			...(roles.trim() !== savedRoles ? { rolesFolder: roles.trim() || null } : {}),
			...(budget !== savedBudget ? { dailyBudget: Number(budget) || null } : {}),
		});
		if (roles.trim() !== savedRoles && roles.trim()) {
			// The roles were written while saving: when that did not go through, the dialog stays to say so.
			const state = await loadRolesFolder();
			setRolesState(state);
			setRoles(getState().settings?.rolesFolder ?? "");
			if (state.problem) return;
		}
		onClose();
	});
	const dirty =
		mode !== savedMode ||
		workspace !== savedWorkspace ||
		log.trim() !== (settings?.decisionLog ?? "") ||
		roles.trim() !== savedRoles ||
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
			<Field
				label={t("rolesFolder")}
				htmlFor={rolesId}
				info={t("rolesFolderHelp")}
				error={rolesLines.error ?? null}
				errorId={rolesErrorId}
			>
				<input
					id={rolesId}
					className="input"
					spellCheck={false}
					placeholder={t("rolesFolderPlaceholder")}
					value={roles}
					aria-describedby={rolesLines.error ? rolesErrorId : undefined}
					onChange={(event) => setRoles(event.target.value)}
				/>
				{rolesLines.hint && <span className="hint">{rolesLines.hint}</span>}
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
