import {
	type DragEvent,
	type ReactNode,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { AttachmentRef } from "../../../src/shared/messages.ts";
import {
	defaultCompactAt,
	PERMISSION_MODES,
	type PermissionMode,
	permissionModeOf,
	type Session,
	type ThinkingLevel,
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
import { freeName, startSession, takePrefill, updateSession } from "../actions/sessions.ts";
import { loadModels } from "../actions/settings.ts";
import { selectSession } from "../actions.ts";
import { formatCost, formatNumber, permissionHint, t, useLang } from "../i18n.ts";
import { useImeGuard } from "../ime.ts";
import { continueMarkdownList, indentMarkdownList, type TextEdit } from "../markdown-edit.ts";
import {
	type ModelInfo,
	setState,
	setTranscriptDetail,
	type TranscriptState,
	useAppState,
} from "../state.ts";
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
import { Capped } from "./content.tsx";
import { NewSessionDialog } from "./dialogs.tsx";
import {
	ArrowUpIcon,
	AttachIcon,
	ChatIcon,
	CheckIcon,
	ChevronIcon,
	CodeIcon,
	CompactIcon,
	CompactViewIcon,
	DetailedViewIcon,
	MenuIcon,
	NotesIcon,
	PlayIcon,
	RenameIcon,
	RenewIcon,
	SlidersIcon,
	StopIcon,
	TodoActiveIcon,
	TodoDoneIcon,
	TodoIcon,
	TodoPendingIcon,
	TrashIcon,
} from "./icons.tsx";
import { Mascot } from "./mascot.tsx";
import { SessionClock, useSessionClock } from "./progress.tsx";
import { Transcript } from "./transcript.tsx";
import {
	Button,
	Dialog,
	describeError,
	ErrorBox,
	Menu,
	type MenuEntry,
	type MenuItem,
	place,
	Select,
	useAction,
} from "./ui.tsx";
import { useWorkspaces, WorkspacePicker, workspaceLabel } from "./workspaces.tsx";

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

/** On narrow screens the sidebar is a drawer; this opens it. */
export function SidebarToggle({ className = "" }: { className?: string }) {
	useLang();
	return (
		<Button
			variant="icon"
			className={`only-narrow ${className}`.trim()}
			aria-label={t("openSidebar")}
			onClick={() => setState({ drawerOpen: true })}
		>
			<MenuIcon />
		</Button>
	);
}

/**
 * The header names the session; its actions live in the composer and in the sidebar's row menu. While
 * the session works or waits for the person, the time it has taken sits in the middle.
 */
function SessionHeader({
	session,
	transcript,
}: {
	session: Session;
	transcript: TranscriptState | null;
}) {
	useLang();
	const workspaces = useWorkspaces();
	const isMain = useAppState((state) => state.settings?.mainSessionId === session.id);
	const parentId = session.parentId;
	const parent = useAppState((state) =>
		parentId ? (state.sessions[parentId]?.name ?? null) : null,
	);
	const detailed = useAppState((state) => state.transcriptDetail);
	const tokens =
		session.usage.input + session.usage.output + session.usage.cacheRead + session.usage.cacheWrite;
	const clock = useSessionClock(session, transcript);
	return (
		<header className={`session-header${clock.text ? " session-header-clock" : ""}`}>
			<SidebarToggle />
			{/* The title takes the left; marks, status and usage sit on the right and give way first. */}
			<div className="session-title">
				<h1>{session.name}</h1>
			</div>
			<SessionClock clock={clock} />
			<div className="session-aside">
				{isMain && <span className="tag">{t("mainConversation")}</span>}
				{session.outcome && <span className="tag">{t(`outcome_${session.outcome}`)}</span>}
				{parentId && parent && (
					<button
						type="button"
						className="link-button session-parent"
						onClick={() => void selectSession(parentId)}
					>
						{t("openedBy", { name: parent })}
					</button>
				)}
				<span className="session-meta" title={session.cwd ?? undefined}>
					{t(`status_${session.status}`)} ·{" "}
					{session.cwd ? workspaceLabel(workspaces, session.cwd) : t("chat")} ·{" "}
					{t("tokens", { n: formatNumber(tokens) })} ·{" "}
					{t("cost", { n: formatCost(session.usage.cost) })}
				</span>
				<Button
					variant="icon"
					className={`view-mode-toggle${detailed ? " view-mode-detailed" : ""}`}
					aria-pressed={detailed}
					aria-label={t(detailed ? "transcriptViewDetailed" : "transcriptViewCompact")}
					title={t(detailed ? "transcriptViewDetailed" : "transcriptViewCompact")}
					onClick={() => setTranscriptDetail(!detailed)}
				>
					{detailed ? <DetailedViewIcon /> : <CompactViewIcon />}
				</Button>
			</div>
		</header>
	);
}

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
function useAutoGrow(value: string) {
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
function Composer({ session, transcript }: { session: Session; transcript: TranscriptState }) {
	useLang();
	const sandboxed = useAppState((state) => (state.health?.sandbox ?? "none") !== "none");
	const [text, setText] = useState("");
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
	}, [waiting, session.id]);
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

const TODO_MARKS = {
	pending: <TodoPendingIcon />,
	in_progress: <TodoActiveIcon />,
	done: <TodoDoneIcon />,
} as const;

/**
 * The session's task list as a card floating at the transcript's top right, so it never narrows the
 * conversation. Folded, it shows the progress and the task under way; opened, every task.
 */
function TodoCard({ session }: { session: Session }) {
	useLang();
	const [open, setOpen] = useState(false);
	const listId = useId();
	const todos = session.todos;
	if (todos.length === 0) return null;
	const done = todos.filter((todo) => todo.status === "done").length;
	const current = todos.find((todo) => todo.status === "in_progress");
	return (
		<aside className={open ? "todo-card open" : "todo-card"} aria-label={t("todoTitle")}>
			<button
				type="button"
				className="todo-toggle"
				aria-expanded={open}
				aria-controls={listId}
				onClick={() => setOpen(!open)}
			>
				<TodoIcon />
				<span className="todo-count">{t("todoProgress", { done, total: todos.length })}</span>
				{current && <span className="todo-current">{current.text}</span>}
				<ChevronIcon />
			</button>
			<Capped as="ol" id={listId} className="todo-list" hidden={!open} label={t("todoTitle")}>
				{todos
					.map((todo, position) => ({ ...todo, key: `todo-${position}` }))
					.map((todo) => (
						<li key={todo.key} className={`todo-${todo.status}`}>
							{TODO_MARKS[todo.status]}
							<span>{todo.text}</span>
						</li>
					))}
			</Capped>
		</aside>
	);
}

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
function HomeView() {
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

export function SessionView() {
	useLang();
	const selectedId = useAppState((state) => state.selectedId);
	const session = useAppState((state) =>
		state.selectedId ? state.sessions[state.selectedId] : undefined,
	);
	const transcript = useAppState((state) => state.transcript);
	if (!selectedId || !session) {
		return <HomeView />;
	}
	return (
		<main className="main">
			<SessionHeader
				session={session}
				transcript={transcript && transcript.sessionId === session.id ? transcript : null}
			/>
			<div className="session-body">
				{transcript && transcript.sessionId === session.id ? (
					<Transcript transcript={transcript} />
				) : (
					<p className="notice">{t("loading")}</p>
				)}
				<TodoCard session={session} />
			</div>
			{transcript && transcript.sessionId === session.id && (
				<Composer session={session} transcript={transcript} />
			)}
		</main>
	);
}
