import { useCallback, useEffect, useId, useRef, useState } from "react";
import { MCP_PRESETS, type McpPreset, presetEntry } from "../../../../src/shared/mcp-presets.ts";
import {
	addMcpServer,
	loadMcpServers,
	patchMcpServer,
	removeMcpServer,
	saveSettings,
	signOutMcpServer,
} from "../../actions/settings.ts";
import { hasMessage, type MessageKey, t, useLang } from "../../i18n.ts";
import { type McpServerView, useAppState } from "../../state.ts";
import { ConfirmDialog } from "../dialogs.tsx";
import {
	CheckIcon,
	CloseIcon,
	InfoIcon,
	KeyIcon,
	PlusIcon,
	SignInIcon,
	SignOutIcon,
	TrashIcon,
} from "../icons.tsx";
import {
	Button,
	Dialog,
	ErrorBox,
	Field,
	Select,
	SettingGroup,
	SettingRow,
	Switch,
	useAction,
} from "../ui.tsx";

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
export function McpDialog({ onClose }: { onClose: () => void }) {
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
