import { useEffect, useId } from "react";
import type { ThinkingLevel } from "../../../src/shared/types.ts";
import { loadModels } from "../actions/settings.ts";
import { t, useLang } from "../i18n.ts";
import { type ModelInfo, useAppState } from "../state.ts";
import { Menu, type MenuEntry, type MenuItem } from "./menu.tsx";
import { Select } from "./select.tsx";

export function useModels(provider: string): ModelInfo[] {
	const models = useAppState((state) => state.models[provider]);
	useEffect(() => {
		if (!models) void loadModels(provider).catch(() => {});
	}, [provider, models]);
	return models ?? [];
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
	const providerOptions = providers.map((p) => ({
		value: p.id,
		label: p.hasKey || !p.keyRequired ? p.name : `${p.name} · ${t("noKey")}`,
		group: t(`region_${p.region}`),
	}));
	providerOptions.sort((a, b) => (a.group === b.group ? 0 : a.group === t("region_cn") ? -1 : 1));
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
