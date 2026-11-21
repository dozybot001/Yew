import {
	memo,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	type AssistantMessage,
	askedQuestion,
	bodyAfterSummary,
	type LetterRef,
	type PersonQuote,
	plainLine,
	type ToolCallBlock,
	type ToolResultMessage,
} from "../../../src/shared/messages.ts";
import {
	type Approval,
	type ChangeStep,
	type Entry,
	normalizePermissionMode,
	type PermissionMode,
	type PermissionNote,
	type PermissionRequest,
	type Question,
	type QuestionRequest,
	questionsOf,
	type Session,
	type ToolCallView,
} from "../../../src/shared/types.ts";
import {
	answerApproval,
	forkSession,
	loadEarlier,
	markRead,
	rewindSession,
	selectSession,
	toolCallFor,
} from "../actions.ts";
import {
	formatAgo,
	formatCost,
	formatWaited,
	formatWhen,
	getLang,
	hasMessage,
	type MessageKey,
	t,
	useLang,
} from "../i18n.ts";
import { isImeEvent } from "../ime.ts";
import { tally, YEW_NOTE } from "../progress.ts";
import { type TranscriptState, useAppState } from "../state.ts";
import { ArtifactChip } from "./artifacts.tsx";
import { MessageAttachments } from "./attachments.tsx";
import { Capped, Diff, Markdown, ScrollBlock, useStickToBottom } from "./content.tsx";
import { ConfirmDialog } from "./dialogs.tsx";
import {
	CheckAllIcon,
	CheckIcon,
	ChevronIcon,
	CopyIcon,
	DecisionIcon,
	ForkIcon,
	MailIcon,
	QuestionIcon,
	QuoteIcon,
	RefuseIcon,
	RewindIcon,
	SendIcon,
	ShieldIcon,
} from "./icons.tsx";
import { Mascot } from "./mascot.tsx";
import { tallyText } from "./progress.tsx";
import { Button, CardHead, describeRule, ErrorBox, useAction, useNow } from "./ui.tsx";

function resultText(result: ToolResultMessage | undefined): string {
	if (!result) return "";
	return result.content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
}

/** The line beside a tool's verb: the command, the file, the letter's summary… */
function callSummary(call: ToolCallBlock, recipient: string | null): string {
	const args = call.arguments as Record<string, unknown>;
	switch (call.name) {
		case "send_letter":
			return `${recipient ?? String(args.to ?? "")} · ${String(args.summary ?? "")}`;
		case "open_session":
			return String(args.name ?? "");
		case "post_card":
			return String(args.title ?? "");
		case "update_card":
		case "withdraw_card":
		case "check_decision":
			return `#${String(args.number ?? "")}`;
		case "finish_task":
			return typeof args.result === "string" ? t(`outcome_${args.result}` as MessageKey) : "";
		case "read_attachment": {
			const id = typeof args.id === "string" ? args.id : "";
			const pages = typeof args.pages === "string" ? args.pages : "";
			return pages ? `${id} (${pages})` : id;
		}
		case "todo":
		case "list_sessions":
		case "list_cards":
		case "manage_yew":
			return "";
	}
	const asked = askedQuestion(args);
	if (asked) {
		return asked.count > 1
			? t("moreQuestions", { q: asked.question, n: asked.count - 1 })
			: asked.question;
	}
	const value = args.command ?? args.path ?? args.pattern ?? args.url ?? args.job ?? args.task;
	if (typeof value === "string") return value;
	return JSON.stringify(args);
}

const TOOL_VERBS = [
	"read",
	"read_attachment",
	"write",
	"edit",
	"glob",
	"grep",
	"shell",
	"shell_job",
	"todo",
	"ask_user",
	"web_fetch",
	"open_url",
	"send_letter",
	"list_sessions",
	"check_decision",
	"open_session",
	"finish_task",
	"post_card",
	"update_card",
	"withdraw_card",
	"list_cards",
	"manage_yew",
	"delegate",
] as const;

function isToolVerb(name: string): name is (typeof TOOL_VERBS)[number] {
	return (TOOL_VERBS as readonly string[]).includes(name);
}

const Thinking = memo(function Thinking({ text, live }: { text: string; live: boolean }) {
	// Open while it streams, folded once the answer starts (after AI Elements, prior-art 5.3).
	const [open, setOpen] = useState(live);
	useEffect(() => {
		if (!live) setOpen(false);
	}, [live]);
	return (
		<details
			className="activity"
			open={open}
			onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
		>
			<summary>
				<span className={live ? "activity-verb shimmer" : "activity-verb"}>
					{t("thinkingLabel")}
				</span>
				<ChevronIcon />
			</summary>
			{open && (
				<Capped className="thinking-body" label={t("thinkingLabel")} follow={live}>
					{text}
				</Capped>
			)}
		</details>
	);
});

/**
 * What a permission request does, in the person's words: why a must-confirm operation asks every time,
 * or the kind of action the tool takes. The command, file or address follows below it.
 */
function permissionHeadline(request: PermissionRequest): string {
	if (request.reasons && request.reasons.length > 0) {
		return request.reasons
			.map((reason) => t(`confirm_${reason}` satisfies MessageKey))
			.join(t("listSeparator"));
	}
	if (request.reason) return request.reason;
	// manage_yew: organizing, or changing settings; widening shows its reasons above.
	const scope = request.rememberRules?.[0]?.pattern;
	if (request.tool === "manage_yew" && (scope === "organize" || scope === "configure")) {
		return t(`manage_${scope}`);
	}
	// A task session is named in the line itself; there is no command or file to show under it.
	if (request.tool === "open_session") {
		return t("ask_open_session_named", { name: t("quoted", { s: request.summary }) });
	}
	const key = `ask_${request.tool}`;
	return hasMessage(key) ? t(key) : request.tool;
}

const clip = (text: string, max = 80) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return [...flat].length > max ? `${[...flat].slice(0, max).join("")}…` : flat;
};

/** One change manage_yew makes, in the person's language, for permission cards and the trace notice. */
export function changeText(step: ChangeStep): string {
	const quoted = (name: string) => t("quoted", { s: name });
	const folder = (path: string | null) => (path === null ? t("change_no_folder") : path);
	switch (step.action) {
		case "create_team":
			return t("change_create_team", { name: quoted(step.name) });
		case "rename_team":
			return t("change_rename_team", { from: quoted(step.from), to: quoted(step.to) });
		case "create_session": {
			const details = [
				t("change_detail_model", { model: step.model }),
				t("change_detail_folder", { folder: folder(step.folder) }),
				...(step.team ? [t("change_detail_team", { team: quoted(step.team) })] : []),
				...(step.role ? [t("change_detail_role", { role: clip(step.role) })] : []),
			].join(t("listSeparator"));
			return t("change_create_session", { name: quoted(step.name), details });
		}
		case "rename_session":
			return t("change_rename_session", { from: quoted(step.from), to: quoted(step.to) });
		case "move_to_team": {
			const sessions = step.sessions.map(quoted).join(t("enumSeparator"));
			return step.team === null
				? t("change_leave_team", { sessions })
				: t("change_move_to_team", { sessions, team: quoted(step.team) });
		}
		case "set_role":
			return t("change_set_role", { session: quoted(step.session), role: clip(step.role) });
		case "set_model":
			return t("change_set_model", { session: quoted(step.session), from: step.from, to: step.to });
		case "set_folder":
			return t("change_set_folder", {
				session: quoted(step.session),
				from: folder(step.from),
				to: folder(step.to),
			});
		case "set_permission":
			return t("change_set_permission", {
				session: quoted(step.session),
				// Changes saved before 1.7 name the earlier modes, which read as default now.
				from: t(`perm_${normalizePermissionMode(step.from) ?? "default"}`),
				to: t(`perm_${normalizePermissionMode(step.to) ?? "default"}`),
			});
		case "set_receive":
			return t("change_set_receive", {
				session: quoted(step.session),
				from: t(`receive_${step.from}`),
				to: t(`receive_${step.to}`),
			});
		case "set_letter_quota":
			return t("change_set_letter_quota", {
				session: quoted(step.session),
				from: step.from,
				to: step.to,
			});
		case "set_daily_budget": {
			const amount = (value: number | null) =>
				value === null ? t("budgetNone") : t("cost", { n: formatCost(value) });
			return step.session === null
				? t("change_set_daily_budget_all", { from: amount(step.from), to: amount(step.to) })
				: t("change_set_daily_budget", {
						session: quoted(step.session),
						from: amount(step.from),
						to: amount(step.to),
					});
		}
		case "set_right":
			return t(step.on ? "change_right_on" : "change_right_off", {
				session: quoted(step.session),
				right: t(`right_${step.right}`),
			});
		case "pin":
			return t(step.on ? "change_pin_on" : "change_pin_off", { session: quoted(step.session) });
		case "archive":
			return t(step.on ? "change_archive_on" : "change_archive_off", {
				session: quoted(step.session),
			});
		case "set_main":
			if (step.to === null) return t("change_clear_main", { from: quoted(step.from ?? "") });
			return step.from === null
				? t("change_set_main_first", { to: quoted(step.to) })
				: t("change_set_main", { from: quoted(step.from), to: quoted(step.to) });
		case "set_default_model":
			return t("change_set_default_model", { from: step.from, to: step.to });
		case "set_decision_log":
			return step.to === null
				? t("change_clear_decision_log")
				: t("change_set_decision_log", { to: step.to });
		case "add_workspace":
			return t("change_add_workspace", { folder: step.folder });
		case "remove_workspace":
			return t("change_remove_workspace", { folder: step.folder });
		case "set_theme":
			return t("change_set_theme", { to: t(`theme_${step.to}`) });
		case "set_language":
			return t("change_set_language", {
				to: step.to === "system" ? t("language_system") : step.to === "zh" ? "中文" : "English",
			});
		case "create_schedule": {
			const details = [
				t("change_detail_cron", { cron: step.cron }),
				t("change_detail_to", { session: quoted(step.session) }),
				...(step.permission
					? [t("change_detail_run_mode", { mode: t(`perm_${step.permission}`) })]
					: []),
				t("change_detail_letter", { message: clip(step.message) }),
			].join(t("listSeparator"));
			return t("change_create_schedule", { name: quoted(step.name), details });
		}
		case "change_schedule": {
			const runMode = (mode: PermissionMode | null) =>
				mode ? t(`perm_${mode}`) : t("scheduleModeSession");
			const details = [
				...(step.name !== undefined
					? [t("change_detail_rename", { name: quoted(step.name) })]
					: []),
				...(step.cron !== undefined ? [t("change_detail_cron", { cron: step.cron })] : []),
				...(step.session !== undefined
					? [t("change_detail_to", { session: quoted(step.session) })]
					: []),
				...(step.permission !== undefined
					? [t("change_detail_run_mode_change", { mode: runMode(step.permission) })]
					: []),
				...(step.message !== undefined
					? [t("change_detail_letter", { message: clip(step.message) })]
					: []),
				...(step.catchUp !== undefined
					? [t(step.catchUp ? "change_detail_catch_up_on" : "change_detail_catch_up_off")]
					: []),
				...(step.enabled !== undefined
					? [t(step.enabled ? "change_detail_on" : "change_detail_off")]
					: []),
			].join(t("listSeparator"));
			return t("change_change_schedule", { name: quoted(step.schedule), details });
		}
		case "set_extra_dirs":
			return t("change_set_extra_dirs", {
				session: quoted(step.session),
				dirs:
					step.dirs.length > 0
						? step.dirs
								.map((d) => `${d.path} (${t(`access_${d.access}`)})`)
								.join(t("listSeparator"))
						: t("change_no_folder"),
			});
		case "set_allowed_domains":
			return step.session === null
				? t("change_set_allowed_domains_all", {
						domains:
							step.domains.length > 0 ? step.domains.join(t("listSeparator")) : t("noneLabel"),
					})
				: t("change_set_allowed_domains", {
						session: quoted(step.session),
						domains:
							step.domains.length > 0 ? step.domains.join(t("listSeparator")) : t("noneLabel"),
					});
	}
}

/**
 * A permission request. In the approval center it names the session and how long it has been waiting;
 * in the session itself it says that it needs the person's permission.
 */
export function PermissionCard({ approval, session }: { approval: Approval; session?: ReactNode }) {
	const request = approval.request as PermissionRequest;
	const [reason, setReason] = useState("");
	const [denying, setDenying] = useState(false);
	const now = useNow();
	const action = useAction((decision: "allow_once" | "allow_always" | "deny") =>
		answerApproval(
			approval.id,
			decision === "deny" && reason.trim() ? { decision, reason: reason.trim() } : { decision },
		),
	);
	if (approval.status !== "pending") {
		const decision = approval.response?.decision;
		return (
			<p className="hint">
				{approval.status === "cancelled"
					? t("cancelled")
					: decision && approval.response?.reason
						? t("decidedWithReason", {
								decision: t(`decided_${decision}`),
								reason: approval.response.reason,
							})
						: decision
							? t(`decided_${decision}`)
							: ""}
			</p>
		);
	}
	// "Always allow" names what it remembers the way the session settings list it.
	const rules = request.rememberRules?.map(describeRule).join(t("listSeparator"));
	const headline = permissionHeadline(request);
	return (
		<section className="card request-card" aria-label={headline}>
			<CardHead
				icon={<ShieldIcon />}
				parts={session ? [session, formatWaited(approval.createdAt, now)] : [t("approvalTitle")]}
				tags={
					request.matter ? (
						<span className="tag" title={t("matterTagHint")}>
							{t("matterTag")}
						</span>
					) : request.mustConfirm ? (
						<span className="tag" title={t("confirmEachTimeHint")}>
							{t("confirmEachTime")}
						</span>
					) : null
				}
			/>
			{/* The automatic mode's check looked at it first and left it to the person. */}
			{request.review !== undefined && (
				<p className="hint">
					{request.review
						? t("reviewDeclined", { reason: request.review })
						: t("reviewDeclinedPlain")}
				</p>
			)}
			<p className="request-title">{headline}</p>
			{request.description && (
				<Capped className="request-description" label={headline}>
					{request.description}
				</Capped>
			)}
			{request.tool === "open_session" ? null : request.changes ? (
				<ul className="request-list">
					{request.changes.map((step, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: the changes are fixed and in order
						<li key={index}>{changeText(step)}</li>
					))}
				</ul>
			) : (
				<ScrollBlock className="code request-code" label={headline}>
					{request.summary}
				</ScrollBlock>
			)}
			{/* A site asked about while other things ran in the sandbox: what ran, and a yes is for once. */}
			{request.running && request.running.length > 0 && (
				<>
					<p className="hint">{t("siteRunning")}</p>
					<ul className="request-list">
						{request.running.map((item, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: the list is fixed and in order
							<li key={index}>{t(`siteRunning_${item.kind}`, { text: item.text })}</li>
						))}
					</ul>
					<p className="hint request-warning">{t("siteOnce")}</p>
				</>
			)}
			{request.diff && <Diff patch={request.diff} />}
			{denying && (
				<input
					className="input"
					placeholder={t("denyReason")}
					aria-label={t("denyReason")}
					value={reason}
					onChange={(event) => setReason(event.target.value)}
					onKeyDown={(event) =>
						event.key === "Enter" && !isImeEvent(event) && void action.run("deny")
					}
				/>
			)}
			{/* What "always allow" covers for a tool that acts with the person's sign-ins. */}
			{rules && request.warning === "acts-as-you" && (
				<p className="hint request-warning">{t("alwaysActsAsYou")}</p>
			)}
			{/* Allow, always allow (the rule is in the label), decline. */}
			<div className="request-actions">
				<Button variant="primary" busy={action.busy} onClick={() => void action.run("allow_once")}>
					<CheckIcon />
					{t("approve")}
				</Button>
				{rules && (
					<Button
						className="request-always"
						busy={action.busy}
						onClick={() => void action.run("allow_always")}
						title={t("rememberAs", { rules })}
					>
						<CheckAllIcon />
						{t("approveAlways", { rules })}
					</Button>
				)}
				<Button
					variant="danger"
					busy={action.busy}
					onClick={() => (denying ? void action.run("deny") : setDenying(true))}
				>
					<RefuseIcon />
					{denying ? t("confirmDeny") : t("deny")}
				</Button>
			</div>
			<ErrorBox error={action.error} />
		</section>
	);
}

type Draft = { choices: number[]; other: boolean; text: string };

/** What the person answered, as the resolved card shows it: options picked, then their own words. */
function answeredText(questions: Question[], response: Approval["response"]): string {
	const answers = response?.answers;
	if (!answers) return t("answered", { a: response?.answer ?? "" });
	const parts = questions.map((question, index) => {
		const answer = answers[index];
		const labels = (answer?.choices ?? [])
			.map((choice) => question.options?.[choice]?.label ?? "")
			.join(t("enumSeparator"));
		const words = answer?.text ?? "";
		const part = labels && words ? `${labels}${t("clauseSeparator")}${words}` : labels || words;
		return questions.length === 1 ? part : `${question.header || question.question} ${part}`;
	});
	return t("answered", { a: parts.join(t("clauseSeparator")) });
}

/** An answer nobody has touched: the recommended option chosen, or the person's own words when there are no options. */
function startingDraft(question: Question): Draft {
	return {
		choices:
			question.recommended !== undefined && question.options?.[question.recommended]
				? [question.recommended]
				: [],
		other: !question.options?.length,
		text: "",
	};
}

/**
 * Questions from a session, up to four on one card. Each lists its options with what they mean, the
 * recommended one chosen to start with; the last row takes the person's own words instead. One answer
 * button sends them all.
 */
export function QuestionCard({ approval, session }: { approval: Approval; session?: ReactNode }) {
	const questions = questionsOf(approval.request as QuestionRequest);
	const [drafts, setDrafts] = useState<Draft[]>(() => questions.map(startingDraft));
	// A question Yew took from a reply gets its choices a moment after the card shows: an answer the
	// person has not started takes them up, one they have started stays as it is.
	const shape = questions.map((question) => question.options?.length ?? 0).join();
	const [shown, setShown] = useState(shape);
	if (shown !== shape) {
		setShown(shape);
		setDrafts((all) =>
			questions.map((question, index) => {
				const had = all[index];
				return had && (had.text.trim() || had.choices.length > 0) ? had : startingDraft(question);
			}),
		);
	}
	const now = useNow();
	const id = useId();
	const action = useAction(() =>
		answerApproval(approval.id, {
			answers: drafts.map((draft) => ({
				choices: draft.choices,
				...(draft.other && draft.text.trim() ? { text: draft.text.trim() } : {}),
			})),
		}),
	);
	if (approval.status !== "pending") {
		return (
			<p className="hint">
				{approval.status === "cancelled"
					? t("cancelled")
					: answeredText(questions, approval.response)}
			</p>
		);
	}
	const ready = drafts.every(
		(draft) => draft.choices.length > 0 || (draft.other && draft.text.trim()),
	);
	const update = (index: number, change: (draft: Draft) => Draft) =>
		setDrafts((all) => all.map((draft, at) => (at === index ? change(draft) : draft)));
	// One choice replaces the others and the own words; with several allowed, each one toggles.
	const pick = (index: number, choice: number, multiple: boolean) =>
		update(index, (draft) =>
			multiple
				? {
						...draft,
						choices: draft.choices.includes(choice)
							? draft.choices.filter((c) => c !== choice)
							: [...draft.choices, choice].sort((a, b) => a - b),
					}
				: { ...draft, choices: [choice], other: false },
		);
	const pickOther = (index: number, multiple: boolean, on = true) =>
		update(index, (draft) =>
			multiple
				? { ...draft, other: on }
				: { ...draft, choices: on ? [] : draft.choices, other: on },
		);
	return (
		<section className="card request-card" aria-label={t("questionTitle")}>
			<CardHead
				icon={<QuestionIcon />}
				parts={
					session
						? [
								session,
								// A question Yew took from the end of a reply, not one asked with ask_user.
								(approval.request as QuestionRequest).fromReply && t("askedInReply"),
								formatWaited(approval.createdAt, now),
							]
						: [t("questionTitle")]
				}
			/>
			{questions.map((question, index) => {
				const draft = drafts[index] as Draft;
				const name = `${id}-${index}`;
				const options = question.options ?? [];
				const multiple = question.multiple === true;
				const kind = multiple ? "checkbox" : "radio";
				const mark = multiple ? "decision-check" : "decision-radio";
				return (
					<fieldset
						// biome-ignore lint/suspicious/noArrayIndexKey: a card's questions never change
						key={index}
						className="question-block"
						aria-labelledby={`${name}-q`}
					>
						<p id={`${name}-q`} className="request-title request-question">
							{question.header && <span className="tag">{question.header}</span>}
							{question.question}
							{multiple && <span className="hint">{t("pickSeveral")}</span>}
						</p>
						{options.map((option, choice) => (
							<label
								// biome-ignore lint/suspicious/noArrayIndexKey: options never change order, and labels may repeat
								key={choice}
								className="decision-option"
								data-checked={draft.choices.includes(choice) ? "true" : undefined}
							>
								<input
									type={kind}
									className="visually-hidden"
									name={name}
									checked={draft.choices.includes(choice)}
									onChange={() => pick(index, choice, multiple)}
								/>
								<span className={mark} aria-hidden="true" />
								<span className="decision-option-text">
									<span className="decision-option-label">
										{option.label}
										{choice === question.recommended && (
											<span className="tag">{t("recommended")}</span>
										)}
									</span>
									{option.detail && <span className="hint">{option.detail}</span>}
								</span>
							</label>
						))}
						{options.length > 0 ? (
							<div
								className="decision-option question-other"
								data-checked={draft.other ? "true" : undefined}
							>
								<input
									id={`${name}-other`}
									type={kind}
									className="visually-hidden"
									name={name}
									checked={draft.other}
									onChange={(event) => pickOther(index, multiple, event.target.checked)}
								/>
								<label htmlFor={`${name}-other`}>
									<span className={mark} aria-hidden="true" />
									<span className="visually-hidden">{t("otherAnswer")}</span>
								</label>
								<textarea
									className="question-other-input"
									rows={1}
									placeholder={t("otherAnswer")}
									aria-label={t("otherAnswer")}
									value={draft.text}
									onFocus={() => !multiple && !draft.other && pickOther(index, false)}
									onChange={(event) => {
										const text = event.target.value;
										update(index, (current) => ({
											...current,
											text,
											other: true,
											choices: multiple ? current.choices : [],
										}));
									}}
								/>
							</div>
						) : (
							<textarea
								className="textarea"
								rows={1}
								placeholder={t("answerPlaceholder")}
								aria-labelledby={`${name}-q`}
								value={draft.text}
								onChange={(event) => {
									const text = event.target.value;
									update(index, (current) => ({ ...current, text, other: true }));
								}}
							/>
						)}
					</fieldset>
				);
			})}
			<div className="request-actions">
				<Button
					variant="primary"
					busy={action.busy}
					disabled={!ready}
					onClick={() => void action.run()}
				>
					<SendIcon />
					{t("answer")}
				</Button>
			</div>
			<ErrorBox error={action.error} />
		</section>
	);
}

const ToolCard = memo(function ToolCard({
	call,
	view,
	result,
	approvals,
	output,
}: {
	call: ToolCallBlock;
	view: ToolCallView | undefined;
	result: ToolResultMessage | undefined;
	approvals: Approval[];
	output: string | undefined;
}) {
	const status = view?.status ?? (result ? (result.isError ? "error" : "done") : "pending");
	const pending = approvals.some((approval) => approval.status === "pending");
	const detail = view?.detail as
		| {
				diff?: string;
				added?: number;
				removed?: number;
				code?: string;
				permission?: PermissionNote;
		  }
		| null
		| undefined;
	// Ran without being asked about: in skip mode with its risk, or allowed by the check.
	const risk = detail?.permission?.risk;
	const reviewed = detail?.permission?.reviewed;
	const riskText = risk
		?.map((reason) => t(`confirm_${reason}` satisfies MessageKey))
		.join(t("listSeparator"));
	// Refused because the turn was a scheduled run with nobody watching (M3 plan, section 9).
	const unattended = detail?.code === "unattended";
	const [open, setOpen] = useState(false);
	const to = call.name === "send_letter" ? (call.arguments as { to?: unknown }).to : undefined;
	const recipient = useAppState((state) =>
		typeof to === "string" ? (state.sessions[to]?.name ?? null) : null,
	);
	const running = status === "running";
	const verb = isToolVerb(call.name)
		? t(running ? `act_${call.name}_ing` : `act_${call.name}`)
		: call.name;
	const flagged = status !== "running" && status !== "done";
	const substep =
		running && !open && call.name === "delegate" && output
			? (() => {
					const lines = output.trim().split("\n").filter(Boolean);
					const latest = lines[lines.length - 1];
					return latest ? { count: lines.length, text: latest } : null;
				})()
			: null;
	return (
		<div className="msg-assistant msg-tool">
			{/* While the person is asked, the request card alone says what the call wants to do. */}
			{!pending && (
				<details
					className="activity tool-card"
					open={open}
					onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
				>
					<summary>
						<span className={running ? "activity-verb shimmer" : "activity-verb"}>{verb}</span>
						<span className="tool-summary">{callSummary(call, recipient)}</span>
						{detail?.diff && (
							<span className="tool-stat">
								<span className="stat-add" aria-hidden="true">
									+{detail.added ?? 0}
								</span>{" "}
								<span className="stat-del" aria-hidden="true">
									−{detail.removed ?? 0}
								</span>
								<span className="visually-hidden">
									{t("linesAdded", { n: detail.added ?? 0 })}{" "}
									{t("linesRemoved", { n: detail.removed ?? 0 })}
								</span>
							</span>
						)}
						{flagged && (
							<span className={`tool-state tool-state-${status}`}>
								{status === "denied" && unattended ? t("tool_unattended") : t(`tool_${status}`)}
							</span>
						)}
						{riskText && (
							<span className="tool-state tool-state-risk" title={riskText}>
								{t("permRisk")}
							</span>
						)}
						{reviewed !== undefined && (
							<span className="tool-state tool-state-reviewed" title={reviewed || undefined}>
								{t("permReviewed")}
							</span>
						)}
						<ChevronIcon />
					</summary>
					{open && (
						<div className="tool-detail">
							{riskText && <p className="hint">{t("permRiskLine", { reasons: riskText })}</p>}
							{reviewed !== undefined && (
								<p className="hint">
									{reviewed ? t("permReviewedLine", { reason: reviewed }) : t("permReviewedPlain")}
								</p>
							)}
							<h2>{t("toolArguments")}</h2>
							<ScrollBlock className="code output" label={t("toolArguments")}>
								{JSON.stringify(call.arguments, null, 2)}
							</ScrollBlock>
							{status === "running" && output && (
								<>
									<h2>{t("toolOutput")}</h2>
									<ScrollBlock className="code output" label={t("toolOutput")} follow>
										{output}
									</ScrollBlock>
								</>
							)}
							{detail?.diff && (
								<>
									<h2>{t("diff")}</h2>
									<Diff patch={detail.diff} />
								</>
							)}
							{result && (
								<>
									<h2>{t("toolResult")}</h2>
									<ScrollBlock className="code output" label={t("toolResult")}>
										{resultText(result)}
									</ScrollBlock>
								</>
							)}
						</div>
					)}
				</details>
			)}
			{!pending && substep && (
				<p className="tool-substep" title={substep.text}>
					<span className="tool-substep-count">{substep.count}</span>
					<span className="tool-substep-text">{substep.text}</span>
				</p>
			)}
			{approvals.map((approval) =>
				approval.kind === "permission" ? (
					<PermissionCard key={approval.id} approval={approval} />
				) : (
					<QuestionCard key={approval.id} approval={approval} />
				),
			)}
		</div>
	);
});

/** One step of a turn's work: a thought, a tool call, or a note Yew added to the context. */
type Step =
	| { kind: "thinking"; key: string; text: string; live: boolean }
	| { kind: "tool"; key: string; block: ToolCallBlock; entryId: string | null }
	| { kind: "note"; key: string; entry: Entry };

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

function failed(
	step: Step,
	transcript: TranscriptState,
	results: Map<string, ToolResultMessage>,
): boolean {
	if (step.kind !== "tool") return false;
	const view = step.entryId
		? toolCallFor(transcript.toolCalls, step.entryId, step.block.id)
		: undefined;
	const status = view?.status ?? (results.get(step.block.id)?.isError ? "error" : "done");
	return status === "error" || status === "denied";
}

/** "读取 6 个文件，运行 4 条命令，编辑 2 处": what a run did, counted by kind. */
function summarize(steps: Step[]): string {
	const tools = steps.flatMap((step) => (step.kind === "tool" ? [step.block.name] : []));
	const counted = tally(tools);
	const notes = steps.filter((step) => step.kind === "note").length;
	const thoughts = steps.filter((step) => step.kind === "thinking").length;
	return (
		tallyText({ ...counted, others: counted.others + notes }) ||
		t(thoughts === 1 ? "sum_think_one" : "sum_think", { n: thoughts })
	);
}

/**
 * Under a message from the person and under a finished reply, shown on hover or focus (blueprint
 * 6.11, item 42): when it was written, copy it, take the conversation back to it, fork from it.
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

function StepView({
	step,
	transcript,
	results,
}: {
	step: Step;
	transcript: TranscriptState;
	results: Map<string, ToolResultMessage>;
}) {
	if (step.kind === "thinking") return <Thinking text={step.text} live={step.live} />;
	if (step.kind === "note") return <NoteStep entry={step.entry} />;
	const view = step.entryId
		? toolCallFor(transcript.toolCalls, step.entryId, step.block.id)
		: undefined;
	const approvals = view
		? Object.values(transcript.approvals).filter((a) => a.toolCallId === view.id)
		: [];
	const saved = step.block.name === "save_artifact" ? view?.detail : null;
	if (saved && typeof saved.artifactId === "string") {
		return (
			<ArtifactChip
				id={saved.artifactId}
				name={String(saved.name ?? "")}
				kind={String(saved.kind ?? "markdown")}
				version={Number(saved.version ?? 1)}
			/>
		);
	}
	return (
		<ToolCard
			call={step.block}
			view={view}
			result={results.get(step.block.id)}
			approvals={approvals}
			output={view ? transcript.outputs[view.id] : undefined}
		/>
	);
}

/**
 * A run of steps folded into one line that counts what was done; open it to see every step. While the
 * session is still working on it, the latest step stays visible under the line.
 */
const StepGroup = memo(function StepGroup({
	steps,
	live,
	transcript,
	results,
}: {
	steps: Step[];
	live: boolean;
	transcript: TranscriptState;
	results: Map<string, ToolResultMessage>;
}) {
	useLang();
	const [open, setOpen] = useState(false);
	const errors = steps.filter((step) => failed(step, transcript, results)).length;
	const active = live
		? (steps.findLast(
				(step) =>
					step.kind === "tool" &&
					step.entryId &&
					toolCallFor(transcript.toolCalls, step.entryId, step.block.id)?.status === "running",
			) ?? steps[steps.length - 1])
		: undefined;
	return (
		<div className="step-group">
			<details
				className="activity"
				open={open}
				onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
			>
				<summary>
					<span className="activity-verb activity-count">{summarize(steps)}</span>
					{errors > 0 && (
						<span className="tool-state tool-state-error">{t("stepsFailed", { n: errors })}</span>
					)}
					<ChevronIcon />
				</summary>
				{open && (
					<Capped className="step-list" label={summarize(steps)} follow={live}>
						{steps.map((step) => (
							<StepView key={step.key} step={step} transcript={transcript} results={results} />
						))}
					</Capped>
				)}
			</details>
			{live && !open && active && (
				<StepView step={active} transcript={transcript} results={results} />
			)}
		</div>
	);
});

/** Yew's notes in the context: changed instruction files, or the summary of compacted history. */
function NoteStep({ entry }: { entry: Entry }) {
	useLang();
	const [open, setOpen] = useState(false);
	if (entry.role === "system") {
		return (
			<details
				className="activity"
				open={open}
				onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
			>
				<summary>
					<span className="activity-verb">{t("instructionsUpdated")}</span>
					<ChevronIcon />
				</summary>
				{open && (
					<ScrollBlock className="code output note-body" label={t("instructionsUpdated")}>
						{entry.message.content}
					</ScrollBlock>
				)}
			</details>
		);
	}
	if (entry.role === "compaction") {
		return (
			<details
				className="activity"
				open={open}
				onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
			>
				<summary>
					<span className="activity-verb">{t("summaryTitle")}</span>
					<ChevronIcon />
				</summary>
				{open && (
					<Capped className="tool-detail note-summary" label={t("summaryTitle")}>
						<Markdown text={entry.compaction.summary} />
					</Capped>
				)}
			</details>
		);
	}
	return null;
}

/** Where the person's words come from, in their own terms: "你在「总办」里写的". */
function quoteOrigin(quote: PersonQuote): string {
	const name = t("quoted", { s: quote.sessionName ?? "" });
	switch (quote.source) {
		case "message":
			return t("quoteMessage", { name });
		case "answer":
			return t(quote.chosen ? "quoteAnswerChosen" : "quoteAnswer", { name });
		case "decision":
			return t(quote.chosen ? "quoteDecisionChosen" : "quoteNote", { n: quote.card ?? "" });
	}
}

/**
 * The person's words a letter passes on, as Yew found them in its records: theirs, not the sender's,
 * with where and when they wrote or chose them.
 */
export function PersonQuotes({ quotes }: { quotes: PersonQuote[] | undefined }) {
	useLang();
	if (!quotes?.length) return null;
	return (
		<section className="letter-quotes" aria-label={t("quotesHeading")}>
			<div className="letter-quotes-head">
				<QuoteIcon />
				<span>{t("quotesHeading")}</span>
				<span>·</span>
				<span>{t("quotesChecked")}</span>
			</div>
			{quotes.map((quote, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a letter's quotes never change or move.
				<figure key={index} className="letter-quote">
					<blockquote>{quote.text}</blockquote>
					<figcaption>
						{[quoteOrigin(quote), formatWhen(quote.at), quote.excerpt ? t("quoteExcerpt") : null]
							.filter(Boolean)
							.join(" · ")}
					</figcaption>
				</figure>
			))}
		</section>
	);
}

/**
 * A letter from another session, a script or Yew, shown as a letter, not as words of the person. The
 * person's own decisions carry the "by you" mark, and the person's words it passes on, as Yew found
 * them, are set apart from the sender's.
 */
function LetterEntry({ letter }: { letter: LetterRef }) {
	useLang();
	const senderId = letter.from.sessionId;
	const sender = useAppState((state) =>
		senderId ? (state.sessions[senderId]?.name ?? null) : null,
	);
	if (letter.kind === "decision" && letter.decision && letter.from.kind === "person") {
		const decision = letter.decision;
		return (
			<section
				className="letter-card letter-decision"
				aria-label={t("decisionHeading", { n: decision.number })}
			>
				<div className="letter-head">
					<DecisionIcon />
					<span>{t("decisionHeading", { n: decision.number })}</span>
					<span className="tag">{t("byYou")}</span>
				</div>
				<p className="letter-summary">{decision.title}</p>
				<p>{decision.choice ? t("decidedChoice", { c: decision.choice }) : t("noteOnly")}</p>
				{decision.note && <p className="letter-note">{decision.note}</p>}
			</section>
		);
	}
	const from =
		letter.from.kind === "cli"
			? t("fromCli")
			: letter.from.kind === "person"
				? t("you")
				: letter.from.kind === "yew"
					? t("fromSchedule", { name: t("quoted", { s: letter.from.name }) })
					: (sender ?? letter.from.name);
	// An automatic report repeats its first line as the summary; show it once.
	const body = bodyAfterSummary(letter.body, letter.summary);
	const kind = t(`letterKind_${letter.kind}`);
	return (
		<section className="letter-card" aria-label={`${kind} · ${from}`}>
			<div className="letter-head">
				<MailIcon />
				{senderId && sender ? (
					<button
						type="button"
						className="link-button"
						onClick={() => void selectSession(senderId)}
					>
						{from}
					</button>
				) : (
					<span>{from}</span>
				)}
				<span className="tag">{kind}</span>
				{letter.schedule && letter.from.kind !== "yew" && (
					<span className="hint">
						{t("fromSchedule", { name: t("quoted", { s: letter.schedule.name }) })}
					</span>
				)}
				{letter.auto && <span className="hint">{t("sentByYew")}</span>}
			</div>
			<p className="letter-summary">{plainLine(letter.summary) || letter.summary}</p>
			{body && (
				<Capped className="letter-body" label={letter.summary}>
					<Markdown text={body} breaks />
				</Capped>
			)}
			<PersonQuotes quotes={letter.quotes} />
			{letter.decision && (
				<p className="hint">
					{t("verifiedDecision", { n: letter.decision.number })} ·{" "}
					{letter.decision.choice
						? t("decidedChoice", { c: letter.decision.choice })
						: t("noteOnly")}
				</p>
			)}
		</section>
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
 * up it leaves the view alone and offers a "new messages" button instead (spec 9.8).
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
	// Follows new content only while you are at the bottom; any scroll up stops it at once (spec 9.8).
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
			// biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll area must be reachable by keyboard (spec 18.6)
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
