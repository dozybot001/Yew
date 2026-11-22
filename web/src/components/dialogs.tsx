import { useEffect, useId, useState } from "react";
import {
	EXTRA_DIR_ACCESS,
	type ExtraDir,
	type ExtraDirAccess,
	type Group,
	letterQuotaOf,
	type PermissionRule,
	RECEIVE_POLICIES,
	type ReceivePolicy,
	type Session,
	type SessionKind,
	type ThinkingLevel,
} from "../../../src/shared/types.ts";
import { createGroup, createSession, renameGroup, updateSession } from "../actions/sessions.ts";
import { pickFolder, spentToday } from "../actions/settings.ts";
import { ApiError } from "../api.ts";
import { formatCost, t, useLang } from "../i18n.ts";
import { isImeEvent } from "../ime.ts";
import { useAppState } from "../state.ts";
import { CheckIcon, CloseIcon, FolderIcon, PlusIcon } from "./icons.tsx";
import { ModelPicker } from "./model-picker.tsx";
import {
	Button,
	Dialog,
	describeError,
	describeRule,
	ErrorBox,
	Field,
	Select,
	SettingGroup,
	SettingRow,
	Switch,
	Toggletip,
	useAction,
} from "./ui.tsx";
import { WorkspacePicker } from "./workspaces.tsx";

function fieldError(error: unknown, field: string): string | null {
	if (!(error instanceof ApiError) || error.field !== field) return null;
	return describeError(error);
}

function generalError(error: unknown, fields: string[]): unknown {
	if (error instanceof ApiError && error.field && fields.includes(error.field)) return null;
	return error;
}

/**
 * What "always allow" on an approval card remembered for this session, one line each, each removable.
 * Rules are no longer written by hand: the approval mode decides how much Yew asks, and this list
 * holds the exceptions the person granted. Operations that must be confirmed never get here.
 */
export function AllowedList({
	rules,
	onChange,
}: {
	rules: PermissionRule[];
	onChange: (rules: PermissionRule[]) => void;
}) {
	useLang();
	const headingId = useId();
	return (
		<section className="setting-group" aria-labelledby={headingId}>
			<h3 className="setting-group-title">
				<span id={headingId}>{t("allowedTitle")}</span>
				<Toggletip label={t("allowedTitle")} text={t("allowedHelp")} />
			</h3>
			<div className="setting-box">
				{rules.length === 0 ? (
					<p className="rules-empty">{t("noAllowed")}</p>
				) : (
					rules.map((rule, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: remembered approvals have no identity besides their position
						<div key={index} className="allowed-row">
							<span className="allowed-text">{describeRule(rule)}</span>
							<Button
								variant="icon"
								aria-label={t("removeAllowed", { rule: describeRule(rule) })}
								title={t("removeAllowed", { rule: describeRule(rule) })}
								onClick={() => onChange(rules.filter((_, i) => i !== index))}
							>
								<CloseIcon />
							</Button>
						</div>
					))
				)}
			</div>
		</section>
	);
}

/**
 * Name and role first, since they define the session; then the folder, the model, and kind and group
 * side by side. Nothing is folded away, and the dialog fits without scrolling.
 */
export function NewSessionDialog({
	onClose,
	groupId,
}: {
	onClose: () => void;
	groupId?: string | null;
}) {
	useLang();
	const settings = useAppState((state) => state.settings);
	const groups = useAppState((state) => state.groups);
	const [name, setName] = useState("");
	const [kind, setKind] = useState<SessionKind>("task");
	const [group, setGroup] = useState<string>(groupId ?? "");
	const [cwd, setCwd] = useState(
		() =>
			settings?.workspaces.find((workspace) => workspace.id === settings.defaultWorkspaceId)
				?.path ?? "",
	);
	const [responsibility, setResponsibility] = useState("");
	const [model, setModel] = useState({
		provider: settings?.defaultModel.provider ?? "deepseek",
		model: settings?.defaultModel.model ?? "deepseek-v4-pro",
		thinking: (settings?.defaultModel.thinking ?? "medium") as ThinkingLevel,
	});
	const ids = {
		name: useId(),
		nameError: useId(),
		role: useId(),
		cwd: useId(),
		cwdError: useId(),
		cwdHint: useId(),
	};
	const create = useAction(async () => {
		await createSession({
			name,
			kind,
			groupId: group || null,
			cwd: cwd.trim() || null,
			responsibility,
			...model,
		});
		onClose();
	});
	const nameError = fieldError(create.error, "name");
	const cwdError = fieldError(create.error, "cwd");
	return (
		<Dialog
			title={t("newSession")}
			size="m"
			onClose={onClose}
			footer={
				<>
					<Button onClick={onClose}>{t("cancel")}</Button>
					<Button
						variant="primary"
						busy={create.busy}
						disabled={!name.trim()}
						onClick={() => void create.run()}
					>
						<PlusIcon />
						{t("create")}
					</Button>
				</>
			}
		>
			<Field label={t("name")} htmlFor={ids.name} error={nameError} errorId={ids.nameError}>
				<input
					id={ids.name}
					className="input"
					value={name}
					maxLength={60}
					autoFocus
					aria-invalid={nameError ? "true" : undefined}
					aria-describedby={nameError ? ids.nameError : undefined}
					onChange={(event) => setName(event.target.value)}
				/>
			</Field>
			<Field label={t("responsibility")} htmlFor={ids.role}>
				<textarea
					id={ids.role}
					className="textarea textarea-large"
					placeholder={t("responsibilityPlaceholder")}
					value={responsibility}
					onChange={(event) => setResponsibility(event.target.value)}
				/>
			</Field>
			<Field label={t("workingFolder")} error={cwdError} errorId={ids.cwdError}>
				<WorkspacePicker value={cwd || null} onChange={(path) => setCwd(path ?? "")} />
			</Field>
			<ModelPicker
				{...model}
				layout="grid"
				onChange={(patch) => setModel((current) => ({ ...current, ...patch }))}
			/>
			<div className="field-row">
				<Field label={t("kind")}>
					<Select
						label={t("kind")}
						value={kind}
						options={(["task", "standing"] as const).map((k) => ({
							value: k,
							label: t(`kind_${k}`),
						}))}
						onChange={(value) => setKind(value as SessionKind)}
					/>
				</Field>
				<Field label={t("group")}>
					<Select
						label={t("group")}
						value={group}
						options={[
							{ value: "", label: t("noGroup") },
							...groups.map((g) => ({ value: g.id, label: g.name })),
						]}
						onChange={setGroup}
					/>
				</Field>
			</div>
			<ErrorBox error={generalError(create.error, ["name", "cwd"])} />
		</Dialog>
	);
}

/**
 * Session settings: the role, permission rules and the compaction threshold. The rest sits where it
 * is used: name and group in the row menu; folder, model and edits in the composer.
 */
export function SessionSettingsDialog({
	session,
	onClose,
}: {
	session: Session;
	onClose: () => void;
}) {
	useLang();
	const [responsibility, setResponsibility] = useState(session.responsibility);
	const [compactAt, setCompactAt] = useState(
		session.options.compactAt ? String(session.options.compactAt) : "",
	);
	const [rules, setRules] = useState(session.rules);
	const isMain = useAppState((state) => state.settings?.mainSessionId === session.id);
	const [receive, setReceive] = useState<ReceivePolicy>(session.options.receive ?? "accept");
	const savedQuota = session.options.letterQuota ? String(session.options.letterQuota) : "";
	const [quota, setQuota] = useState(savedQuota);
	const savedBudget = session.options.dailyBudget ? String(session.options.dailyBudget) : "";
	const [budget, setBudget] = useState(savedBudget);
	const [spent, setSpent] = useState<number | null>(null);
	useEffect(() => {
		spentToday()
			.then((today) => setSpent(today.sessions[session.id] ?? 0))
			.catch(() => {});
	}, [session.id]);
	const budgetId = useId();
	const [canPost, setCanPost] = useState(session.options.canPostCards === true);
	const [canOrganize, setCanOrganize] = useState(session.options.canOrganize === true);
	const savedExtraDirs = session.options.extraDirs ?? [];
	const [extraDirs, setExtraDirs] = useState<ExtraDir[]>(savedExtraDirs);
	const [newDirPath, setNewDirPath] = useState("");
	const [newDirAccess, setNewDirAccess] = useState<ExtraDirAccess>("read");
	const savedDomains = (session.options.allowedDomains ?? []).join("\n");
	const [domainsText, setDomainsText] = useState(savedDomains);
	const [containers, setContainers] = useState(session.options.allowContainers === true);
	const roleId = useId();
	const containersId = useId();
	const compactId = useId();
	const compactErrorId = useId();
	const quotaId = useId();
	const receiveId = useId();
	const postId = useId();
	const organizeId = useId();
	const extraDirId = useId();
	const domainsId = useId();
	const pickExtra = useAction(async () => {
		const picked = await pickFolder();
		if (!picked) return;
		setExtraDirs((current) =>
			current.some((d) => d.path === picked)
				? current
				: [...current, { path: picked, access: newDirAccess }],
		);
	});
	const addTypedDir = () => {
		const path = newDirPath.trim();
		if (!path) return;
		setExtraDirs((current) =>
			current.some((d) => d.path === path) ? current : [...current, { path, access: newDirAccess }],
		);
		setNewDirPath("");
	};
	const save = useAction(async () => {
		const nextDomains = domainsText
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		await updateSession(session.id, {
			responsibility,
			rules,
			options: {
				compactAt: compactAt.trim() ? Number(compactAt) : null,
				receive,
				letterQuota: quota.trim() ? Number(quota) : null,
				...(budget !== savedBudget ? { dailyBudget: Number(budget) || null } : {}),
				canPostCards: canPost,
				canOrganize,
				...(containers !== (session.options.allowContainers === true)
					? { allowContainers: containers }
					: {}),
				...(JSON.stringify(extraDirs) !== JSON.stringify(savedExtraDirs) ? { extraDirs } : {}),
				...(domainsText !== savedDomains ? { allowedDomains: nextDomains } : {}),
			},
		});
		onClose();
	});
	const left = Math.max(0, letterQuotaOf(session.options, isMain) - session.lettersSent);
	const dirty =
		responsibility !== session.responsibility ||
		compactAt !== (session.options.compactAt ? String(session.options.compactAt) : "") ||
		JSON.stringify(rules) !== JSON.stringify(session.rules) ||
		receive !== (session.options.receive ?? "accept") ||
		quota !== savedQuota ||
		budget !== savedBudget ||
		canPost !== (session.options.canPostCards === true) ||
		canOrganize !== (session.options.canOrganize === true) ||
		containers !== (session.options.allowContainers === true) ||
		JSON.stringify(extraDirs) !== JSON.stringify(savedExtraDirs) ||
		domainsText !== savedDomains;
	return (
		<Dialog
			title={t("sessionSettings")}
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
					<Button variant="primary" busy={save.busy} onClick={() => void save.run()}>
						<CheckIcon />
						{t("save")}
					</Button>
				</>
			}
		>
			<section className="setting-group">
				<h3 className="setting-group-title">
					<label htmlFor={roleId}>{t("responsibility")}</label>
				</h3>
				<textarea
					id={roleId}
					className="textarea textarea-large"
					placeholder={t("responsibilityPlaceholder")}
					value={responsibility}
					onChange={(event) => setResponsibility(event.target.value)}
				/>
			</section>
			<AllowedList rules={rules} onChange={setRules} />
			{session.cwd !== null && (
				<SettingGroup title={t("extraDirsSection")} info={t("extraDirsHelp")}>
					{extraDirs.length > 0 && (
						<ul className="extra-dir-list">
							{extraDirs.map((item) => (
								<li key={item.path} className="extra-dir-row">
									<span className="extra-dir-path" title={item.path}>
										{item.path}
									</span>
									<Select
										label={t("extraDirAccess")}
										value={item.access}
										options={EXTRA_DIR_ACCESS.map((access) => ({
											value: access,
											label: t(`access_${access}`),
										}))}
										onChange={(value) =>
											setExtraDirs((current) =>
												current.map((entry) =>
													entry.path === item.path
														? { ...entry, access: value as ExtraDirAccess }
														: entry,
												),
											)
										}
									/>
									<Button
										variant="icon"
										aria-label={t("removeFolder", { path: item.path })}
										title={t("remove")}
										onClick={() =>
											setExtraDirs((current) => current.filter((entry) => entry.path !== item.path))
										}
									>
										<CloseIcon />
									</Button>
								</li>
							))}
						</ul>
					)}
					<div className="extra-dir-add">
						<input
							id={extraDirId}
							className="input mono-input"
							spellCheck={false}
							placeholder={t("extraDirsPlaceholder")}
							aria-label={t("extraDirsSection")}
							value={newDirPath}
							onChange={(event) => setNewDirPath(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && !isImeEvent(event)) {
									event.preventDefault();
									addTypedDir();
								}
							}}
						/>
						<Select
							label={t("extraDirAccess")}
							value={newDirAccess}
							options={EXTRA_DIR_ACCESS.map((access) => ({
								value: access,
								label: t(`access_${access}`),
							}))}
							onChange={(value) => setNewDirAccess(value as ExtraDirAccess)}
						/>
						<Button disabled={!newDirPath.trim()} onClick={addTypedDir}>
							<PlusIcon />
							{t("add")}
						</Button>
						<Button busy={pickExtra.busy} onClick={() => void pickExtra.run()}>
							<FolderIcon />
							{t("chooseFolder")}
						</Button>
					</div>
				</SettingGroup>
			)}
			{session.cwd !== null && <ErrorBox error={pickExtra.error} />}
			{session.cwd !== null && (
				<section className="setting-group">
					<h3 className="setting-group-title">
						<label htmlFor={domainsId}>{t("sessionDomainsSection")}</label>
						<Toggletip label={t("sessionDomainsSection")} text={t("sandboxDomainsHelp")} />
					</h3>
					<textarea
						id={domainsId}
						className="textarea"
						spellCheck={false}
						rows={2}
						placeholder={t("sandboxDomainsPlaceholder")}
						value={domainsText}
						onChange={(event) => setDomainsText(event.target.value)}
					/>
					{fieldError(save.error, "allowedDomains") && (
						<span className="field-error">{fieldError(save.error, "allowedDomains")}</span>
					)}
				</section>
			)}
			{session.cwd !== null && (
				<SettingGroup title={t("containersSection")}>
					<SettingRow
						label={t("allowContainers")}
						labelId={containersId}
						hint={t("allowContainersHint")}
					>
						<Switch labelledBy={containersId} checked={containers} onChange={setContainers} />
					</SettingRow>
				</SettingGroup>
			)}
			<SettingGroup title={t("lettersSection")}>
				<SettingRow label={t("receive")} labelId={receiveId} hint={t(`receive_${receive}_hint`)}>
					<Select
						labelledBy={receiveId}
						value={receive}
						options={RECEIVE_POLICIES.map((policy) => ({
							value: policy,
							label: t(`receive_${policy}`),
							hint: t(`receive_${policy}_hint`),
						}))}
						onChange={(value) => setReceive(value as ReceivePolicy)}
					/>
				</SettingRow>
				<SettingRow
					label={t("letterQuota")}
					htmlFor={quotaId}
					info={t("letterQuotaHelp")}
					hint={t("lettersLeft", { n: left })}
				>
					<input
						id={quotaId}
						className="input input-number"
						inputMode="numeric"
						placeholder={String(letterQuotaOf({}, isMain))}
						value={quota}
						onChange={(event) => setQuota(event.target.value.replace(/[^\d]/g, "").slice(0, 3))}
					/>
				</SettingRow>
				{!isMain && (
					<>
						<SettingRow label={t("canPostCards")} labelId={postId} hint={t("canPostCardsHint")}>
							<Switch labelledBy={postId} checked={canPost} onChange={setCanPost} />
						</SettingRow>
						<SettingRow label={t("canOrganize")} labelId={organizeId} hint={t("canOrganizeHint")}>
							<Switch labelledBy={organizeId} checked={canOrganize} onChange={setCanOrganize} />
						</SettingRow>
					</>
				)}
			</SettingGroup>
			<SettingGroup title={t("budgetSection")}>
				<SettingRow
					label={t("dailyBudget")}
					htmlFor={budgetId}
					info={t("dailyBudgetHelp")}
					{...(spent === null ? {} : { hint: t("spentToday", { n: formatCost(spent) }) })}
				>
					<input
						id={budgetId}
						className="input input-number"
						inputMode="decimal"
						placeholder={t("budgetNone")}
						value={budget}
						onChange={(event) => setBudget(cleanAmount(event.target.value))}
					/>
				</SettingRow>
			</SettingGroup>
			<SettingGroup title={t("contextSection")}>
				<SettingRow
					label={t("compactAt")}
					htmlFor={compactId}
					info={t("compactAtHelp")}
					hint={t("compactAtHint")}
					error={fieldError(save.error, "options")}
					errorId={compactErrorId}
				>
					<input
						id={compactId}
						className="input input-number"
						inputMode="numeric"
						placeholder={t("automatic")}
						aria-invalid={fieldError(save.error, "options") ? "true" : undefined}
						aria-describedby={fieldError(save.error, "options") ? compactErrorId : undefined}
						value={compactAt}
						onChange={(event) => setCompactAt(event.target.value.replace(/[^\d]/g, ""))}
					/>
				</SettingRow>
			</SettingGroup>
			<ErrorBox error={generalError(save.error, ["options", "allowedDomains"])} />
		</Dialog>
	);
}

/** Keeps what was typed to an amount: digits with at most one point and two decimals. */
export function cleanAmount(value: string): string {
	const [whole = "", ...rest] = value.replace(/[^\d.]/g, "").split(".");
	const head = whole.slice(0, 6);
	return rest.length > 0 ? `${head}.${rest.join("").slice(0, 2)}` : head;
}

export function GroupDialog({
	group,
	onClose,
	onCreated,
}: {
	group?: { id: string; name: string };
	onClose: () => void;
	/** Called with a new team, e.g. to move a session into it right away. */
	onCreated?: (group: Group) => unknown;
}) {
	useLang();
	const [name, setName] = useState(group?.name ?? "");
	const id = useId();
	const save = useAction(async () => {
		if (group) await renameGroup(group.id, name);
		else await onCreated?.(await createGroup(name));
		onClose();
	});
	return (
		<Dialog
			title={group ? t("renameGroup") : t("newGroup")}
			size="s"
			onClose={onClose}
			footer={
				<>
					<Button onClick={onClose}>{t("cancel")}</Button>
					<Button
						variant="primary"
						busy={save.busy}
						disabled={!name.trim()}
						onClick={() => void save.run()}
					>
						<CheckIcon />
						{group ? t("save") : t("create")}
					</Button>
				</>
			}
		>
			<Field label={t("groupName")} htmlFor={id}>
				<input
					id={id}
					className="input"
					value={name}
					maxLength={60}
					onChange={(event) => setName(event.target.value)}
					onKeyDown={(event) =>
						event.key === "Enter" && !isImeEvent(event) && name.trim() && void save.run()
					}
				/>
			</Field>
			<ErrorBox error={save.error} />
		</Dialog>
	);
}

export function ConfirmDialog({
	title,
	body,
	confirmLabel,
	onConfirm,
	onClose,
}: {
	title: string;
	body: string;
	confirmLabel: string;
	onConfirm: () => Promise<unknown>;
	onClose: () => void;
}) {
	const action = useAction(async () => {
		await onConfirm();
		onClose();
	});
	return (
		<Dialog
			title={title}
			size="s"
			onClose={onClose}
			footer={
				<>
					<Button onClick={onClose}>{t("cancel")}</Button>
					<Button variant="danger" busy={action.busy} onClick={() => void action.run()}>
						{confirmLabel}
					</Button>
				</>
			}
		>
			<p>{body}</p>
			<ErrorBox error={action.error} />
		</Dialog>
	);
}
