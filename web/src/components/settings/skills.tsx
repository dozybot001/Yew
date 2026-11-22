import { useCallback, useEffect, useId, useState } from "react";
import { loadSkills, patchSkill, revealSkill } from "../../actions/settings.ts";
import { t, useLang } from "../../i18n.ts";
import type { SkillList, SkillView } from "../../state.ts";
import { FolderIcon } from "../icons.tsx";
import { Button, Dialog, ErrorBox, SettingGroup, Switch, useAction } from "../ui.tsx";

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
export function SkillsDialog({ onClose }: { onClose: () => void }) {
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
