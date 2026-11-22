import { useEffect, useId, useState } from "react";
import { loadSystem, saveSettings, saveSystem } from "../../actions.ts";
import { t, useLang } from "../../i18n.ts";
import { type SystemStatus, useAppState } from "../../state.ts";
import { Dialog, ErrorBox, SettingGroup, SettingRow, Switch, useAction } from "../ui.tsx";

/**
 * Starting at login and the launcher icon: the same as `yew service` and
 * `yew app`, as two switches. Where the system does not support one, its row says so.
 */
export function SystemDialog({ onClose }: { onClose: () => void }) {
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
