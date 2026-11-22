import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { MCP_PRESETS, type McpPreset, presetEntry } from "../../../src/shared/mcp-presets.ts";
import { POLICY_VERSION } from "../../../src/shared/policy.ts";
import {
	DEFAULT_RELAY_URL,
	FILE_OPENERS,
	type FileOpener,
	PERMISSION_MODES,
	type PermissionMode,
	type Session,
} from "../../../src/shared/types.ts";
import {
	addMcpServer,
	checkUpdates,
	cleanUpData,
	createPairing,
	deleteArchivedSessions,
	deleteCustomProvider,
	deleteKey,
	deleteSearchKey,
	exportData,
	installUpdate,
	loadArchived,
	loadData,
	loadMcpServers,
	loadPhones,
	loadSearchServices,
	loadSkills,
	loadSystem,
	loadUpdates,
	openSettings,
	patchMcpServer,
	patchSkill,
	pickFolder,
	removeMcpServer,
	restartYew,
	revealData,
	revealSkill,
	revokeDevice,
	saveCustomProvider,
	saveKey,
	saveSearchKey,
	saveSettings,
	saveSystem,
	setDevicePush,
	setPhoneAccess,
	signOutMcpServer,
	spentToday,
	testProvider,
} from "../actions.ts";
import {
	formatAgo,
	formatBytes,
	formatClock,
	formatCost,
	getLang,
	hasMessage,
	type MessageKey,
	permissionHint,
	t,
	useLang,
} from "../i18n.ts";
import {
	type DataCleanup,
	type DataExport,
	type DataOverview,
	type McpServerView,
	NOTIFY_KINDS,
	type PingResult,
	type ProviderSummary,
	type SearchServiceView,
	type SettingsDialogName,
	type SkillList,
	type SkillView,
	type SystemStatus,
	setState,
	useAppState,
} from "../state.ts";
import { ConfirmDialog, cleanAmount } from "./dialogs.tsx";
import {
	ArrowUpIcon,
	BackIcon,
	CheckIcon,
	ChevronIcon,
	CloseIcon,
	CodeIcon,
	CopyIcon,
	DataIcon,
	ExportIcon,
	FolderIcon,
	GearIcon,
	InfoIcon,
	KeyIcon,
	MailIcon,
	PhoneIcon,
	PlusIcon,
	PowerIcon,
	ProductName,
	PulseIcon,
	RefuseIcon,
	RenameIcon,
	RetryIcon,
	SignInIcon,
	SignOutIcon,
	SkillsIcon,
	SlidersIcon,
	ThemeIcon,
	ToolsIcon,
	TrashIcon,
	YewMark,
} from "./icons.tsx";
import { Mascot } from "./mascot.tsx";
import { ModelPicker } from "./session.tsx";
import { useNarrow } from "./sidebar.tsx";
import {
	Button,
	Dialog,
	ErrorBox,
	Field,
	InSettingsWindow,
	Select,
	SettingGroup,
	SettingRow,
	Switch,
	Toggletip,
	useAction,
	useBackdropClose,
	useNow,
} from "./ui.tsx";

/**
 * One service that takes an API key: its name and whether a key is saved, with save, replace and
 * delete. The key goes to the system keychain and is never shown again.
 */
function KeyRow({
	name,
	note,
	hasKey,
	takesKey,
	deleteBody,
	onSave,
	onDelete,
	extra,
	detail,
}: {
	name: string;
	note: string;
	hasKey: boolean;
	takesKey: boolean;
	deleteBody: string;
	onSave: (key: string) => Promise<unknown>;
	onDelete: () => Promise<unknown>;
	/** Further actions on the row, shown while the key is not being typed. */
	extra?: ReactNode;
	/** Lines under the name: the result of a test. */
	detail?: ReactNode;
}) {
	useLang();
	const [editing, setEditing] = useState(false);
	const [key, setKey] = useState("");
	const [confirming, setConfirming] = useState(false);
	const save = useAction(async () => {
		await onSave(key.trim());
		setKey("");
		setEditing(false);
	});
	return (
		<div className="provider-row">
			<div>
				<strong>{name}</strong> <span className="hint">· {note}</span>
				{detail}
				{editing && (
					<div className="provider-key">
						{/* An API key is not a sign-in password, so it is not marked as one. */}
						<input
							className="input secret-input"
							type="text"
							autoComplete="off"
							spellCheck={false}
							data-1p-ignore="true"
							aria-label={`${name} · ${t("keyPlaceholder")}`}
							placeholder={t("keyPlaceholder")}
							value={key}
							onChange={(event) => setKey(event.target.value)}
						/>
						<span className="hint">{t("keyHelp")}</span>
						<ErrorBox error={save.error} />
					</div>
				)}
			</div>
			<div className="request-actions">
				{!editing && extra}
				{editing ? (
					<>
						<Button onClick={() => setEditing(false)}>{t("cancel")}</Button>
						<Button
							variant="primary"
							busy={save.busy}
							disabled={!key.trim()}
							onClick={() => void save.run()}
						>
							<CheckIcon />
							{t("save")}
						</Button>
					</>
				) : (
					takesKey && (
						<Button onClick={() => setEditing(true)}>
							<KeyIcon />
							{hasKey ? t("replaceKey") : t("setKey")}
						</Button>
					)
				)}
				{hasKey && takesKey && !editing && (
					<Button variant="danger" onClick={() => setConfirming(true)}>
						<TrashIcon />
						{t("deleteKey")}
					</Button>
				)}
			</div>
			{confirming && (
				<ConfirmDialog
					title={t("deleteKey")}
					body={deleteBody}
					confirmLabel={t("delete")}
					onConfirm={onDelete}
					onClose={() => setConfirming(false)}
				/>
			)}
		</div>
	);
}

/** "320 毫秒" below a second, "1.4 秒" above. */
function formatLatency(ms: number): string {
	return ms < 1000
		? t("latencyMs", { n: Math.round(ms) })
		: t("latencySeconds", { n: (ms / 1000).toFixed(1) });
}

function ProviderRow({ provider }: { provider: ProviderSummary }) {
	useLang();
	const [removing, setRemoving] = useState(false);
	const [ping, setPing] = useState<PingResult | null>(null);
	const test = useAction(async () => {
		setPing(null);
		setPing(await testProvider(provider.id));
	});
	const usable = provider.hasKey || !provider.keyRequired;
	const status = !provider.keyRequired
		? t("keyless")
		: provider.hasKey
			? t("keySaved")
			: t("noKey");
	return (
		<>
			<KeyRow
				name={provider.name}
				note={status}
				hasKey={provider.hasKey}
				takesKey={provider.keyRequired}
				deleteBody={t("deleteKeyBody", { name: provider.name })}
				onSave={(key) => saveKey(provider.id, key)}
				onDelete={() => deleteKey(provider.id)}
				detail={
					<div className="provider-detail" aria-live="polite">
						{ping && (
							<p className={ping.ok ? "hint" : "hint provider-failed"}>
								{ping.ok
									? t("testOk", {
											first: formatLatency(ping.firstMs ?? ping.totalMs),
											total: formatLatency(ping.totalMs),
											model: ping.model,
										})
									: t("testFailed", { model: ping.model, error: ping.error ?? "" })}
							</p>
						)}
						<ErrorBox error={test.error} />
					</div>
				}
				extra={
					<>
						{usable && (
							<Button busy={test.busy} title={t("testHint")} onClick={() => void test.run()}>
								<PulseIcon />
								{t("testConnection")}
							</Button>
						)}
						{provider.custom && (
							<Button variant="danger" onClick={() => setRemoving(true)}>
								<TrashIcon />
								{t("deleteProvider")}
							</Button>
						)}
					</>
				}
			/>
			{removing && (
				<ConfirmDialog
					title={t("deleteProvider")}
					body={t("deleteProviderBody", { name: provider.name })}
					confirmLabel={t("delete")}
					onConfirm={() => deleteCustomProvider(provider.id)}
					onClose={() => setRemoving(false)}
				/>
			)}
		</>
	);
}

/** A search service's name in the interface language; the server's own name when Yew has none. */
function searchName(service: SearchServiceView): string {
	const key = `searchName_${service.id.replace(/^search-/, "")}`;
	return hasMessage(key) ? t(key) : service.name;
}

/** A model provider as a search service names it: DeepSeek's search uses the DeepSeek key. */
const providerName = (id: string) => (id === "deepseek" ? "DeepSeek" : id);

/**
 * The search services: which have a key, and saving, replacing and
 * deleting it. Each row says who provides the service, since the query is sent to them.
 */
function SearchServices() {
	useLang();
	const [services, setServices] = useState<SearchServiceView[] | null>(null);
	const [error, setError] = useState<unknown>(null);
	const reload = useCallback(() => loadSearchServices().then(setServices, setError), []);
	useEffect(() => {
		void reload();
	}, [reload]);
	return (
		<section className="settings-section" aria-label={t("searchServices")}>
			<p className="hint">{t("searchHelp")}</p>
			<div className="provider-group">
				{(services ?? []).map((service) => (
					<KeyRow
						key={service.id}
						name={searchName(service)}
						note={[
							// DeepSeek's search uses the model's key: it is saved under Providers and keys.
							service.provider
								? t(service.hasKey ? "searchUsesProviderKey" : "searchNeedsProviderKey", {
										provider: providerName(service.provider),
									})
								: service.hasKey
									? t("keySaved")
									: t("noKey"),
							service.active ? t("searchInUse") : null,
							t(`search_${service.region}`),
						]
							.filter(Boolean)
							.join(t("hintSeparator"))}
						hasKey={service.hasKey}
						takesKey={!service.provider}
						deleteBody={t("deleteSearchKeyBody", { name: searchName(service) })}
						onSave={async (key) => {
							await saveSearchKey(service.id, key);
							await reload();
						}}
						onDelete={async () => {
							await deleteSearchKey(service.id);
							await reload();
						}}
					/>
				))}
			</div>
			<ErrorBox error={error} />
		</section>
	);
}

const KEY_TABS = ["models", "search"] as const;

/**
 * Providers and keys: the model providers on one tab and the search services on the other, so the
 * three search services are not under the long list of providers.
 */
function ProvidersDialog({ onClose }: { onClose: () => void }) {
	useLang();
	const [tab, setTab] = useState<(typeof KEY_TABS)[number]>("models");
	const id = useId();
	// Arrow keys move between tabs, as in any tab list (WAI-ARIA).
	const onKeyDown = (event: React.KeyboardEvent) => {
		const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
		if (!step) return;
		event.preventDefault();
		const next = KEY_TABS[(KEY_TABS.indexOf(tab) + step + KEY_TABS.length) % KEY_TABS.length];
		if (!next) return;
		setTab(next);
		document.getElementById(`${id}-${next}`)?.focus();
	};
	return (
		<Dialog
			title={t("providers")}
			size="l"
			onClose={onClose}
			tabs={
				<div className="panel-tabs dialog-tabs" role="tablist" aria-label={t("providers")}>
					{KEY_TABS.map((name) => (
						<button
							key={name}
							id={`${id}-${name}`}
							type="button"
							role="tab"
							className="panel-tab"
							aria-selected={tab === name}
							aria-controls={`${id}-panel`}
							tabIndex={tab === name ? 0 : -1}
							onKeyDown={onKeyDown}
							onClick={() => setTab(name)}
						>
							{name === "models" ? t("modelProviders") : t("searchServices")}
						</button>
					))}
				</div>
			}
		>
			<div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}`}>
				{tab === "models" ? <Providers /> : <SearchServices />}
			</div>
		</Dialog>
	);
}

/** Adding an OpenAI-compatible provider opens its own dialog, so the page holds no folded form. */
function CustomProviderForm() {
	useLang();
	const empty = {
		id: "",
		name: "",
		baseUrl: "",
		modelId: "",
		contextWindow: "32768",
		maxTokens: "8192",
		keyRequired: true,
	};
	const [open, setOpen] = useState(false);
	const [form, setForm] = useState(empty);
	const save = useAction(async () => {
		await saveCustomProvider(form.id.trim(), {
			name: form.name.trim(),
			baseUrl: form.baseUrl.trim(),
			keyRequired: form.keyRequired,
			models: [
				{
					id: form.modelId.trim(),
					contextWindow: Number(form.contextWindow),
					maxTokens: Number(form.maxTokens),
				},
			],
		});
		setForm(empty);
		setOpen(false);
	});
	const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
		setForm({ ...form, [key]: event.target.value });
	const field = (
		key: "id" | "name" | "baseUrl" | "modelId" | "contextWindow" | "maxTokens",
		label: string,
		placeholder?: string,
	) => (
		<label className="field">
			<span className="field-label">{label}</span>
			<input
				className="input"
				value={form[key]}
				placeholder={placeholder}
				inputMode={key === "contextWindow" || key === "maxTokens" ? "numeric" : undefined}
				onChange={set(key)}
			/>
		</label>
	);
	return (
		<div>
			<Button onClick={() => setOpen(true)}>
				<PlusIcon />
				{t("addProvider")}
			</Button>
			{open && (
				<Dialog
					title={t("addProvider")}
					size="m"
					onClose={() => setOpen(false)}
					footer={
						<>
							<Button onClick={() => setOpen(false)}>{t("cancel")}</Button>
							<Button
								variant="primary"
								busy={save.busy}
								disabled={
									!form.id.trim() ||
									!form.name.trim() ||
									!form.baseUrl.trim() ||
									!form.modelId.trim()
								}
								onClick={() => void save.run()}
							>
								<CheckIcon />
								{t("save")}
							</Button>
						</>
					}
				>
					<div className="field-row">
						{field("id", t("providerId"), "ollama")}
						{field("name", t("name"), "Ollama")}
					</div>
					{field("baseUrl", t("baseUrl"), "http://127.0.0.1:11434/v1")}
					{field("modelId", t("modelId"), "qwen3:8b")}
					<div className="field-row">
						{field("contextWindow", t("contextWindow"))}
						{field("maxTokens", t("maxOutput"))}
					</div>
					<Switch
						checked={form.keyRequired}
						onChange={(value) => setForm({ ...form, keyRequired: value })}
						label={t("keyRequired")}
					/>
					<ErrorBox error={save.error} />
				</Dialog>
			)}
		</div>
	);
}

function Providers() {
	useLang();
	const providers = useAppState((state) => state.providers);
	const regions = ["cn", "custom", "global"] as const;
	return (
		<section className="settings-section" aria-label={t("providers")}>
			<p className="hint">{t("keyHelp")}</p>
			{regions.map((region) => {
				const list = providers
					.filter((provider) => provider.region === region)
					.sort((a, b) => a.name.localeCompare(b.name));
				if (list.length === 0) return null;
				return (
					<div key={region} className="provider-group">
						<h3>{t(`region_${region}`)}</h3>
						{list.map((provider) => (
							<ProviderRow key={provider.id} provider={provider} />
						))}
					</div>
				);
			})}
			<CustomProviderForm />
		</section>
	);
}

/**
 * Defaults for new sessions (the model and the permission rules), and where decisions are logged;
 * saved together.
 */
function DefaultsDialog({ onClose }: { onClose: () => void }) {
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

function About() {
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
	const buildText = health?.build ? t("build", { b: health.build }) : null;
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
 * Personalization: theme, language, Yew in the interface and how the opening
 * leaves. Each applies as soon as it is chosen.
 */
function PersonalDialog({ onClose }: { onClose: () => void }) {
	useLang();
	const settings = useAppState((state) => state.settings);
	const themeId = useId();
	const languageId = useId();
	const mascotId = useId();
	const openingId = useId();
	const openerId = useId();
	const save = (patch: Parameters<typeof saveSettings>[0]) =>
		void saveSettings(patch).catch(() => {});
	const mascot = settings?.mascot !== false;
	return (
		<Dialog title={t("personalMenu")} size="l" onClose={onClose}>
			<SettingGroup title={t("personal_look")}>
				<SettingRow label={t("theme")} labelId={themeId}>
					<Select
						labelledBy={themeId}
						value={settings?.theme ?? "system"}
						options={(["system", "light", "dark"] as const).map((value) => ({
							value,
							label: t(`theme_${value}`),
						}))}
						onChange={(value) => save({ theme: value as "system" | "light" | "dark" })}
					/>
				</SettingRow>
				<SettingRow label={t("language")} labelId={languageId}>
					<Select
						labelledBy={languageId}
						value={settings?.language ?? "system"}
						options={[
							{ value: "system", label: t("language_system") },
							{ value: "zh", label: "简体中文" },
							{ value: "en", label: "English" },
						]}
						onChange={(value) => save({ language: value as "system" | "zh" | "en" })}
					/>
				</SettingRow>
			</SettingGroup>
			<SettingGroup title={t("personal_files")}>
				<SettingRow label={t("fileOpener")} hint={t("fileOpenerHint")} labelId={openerId}>
					<Select
						labelledBy={openerId}
						value={settings?.fileOpener ?? "system"}
						options={FILE_OPENERS.map((value) => ({
							value,
							label: t(`fileOpener_${value}`),
						}))}
						onChange={(value) => save({ fileOpener: value as FileOpener })}
					/>
				</SettingRow>
			</SettingGroup>
			<SettingGroup title={t("personal_yew")}>
				<SettingRow label={t("mascotMenu")} hint={t("mascotHint")} labelId={mascotId}>
					<Switch checked={mascot} labelledBy={mascotId} onChange={(on) => save({ mascot: on })} />
				</SettingRow>
				<SettingRow label={t("opening")} info={t("openingHint")} labelId={openingId}>
					<Select
						labelledBy={openingId}
						value={settings?.opening ?? "auto"}
						disabled={!mascot}
						options={(["auto", "click"] as const).map((value) => ({
							value,
							label: t(`opening_${value}`),
						}))}
						onChange={(value) => save({ opening: value as "auto" | "click" })}
					/>
				</SettingRow>
			</SettingGroup>
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

/**
 * Data: what the data folder takes and where it is, exporting everything
 * as `yew export` does, deleting the over-long command output, and deleting archived sessions. The
 * sizes are read when the dialog opens and after each action; nothing here runs by itself.
 */
function DataDialog({ onClose }: { onClose: () => void }) {
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

/**
 * Phone access: turn it on, see the relay connection, pair a phone by
 * QR code and remove paired phones. Everything between the phone and this Mac is end-to-end encrypted.
 */
function PhonesDialog({ onClose }: { onClose: () => void }) {
	useLang();
	const phones = useAppState((state) => state.phones);
	const [pairing, setPairing] = useState<{ svg: string; expiresAt: number; before: number } | null>(
		null,
	);
	const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
	const [relaying, setRelaying] = useState(false);
	const settings = useAppState((state) => state.settings);
	const notify = useAction((kind: (typeof NOTIFY_KINDS)[number], on: boolean) =>
		saveSettings({ notify: { [kind]: on } }),
	);
	const now = useNow();
	const switchId = useId();
	const notifyId = useId();
	const toggle = useAction((enabled: boolean) => setPhoneAccess(enabled));
	const pair = useAction(async () => {
		const result = await createPairing();
		setPairing({ ...result, before: phones?.devices.length ?? 0 });
	});
	// The relay connection changes without an event; look again while the dialog is open.
	useEffect(() => {
		void loadPhones();
		const timer = setInterval(() => void loadPhones(), 3000);
		return () => clearInterval(timer);
	}, []);
	// The code appears below the device list; bring it and its help text into view.
	const pairingArea = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (pairing) pairingArea.current?.scrollIntoView({ block: "nearest" });
	}, [pairing]);
	const remote = phones?.remote;
	const devices = phones?.devices ?? [];
	const paired = pairing && devices.length > pairing.before ? devices.at(-1) : null;
	const expired = pairing && !paired && pairing.expiresAt < now;
	return (
		<Dialog title={t("phones")} size="l" onClose={onClose}>
			<SettingGroup title={t("phoneAccess")}>
				<SettingRow label={t("phoneAccessSwitch")} hint={t("phoneAccessHint")} labelId={switchId}>
					<Switch
						checked={remote?.enabled ?? false}
						busy={toggle.busy}
						labelledBy={switchId}
						onChange={(value) => void toggle.run(value)}
					/>
				</SettingRow>
				<SettingRow
					label={t("relay")}
					hint={
						remote?.enabled
							? remote.connected
								? t("relayConnected")
								: t("relayConnecting")
							: undefined
					}
				>
					<code className="relay-url">{remote?.relayUrl ?? settings?.remote.relayUrl}</code>
					<Button onClick={() => setRelaying(true)}>
						<RenameIcon /> {t("relayChange")}
					</Button>
				</SettingRow>
			</SettingGroup>
			<SettingGroup title={t("pairedPhones")}>
				{devices.length === 0 && <p className="hint setting-empty">{t("noPairedPhones")}</p>}
				{devices.map((device) => (
					<SettingRow
						key={device.id}
						label={device.name}
						hint={[
							device.lastSeenAt
								? t("lastConnected", { ago: formatAgo(device.lastSeenAt, now) })
								: t("neverConnected"),
							device.canPush ? null : t("phoneNoPush"),
						]
							.filter(Boolean)
							.join(t("hintSeparator"))}
					>
						<Switch
							label={t("phoneNotify")}
							checked={device.push}
							onChange={(push) => void setDevicePush(device.id, push)}
						/>
						<Button
							variant="danger"
							onClick={() => setRemoving({ id: device.id, name: device.name })}
						>
							<TrashIcon />
							{t("removePhone")}
						</Button>
					</SettingRow>
				))}
			</SettingGroup>
			<SettingGroup title={t("notifyTitle")} info={t("notifyHelp")}>
				{NOTIFY_KINDS.map((kind) => (
					<SettingRow
						key={kind}
						label={t(`notify_${kind}`)}
						hint={t(`notify_${kind}_hint`)}
						labelId={`${notifyId}-${kind}`}
					>
						<Switch
							checked={settings?.notify[kind] ?? true}
							busy={notify.busy}
							labelledBy={`${notifyId}-${kind}`}
							onChange={(on) => void notify.run(kind, on)}
						/>
					</SettingRow>
				))}
			</SettingGroup>
			<div className="pairing" ref={pairingArea}>
				{paired ? (
					<p role="status">{t("phonePaired", { name: paired.name })}</p>
				) : pairing && !expired ? (
					<>
						<img
							className="pairing-qr"
							src={`data:image/svg+xml;utf8,${encodeURIComponent(pairing.svg)}`}
							alt={t("pairingQr")}
						/>
						<p className="hint">{t("pairingHelp")}</p>
					</>
				) : (
					<>
						{expired && <p className="hint">{t("pairingExpired")}</p>}
						<Button
							variant="primary"
							busy={pair.busy}
							disabled={!remote?.enabled}
							onClick={() => void pair.run()}
						>
							<PhoneIcon />
							{t("addPhone")}
						</Button>
						{!remote?.enabled && <p className="hint">{t("turnOnFirst")}</p>}
					</>
				)}
			</div>
			<ErrorBox error={toggle.error ?? pair.error ?? notify.error} />
			{relaying && (
				<RelayDialog
					current={remote?.relayUrl ?? settings?.remote.relayUrl ?? DEFAULT_RELAY_URL}
					paired={devices.length > 0}
					onClose={() => setRelaying(false)}
				/>
			)}
			{removing && (
				<ConfirmDialog
					title={t("removePhoneTitle", { name: removing.name })}
					body={t("removePhoneBody")}
					confirmLabel={t("removePhone")}
					onConfirm={() => revokeDevice(removing.id)}
					onClose={() => setRemoving(null)}
				/>
			)}
		</Dialog>
	);
}

/**
 * The relay address: your own relay in place of the one Yew comes with.
 * A phone keeps the address it was paired with, so after a change it has to pair again.
 */
function RelayDialog({
	current,
	paired,
	onClose,
}: {
	current: string;
	paired: boolean;
	onClose: () => void;
}) {
	useLang();
	const [url, setUrl] = useState(current);
	const id = useId();
	const noteId = useId();
	const save = useAction(async () => {
		const value = url.trim();
		// The default is sent as null, so the saved setting follows Yew's own default.
		await saveSettings({ remote: { relayUrl: value === DEFAULT_RELAY_URL ? null : value } });
		await loadPhones();
		onClose();
	});
	return (
		<Dialog
			title={t("relayTitle")}
			size="m"
			onClose={onClose}
			footer={
				<>
					<Button
						disabled={url.trim() === DEFAULT_RELAY_URL}
						onClick={() => setUrl(DEFAULT_RELAY_URL)}
					>
						<RetryIcon />
						{t("relayRestore")}
					</Button>
					<Button onClick={onClose}>{t("cancel")}</Button>
					<Button
						variant="primary"
						busy={save.busy}
						disabled={!url.trim() || url.trim() === current}
						onClick={() => void save.run()}
					>
						<CheckIcon />
						{t("save")}
					</Button>
				</>
			}
		>
			<Field label={t("relayTitle")} htmlFor={id}>
				<input
					id={id}
					className="input mono-input"
					spellCheck={false}
					autoComplete="off"
					autoCapitalize="off"
					placeholder={DEFAULT_RELAY_URL}
					aria-describedby={noteId}
					value={url}
					onChange={(event) => setUrl(event.target.value)}
				/>
				<span className="hint" id={noteId}>
					{t("relayHelp")}
					{paired ? ` ${t("relayRepair")}` : ""}
				</span>
			</Field>
			<ErrorBox error={save.error} />
		</Dialog>
	);
}

/** Names with values, typed a line at a time; values are hidden as they are typed, like API keys. */
interface Pair {
	id: number;
	name: string;
	value: string;
}

function PairsEditor({
	pairs,
	onChange,
	addLabel,
	namePlaceholder,
}: {
	pairs: Pair[];
	onChange: (pairs: Pair[]) => void;
	addLabel: string;
	namePlaceholder: string;
}) {
	useLang();
	const next = useRef(1);
	const set = (id: number, patch: Partial<Pair>) =>
		onChange(pairs.map((pair) => (pair.id === id ? { ...pair, ...patch } : pair)));
	return (
		<div className="pairs">
			{pairs.map((pair) => (
				<div key={pair.id} className="pair-row">
					<input
						className="input mono-input"
						spellCheck={false}
						autoComplete="off"
						autoCapitalize="off"
						aria-label={t("mcpPairName")}
						placeholder={namePlaceholder}
						value={pair.name}
						onChange={(event) => set(pair.id, { name: event.target.value })}
					/>
					<input
						className="input secret-input"
						type="text"
						spellCheck={false}
						autoComplete="off"
						data-1p-ignore="true"
						aria-label={t("mcpPairValue")}
						placeholder={t("mcpPairValue")}
						value={pair.value}
						onChange={(event) => set(pair.id, { value: event.target.value })}
					/>
					<Button
						variant="icon"
						aria-label={t("mcpRemovePair")}
						title={t("mcpRemovePair")}
						onClick={() => onChange(pairs.filter((other) => other.id !== pair.id))}
					>
						<CloseIcon />
					</Button>
				</div>
			))}
			<Button
				onClick={() => {
					onChange([...pairs, { id: next.current, name: "", value: "" }]);
					next.current += 1;
				}}
			>
				<PlusIcon />
				{addLabel}
			</Button>
		</div>
	);
}

const pairsToRecord = (pairs: Pair[]): Record<string, string> =>
	Object.fromEntries(
		pairs.filter((pair) => pair.name.trim()).map((pair) => [pair.name.trim(), pair.value]),
	);

/** Adding an MCP server: a command Yew starts on this computer, or a URL it connects to. */
/**
 * An official server from the list: what it is, where its token comes from,
 * where the token goes and what will run, then the same entry a person would write in mcp.json.
 */
function McpPresetDialog({
	preset,
	onClose,
	onAdded,
}: {
	preset: McpPreset;
	onClose: () => void;
	onAdded: () => Promise<unknown>;
}) {
	useLang();
	const [token, setToken] = useState("");
	const [client, setClient] = useState({ id: "", secret: "" });
	const tokenId = useId();
	const clientIdId = useId();
	const clientSecretId = useId();
	const own = preset.signIn?.ownClient;
	// Where the browser comes back to after signing in: this Yew, on this port.
	const redirect = `http://127.0.0.1:${window.location.port}/oauth/callback`;
	const add = useAction(async () => {
		await addMcpServer(presetEntry(preset, token, client));
		await onAdded();
		onClose();
	});
	const remote = "url" in preset.connect;
	const where = remote
		? t("mcpPresetRemote", {
				publisher: preset.publisher,
				host: new URL((preset.connect as { url: string }).url).host,
			})
		: t("mcpPresetLocal", { pkg: (preset.connect as { package: string }).package });
	return (
		<Dialog
			title={t("mcpPresetAddTitle", { name: preset.name })}
			size="m"
			onClose={onClose}
			footer={
				<>
					<Button onClick={onClose}>{t("cancel")}</Button>
					<Button
						variant="primary"
						busy={add.busy}
						disabled={
							own
								? !client.id.trim() || !client.secret.trim()
								: Boolean(preset.token && !preset.token.optional && !token.trim())
						}
						onClick={() => void add.run()}
					>
						<PlusIcon />
						{t("mcpAdd")}
					</Button>
				</>
			}
		>
			<p>{t(`mcpPreset_${preset.id}` as MessageKey)}</p>
			<p className="hint">{where}</p>
			{preset.signIn && !own && (
				<p className="hint">{t("mcpPresetSignIn", { publisher: preset.publisher })}</p>
			)}
			{own && (
				<>
					<ol className="preset-steps">
						<li>{t("mcpGoogleStep1")}</li>
						<li>{t("mcpGoogleStep2", { apis: own.apis.join(t("listSeparator")) })}</li>
						<li>
							{t("mcpGoogleStep3")}
							{own.scopes.map((scope) => (
								<code key={scope} className="mcp-code preset-redirect">
									{scope}
								</code>
							))}
						</li>
						<li>
							{t("mcpGoogleStep4")}
							<code className="mcp-code preset-redirect">{redirect}</code>
						</li>
						<li>{t("mcpGoogleStep5")}</li>
					</ol>
					<p className="hint">
						<a href={own.guide} target="_blank" rel="noopener noreferrer">
							{t("mcpGoogleGuide")}
						</a>
						{t("hintSeparator")}
						{t("mcpGoogleShared")}
					</p>
					<Field label={t("mcpClientId")} htmlFor={clientIdId}>
						<input
							id={clientIdId}
							className="input mono-input"
							autoComplete="off"
							spellCheck={false}
							data-1p-ignore="true"
							value={client.id}
							onChange={(event) => setClient({ ...client, id: event.target.value })}
						/>
					</Field>
					<Field label={t("mcpClientSecret")} htmlFor={clientSecretId}>
						<input
							id={clientSecretId}
							className="input secret-input"
							type="text"
							autoComplete="off"
							spellCheck={false}
							data-1p-ignore="true"
							value={client.secret}
							onChange={(event) => setClient({ ...client, secret: event.target.value })}
						/>
						<span className="hint">{t("mcpClientStored")}</span>
					</Field>
				</>
			)}
			{preset.token && (
				<Field
					label={preset.token.optional ? t("mcpPresetTokenOptional") : t("mcpPresetToken")}
					htmlFor={tokenId}
				>
					{/* A token is not a sign-in password, so it is not marked as one. */}
					<input
						id={tokenId}
						className="input secret-input"
						type="text"
						autoComplete="off"
						spellCheck={false}
						data-1p-ignore="true"
						value={token}
						onChange={(event) => setToken(event.target.value)}
					/>
					<span className="hint">
						<a href={preset.token.where} target="_blank" rel="noopener noreferrer">
							{t("mcpPresetWhere", { publisher: preset.publisher })}
						</a>
						{t("hintSeparator")}
						{t("mcpPresetStored")}
					</span>
				</Field>
			)}
			<ErrorBox error={add.error} />
		</Dialog>
	);
}

function McpAddDialog({
	onClose,
	onAdded,
}: {
	onClose: () => void;
	onAdded: () => Promise<unknown>;
}) {
	useLang();
	const [name, setName] = useState("");
	const [kind, setKind] = useState<"stdio" | "http">("stdio");
	const [command, setCommand] = useState("");
	const [args, setArgs] = useState("");
	const [env, setEnv] = useState<Pair[]>([]);
	const [url, setUrl] = useState("");
	const [headers, setHeaders] = useState<Pair[]>([]);
	const ids = {
		name: useId(),
		nameHint: useId(),
		kind: useId(),
		command: useId(),
		args: useId(),
		url: useId(),
	};
	const add = useAction(async () => {
		await addMcpServer(
			kind === "stdio"
				? {
						name: name.trim(),
						command: command.trim(),
						args: args
							.split("\n")
							.map((line) => line.trim())
							.filter(Boolean),
						env: pairsToRecord(env),
					}
				: { name: name.trim(), url: url.trim(), headers: pairsToRecord(headers) },
		);
		await onAdded();
		onClose();
	});
	return (
		<Dialog
			title={t("mcpAdd")}
			size="m"
			onClose={onClose}
			footer={
				<>
					<Button onClick={onClose}>{t("cancel")}</Button>
					<Button
						variant="primary"
						busy={add.busy}
						disabled={!name.trim() || !(kind === "stdio" ? command.trim() : url.trim())}
						onClick={() => void add.run()}
					>
						<PlusIcon />
						{t("mcpAdd")}
					</Button>
				</>
			}
		>
			<Field label={t("mcpName")} htmlFor={ids.name}>
				<input
					id={ids.name}
					className="input mono-input"
					spellCheck={false}
					autoComplete="off"
					autoCapitalize="off"
					maxLength={32}
					aria-describedby={ids.nameHint}
					value={name}
					onChange={(event) => setName(event.target.value)}
				/>
				<span className="hint" id={ids.nameHint}>
					{t("mcpNameHint")}
				</span>
			</Field>
			<Field label={t("mcpKind")} labelId={ids.kind}>
				<Select
					labelledBy={ids.kind}
					value={kind}
					options={(["stdio", "http"] as const).map((value) => ({
						value,
						label: t(`mcpKind_${value}`),
						hint: t(`mcpKind_${value}_hint`),
					}))}
					onChange={(value) => setKind(value as "stdio" | "http")}
				/>
			</Field>
			{kind === "stdio" ? (
				<>
					<Field label={t("mcpCommand")} htmlFor={ids.command}>
						<input
							id={ids.command}
							className="input mono-input"
							spellCheck={false}
							autoComplete="off"
							autoCapitalize="off"
							placeholder="npx"
							value={command}
							onChange={(event) => setCommand(event.target.value)}
						/>
					</Field>
					<Field label={t("mcpArgs")} htmlFor={ids.args}>
						<textarea
							id={ids.args}
							className="textarea mono-input"
							spellCheck={false}
							rows={2}
							placeholder={t("mcpArgsHint")}
							value={args}
							onChange={(event) => setArgs(event.target.value)}
						/>
					</Field>
					<Field label={t("mcpEnv")} info={t("mcpEnvHelp")}>
						<PairsEditor
							pairs={env}
							onChange={setEnv}
							addLabel={t("mcpAddEnv")}
							namePlaceholder="API_KEY"
						/>
					</Field>
				</>
			) : (
				<>
					<Field label={t("mcpUrl")} htmlFor={ids.url}>
						<input
							id={ids.url}
							className="input mono-input"
							spellCheck={false}
							autoComplete="off"
							autoCapitalize="off"
							inputMode="url"
							placeholder="https://example.com/mcp"
							value={url}
							onChange={(event) => setUrl(event.target.value)}
						/>
					</Field>
					<Field label={t("mcpHeaders")} info={t("mcpHeadersHelp")}>
						<PairsEditor
							pairs={headers}
							onChange={setHeaders}
							addLabel={t("mcpAddHeader")}
							namePlaceholder="Authorization"
						/>
					</Field>
				</>
			)}
			<ErrorBox error={add.error} />
		</Dialog>
	);
}

/** One saved variable or header: its name, and a way to type its value again. The value is never shown. */
function McpValue({ name, onSave }: { name: string; onSave: (value: string) => Promise<unknown> }) {
	useLang();
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState("");
	const save = useAction(async () => {
		await onSave(value);
		setValue("");
		setEditing(false);
	});
	return (
		<div className="mcp-value">
			<code className="mcp-code">{name}</code>
			{editing ? (
				<>
					<input
						className="input secret-input"
						type="text"
						spellCheck={false}
						autoComplete="off"
						data-1p-ignore="true"
						aria-label={t("mcpNewValue", { name })}
						placeholder={t("mcpNewValue", { name })}
						value={value}
						onChange={(event) => setValue(event.target.value)}
					/>
					<Button onClick={() => setEditing(false)}>{t("cancel")}</Button>
					<Button variant="primary" busy={save.busy} onClick={() => void save.run()}>
						<CheckIcon />
						{t("save")}
					</Button>
				</>
			) : (
				<Button variant="ghost" onClick={() => setEditing(true)}>
					<KeyIcon />
					{t("mcpReenter")}
				</Button>
			)}
			<ErrorBox error={save.error} />
		</div>
	);
}

function McpServerRow({
	server,
	onChanged,
	onRemove,
}: {
	server: McpServerView;
	onChanged: () => Promise<unknown>;
	onRemove: () => void;
}) {
	useLang();
	const [open, setOpen] = useState(false);
	const detailId = useId();
	const toggle = useAction(async (enabled: boolean) => {
		await patchMcpServer(server.name, { disabled: !enabled });
		await onChanged();
	});
	const signOut = useAction(async () => {
		await signOutMcpServer(server.name);
		await onChanged();
	});
	// Yew's own browser server: the person's Chrome, or a window of its own.
	const browserMode = useAppState((state) => state.settings?.browser ?? "own");
	const browserId = useId();
	const chooseBrowser = useAction(async (mode: "own" | "separate") => {
		await saveSettings({ browser: mode });
		await onChanged();
	});
	const state =
		server.state === "ready"
			? t("mcpState_ready", { n: server.tools.length })
			: server.state === "error" && server.error
				? `${t("mcpState_error")}${t("hintSeparator")}${server.error}`
				: t(`mcpState_${server.state}`);
	const values = server.kind === "stdio" ? server.envNames : server.headerNames;
	// What a server Yew sets up by itself is for, in the interface language.
	const titleKey = `mcpBuiltin_${server.name}`;
	const helpKey = `mcpBuiltinHelp_${server.name}`;
	return (
		<div className="mcp-server">
			<div className="setting-row mcp-row">
				<div className="setting-text">
					<span className="setting-label">
						{server.builtin && hasMessage(titleKey) && <>{t(titleKey)} </>}
						<span className="mcp-code">{server.name}</span>
					</span>
					{server.builtin && hasMessage(helpKey) && <span className="hint">{t(helpKey)}</span>}
					<span className="hint" role="status">
						{state}
					</span>
					{/* Which site the sign-in opens, so a server that sends it somewhere odd shows it first. */}
					{server.state === "sign-in" && server.signInAt && !server.disabled && (
						<span className="hint">{t("mcpSignInAt", { host: server.signInAt })}</span>
					)}
				</div>
				<div className="setting-control">
					{/* A link, so the browser opens the sign-in in a new tab without a pop-up to block. */}
					{server.state === "sign-in" && !server.disabled && (
						<a
							className="btn btn-primary"
							href={`/api/mcp/${encodeURIComponent(server.name)}/sign-in`}
							target="_blank"
							rel="noopener noreferrer"
						>
							<SignInIcon />
							{t("mcpSignIn")}
						</a>
					)}
					{server.signedIn && (
						<Button busy={signOut.busy} onClick={() => void signOut.run()}>
							<SignOutIcon />
							{t("mcpSignOut")}
						</Button>
					)}
					<Button
						variant="ghost"
						aria-expanded={open}
						aria-controls={detailId}
						onClick={() => setOpen(!open)}
					>
						<InfoIcon />
						{t("mcpDetails")}
					</Button>
					<Switch
						label={t("mcpEnabled")}
						checked={!server.disabled}
						busy={toggle.busy}
						onChange={(value) => void toggle.run(value)}
					/>
					{!server.builtin && (
						<Button variant="danger" onClick={onRemove}>
							<TrashIcon />
							{t("mcpRemove")}
						</Button>
					)}
				</div>
			</div>
			{server.builtin && server.name === "browser" && (
				<SettingRow
					label={t("browserMode")}
					hint={t(`browserModeHint_${browserMode}`)}
					labelId={browserId}
				>
					<div className="select-wide">
						<Select
							labelledBy={browserId}
							value={browserMode}
							disabled={chooseBrowser.busy}
							options={(["own", "separate"] as const).map((value) => ({
								value,
								label: t(`browserMode_${value}`),
							}))}
							onChange={(value) => void chooseBrowser.run(value as "own" | "separate")}
						/>
					</div>
				</SettingRow>
			)}
			<ErrorBox error={chooseBrowser.error} />
			{open && (
				<div className="mcp-detail" id={detailId}>
					<div className="mcp-line">
						<span>
							{server.package
								? t("mcpPackage")
								: server.kind === "stdio"
									? t("mcpCommand")
									: t("mcpUrl")}
						</span>
						<code className="mcp-code">
							{server.package ??
								(server.kind === "stdio" ? [server.command, ...server.args].join(" ") : server.url)}
						</code>
					</div>
					<div className="mcp-line">
						<span>{server.kind === "stdio" ? t("mcpEnv") : t("mcpHeaders")}</span>
						<div className="mcp-values">
							{values.length === 0 && <span className="hint">{t("mcpNoValues")}</span>}
							{values.map((name) => (
								<McpValue
									key={name}
									name={name}
									onSave={async (value) => {
										await patchMcpServer(
											server.name,
											server.kind === "stdio"
												? { env: { [name]: value } }
												: { headers: { [name]: value } },
										);
										await onChanged();
									}}
								/>
							))}
						</div>
					</div>
					{server.state === "ready" && (
						<div className="mcp-line">
							<span>{t("mcpTools")}</span>
							{server.tools.length === 0 ? (
								<span className="hint">{t("mcpNoTools")}</span>
							) : (
								<ul className="mcp-tools">
									{server.tools.map((tool) => (
										<li key={tool}>
											<code className="mcp-code">{tool}</code>
										</li>
									))}
								</ul>
							)}
						</div>
					)}
					<ErrorBox error={toggle.error} />
				</div>
			)}
			{!open && <ErrorBox error={toggle.error} />}
		</div>
	);
}

/**
 * MCP servers: the servers in mcp.json, whether each is connected and the
 * tools it offers; add one, turn one off, remove one. Changes apply to the running Yew at once.
 */
function McpDialog({ onClose }: { onClose: () => void }) {
	useLang();
	const [servers, setServers] = useState<McpServerView[] | null>(null);
	const [error, setError] = useState<unknown>(null);
	const [adding, setAdding] = useState(false);
	const [preset, setPreset] = useState<McpPreset | null>(null);
	const [removing, setRemoving] = useState<string | null>(null);
	const reload = useCallback(
		() =>
			loadMcpServers().then((items) => {
				setServers(items);
				setError(null);
			}, setError),
		[],
	);
	// A server connects or fails without an event; look again while the dialog is open.
	useEffect(() => {
		void reload();
		const timer = setInterval(() => void reload(), 2000);
		return () => clearInterval(timer);
	}, [reload]);
	return (
		<Dialog title={t("mcpTitle")} size="l" onClose={onClose}>
			<p className="hint">{t("mcpHelp")}</p>
			{(servers ?? []).some((server) => server.builtin) && (
				<SettingGroup title={t("mcpBuiltin")}>
					{(servers ?? [])
						.filter((server) => server.builtin)
						.map((server) => (
							<McpServerRow
								key={server.name}
								server={server}
								onChanged={reload}
								onRemove={() => {}}
							/>
						))}
				</SettingGroup>
			)}
			<SettingGroup title={t("mcpAdded")}>
				{servers === null && !error && <p className="hint setting-empty">{t("loading")}</p>}
				{servers?.filter((server) => !server.builtin).length === 0 && (
					<p className="hint setting-empty">{t("mcpNone")}</p>
				)}
				{(servers ?? [])
					.filter((server) => !server.builtin)
					.map((server) => (
						<McpServerRow
							key={server.name}
							server={server}
							onChanged={reload}
							onRemove={() => setRemoving(server.name)}
						/>
					))}
			</SettingGroup>
			<div>
				<Button onClick={() => setAdding(true)}>
					<PlusIcon />
					{t("mcpAdd")}
				</Button>
			</div>
			{servers && (
				<SettingGroup title={t("mcpPresets")} info={t("mcpPresetsInfo")}>
					{MCP_PRESETS.filter((preset) => !servers.some((server) => server.name === preset.id)).map(
						(preset) => (
							<div key={preset.id} className="setting-row">
								<div className="setting-text">
									<span className="setting-label">{preset.name}</span>
									<span className="hint">
										{preset.publisher}
										{t("hintSeparator")}
										{t(`mcpPreset_${preset.id}` as MessageKey)}
									</span>
								</div>
								<div className="setting-control">
									<Button onClick={() => setPreset(preset)}>
										<PlusIcon />
										{t("mcpAdd")}
									</Button>
								</div>
							</div>
						),
					)}
				</SettingGroup>
			)}
			<ErrorBox error={error} />
			{adding && <McpAddDialog onClose={() => setAdding(false)} onAdded={reload} />}
			{preset && (
				<McpPresetDialog preset={preset} onClose={() => setPreset(null)} onAdded={reload} />
			)}
			{removing && (
				<ConfirmDialog
					title={t("mcpRemoveTitle", { name: removing })}
					body={t("mcpRemoveBody")}
					confirmLabel={t("mcpRemove")}
					onConfirm={async () => {
						await removeMcpServer(removing);
						await reload();
					}}
					onClose={() => setRemoving(null)}
				/>
			)}
		</Dialog>
	);
}

function SkillRow({
	skill,
	reveal,
	onChanged,
}: {
	skill: SkillView;
	reveal: SkillList["reveal"];
	onChanged: () => Promise<unknown>;
}) {
	useLang();
	const [full, setFull] = useState(false);
	const nameId = useId();
	const toggle = useAction(async (enabled: boolean) => {
		await patchSkill(skill.id, !enabled);
		await onChanged();
	});
	const show = useAction(() => revealSkill(skill.id));
	return (
		<div className="skill">
			<div className="setting-row skill-row">
				<div className="setting-text">
					<span className="setting-label skill-name">
						<span id={nameId}>{skill.name}</span>
						{skill.problem && <span className="skill-mark">{t("skillUnread")}</span>}
					</span>
					{skill.problem ? (
						<span className="hint">{t(`skillProblem_${skill.problem}`)}</span>
					) : skill.description ? (
						// One line; a click shows the rest, so it can be read without a pointer too.
						<button
							type="button"
							className={`hint skill-description${full ? " open" : ""}`}
							aria-expanded={full}
							title={full ? undefined : skill.description}
							onClick={() => setFull(!full)}
						>
							{skill.description}
						</button>
					) : (
						<span className="hint">{t("skillNoDescription")}</span>
					)}
				</div>
				<div className="setting-control">
					{reveal && (
						<Button variant="ghost" busy={show.busy} onClick={() => void show.run()}>
							<FolderIcon />
							{t(reveal === "finder" ? "skillRevealFinder" : "skillRevealFiles")}
						</Button>
					)}
					{!skill.problem && (
						<Switch
							checked={!skill.disabled}
							busy={toggle.busy}
							labelledBy={nameId}
							onChange={(value) => void toggle.run(value)}
						/>
					)}
				</div>
			</div>
			<ErrorBox error={toggle.error ?? show.error} />
		</div>
	);
}

/**
 * Skills: what Yew read from the global folders and the saved workspaces,
 * a switch for each, and its folder in the file manager. Folders that could not be read are listed
 * with the reason. A skill's content is edited in its folder, not here.
 */
function SkillsDialog({ onClose }: { onClose: () => void }) {
	useLang();
	const [list, setList] = useState<SkillList | null>(null);
	const [error, setError] = useState<unknown>(null);
	const reload = useCallback(
		() =>
			loadSkills().then((loaded) => {
				setList(loaded);
				setError(null);
			}, setError),
		[],
	);
	useEffect(() => {
		void reload();
	}, [reload]);
	const globalPaths = list?.folders.find((group) => group.source.kind === "global")?.paths ?? [];
	const inGroup = (source: SkillList["folders"][number]["source"]) =>
		(list?.items ?? []).filter((item) =>
			source.kind === "builtin"
				? item.source.kind === "builtin"
				: source.kind === "global"
					? item.source.kind === "global"
					: item.source.kind === "workspace" && item.source.path === source.path,
		);
	return (
		<Dialog title={t("skillsTitle")} size="l" onClose={onClose}>
			{list && (
				<p className="hint">{t("skillsHelp", { global: globalPaths.join(t("listSeparator")) })}</p>
			)}
			{list === null && !error && <p className="hint">{t("loading")}</p>}
			{(list?.folders ?? []).map(({ source }) => {
				const skills = inGroup(source);
				// Empty workspace or empty built-in groups are left out; the global group always shows.
				if (source.kind !== "global" && skills.length === 0) return null;
				return (
					<SettingGroup
						key={source.kind === "workspace" ? source.path : source.kind}
						title={
							source.kind === "builtin"
								? t("skillsBuiltin")
								: source.kind === "global"
									? t("skillsGlobal")
									: `${source.name}${t("hintSeparator")}${source.path}`
						}
					>
						{skills.length === 0 && (
							<p className="hint setting-empty">
								{t("skillsNone", { folder: globalPaths[0] ?? "" })}
							</p>
						)}
						{skills.map((skill) => (
							<SkillRow
								key={skill.id}
								skill={skill}
								reveal={list?.reveal ?? null}
								onChanged={reload}
							/>
						))}
					</SettingGroup>
				);
			})}
			<ErrorBox error={error} />
		</Dialog>
	);
}

/**
 * Starting at login and the launcher icon: the same as `yew service` and
 * `yew app`, as two switches. Where the system does not support one, its row says so.
 */
function SystemDialog({ onClose }: { onClose: () => void }) {
	useLang();
	const sandbox = useAppState((state) => state.health?.sandbox ?? "none");
	const credentials = useAppState((state) => state.settings?.sandboxCredentials ?? false);
	const credentialsId = useId();
	const [status, setStatus] = useState<SystemStatus | null>(null);
	const [error, setError] = useState<unknown>(null);
	useEffect(() => {
		loadSystem().then(setStatus, setError);
	}, []);
	const change = useAction(async (patch: { startAtLogin?: boolean; launcher?: boolean }) => {
		setStatus(await saveSystem(patch));
	});
	const loginId = useId();
	const launcherId = useId();
	const login = status?.startAtLogin;
	const launcher = status?.launcher;
	const hint = (
		text: string,
		unsupported: string,
		item?: { supported: boolean; on: boolean },
		path?: string | null,
	) =>
		item && !item.supported
			? unsupported
			: item?.on && path
				? `${text} ${t("writtenTo", { path })}`
				: text;
	return (
		<Dialog title={t("systemTitle")} size="l" onClose={onClose}>
			<SettingGroup title={t("systemTitle")}>
				<SettingRow
					label={t("startAtLogin")}
					hint={hint(t("startAtLoginHint"), t("startAtLoginUnsupported"), login, login?.file)}
					labelId={loginId}
				>
					<Switch
						checked={login?.on ?? false}
						disabled={!login?.supported}
						busy={change.busy}
						labelledBy={loginId}
						onChange={(on) => void change.run({ startAtLogin: on })}
					/>
				</SettingRow>
				<SettingRow
					label={t("launcher")}
					hint={hint(t("launcherHint"), t("launcherUnsupported"), launcher, launcher?.path)}
					labelId={launcherId}
				>
					<Switch
						checked={launcher?.on ?? false}
						disabled={!launcher?.supported}
						busy={change.busy}
						labelledBy={launcherId}
						onChange={(on) => void change.run({ launcher: on })}
					/>
				</SettingRow>
			</SettingGroup>
			{/* Where sessions' commands run; without a sandbox it says so. */}
			{sandbox === "none" ? (
				<SettingGroup title={t("sandbox")}>
					<SettingRow label={t("sandbox_none")} hint={t("sandbox_none_hint")}>
						{null}
					</SettingRow>
				</SettingGroup>
			) : (
				<SettingGroup title={t("sandbox")}>
					<SettingRow
						label={t(`sandbox_${sandbox}`)}
						hint={t(sandbox === "linux" ? "sandboxHintLinux" : "sandboxHint")}
					>
						{null}
					</SettingRow>
					<SettingRow
						label={t("sandboxCredentials")}
						hint={t("sandboxCredentialsHint")}
						labelId={credentialsId}
					>
						<Switch
							checked={credentials}
							labelledBy={credentialsId}
							onChange={(on) => void saveSettings({ sandboxCredentials: on }).catch(() => {})}
						/>
					</SettingRow>
				</SettingGroup>
			)}
			<ErrorBox error={error ?? change.error} />
		</Dialog>
	);
}
