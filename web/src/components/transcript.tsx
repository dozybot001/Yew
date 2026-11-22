import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AssistantMessage, ToolResultMessage } from "../../../src/shared/messages.ts";
import type { ChangeStep, Entry, Session } from "../../../src/shared/types.ts";
import { forkSession, loadEarlier, markRead, rewindSession, toolCallFor } from "../actions.ts";
import { formatAgo, formatCost, getLang, t, useLang } from "../i18n.ts";
import { YEW_NOTE } from "../progress.ts";
import { type TranscriptState, useAppState } from "../state.ts";
import { MessageAttachments } from "./attachments.tsx";
import { Capped, Markdown, useStickToBottom } from "./content.tsx";
import { ConfirmDialog } from "./dialogs.tsx";
import { CheckIcon, ChevronIcon, CopyIcon, ForkIcon, RewindIcon } from "./icons.tsx";
import { LetterEntry } from "./letter-entry.tsx";
import { Mascot } from "./mascot.tsx";
import { changeText } from "./permission-card.tsx";
import { QuestionCard } from "./question-card.tsx";
import { type Step, StepGroup, StepView } from "./steps.tsx";
import { Button, ErrorBox, useAction, useNow } from "./ui.tsx";

/** What the transcript shows, in order: messages, the assistant's text, and runs of steps. */
type Item =
	| { kind: "entry"; key: string; entry: Entry }
	| {
			kind: "text";
			key: string;
			text: string;
			live: boolean;
			/** The reply this text ends, when a new session can be forked from it. */
			forkFrom: string | null;
	  }
	| { kind: "steps"; key: string; steps: Step[]; live: boolean; alone: boolean };

/** All the text of a reply, as it would be copied. */
function replyText(entry: Entry): string {
	if (entry.role !== "assistant") return "";
	return entry.message.content
		.flatMap((block) => (block.type === "text" && block.text.trim() ? [block.text] : []))
		.join("\n\n");
}

function userText(entry: Extract<Entry, { role: "user" }>): string {
	const content = entry.message.content;
	return typeof content === "string"
		? content
		: content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
}

/** Low-signal audit notices hidden in concise timeline view (always visible in detailed view). */
const QUIET_NOTICES = new Set([
	"model_changed",
	"reviewed",
	"changed",
	"compacted",
	"job_finished",
]);

/**
 * Turns the transcript into items. Consecutive thoughts and tool calls between two pieces of text form
 * one run, shown folded so the conversation stays readable. A call waiting for the person is taken out
 * of its run, so an approval is never hidden.
 */
function buildItems(transcript: TranscriptState, working: boolean, detailed: boolean): Item[] {
	const items: Item[] = [];
	let run: Step[] = [];
	const flush = (live = false) => {
		const first = run[0];
		if (first) items.push({ kind: "steps", key: first.key, steps: run, live, alone: false });
		run = [];
	};
	const blocks = (message: AssistantMessage, entryId: string | null, live: boolean) => {
		message.content.forEach((block, position) => {
			const key = `${entryId ?? "draft"}:${position}`;
			if (block.type === "thinking") {
				const last = position === message.content.length - 1;
				if (block.thinking.trim()) {
					run.push({ kind: "thinking", key, text: block.thinking, live: live && last });
				}
			} else if (block.type === "text") {
				if (!block.text.trim()) return;
				flush();
				// A finished reply: the last text of a message that calls no tools.
				const finished =
					entryId !== null &&
					!live &&
					!message.content.some((other) => other.type === "toolCall") &&
					!message.content
						.slice(position + 1)
						.some((other) => other.type === "text" && other.text.trim());
				items.push({
					kind: "text",
					key,
					text: block.text,
					live,
					forkFrom: finished ? entryId : null,
				});
			} else {
				const view = entryId ? toolCallFor(transcript.toolCalls, entryId, block.id) : undefined;
				const waiting =
					view !== undefined &&
					Object.values(transcript.approvals).some(
						(a) => a.toolCallId === view.id && a.status === "pending",
					);
				const step: Step = { kind: "tool", key: block.id, block, entryId };
				if (!waiting) {
					run.push(step);
					return;
				}
				flush();
				items.push({ kind: "steps", key: block.id, steps: [step], live: false, alone: true });
			}
		});
	};
	for (const entry of transcript.entries) {
		if (entry.role === "assistant") blocks(entry.message, entry.id, false);
		else if (
			entry.role === "system" ||
			(entry.role === "compaction" && entry.compaction.kind !== "renew")
		) {
			if (detailed) run.push({ kind: "note", key: entry.id, entry });
		} else if (entry.role === "notice" && !detailed && QUIET_NOTICES.has(entry.notice.kind)) {
			// Hidden in concise mode without splitting a step run.
		} else if (entry.role === "user" && userText(entry).startsWith(YEW_NOTE)) {
			// Yew's own notes to the model are not shown and do not split a run.
		} else if (entry.role !== "toolResult") {
			flush();
			items.push({ kind: "entry", key: entry.id, entry });
		}
	}
	if (transcript.draft) blocks(transcript.draft, null, true);
	flush(working);
	return items;
}

/**
 * Under a message from the person and under a finished reply, shown on hover or focus: when it was
 * written, copy it, take the conversation back to it, fork from it.
 * Taken back or forked from the person's message, that message waits in the message box again.
 */
function MessageActions({
	session,
	entry,
	text,
	mine,
	canRewind,
}: {
	session: Session;
	entry: Entry;
	text: string;
	mine: boolean;
	canRewind: boolean;
}) {
	useLang();
	const now = useNow();
	const [copied, setCopied] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const fork = useAction(() => forkSession(session.id, entry.id, mine ? text : undefined));
	const rewind = useAction(() => rewindSession(session.id, entry.id, mine ? text : undefined));
	const copy = async () => {
		await navigator.clipboard?.writeText(text);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	};
	const when = new Intl.DateTimeFormat(getLang() === "zh" ? "zh-CN" : "en-US", {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(entry.createdAt);
	const copyButton = (
		<Button
			variant="icon"
			aria-label={copied ? t("copied") : t("copy")}
			title={copied ? t("copied") : t("copy")}
			onClick={() => void copy()}
		>
			{copied ? <CheckIcon /> : <CopyIcon />}
		</Button>
	);
	const rewindButton = canRewind ? (
		<Button
			variant="icon"
			aria-label={t("rewindHere")}
			title={session.status === "working" ? t("rewindBusy") : t("rewindHere")}
			disabled={session.status === "working"}
			busy={rewind.busy}
			onClick={() => setConfirming(true)}
		>
			<RewindIcon />
		</Button>
	) : null;
	const forkButton = (
		<Button
			variant="icon"
			aria-label={t("forkFromHere")}
			title={t(mine ? "forkBeforeHint" : "forkFromHereHint")}
			busy={fork.busy}
			onClick={() => void fork.run()}
		>
			<ForkIcon />
		</Button>
	);
	return (
		<div className={mine ? "message-actions message-actions-mine" : "message-actions"}>
			<time className="hint" dateTime={new Date(entry.createdAt).toISOString()} title={when}>
				{formatAgo(entry.createdAt, now)}
			</time>
			{mine ? (
				<>
					{forkButton}
					{rewindButton}
					{copyButton}
				</>
			) : (
				<>
					{copyButton}
					{rewindButton}
					{forkButton}
				</>
			)}
			<ErrorBox error={fork.error ?? rewind.error} />
			{confirming && (
				<ConfirmDialog
					title={t("rewindTitle")}
					body={t(mine ? "rewindBodyMine" : "rewindBodyReply")}
					confirmLabel={t("rewind")}
					onConfirm={() => rewind.run()}
					onClose={() => setConfirming(false)}
				/>
			)}
		</div>
	);
}

/** A message from the person, a letter, or a notice from Yew. */
function EntryView({ entry, sessionId }: { entry: Entry; sessionId: string }) {
	switch (entry.role) {
		case "user": {
			if (entry.letter) return <LetterEntry letter={entry.letter} />;
			const text = userText(entry);
			const attached = entry.attachments ?? [];
			return (
				<Capped className="msg-user" label={t("you")}>
					<span className="visually-hidden">{t("you")}: </span>
					{attached.length > 0 && <MessageAttachments attachments={attached} />}
					{text && (
						<div className="msg-user-text">
							<Markdown text={text} breaks sessionId={sessionId} />
						</div>
					)}
				</Capped>
			);
		}
		case "compaction": {
			if (entry.compaction.kind !== "renew") return null;
			const brief = entry.compaction.summary.trim();
			return (
				<div className="renew-block">
					<div className="renew-divider">
						<span>{t("renewDivider")}</span>
					</div>
					{brief && (
						<details className="activity renew-brief">
							<summary>
								<span className="activity-verb">{t("renewBriefTitle")}</span>
								<ChevronIcon />
							</summary>
							<Capped className="tool-detail note-summary" label={t("renewBriefTitle")}>
								<Markdown text={brief} />
							</Capped>
						</details>
					)}
				</div>
			);
		}
		case "notice": {
			const notice = entry.notice;
			// The renew compaction entry right above already renders the horizontal divider.
			if (notice.kind === "renewed") return null;
			const data = (notice.data ?? {}) as Record<string, string | number | null>;
			let text: string;
			if (notice.kind === "error") {
				const code = String(data.code ?? "");
				text =
					code === "model-error"
						? t("notice_error_model", { text: notice.text ?? "" })
						: code === "compact-failed"
							? t("notice_compact_failed", { text: notice.text ?? "" })
							: code === "missing-api-key"
								? t("err_missingKey", { provider: String(data.provider ?? "") })
								: code === "step-limit"
									? t("notice_step_limit", { n: Number(data.steps ?? 0) })
									: code === "output-cut"
										? t("notice_output_cut")
										: t("notice_error_internal");
			} else if (notice.kind === "job_finished") {
				text = t("notice_job_finished", {
					job: String(data.job ?? ""),
					command: String(data.command ?? ""),
					exit:
						data.exitCode === null || data.exitCode === undefined
							? ""
							: t("jobExit", { code: data.exitCode }),
				});
			} else if (notice.kind === "budget") {
				text = t(
					data.code === "budget-reached" ? "notice_budget_reached" : "notice_budget_warning",
					{
						scope: t(data.scope === "session" ? "budgetScope_session" : "budgetScope_all"),
						spent: formatCost(Number(data.spent ?? 0)),
						limit: formatCost(Number(data.limit ?? 0)),
					},
				);
			} else if (notice.kind === "hook") {
				text = t(data.kind === "blocked" ? "notice_hook_blocked" : "notice_hook_error", {
					event: String(data.event ?? ""),
					text: String(data.text ?? ""),
				});
			} else if (notice.kind === "reviewed") {
				text = data.reason
					? t("notice_reviewed", {
							summary: String(data.summary ?? ""),
							reason: String(data.reason),
						})
					: t("notice_reviewed_plain", { summary: String(data.summary ?? "") });
			} else if (notice.kind === "compacted" && data.tier === "prune") {
				text = t("notice_compacted_pruned", { n: Number(data.prunedCount ?? 0) });
			} else if (notice.kind === "changed") {
				const steps = (notice.data?.steps ?? []) as unknown as ChangeStep[];
				text = t("notice_changed", {
					by: String(data.by ?? ""),
					changes: steps.map(changeText).join(t("clauseSeparator")),
				});
			} else {
				text = t(`notice_${notice.kind}`, { text: notice.text ?? "" });
			}
			return <p className={`notice ${notice.kind === "error" ? "notice-error" : ""}`}>{text}</p>;
		}
		default:
			return null;
	}
}

/**
 * The conversation. It follows new content only while you are at the bottom; when you have scrolled
 * up it leaves the view alone and offers a "new messages" button instead.
 */
export function Transcript({ transcript }: { transcript: TranscriptState }) {
	useLang();
	const session = useAppState((state) => state.sessions[transcript.sessionId]);
	const byId = useMemo(
		() => new Map(transcript.entries.map((entry) => [entry.id, entry])),
		[transcript.entries],
	);
	// The conversation cannot be taken back past the latest summary of earlier history.
	const summarySeq = useMemo(
		() =>
			transcript.entries.reduce(
				(latest, entry) => (entry.role === "compaction" ? Math.max(latest, entry.seq) : latest),
				0,
			),
		[transcript.entries],
	);
	const scroller = useRef<HTMLDivElement>(null);
	const [behind, setBehind] = useState(false);
	const onFollow = useCallback((following: boolean) => {
		if (following) setBehind(false);
	}, []);
	// Follows new content only while you are at the bottom; any scroll up stops it at once.
	const following = useStickToBottom(scroller, onFollow);
	const loadMore = useAction(loadEarlier);

	const results = useMemo(() => {
		const map = new Map<string, ToolResultMessage>();
		for (const entry of transcript.entries) {
			if (entry.role === "toolResult") map.set(entry.message.toolCallId, entry.message);
		}
		return map;
	}, [transcript.entries]);
	const detailed = useAppState((state) => state.transcriptDetail);
	const working = session?.status === "working";
	const items = useMemo(
		() => buildItems(transcript, working, detailed),
		[transcript, working, detailed],
	);
	const freeApprovals = Object.values(transcript.approvals).filter(
		(a) => !a.toolCallId && a.status === "pending",
	);
	const lastSeq = transcript.entries.at(-1)?.seq ?? 0;
	const draftSize = transcript.draft
		? transcript.draft.content.reduce(
				(n, b) =>
					n + (b.type === "text" ? b.text.length : b.type === "thinking" ? b.thinking.length : 1),
				0,
			)
		: 0;
	const contentKey = `${lastSeq}:${draftSize}:${Object.keys(transcript.approvals).length}`;

	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when new content arrives, keyed by contentKey
	useLayoutEffect(() => {
		const element = scroller.current;
		if (!element) return;
		if (following.current) {
			element.scrollTop = element.scrollHeight;
			markRead(transcript.sessionId);
		} else {
			setBehind(true);
		}
	}, [contentKey]);

	const openSessionId = transcript.sessionId;
	// biome-ignore lint/correctness/useExhaustiveDependencies: resets the scroll state when another session opens
	useEffect(() => {
		following.current = true;
		setBehind(false);
	}, [openSessionId]);

	// A turn that ends while you are watching at the bottom counts as read.
	const unread = session?.unread ?? 0;
	useEffect(() => {
		if (unread > 0 && following.current) markRead(transcript.sessionId);
	}, [unread, transcript.sessionId, following]);

	return (
		<section
			ref={scroller}
			className="transcript"
			aria-label={session?.name ?? ""}
			aria-live="off"
			// biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll area must be reachable by keyboard
			tabIndex={0}
			data-last-seq={lastSeq}
		>
			<div className="transcript-inner">
				{transcript.olderCursor !== null && (
					<Button busy={loadMore.busy} onClick={() => void loadMore.run()}>
						{t("loadEarlier")}
					</Button>
				)}
				{transcript.entries.length === 0 && !transcript.draft && (
					<div className="empty-session">
						<Mascot pose={session?.cwd ? "typing" : "tea"} height={84} />
						<p className="empty-session-title">{session?.name ?? t("emptyTranscript")}</p>
						{session?.cwd && <p className="empty-session-path">{session.cwd}</p>}
						{session?.responsibility ? (
							<p className="empty-session-brief">{session.responsibility}</p>
						) : (
							<p className="notice">{t("emptyTranscript")}</p>
						)}
					</div>
				)}
				{items.map((item) => {
					if (item.kind === "entry") {
						const entry = item.entry;
						if (session && entry.role === "user" && !entry.letter) {
							return (
								<div key={item.key} className="message message-mine">
									<EntryView entry={entry} sessionId={transcript.sessionId} />
									<MessageActions
										session={session}
										entry={entry}
										text={userText(entry)}
										mine
										canRewind={entry.seq - 1 >= summarySeq}
									/>
								</div>
							);
						}
						return <EntryView key={item.key} entry={entry} sessionId={transcript.sessionId} />;
					}
					if (item.kind === "text") {
						return (
							<div key={item.key} className="msg-assistant">
								<Markdown text={item.text} live={item.live} sessionId={transcript.sessionId} />
								{item.forkFrom && session && byId.get(item.forkFrom) && (
									<MessageActions
										session={session}
										entry={byId.get(item.forkFrom) as Entry}
										text={replyText(byId.get(item.forkFrom) as Entry)}
										mine={false}
										canRewind={(byId.get(item.forkFrom) as Entry).seq >= summarySeq}
									/>
								)}
							</div>
						);
					}
					const only = item.steps[0];
					// A single step, or one waiting for the person, shows as itself.
					if (only && (item.alone || item.steps.length === 1)) {
						return (
							<StepView key={item.key} step={only} transcript={transcript} results={results} />
						);
					}
					return (
						<StepGroup
							key={item.key}
							steps={item.steps}
							live={item.live}
							transcript={transcript}
							results={results}
						/>
					);
				})}
				{freeApprovals.map((approval) => (
					<QuestionCard key={approval.id} approval={approval} />
				))}
				{behind && (
					<Button
						className="new-messages"
						onClick={() => {
							const element = scroller.current;
							if (element) element.scrollTop = element.scrollHeight;
							following.current = true;
							setBehind(false);
						}}
					>
						{t("jumpToNew")} ↓
					</Button>
				)}
			</div>
		</section>
	);
}
