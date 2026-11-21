import { type ReactNode, useId, useState } from "react";
import { bodyAfterSummary, plainLine } from "../../../src/shared/messages.ts";
import type { Approval, Card, Letter } from "../../../src/shared/types.ts";
import {
	decideCard,
	loadDecisions,
	loadLetters,
	openCenter,
	refuseLetter,
	releaseLetter,
	selectSession,
} from "../actions.ts";
import { formatAgo, formatWaited, type MessageKey, t, useLang } from "../i18n.ts";
import { type CenterTab, centerCount, useAppState } from "../state.ts";
import { Capped, Markdown } from "./content.tsx";
import {
	CenterIcon,
	CheckIcon,
	ChevronIcon,
	DecisionIcon,
	MailIcon,
	RefuseIcon,
	SendIcon,
} from "./icons.tsx";
import { Mascot } from "./mascot.tsx";
import { SidebarToggle } from "./session.tsx";
import { PermissionCard, PersonQuotes, QuestionCard } from "./transcript.tsx";
import { Button, CardHead, ErrorBox, useAction, useNow } from "./ui.tsx";

/** A session's current name; letters and cards keep ids, so a renamed session shows its new name. */
function useSessionName(id: string | null): string | null {
	return useAppState((state) => (id ? (state.sessions[id]?.name ?? null) : null));
}

function SessionLink({ id, fallback }: { id: string | null; fallback?: string }) {
	const name = useSessionName(id);
	if (!id || !name) return <span>{fallback ?? ""}</span>;
	return (
		<button type="button" className="link-button" onClick={() => void selectSession(id)}>
			{name}
		</button>
	);
}

function SenderLink({ letter }: { letter: Letter }) {
	useLang();
	if (letter.fromKind === "cli") return <span>{t("fromCli")}</span>;
	if (letter.fromKind === "person") return <span>{t("you")}</span>;
	if (letter.fromKind === "yew") {
		return <span>{t("fromSchedule", { name: t("quoted", { s: letter.fromName }) })}</span>;
	}
	return <SessionLink id={letter.fromSession} fallback={letter.fromName} />;
}

/**
 * Cards with a deadline first, by deadline; then the one that has waited longest first. Permission
 * requests, questions and held letters have no deadline and are listed the one that has waited longest
 * first.
 */
function byDeadline(a: Card, b: Card): number {
	const longest = a.createdAt - b.createdAt || a.number - b.number;
	if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline) || longest;
	if (a.deadline) return -1;
	if (b.deadline) return 1;
	return longest;
}

/**
 * A decision card, read at a glance: the top line says who asks, through whom and since
 * when, with the deadline and whether it can be undone on the right; then the question, a few lines of
 * context, the options with the recommended one chosen, and a note. Sending records the decision as the
 * person's and returns it to the sessions that asked.
 */
function DecisionCard({ card }: { card: Card }) {
	useLang();
	const [choice, setChoice] = useState<number | null>(card.recommended);
	const [note, setNote] = useState("");
	const names = useAppState((state) => state.sessions);
	const now = useNow();
	const titleId = useId();
	const noteId = useId();
	const send = useAction(() => decideCard(card.id, choice, note.trim() || null));
	const hasOptions = card.options.length > 0;
	const ready = choice !== null || note.trim().length > 0;
	// The sessions the card's top line does not already name.
	const others = card.sessions
		.filter((id) => id !== card.requestedBy && id !== card.createdBy)
		.map((id) => names[id]?.name)
		.filter((name): name is string => Boolean(name));
	const via = card.createdBy && card.createdBy !== card.requestedBy ? card.createdBy : null;
	return (
		<section className="card decision-card" aria-labelledby={titleId}>
			<CardHead
				icon={<DecisionIcon />}
				parts={[
					`#${card.number}`,
					card.requestedBy && (
						<WithLink
							text={t("cardFrom", { name: "\u0000" })}
							link={<SessionLink id={card.requestedBy} />}
						/>
					),
					via && (
						<WithLink text={t("cardVia", { name: "\u0000" })} link={<SessionLink id={via} />} />
					),
					others.length > 0 && t("cardAlsoInvolves", { names: others.join(t("listSeparator")) }),
					formatWaited(card.createdAt, now),
				]}
				tags={
					<>
						{card.deadline && (
							<span className="tag tag-deadline" title={card.deadline}>
								{t("cardDeadline", { d: card.deadline })}
							</span>
						)}
						{typeof card.undoable === "boolean" && (
							<span
								className={card.undoable ? "tag" : "tag tag-danger"}
								title={card.reversible || undefined}
							>
								{card.undoable ? t("undoable") : t("notUndoable")}
							</span>
						)}
					</>
				}
			/>
			<h3 id={titleId}>{card.title}</h3>
			{card.context && (
				<Capped className="decision-context" label={card.title}>
					<Markdown text={card.context} />
				</Capped>
			)}
			{typeof card.undoable !== "boolean" && card.reversible && (
				<p className="hint">{card.reversible}</p>
			)}
			{hasOptions && (
				<fieldset className="decision-options">
					<legend className="visually-hidden">{t("cardOptions")}</legend>
					{card.options.map((option, index) => (
						<label
							// biome-ignore lint/suspicious/noArrayIndexKey: a card's options never change order, and labels may repeat
							key={index}
							className="decision-option"
							data-checked={choice === index ? "true" : undefined}
						>
							<input
								type="radio"
								className="visually-hidden"
								name={`card-${card.id}`}
								checked={choice === index}
								onChange={() => setChoice(index)}
							/>
							<span className="decision-radio" aria-hidden="true" />
							<span className="decision-option-text">
								<span className="decision-option-label">
									{option.label}
									{index === card.recommended && <span className="tag">{t("recommended")}</span>}
								</span>
								{option.detail && <span className="hint">{option.detail}</span>}
							</span>
						</label>
					))}
				</fieldset>
			)}
			{card.after && <p className="hint">{card.after}</p>}
			<label className="visually-hidden" htmlFor={noteId}>
				{t("cardNote")}
			</label>
			<div className="composer-row">
				<textarea
					id={noteId}
					className="textarea"
					rows={1}
					placeholder={hasOptions ? t("notePlaceholder") : t("answerRequired")}
					value={note}
					onChange={(event) => setNote(event.target.value)}
				/>
				<Button
					variant="primary"
					busy={send.busy}
					disabled={!ready}
					onClick={() => void send.run()}
				>
					<SendIcon />
					{t("send")}
				</Button>
			</div>
			<ErrorBox error={send.error} />
		</section>
	);
}

/** A letter held for the person: who wrote to whom and since when, why it waits, and release or refuse. */
function HeldLetter({ letter }: { letter: Letter }) {
	useLang();
	const now = useNow();
	const release = useAction(() => releaseLetter(letter.id));
	const refuse = useAction(() => refuseLetter(letter.id));
	return (
		<section className="card request-card" aria-label={letter.summary}>
			<CardHead
				icon={<MailIcon />}
				parts={[
					<>
						<SenderLink letter={letter} /> → <SessionLink id={letter.toSession} />
					</>,
					t(`letterKind_${letter.kind}`),
					formatWaited(letter.createdAt, now),
				]}
			/>
			<p className="request-title">{plainLine(letter.summary) || letter.summary}</p>
			{letter.body && (
				<Capped className="letter-body" label={letter.summary}>
					<Markdown text={letter.body} breaks />
				</Capped>
			)}
			<PersonQuotes quotes={letter.quotes} />
			<p className="hint">
				{t(`letterReason_${letter.statusReason ?? "hold-policy"}` as MessageKey)}
			</p>
			<div className="request-actions">
				<Button variant="primary" busy={release.busy} onClick={() => void release.run()}>
					<CheckIcon />
					{t("release")}
				</Button>
				<Button variant="danger" busy={refuse.busy} onClick={() => void refuse.run()}>
					<RefuseIcon />
					{t("refuse")}
				</Button>
			</div>
			<ErrorBox error={release.error ?? refuse.error} />
		</section>
	);
}

/** A permission request or question from any session; the card's top line links to the session. */
function PendingApproval({ approval }: { approval: Approval }) {
	const session = <SessionLink id={approval.sessionId} />;
	return approval.kind === "permission" ? (
		<PermissionCard approval={approval} session={session} />
	) : (
		<QuestionCard approval={approval} session={session} />
	);
}

/** A translated sentence with a link in place of {name}. */
function WithLink({ text, link }: { text: string; link: ReactNode }) {
	const [before = "", after = ""] = text.split("\u0000");
	return (
		<span>
			{before}
			{link}
			{after}
		</span>
	);
}

/**
 * One decision on one line: its number, the question, what you chose and when. Clicking the line
 * unfolds it in place, in the same card: the context, the options with your choice and the recommended
 * one, your note, then who asked and who put it up.
 */
function DecisionRecord({ card, now }: { card: Card; now: number }) {
	useLang();
	const [open, setOpen] = useState(false);
	const panel = useId();
	const chosen = card.choice === null ? null : (card.options[card.choice]?.label ?? null);
	return (
		<li className="letter-item" data-open={open}>
			<button
				type="button"
				className="letter-line"
				aria-expanded={open}
				aria-controls={panel}
				onClick={() => setOpen((value) => !value)}
			>
				<span className="letter-line-route">#{card.number}</span>
				<span className="letter-line-summary">{card.title}</span>
				<span className="tag">{chosen ?? t("noteOnly")}</span>
				<span className="letter-line-meta">
					<span className="session-time">{formatAgo(card.decidedAt ?? card.updatedAt, now)}</span>
				</span>
				<ChevronIcon />
			</button>
			{open && (
				<div className="letter-panel" id={panel}>
					<Capped className="letter-content" label={card.title}>
						<p className="letter-summary">{card.title}</p>
						{card.context && <Markdown text={card.context} breaks />}
						{card.options.length > 0 && (
							<ul className="record-options" aria-label={t("cardOptions")}>
								{card.options.map((option, index) => (
									<li
										// biome-ignore lint/suspicious/noArrayIndexKey: a card's options never change order, and labels may repeat
										key={index}
										data-chosen={index === card.choice}
									>
										<span className="record-check" aria-hidden="true">
											{index === card.choice ? "✓" : ""}
										</span>
										<span>
											{option.label}
											{index === card.choice && (
												<span className="visually-hidden">{t("chosenMark")}</span>
											)}
										</span>
										{index === card.recommended && <span className="tag">{t("recommended")}</span>}
									</li>
								))}
							</ul>
						)}
						{card.note && (
							<p>
								{t("cardNote")}：{card.note}
							</p>
						)}
					</Capped>
					<div className="letter-row-head">
						<span>{t("byYou")}</span>
						{card.requestedBy && (
							<WithLink
								text={t("cardFrom", { name: "\u0000" })}
								link={<SessionLink id={card.requestedBy} />}
							/>
						)}
						{card.createdBy && card.createdBy !== card.requestedBy && (
							<WithLink
								text={t("cardPostedBy", { name: "\u0000" })}
								link={<SessionLink id={card.createdBy} />}
							/>
						)}
					</div>
				</div>
			)}
		</li>
	);
}

function DecisionList() {
	useLang();
	const decisions = useAppState((state) => state.decisions);
	const more = useAction(() => loadDecisions(true));
	const now = useNow();
	if (!decisions.loaded) return <p className="hint">{t("loading")}</p>;
	if (decisions.items.length === 0) return <p className="empty-box">{t("decisionsEmpty")}</p>;
	return (
		<>
			<ul className="letter-list decision-lines">
				{decisions.items.map((card) => (
					<DecisionRecord key={card.id} card={card} now={now} />
				))}
			</ul>
			{decisions.nextCursor && (
				<Button busy={more.busy} onClick={() => void more.run()}>
					{t("loadMore")}
				</Button>
			)}
			<ErrorBox error={more.error} />
		</>
	);
}

function CenterList() {
	useLang();
	const center = useAppState((state) => state.center);
	const approvals = Object.values(center.approvals).sort((a, b) => a.createdAt - b.createdAt);
	const permissions = approvals.filter((approval) => approval.kind === "permission");
	const questions = approvals.filter((approval) => approval.kind === "question");
	const cards = Object.values(center.cards).sort(byDeadline);
	const held = Object.values(center.held).sort((a, b) => a.createdAt - b.createdAt);
	return (
		<>
			{approvals.length + cards.length + held.length === 0 && (
				<div className="empty-state">
					<Mascot pose="happy" height={96} />
					<p className="empty-box">{t("centerEmpty")}</p>
				</div>
			)}
			{permissions.length > 0 && (
				<section className="center-section" aria-label={t("waitingApprovals")}>
					<h2>{t("waitingApprovals")}</h2>
					{permissions.map((approval) => (
						<PendingApproval key={approval.id} approval={approval} />
					))}
				</section>
			)}
			{questions.length > 0 && (
				<section className="center-section" aria-label={t("waitingQuestions")}>
					<h2>{t("waitingQuestions")}</h2>
					{questions.map((approval) => (
						<PendingApproval key={approval.id} approval={approval} />
					))}
				</section>
			)}
			{cards.length > 0 && (
				<section className="center-section" aria-label={t("decisionsToMake")}>
					<h2>{t("decisionsToMake")}</h2>
					{cards.map((card) => (
						<DecisionCard key={card.id} card={card} />
					))}
				</section>
			)}
			{held.length > 0 && (
				<section className="center-section" aria-label={t("heldLetters")}>
					<h2>{t("heldLetters")}</h2>
					{held.map((letter) => (
						<HeldLetter key={letter.id} letter={letter} />
					))}
				</section>
			)}
		</>
	);
}

/** Who a letter is from, as plain text for the one-line row. */
function useSenderName(letter: Letter): string {
	const name = useSessionName(letter.fromSession);
	if (letter.fromKind === "cli") return t("fromCli");
	if (letter.fromKind === "person") return t("you");
	if (letter.fromKind === "yew")
		return t("fromSchedule", { name: t("quoted", { s: letter.fromName }) });
	return name ?? letter.fromName;
}

/**
 * One letter on one line: who wrote to whom, the kind, the summary and when. Only a letter that did not
 * get through (held, refused, dropped) shows its state on the line. Clicking the line unfolds the letter
 * under it, in the same card: the full summary and the body at a fixed height that scrolls inside, then
 * links to both sessions with every state and its reason.
 */
function LetterRow({ letter, now }: { letter: Letter; now: number }) {
	useLang();
	const [open, setOpen] = useState(false);
	const panel = useId();
	const from = useSenderName(letter);
	const to = useSessionName(letter.toSession) ?? "";
	const summary = plainLine(letter.summary) || letter.summary;
	const body = bodyAfterSummary(letter.body, letter.summary);
	const failed = ["held", "refused", "dropped"].includes(letter.status);
	const reason =
		letter.statusReason && failed ? t(`letterReason_${letter.statusReason}` as MessageKey) : null;
	const status = (
		<span className={`letter-status letter-status-${letter.status}`}>
			{t(`letterStatus_${letter.status}`)}
		</span>
	);
	return (
		<li className="letter-item" data-open={open}>
			<button
				type="button"
				className="letter-line"
				aria-expanded={open}
				aria-controls={panel}
				onClick={() => setOpen((value) => !value)}
			>
				<span className="letter-line-route">
					{from} → {to}
				</span>
				<span className="tag">{t(`letterKind_${letter.kind}`)}</span>
				<span className="letter-line-summary">{summary}</span>
				<span className="letter-line-meta">
					{failed && status}
					<span className="session-time">{formatAgo(letter.createdAt, now)}</span>
				</span>
				<ChevronIcon />
			</button>
			{open && (
				<div className="letter-panel" id={panel}>
					<Capped className="letter-content" label={summary}>
						<p className="letter-summary">{summary}</p>
						{body && <Markdown text={body} breaks />}
					</Capped>
					<PersonQuotes quotes={letter.quotes} />
					<div className="letter-row-head">
						<span>
							<SenderLink letter={letter} /> → <SessionLink id={letter.toSession} />
						</span>
						{letter.auto && <span>{t("sentByYew")}</span>}
						{status}
						{reason && <span>{reason}</span>}
					</div>
				</div>
			)}
		</li>
	);
}

function LetterList() {
	useLang();
	const letters = useAppState((state) => state.letters);
	const more = useAction(() => loadLetters(true));
	const now = Date.now();
	if (!letters.loaded) return <p className="hint">{t("loading")}</p>;
	if (letters.items.length === 0) return <p className="empty-box">{t("lettersEmpty")}</p>;
	return (
		<>
			<ul className="letter-list letter-lines">
				{letters.items.map((letter) => (
					<LetterRow key={letter.id} letter={letter} now={now} />
				))}
			</ul>
			{letters.nextCursor && (
				<Button busy={more.busy} onClick={() => void more.run()}>
					{t("loadMore")}
				</Button>
			)}
			<ErrorBox error={more.error} />
		</>
	);
}

const TABS: CenterTab[] = ["pending", "decided", "letters"];

/**
 * The approval center, a page of its own in place of the session. In a session you work on one
 * thing; here you clear what every session is waiting for, then go back.
 */
export function CenterPage() {
	useLang();
	const tab = useAppState((state) => state.centerTab);
	const count = useAppState((state) => centerCount(state.center));
	const id = useId();
	const label: Record<CenterTab, string> = {
		pending: t("tabPending"),
		decided: t("tabDecided"),
		letters: t("tabLetters"),
	};
	const icon: Record<CenterTab, ReactNode> = {
		pending: <CenterIcon />,
		decided: <DecisionIcon />,
		letters: <MailIcon />,
	};
	// Arrow keys move between tabs, as in any tab list (WAI-ARIA).
	const onKeyDown = (event: React.KeyboardEvent) => {
		const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
		if (!step) return;
		event.preventDefault();
		const next = TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length] as CenterTab;
		openCenter(next);
		document.getElementById(`${id}-${next}`)?.focus();
	};
	return (
		<main className="main center-main">
			<header className="session-header">
				<SidebarToggle />
				<div className="session-title">
					<h1>{t("approvalCenter")}</h1>
					<span className="session-meta">
						{count > 0 ? t("approvalCount", { n: count }) : t("centerEmpty")}
					</span>
				</div>
			</header>
			<div
				className="center-body"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll area must be reachable by keyboard
				tabIndex={0}
			>
				<div className="center-inner">
					<div className="panel-tabs" role="tablist" aria-label={t("approvalCenter")}>
						{TABS.map((name) => (
							<button
								key={name}
								id={`${id}-${name}`}
								type="button"
								role="tab"
								className="panel-tab"
								aria-selected={tab === name}
								aria-controls={`${id}-panel`}
								tabIndex={tab === name ? 0 : -1}
								onKeyDown={onKeyDown}
								onClick={() => openCenter(name)}
							>
								{icon[name]}
								{label[name]}
								{name === "pending" && count > 0 ? <span className="badge">{count}</span> : null}
							</button>
						))}
					</div>
					<div
						id={`${id}-panel`}
						className="center-panel"
						role="tabpanel"
						aria-labelledby={`${id}-${tab}`}
					>
						{tab === "pending" ? (
							<CenterList />
						) : tab === "decided" ? (
							<DecisionList />
						) : (
							<LetterList />
						)}
					</div>
				</div>
			</div>
		</main>
	);
}
