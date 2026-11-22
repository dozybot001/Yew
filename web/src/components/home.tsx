import { type DragEvent, type ReactNode, useEffect, useRef, useState } from "react";
import type { ThinkingLevel } from "../../../src/shared/types.ts";
import { freeName, startSession } from "../actions/sessions.ts";
import { t, useLang } from "../i18n.ts";
import { useImeGuard } from "../ime.ts";
import { continueMarkdownList, indentMarkdownList, type TextEdit } from "../markdown-edit.ts";
import { setState, useAppState } from "../state.ts";
import {
	ATTACHMENT_ACCEPT,
	filesFromClipboard,
	guessAttachmentKind,
	MAX_STAGED_ATTACHMENTS,
	type StagedAttachment,
	StagedAttachmentStrip,
} from "./attachments.tsx";
import { useAutoGrow } from "./composer.tsx";
import { ComposerMenu, useComposerMenu } from "./composer-menu.tsx";
import { NewSessionDialog } from "./dialogs.tsx";
import { ArrowUpIcon, AttachIcon, ChatIcon, CodeIcon, NotesIcon, SlidersIcon } from "./icons.tsx";
import { Mascot } from "./mascot.tsx";
import { ModelPicker, useModels } from "./model-picker.tsx";
import { SidebarToggle } from "./sidebar-toggle.tsx";
import { Button, ErrorBox, useAction } from "./ui.tsx";
import { WorkspacePicker } from "./workspaces.tsx";

type TemplateKey = "code" | "docs" | "chat";

const TEMPLATES: { key: TemplateKey; icon: ReactNode }[] = [
	{ key: "code", icon: <CodeIcon /> },
	{ key: "docs", icon: <NotesIcon /> },
	{ key: "chat", icon: <ChatIcon /> },
];

/** A short session name from the first line of the first message; names may not hold @ or control characters. */
function nameFrom(text: string): string {
	const line = (text.trim().split("\n")[0] ?? "").replace(/[@\p{Cc}]/gu, "").trim();
	const chars = [...line];
	return chars.length > 24 ? `${chars.slice(0, 24).join("")}…` : line;
}

/**
 * No session open: one composer in the middle of the page. You pick a folder
 * and a model in its bar and start by sending; the three templates under it add a role.
 */
export function HomeView() {
	useLang();
	const settings = useAppState((state) => state.settings);
	const homeFolder = useAppState((state) => state.homeFolder);
	const [text, setText] = useState("");
	const ime = useImeGuard();
	// The default workspace from the settings is chosen to start with; the bar changes it.
	const [folder, setFolder] = useState<string | null>(
		() =>
			settings?.workspaces.find((workspace) => workspace.id === settings.defaultWorkspaceId)
				?.path ?? null,
	);
	const [template, setTemplate] = useState<TemplateKey | null>(null);
	const [model, setModel] = useState(
		() =>
			settings?.defaultModel ?? {
				provider: "deepseek",
				model: "deepseek-v4-pro",
				thinking: "medium" as ThinkingLevel,
			},
	);
	const [dialog, setDialog] = useState(false);
	const [staged, setStaged] = useState<StagedAttachment[]>([]);
	const [dragging, setDragging] = useState(false);
	const fileInput = useRef<HTMLInputElement>(null);
	const stagedRef = useRef<StagedAttachment[]>([]);
	stagedRef.current = staged;
	useEffect(() => {
		return () => {
			for (const item of stagedRef.current) {
				if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
			}
		};
	}, []);
	const ref = useAutoGrow(text);
	const [caret, setCaret] = useState(0);
	const menu = useComposerMenu({
		sessionId: null,
		hasFolders: false,
		working: false,
		hasContext: false,
		text,
		caret,
		setText,
		setCaret,
		textareaRef: ref,
	});
	useEffect(() => {
		ref.current?.focus();
	}, [ref]);
	// Opening a workspace from the sidebar lands here with that workspace chosen.
	useEffect(() => {
		if (!homeFolder) return;
		setFolder(homeFolder);
		setState({ homeFolder: null });
		ref.current?.focus();
	}, [homeFolder, ref]);
	const addFiles = (list: FileList | File[]) => {
		const files = Array.from(list);
		if (files.length === 0) return;
		const room = Math.max(0, MAX_STAGED_ATTACHMENTS - stagedRef.current.length);
		const next: StagedAttachment[] = files.slice(0, room).map((file) => {
			const kind = guessAttachmentKind(file);
			const previewUrl = kind === "image" ? URL.createObjectURL(file) : undefined;
			return {
				key: crypto.randomUUID(),
				name: file.name || "attachment",
				kind,
				size: file.size,
				file,
				...(previewUrl ? { previewUrl } : {}),
			};
		});
		if (next.length > 0) setStaged((current) => [...current, ...next]);
	};
	const removeStaged = (key: string) => {
		const found = stagedRef.current.find((item) => item.key === key);
		if (found?.previewUrl) URL.revokeObjectURL(found.previewUrl);
		setStaged((current) => current.filter((item) => item.key !== key));
	};
	const models = useModels(model.provider);
	const modelInfo = models.find((m) => m.id === model.model);
	const hasStagedImage = staged.some((item) => item.kind === "image");
	const visionWarning = hasStagedImage && Boolean(modelInfo && !modelInfo.input.includes("image"));
	const role = template === "code" || template === "docs" ? template : null;
	const missingFolder = role !== null && !folder;
	const hasInput = Boolean(text.trim()) || staged.length > 0;
	const start = useAction(async () => {
		const value = text.trim();
		const files = stagedRef.current.map((item) => item.file).filter((f): f is File => Boolean(f));
		if ((!value && files.length === 0) || missingFolder) return;
		const seed = value || files[0]?.name || "";
		await startSession(
			{
				name: freeName(nameFrom(seed) || t("template_chat")),
				kind: "task",
				groupId: null,
				cwd: folder,
				responsibility: role ? t(`template_${role}_role`) : "",
				...model,
				autoName: true,
			},
			value,
			files,
		);
	});
	const pickTemplate = (key: TemplateKey) => {
		const next = template === key ? null : key;
		setTemplate(next);
		if (next === "chat") setFolder(null);
		ref.current?.focus();
	};
	const applyEdit = (edit: TextEdit) => {
		setText(edit.value);
		setCaret(edit.caret);
		requestAnimationFrame(() => {
			ref.current?.setSelectionRange(edit.caret, edit.caret);
		});
	};
	const onDragOver = (event: DragEvent) => {
		if (!event.dataTransfer.types.includes("Files")) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
		if (!dragging) setDragging(true);
	};
	const onDragLeave = (event: DragEvent) => {
		if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
		setDragging(false);
	};
	const onDrop = (event: DragEvent) => {
		event.preventDefault();
		setDragging(false);
		if (event.dataTransfer.files.length > 0) addFiles(event.dataTransfer.files);
	};
	return (
		<main className="main main-home">
			<SidebarToggle className="home-menu" />
			<div className="home">
				<div className="home-intro">
					<Mascot pose="greeting" height={104} className="home-mascot" />
					<h1>{t("homeTitle")}</h1>
				</div>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone wraps the home composer input */}
				<div
					className={dragging ? "composer-box composer-box-dragging" : "composer-box"}
					onDragOver={onDragOver}
					onDragLeave={onDragLeave}
					onDrop={onDrop}
				>
					<Mascot pose="peek" height={80} className="composer-peek" />
					<ComposerMenu menu={menu} />
					<input
						ref={fileInput}
						type="file"
						multiple
						accept={ATTACHMENT_ACCEPT}
						className="visually-hidden"
						aria-label={t("attachFile")}
						onChange={(event) => {
							if (event.target.files) addFiles(event.target.files);
							event.target.value = "";
						}}
					/>
					<StagedAttachmentStrip items={staged} onRemove={removeStaged} />
					{visionWarning && (
						<p className="hint composer-vision-hint" role="status">
							{t("attachNoVision")}
						</p>
					)}
					<textarea
						ref={ref}
						rows={2}
						value={text}
						placeholder={dragging ? t("attachHintDrop") : t("homePlaceholder")}
						aria-label={t("homeTitle")}
						aria-controls={menu.open ? menu.listId : undefined}
						onCompositionStart={ime.onCompositionStart}
						onCompositionEnd={ime.onCompositionEnd}
						onChange={(event) => {
							setText(event.target.value);
							setCaret(event.target.selectionStart ?? event.target.value.length);
						}}
						onSelect={(event) =>
							setCaret(event.currentTarget.selectionStart ?? event.currentTarget.value.length)
						}
						onPaste={(event) => {
							const files = filesFromClipboard(event);
							if (files.length === 0) return;
							if (!event.clipboardData.getData("text/plain")) event.preventDefault();
							addFiles(files);
						}}
						onKeyDown={(event) => {
							if (ime.isComposing(event)) return;
							if (menu.onKeyDown(event)) return;
							if (event.key === "Enter" && event.shiftKey) {
								const el = event.currentTarget;
								const edit = continueMarkdownList(
									text,
									el.selectionStart ?? text.length,
									el.selectionEnd ?? text.length,
								);
								if (edit) {
									event.preventDefault();
									applyEdit(edit);
								}
								return;
							}
							if (event.key === "Tab") {
								const el = event.currentTarget;
								const edit = indentMarkdownList(
									text,
									el.selectionStart ?? text.length,
									el.selectionEnd ?? text.length,
									event.shiftKey,
								);
								if (edit) {
									event.preventDefault();
									applyEdit(edit);
								}
								return;
							}
							if (event.key === "Enter" && !event.shiftKey) {
								event.preventDefault();
								void start.run();
							}
						}}
					/>
					<div className="composer-bar">
						<div className="composer-chips">
							<Button
								variant="icon"
								aria-label={t("attachFile")}
								title={t("attachFile")}
								disabled={staged.length >= MAX_STAGED_ATTACHMENTS}
								onClick={() => fileInput.current?.click()}
							>
								<AttachIcon />
							</Button>
							<WorkspacePicker value={folder} onChange={setFolder} />
							<ModelPicker {...model} onChange={(patch) => setModel((m) => ({ ...m, ...patch }))} />
						</div>
						<div className="composer-actions">
							<Button
								className="send-button"
								aria-label={t("send")}
								title={t("send")}
								busy={start.busy}
								disabled={!hasInput || missingFolder}
								onClick={() => void start.run()}
							>
								<ArrowUpIcon />
							</Button>
						</div>
					</div>
				</div>
				{missingFolder && (
					<p className="hint" role="status">
						{t("folderRequired")}
					</p>
				)}
				<ErrorBox error={start.error} />
				<div className="suggestions">
					{TEMPLATES.map(({ key, icon }) => (
						<Button
							key={key}
							className="suggestion"
							aria-pressed={template === key}
							onClick={() => pickTemplate(key)}
						>
							{icon}
							{t(`template_${key}`)}
						</Button>
					))}
				</div>
				<Button variant="ghost" className="home-more" onClick={() => setDialog(true)}>
					<SlidersIcon />
					{t("moreOptions")}
				</Button>
				{dialog && <NewSessionDialog onClose={() => setDialog(false)} />}
			</div>
		</main>
	);
}
