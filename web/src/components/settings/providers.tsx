import { type ReactNode, useCallback, useEffect, useId, useState } from "react";
import {
	deleteCustomProvider,
	deleteKey,
	deleteSearchKey,
	loadSearchServices,
	saveCustomProvider,
	saveKey,
	saveSearchKey,
	saveSettings,
	testProvider,
} from "../../actions/settings.ts";
import { hasMessage, t, useLang } from "../../i18n.ts";
import {
	type PingResult,
	type ProviderSummary,
	type SearchServiceView,
	type Settings,
	useAppState,
} from "../../state.ts";
import { Dialog } from "../dialog.tsx";
import { ConfirmDialog } from "../dialogs.tsx";
import { CheckIcon, KeyIcon, PlusIcon, PulseIcon, TrashIcon } from "../icons.tsx";
import { ModelPicker, SideModelPicker } from "../model-picker.tsx";
import { Button, ErrorBox, Field, Switch, useAction } from "../ui.tsx";

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
							// DeepSeek's search uses the model's key: it is saved with the model providers.
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
 * Models and keys: the model providers on one tab and the search services on the other, so the
 * three search services are not under the long list of providers.
 */
export function ProvidersDialog({ onClose }: { onClose: () => void }) {
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

/**
 * The two models sessions start from: the one new sessions use, and the one that does the jobs
 * beside every conversation. A choice is saved as it is made, like the keys below.
 */
function ModelRoles() {
	useLang();
	const settings = useAppState((state) => state.settings);
	const providers = useAppState((state) => state.providers);
	const main = useAction((value: Settings["defaultModel"]) =>
		saveSettings({ defaultModel: value }),
	);
	const side = useAction((value: Settings["sideModel"]) => saveSettings({ sideModel: value }));
	if (!settings) return null;
	const chosen = settings.sideModel;
	const at = chosen ? providers.find((provider) => provider.id === chosen.provider) : undefined;
	const name = at?.name ?? chosen?.provider ?? "";
	return (
		<>
			<Field label={t("mainModel")} info={t("mainModelHelp")}>
				<ModelPicker
					{...settings.defaultModel}
					layout="grid"
					busy={main.busy}
					onChange={(patch) => void main.run({ ...settings.defaultModel, ...patch })}
				/>
				<ErrorBox error={main.error} />
			</Field>
			<Field label={t("sideModel")} info={t("sideModelHelp")}>
				<SideModelPicker
					value={chosen}
					busy={side.busy}
					onChange={(value) => void side.run(value)}
				/>
				<span className="hint" role="status">
					{!chosen
						? t("sideModelUnsetHint")
						: at && (at.hasKey || !at.keyRequired)
							? t("sideModelSends", { provider: name })
							: t("sideModelNoKey", { provider: name })}
				</span>
				<ErrorBox error={side.error} />
			</Field>
		</>
	);
}

function Providers() {
	useLang();
	const providers = useAppState((state) => state.providers);
	const regions = ["cn", "custom", "global"] as const;
	return (
		<section className="settings-section" aria-label={t("providers")}>
			<ModelRoles />
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
