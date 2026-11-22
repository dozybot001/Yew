import { useId } from "react";
import { FILE_OPENERS, type FileOpener } from "../../../../src/shared/types.ts";
import { saveSettings } from "../../actions/settings.ts";
import { t, useLang } from "../../i18n.ts";
import { useAppState } from "../../state.ts";
import { Dialog, Select, SettingGroup, SettingRow, Switch } from "../ui.tsx";

/**
 * Personalization: theme, language, Yew in the interface and how the opening
 * leaves. Each applies as soon as it is chosen.
 */
export function PersonalDialog({ onClose }: { onClose: () => void }) {
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
