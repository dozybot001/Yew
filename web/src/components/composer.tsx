import { type DragEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { AttachmentRef } from "../../../src/shared/messages.ts";
import {
	defaultCompactAt,
	PERMISSION_MODES,
	type PermissionMode,
	permissionModeOf,
	type Session,
} from "../../../src/shared/types.ts";
import {
	compactSession,
	continueSession,
	editQueued,
	removePendingAttachment,
	renewSession,
	sendMessage,
	stopSession,
	uploadAttachment,
	withdrawQueued,
} from "../actions/messages.ts";
import { takePrefill, updateSession } from "../actions/sessions.ts";
import { formatCost, formatNumber, permissionHint, t, useLang } from "../i18n.ts";
import { useImeGuard } from "../ime.ts";
import { continueMarkdownList, indentMarkdownList, type TextEdit } from "../markdown-edit.ts";
import { type TranscriptState, useAppState } from "../state.ts";
import { useUnsent } from "../use-unsent.ts";
import {
	ATTACHMENT_ACCEPT,
	filesFromClipboard,
	guessAttachmentKind,
	MAX_STAGED_ATTACHMENTS,
	QueuedAttachments,
	type StagedAttachment,
	StagedAttachmentStrip,
} from "./attachments.tsx";
import { ComposerMenu, useComposerMenu } from "./composer-menu.tsx";
import { Dialog } from "./dialog.tsx";
import {
	ArrowUpIcon,
	AttachIcon,
	CheckIcon,
	CompactIcon,
	PlayIcon,
	RenameIcon,
	RenewIcon,
	StopIcon,
	TrashIcon,
} from "./icons.tsx";
import { ModelPicker, useModels } from "./model-picker.tsx";
import { Select } from "./select.tsx";
import { Button, describeError, ErrorBox, place, useAction } from "./ui.tsx";
import { WorkspacePicker } from "./workspaces.tsx";

/**
 * How close the context is to auto-compaction: a small clickable pie next to the send button, full at
 * the compaction threshold rather than at the model's context window, since that is where the
 * session's history gets compacted. Clicking opens a popover with exact token counts, what is left
 * before compaction, the model's context window and cumulative usage.
 */
function ContextPie({ session, total }: { session: Session; total: number }) {
	useLang();
	const [open, setOpen] = useState(false);
	const button = useRef<HTMLButtonElement>(null);
	const pop = useRef<HTMLDivElement>(null);
	const id = useId();

	const used = session.contextTokens;
	const threshold = session.options.compactAt ?? defaultCompactAt(total);
	const percent = threshold > 0 ? Math.min(100, Math.round((used / threshold) * 100)) : 0;
	const high = threshold > 0 && used >= threshold;
	const remaining = Math.max(0, threshold - used);
	const cumulative =
		session.usage.input + session.usage.output + session.usage.cacheRead + session.usage.cacheWrite;
	const label = t("contextPercent", {
		p: percent,
		used: formatNumber(used),
		limit: formatNumber(threshold),
	});
	const angle = ((percent / 100) * 360 - 90) * (Math.PI / 180);
	const x = 12 + 6 * Math.cos(angle);
	const y = 12 + 6 * Math.sin(angle);

	useLayoutEffect(() => {
		const element = pop.current;
		if (!element || !button.current) return;
		if (open) {
			element.showPopover?.();
			place(element, button.current, 304);
		} else if (element.matches(":popover-open")) {
			element.hidePopover?.();
		}
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const onKey = (event: globalThis.KeyboardEvent) => event.key === "Escape" && setOpen(false);
		const onDown = (event: MouseEvent) => {
			const target = event.target as Node;
			if (!pop.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("mousedown", onDown);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("mousedown", onDown);
		};
	}, [open]);

	return (
		<>
			<button
				ref={button}
				type="button"
				className={
					high ? "btn btn-ghost context-pie context-pie-high" : "btn btn-ghost context-pie"
				}
				aria-label={label}
				aria-expanded={open}
				aria-controls={open ? id : undefined}
				title={label}
				onClick={() => setOpen((value) => !value)}
			>
				<svg viewBox="0 0 24 24" width={16} height={16} aria-hidden="true">
					<circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeWidth="1.75" />
					{percent >= 100 ? (
						<circle cx="12" cy="12" r="6" fill="currentColor" />
					) : percent > 0 ? (
						<path
							d={`M12 12V6A6 6 0 ${percent > 50 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}Z`}
							fill="currentColor"
						/>
					) : null}
				</svg>
			</button>
			<div
				ref={pop}
				id={id}
				popover="manual"
				role="dialog"
				aria-label={t("contextDetailTitle")}
				className="context-popover"
			>
				<div className="context-popover-head">
					<strong>{t("contextDetailTitle")}</strong>
					<span className={high ? "context-popover-pct high" : "context-popover-pct"}>
						{percent}%
					</span>
				</div>
				<div className="context-meter" aria-hidden="true">
					<div
						className={high ? "context-meter-fill high" : "context-meter-fill"}
						style={{ width: `${percent}%` }}
					/>
				</div>
				<dl className="context-stats">
					<div>
						<dt>{t("contextDetailUsed")}</dt>
						<dd>{formatNumber(used)}</dd>
					</div>
					<div>
						<dt>{t("contextDetailThreshold")}</dt>
						<dd>{formatNumber(threshold)}</dd>
					</div>
					<div>
						<dt>{t("contextDetailRemaining")}</dt>
						<dd>{formatNumber(remaining)}</dd>
					</div>
					<div>
						<dt>{t("contextDetailWindow")}</dt>
						<dd>{formatNumber(total)}</dd>
					</div>
					{cumulative > 0 && (
						<div>
							<dt>{t("contextDetailSessionTotal")}</dt>
							<dd>
								{formatNumber(cumulative)} · {formatCost(session.usage.cost)}
							</dd>
						</div>
					)}
					{session.usage.cacheRead > 0 && (
						<div>
							<dt>{t("contextDetailCacheRead")}</dt>
							<dd>{formatNumber(session.usage.cacheRead)}</dd>
						</div>
					)}
				</dl>
				<p className="hint context-popover-note">{t("contextDetailNote")}</p>
			</div>
		</>
	);
}

/** Grows with its content; `field-sizing: content` where supported, a height update otherwise. */
export function useAutoGrow(value: string) {
	const ref = useRef<HTMLTextAreaElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the height is measured again whenever the text changes
	useEffect(() => {
		const element = ref.current;
		if (!element || CSS.supports("field-sizing", "content")) return;
		element.style.height = "auto";
		element.style.height = `${element.scrollHeight + 2}px`;
	}, [value]);
	return ref;
}

function QueuedItem({
	sessionId,
	id,
	text,
	attachments,
}: {
	sessionId: string;
	id: string;
	text: string;
	attachments?: AttachmentRef[];
}) {
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState(text);
	const save = useAction(async () => {
		await editQueued(sessionId, id, value);
		setEditing(false);
	});
	const withdraw = useAction(() => withdrawQueued(sessionId, id));
	const ref = useAutoGrow(value);
	return (
		<div className="queued-item">
			<div className="queued-body">
				{editing ? (
					<textarea
						ref={ref}
						className="textarea"
						value={value}
						aria-label={t("edit")}
						onChange={(e) => setValue(e.target.value)}
					/>
				) : text ? (
					<span>{text}</span>
				) : null}
				{attachments && attachments.length > 0 && <QueuedAttachments attachments={attachments} />}
			</div>
			{editing ? (
				<Button busy={save.busy} onClick={() => void save.run()}>
					<CheckIcon />
					{t("save")}
				</Button>
			) : (
				<Button onClick={() => setEditing(true)}>
					<RenameIcon /> {t("edit")}
				</Button>
			)}
			<Button busy={withdraw.busy} onClick={() => void withdraw.run()}>
				<TrashIcon />
				{t("remove")}
			</Button>
			<ErrorBox error={save.error ?? withdraw.error} />
		</div>
	);
}

/** The box at the bottom: your message, the model choice and a round send or stop button. */
export function Composer({
	session,
	transcript,
}: {
	session: Session;
	transcript: TranscriptState;
}) {
	useLang();
	const sandboxed = useAppState((state) => (state.health?.sandbox ?? "none") !== "none");
	// What is typed and not sent is kept, and is here again when the session is opened the next time.
	const [text, setText] = useUnsent(session.id);
	const ime = useImeGuard();
	const [staged, setStaged] = useState<StagedAttachment[]>([]);
	const [dragging, setDragging] = useState(false);
	const fileInput = useRef<HTMLInputElement>(null);
	const stagedRef = useRef<StagedAttachment[]>([]);
	stagedRef.current = staged;

	// Clear staged attachments and object URLs when switching sessions or unmounting.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset staged attachments per session id
	useEffect(() => {
		setStaged((current) => {
			for (const item of current) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
			return [];
		});
		return () => {
			for (const item of stagedRef.current) {
				if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
			}
		};
	}, [session.id]);

	// A message taken back or forked from comes back here to be changed and sent again.
	const waiting = useAppState((state) => state.prefill[session.id]);
	useEffect(() => {
		if (waiting === undefined) return;
		const value = takePrefill(session.id);
		if (value !== null) setText(value);
	}, [waiting, session.id, setText]);
	const ref = useAutoGrow(text);
	const working = session.status === "working" || session.status === "waiting";
	const change = useAction((patch: Parameters<typeof updateSession>[1]) =>
		updateSession(session.id, patch),
	);

	const addFiles = (list: FileList | File[]) => {
		const files = Array.from(list);
		if (files.length === 0) return;
		const room = Math.max(0, MAX_STAGED_ATTACHMENTS - stagedRef.current.length);
		const picked = files.slice(0, room);
		const targetSession = session.id;
		for (const file of picked) {
			const key = crypto.randomUUID();
			const kind = guessAttachmentKind(file);
			const previewUrl = kind === "image" ? URL.createObjectURL(file) : undefined;
			const entry: StagedAttachment = {
				key,
				name: file.name || "attachment",
				kind,
				size: file.size,
				...(previewUrl ? { previewUrl } : {}),
				uploading: true,
			};
			setStaged((current) => [...current, entry]);
			void uploadAttachment(targetSession, file)
				.then((uploaded) => {
					setStaged((current) =>
						current.map((item) =>
							item.key === key
								? {
										...item,
										name: uploaded.name,
										kind: uploaded.kind,
										size: uploaded.size,
										pages: uploaded.pages ?? null,
										ref: uploaded,
										uploading: false,
									}
								: item,
						),
					);
				})
				.catch((error: unknown) => {
					setStaged((current) =>
						current.map((item) =>
							item.key === key ? { ...item, uploading: false, error: describeError(error) } : item,
						),
					);
				});
		}
	};

	const removeStaged = (key: string) => {
		const found = stagedRef.current.find((item) => item.key === key);
		if (found?.previewUrl) URL.revokeObjectURL(found.previewUrl);
		if (found?.ref) void removePendingAttachment(session.id, found.ref.id).catch(() => {});
		setStaged((current) => current.filter((item) => item.key !== key));
	};

	const uploading = staged.some((item) => item.uploading);
	const readyRefs = staged
		.filter((item) => item.ref && !item.uploading && !item.error)
		.map((item) => item.ref as AttachmentRef);
	const canSend = !uploading && (Boolean(text.trim()) || readyRefs.length > 0);

	const send = useAction(async () => {
		if (!canSend) return;
		const value = text;
		const ids = readyRefs.map((item) => item.id);
		await sendMessage(session.id, value, ids);
		for (const item of stagedRef.current) {
			if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
		}
		setStaged([]);
		setText("");
	});
	const stop = useAction(() => stopSession(session.id));
	const cont = useAction(() => continueSession(session.id));
	const compact = useAction(() => compactSession(session.id));
	const [renewOpen, setRenewOpen] = useState(false);
	const renew = useAction(async (summarize: boolean) => {
		await renewSession(session.id, summarize);
		setRenewOpen(false);
	});
	const [caret, setCaret] = useState(0);
	const hasFolders = Boolean(session.cwd) || (session.options.extraDirs?.length ?? 0) > 0;
	const menu = useComposerMenu({
		sessionId: session.id,
		hasFolders,
		working,
		hasContext: session.contextTokens > 0,
		text,
		caret,
		setText,
		setCaret,
		textareaRef: ref,
		onCommand: (command) => {
			if (command === "compact") void compact.run();
			else if (command === "renew") setRenewOpen(true);
		},
	});
	const models = useModels(session.provider);
	const info = models.find((m) => m.id === session.model);
	const hasStagedImage = staged.some((item) => item.kind === "image" && !item.error);
	const visionWarning = hasStagedImage && Boolean(info && !info.input.includes("image"));

	// A workspace makes it a code session, none makes it a chat; the switch applies from the next turn.
	const switchFolder = useAction(async (cwd: string | null) => {
		await updateSession(session.id, { cwd });
	});
	const applyEdit = (edit: TextEdit) => {
		setText(edit.value);
		setCaret(edit.caret);
		requestAnimationFrame(() => {
			ref.current?.setSelectionRange(edit.caret, edit.caret);
		});
	};
	const sendLabel = working ? t("queueSend") : t("send");

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
		<div className="composer">
			<div className="composer-inner">
				{transcript.queue.length > 0 && (
					<section className="queued" aria-label={t("queuedTitle")}>
						{transcript.queue.map((item) => (
							<QueuedItem
								key={item.id}
								sessionId={session.id}
								id={item.id}
								text={item.text}
								{...(item.attachments ? { attachments: item.attachments } : {})}
							/>
						))}
					</section>
				)}
				{/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone wraps the composer input */}
				<div
					className={dragging ? "composer-box composer-box-dragging" : "composer-box"}
					onDragOver={onDragOver}
					onDragLeave={onDragLeave}
					onDrop={onDrop}
				>
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
						rows={1}
						value={text}
						placeholder={
							dragging
								? t("attachHintDrop")
								: working
									? t("composerQueued")
									: t("composerPlaceholder", { name: session.name })
						}
						aria-label={t("composerPlaceholder", { name: session.name })}
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
								void send.run();
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
							<WorkspacePicker
								value={session.cwd}
								busy={switchFolder.busy}
								onChange={(cwd) => void switchFolder.run(cwd)}
							/>
							<ModelPicker
								provider={session.provider}
								model={session.model}
								thinking={session.thinking}
								busy={change.busy}
								onChange={(patch) => void change.run(patch)}
							/>
							<Select
								label={t("permissionMode")}
								value={permissionModeOf(session.options)}
								options={PERMISSION_MODES.map((mode) => ({
									value: mode,
									label: t(`perm_${mode}`),
									hint: permissionHint(mode, sandboxed),
								}))}
								busy={change.busy}
								onChange={(value) =>
									void change.run({ options: { permissionMode: value as PermissionMode } })
								}
							/>
						</div>
						<div className="composer-actions">
							{!working && session.contextTokens > 0 && (
								<>
									<Button
										variant="icon"
										aria-label={t("compact")}
										title={t("compact")}
										busy={compact.busy}
										onClick={() => void compact.run()}
									>
										<CompactIcon />
									</Button>
									<Button
										variant="icon"
										aria-label={t("renewButton")}
										title={t("renewButton")}
										busy={renew.busy}
										onClick={() => setRenewOpen(true)}
									>
										<RenewIcon />
									</Button>
								</>
							)}
							{!working && (
								<Button
									variant="icon"
									aria-label={t("continue")}
									title={t("continueHint")}
									busy={cont.busy}
									onClick={() => void cont.run()}
								>
									<PlayIcon />
								</Button>
							)}
							{info && <ContextPie session={session} total={info.contextWindow} />}
							{working && !canSend ? (
								<Button
									className="send-button"
									aria-label={t("stop")}
									title={t("stop")}
									busy={stop.busy}
									onClick={() => void stop.run()}
								>
									<StopIcon />
								</Button>
							) : (
								<Button
									className="send-button"
									aria-label={sendLabel}
									title={sendLabel}
									busy={send.busy}
									disabled={!canSend}
									onClick={() => void send.run()}
								>
									<ArrowUpIcon />
								</Button>
							)}
						</div>
					</div>
				</div>
				{renewOpen && (
					<Dialog
						title={t("renewTitle")}
						size="s"
						onClose={() => !renew.busy && setRenewOpen(false)}
						footer={
							<>
								<Button disabled={renew.busy} onClick={() => setRenewOpen(false)}>
									{t("cancel")}
								</Button>
								<Button disabled={renew.busy} onClick={() => void renew.run(false)}>
									{t("renewClean")}
								</Button>
								<Button variant="primary" busy={renew.busy} onClick={() => void renew.run(true)}>
									{t("renewWithSummary")}
								</Button>
							</>
						}
					>
						<p>{t("renewHint")}</p>
						<ErrorBox error={renew.error} />
					</Dialog>
				)}
				<ErrorBox
					error={
						send.error ??
						stop.error ??
						change.error ??
						cont.error ??
						compact.error ??
						renew.error ??
						switchFolder.error
					}
				/>
			</div>
		</div>
	);
}
