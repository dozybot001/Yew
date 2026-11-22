import { useId, useState } from "react";
import { saveSettings } from "../actions/settings.ts";
import { api } from "../api.ts";
import { t, useLang } from "../i18n.ts";
import { isImeEvent } from "../ime.ts";
import { getState, useAppState, type Workspace } from "../state.ts";
import { Dialog } from "./dialog.tsx";
import { FolderIcon, PlusIcon } from "./icons.tsx";
import { Select } from "./select.tsx";
import { Button, ErrorBox, Field, useAction } from "./ui.tsx";

/** The saved workspaces: folders sessions work in, each with a name. */
export function useWorkspaces(): Workspace[] {
	return useAppState((state) => state.settings?.workspaces) ?? [];
}

/** A home-relative path, so it stays short: /Users/me/Yew → ~/Yew. */
export function shortPath(path: string): string {
	return path.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, "~");
}

/** The workspace's name for a folder, or the short path when the folder is not saved as one. */
export function workspaceLabel(workspaces: Workspace[], path: string): string {
	return workspaces.find((workspace) => workspace.path === path)?.name ?? shortPath(path);
}

function lastSegment(path: string): string {
	return path.split("/").filter(Boolean).pop() ?? path;
}

/**
 * New workspace, after Claude's "new environment" dialog: a name, then the folder, chosen with the
 * system picker or typed. The same dialog serves the sidebar and every workspace choice.
 */
export function WorkspaceDialog({
	onClose,
	onCreated,
}: {
	onClose: () => void;
	onCreated?: (path: string) => void;
}) {
	useLang();
	const workspaces = useWorkspaces();
	const [name, setName] = useState("");
	const [path, setPath] = useState("");
	const nameId = useId();
	const pathId = useId();
	const pick = useAction(async () => {
		const result = await api<{ path: string | null }>("POST", "/api/folders/pick");
		if (!result.path) return;
		setPath(result.path);
		if (!name.trim()) setName(lastSegment(result.path));
	});
	const create = useAction(async () => {
		const id = crypto.randomUUID();
		const folder = path.trim();
		await saveSettings({
			workspaces: [...workspaces, { id, name: name.trim() || lastSegment(folder), path: folder }],
		});
		const saved = getState().settings?.workspaces.find((workspace) => workspace.id === id);
		onCreated?.(saved?.path ?? folder);
		onClose();
	});
	return (
		<Dialog
			title={t("newWorkspace")}
			size="s"
			onClose={onClose}
			footer={
				<>
					<Button onClick={onClose}>{t("cancel")}</Button>
					<Button
						variant="primary"
						busy={create.busy}
						disabled={!path.trim()}
						onClick={() => void create.run()}
					>
						<PlusIcon />
						{t("createWorkspace")}
					</Button>
				</>
			}
		>
			<Field label={t("name")} htmlFor={nameId}>
				<input
					id={nameId}
					className="input"
					value={name}
					maxLength={60}
					placeholder={t("workspaceNamePlaceholder")}
					autoFocus
					onChange={(event) => setName(event.target.value)}
				/>
			</Field>
			<div className="field">
				<div className="field-head">
					<label className="field-label" htmlFor={pathId}>
						{t("workspaceFolder")}
					</label>
					<Button busy={pick.busy} onClick={() => void pick.run()}>
						<PlusIcon />
						{t("chooseFolder")}
					</Button>
				</div>
				<div className="folder-box">
					<FolderIcon />
					<input
						id={pathId}
						value={path}
						placeholder={t("workspaceFolderHint")}
						spellCheck={false}
						onChange={(event) => setPath(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && !isImeEvent(event) && path.trim()) {
								event.preventDefault();
								void create.run();
							}
						}}
					/>
				</div>
			</div>
			<ErrorBox error={pick.error ?? create.error} />
		</Dialog>
	);
}

const NEW_WORKSPACE = "new";

/**
 * Where a session works: no workspace (a chat), one of the saved workspaces (code), or a new one made
 * on the spot. A folder that is in use but not saved still shows, by its path.
 */
export function WorkspacePicker({
	value,
	onChange,
	busy,
}: {
	value: string | null;
	onChange: (path: string | null) => void;
	busy?: boolean;
}) {
	useLang();
	const workspaces = useWorkspaces();
	const [creating, setCreating] = useState(false);
	const unsaved = value && !workspaces.some((workspace) => workspace.path === value) ? value : null;
	return (
		<>
			<Select
				label={t("workingFolder")}
				value={value ?? ""}
				busy={busy}
				options={[
					{ value: "", label: t("noFolder") },
					...workspaces.map((workspace) => ({
						value: workspace.path,
						label: workspace.name,
						group: t("workspaces"),
					})),
					...(unsaved
						? [{ value: unsaved, label: shortPath(unsaved), group: t("workspaces") }]
						: []),
					{ value: NEW_WORKSPACE, label: t("newWorkspaceItem") },
				]}
				onChange={(next) => {
					if (next === NEW_WORKSPACE) setCreating(true);
					else onChange(next || null);
				}}
			/>
			{creating && <WorkspaceDialog onClose={() => setCreating(false)} onCreated={onChange} />}
		</>
	);
}
