import { useEffect, useId, useRef, useState } from "react";
import { DEFAULT_RELAY_URL } from "../../../../src/shared/types.ts";
import {
	createPairing,
	loadPhones,
	revokeDevice,
	saveSettings,
	setDevicePush,
	setPhoneAccess,
} from "../../actions/settings.ts";
import { formatAgo, t, useLang } from "../../i18n.ts";
import { NOTIFY_KINDS, useAppState } from "../../state.ts";
import { Dialog } from "../dialog.tsx";
import { ConfirmDialog } from "../dialogs.tsx";
import { CheckIcon, PhoneIcon, RenameIcon, RetryIcon, TrashIcon } from "../icons.tsx";
import {
	Button,
	ErrorBox,
	Field,
	SettingGroup,
	SettingRow,
	Switch,
	useAction,
	useNow,
} from "../ui.tsx";

/**
 * Phone access: turn it on, see the relay connection, pair a phone by
 * QR code and remove paired phones. Everything between the phone and this Mac is end-to-end encrypted.
 */
export function PhonesDialog({ onClose }: { onClose: () => void }) {
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
