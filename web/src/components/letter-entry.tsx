import {
	bodyAfterSummary,
	type LetterRef,
	type PersonQuote,
	plainLine,
} from "../../../src/shared/messages.ts";
import { selectSession } from "../actions.ts";
import { formatWhen, t, useLang } from "../i18n.ts";
import { useAppState } from "../state.ts";
import { Capped, Markdown } from "./content.tsx";
import { DecisionIcon, MailIcon, QuoteIcon } from "./icons.tsx";

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
export function LetterEntry({ letter }: { letter: LetterRef }) {
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
