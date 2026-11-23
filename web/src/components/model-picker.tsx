import { useEffect, useId } from "react";
import type { ThinkingLevel } from "../../../src/shared/types.ts";
import { loadModels } from "../actions/settings.ts";
import { t, useLang } from "../i18n.ts";
import { type ModelInfo, type ProviderSummary, useAppState } from "../state.ts";
import { Menu, type MenuEntry, type MenuItem } from "./menu.tsx";
import { type Option, Select } from "./select.tsx";

/** The provider's models; none for an empty provider. */
export function useModels(provider: string): ModelInfo[] {
	const models = useAppState((state) => state.models[provider]);
	useEffect(() => {
		if (provider && !models) void loadModels(provider).catch(() => {});
	}, [provider, models]);
	return models ?? [];
}

const REGION_ORDER = ["cn", "custom", "global"];

/** Providers as choices, grouped by region; one without a key says so. */
function providerChoices(providers: ProviderSummary[]): Option[] {
	return [...providers]
		.sort((a, b) => REGION_ORDER.indexOf(a.region) - REGION_ORDER.indexOf(b.region))
		.map((p) => ({
			value: p.id,
			label: p.hasKey || !p.keyRequired ? p.name : `${p.name} · ${t("noKey")}`,
			group: t(`region_${p.region}`),
		}));
}

const LEVEL_ORDER: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The level a request will actually use: the chosen one, else the next higher, else the next lower (as the server does). */
export function effectiveLevel(levels: ThinkingLevel[], wanted: ThinkingLevel): ThinkingLevel {
	if (levels.includes(wanted)) return wanted;
	const at = LEVEL_ORDER.indexOf(wanted);
	for (const level of LEVEL_ORDER.slice(at + 1)) if (levels.includes(level)) return level;
	for (const level of LEVEL_ORDER.slice(0, at).reverse()) if (levels.includes(level)) return level;
	return levels[0] ?? "off";
}

export function ModelPicker({
	provider,
	model,
	thinking,
	onChange,
	busy,
	layout = "row",
}: {
	provider: string;
	model: string;
	thinking: ThinkingLevel;
	onChange: (patch: { provider?: string; model?: string; thinking?: ThinkingLevel }) => void;
	busy?: boolean;
	/** "grid" shows a visible label over each choice, for forms; "row" is the compact header form. */
	layout?: "row" | "grid";
}) {
	useLang();
	const providers = useAppState((state) => state.providers);
	const models = useModels(provider);
	const info = models.find((m) => m.id === model);
	const ids = { provider: useId(), model: useId() };
	const providerOptions = providerChoices(providers);
	const grid = layout === "grid";
	const activeLevel = info?.reasoning ? effectiveLevel(info.thinkingLevels, thinking) : null;
	const triggerLabel = info
		? activeLevel
			? `${info.name} · ${t(`thinking_${activeLevel}`)}`
			: info.name
		: model;
	const toModelEntry = (item: ModelInfo): MenuItem => {
		const selected = item.id === model;
		if (item.reasoning && item.thinkingLevels.length > 0) {
			const current = effectiveLevel(item.thinkingLevels, thinking);
			return {
				id: item.id,
				label: item.name,
				checked: selected,
				detail: selected ? t(`thinking_${current}`) : undefined,
				onSelect: () => onChange({ model: item.id }),
				items: item.thinkingLevels.map((level) => ({
					id: `${item.id}:${level}`,
					label: t(`thinking_${level}`),
					checked: selected && current === level,
					onSelect: () => onChange({ model: item.id, thinking: level }),
				})),
			};
		}
		return {
			id: item.id,
			label: item.name,
			checked: selected,
			onSelect: () => onChange({ model: item.id }),
		};
	};
	const latestModels = models.filter((m) => m.latest);
	const otherModels = models.filter((m) => !m.latest);
	const modelEntries: MenuEntry[] =
		latestModels.length > 0 && otherModels.length > 0
			? [
					...latestModels.map(toModelEntry),
					{ separator: true, id: "sep-models" },
					...otherModels.map(toModelEntry),
				]
			: models.map(toModelEntry);
	const choose = {
		provider: (
			<Select
				{...(grid ? { labelledBy: ids.provider } : { label: t("provider") })}
				value={provider}
				options={providerOptions}
				busy={busy}
				onChange={async (value) => {
					const list = await loadModels(value);
					const first = list[0];
					if (first) onChange({ provider: value, model: first.id });
				}}
			/>
		),
		model: (
			<Menu
				label={t("model")}
				width={260}
				items={modelEntries}
				trigger={{
					className: "btn select-trigger model-trigger",
					content: <span>{triggerLabel}</span>,
					title: triggerLabel,
					busy,
					labelledBy: grid ? ids.model : undefined,
				}}
			/>
		),
	};
	if (!grid) {
		return (
			<div className="model-picker">
				{choose.provider}
				{choose.model}
			</div>
		);
	}
	return (
		<div className="model-grid">
			<div className="field">
				<span className="field-label" id={ids.provider}>
					{t("provider")}
				</span>
				{choose.provider}
			</div>
			<div className="field">
				<span className="field-label" id={ids.model}>
					{t("model")}
				</span>
				{choose.model}
			</div>
		</div>
	);
}

export interface SideModelChoice {
	provider: string;
	model: string;
}

/**
 * The model for the jobs beside every conversation: each session's own model, or one model at a
 * provider that can be used. These requests are sent without thinking, so no level is chosen.
 */
export function SideModelPicker({
	value,
	onChange,
	busy,
	none,
}: {
	value: SideModelChoice | null;
	onChange: (value: SideModelChoice | null) => void;
	busy?: boolean;
	/** What choosing no model is called; the side jobs' "same as the session" when left out. */
	none?: string;
}) {
	useLang();
	const providers = useAppState((state) => state.providers);
	const models = useModels(value?.provider ?? "");
	const ids = { provider: useId(), model: useId() };
	// A provider without a key is not offered; the chosen one stays in the list when its key is gone.
	const usable = providers.filter((p) => p.hasKey || !p.keyRequired || p.id === value?.provider);
	return (
		<div className="model-grid">
			<div className="field">
				<span className="field-label" id={ids.provider}>
					{t("provider")}
				</span>
				<Select
					labelledBy={ids.provider}
					value={value?.provider ?? ""}
					options={[{ value: "", label: none ?? t("sideModelFollow") }, ...providerChoices(usable)]}
					busy={busy}
					onChange={async (provider) => {
						if (!provider) return onChange(null);
						const list = await loadModels(provider);
						const first = list.find((item) => item.small) ?? list[0];
						if (first) onChange({ provider, model: first.id });
					}}
				/>
			</div>
			{value && (
				<div className="field">
					<span className="field-label" id={ids.model}>
						{t("model")}
					</span>
					<Select
						labelledBy={ids.model}
						value={value.model}
						options={models.map((item) => ({ value: item.id, label: item.name }))}
						busy={busy}
						onChange={(model) => onChange({ provider: value.provider, model })}
					/>
				</div>
			)}
		</div>
	);
}
