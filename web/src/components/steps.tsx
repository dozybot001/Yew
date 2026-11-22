import { memo, useEffect, useState } from "react";
import {
	askedQuestion,
	type ToolCallBlock,
	type ToolResultMessage,
} from "../../../src/shared/messages.ts";
import type { Approval, Entry, PermissionNote, ToolCallView } from "../../../src/shared/types.ts";
import { toolCallFor } from "../actions.ts";
import { type MessageKey, t, useLang } from "../i18n.ts";
import { tally } from "../progress.ts";
import { type TranscriptState, useAppState } from "../state.ts";
import { ArtifactChip } from "./artifacts.tsx";
import { Capped, Diff, Markdown, ScrollBlock } from "./content.tsx";
import { ChevronIcon } from "./icons.tsx";
import { PermissionCard } from "./permission-card.tsx";
import { tallyText } from "./progress.tsx";
import { QuestionCard } from "./question-card.tsx";

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
export type Step =
	| { kind: "thinking"; key: string; text: string; live: boolean }
	| { kind: "tool"; key: string; block: ToolCallBlock; entryId: string | null }
	| { kind: "note"; key: string; entry: Entry };

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

export function StepView({
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
export const StepGroup = memo(function StepGroup({
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
