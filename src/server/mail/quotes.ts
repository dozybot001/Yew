import { messageText, type PersonQuote } from "../../shared/messages.ts";
import {
	type Approval,
	type Entry,
	type QuestionRequest,
	questionsOf,
	type Session,
} from "../../shared/types.ts";
import { isOwnNote } from "../agent/context.ts";
import { invalid } from "../errors.ts";
import type { Store } from "../store.ts";
import type { MailStore } from "./store.ts";

/** Quotes one letter may carry. */
export const QUOTES_MAX = 10;
/** Characters in one quote. */
export const QUOTE_MAX = 4000;
/**
 * Fewer characters than this, whitespace aside, cannot stand on their own: "好" or "no" cut out of a
 * longer message could mean anything. A quote that short must be all the person wrote or chose.
 */
const SHORT = 4;
/** Decisions searched, newest first. */
const DECISIONS = 500;

/** Somewhere Yew recorded the person writing or choosing words. */
export interface QuoteSource {
	text: string;
	/** Where the words come from, as the quote tells it. */
	origin: Omit<PersonQuote, "text" | "excerpt">;
	/** Only all of it counts: the words of an option the person chose are the session's, not theirs. */
	wholeOnly?: boolean;
	/** Already part of something longer the person wrote. */
	excerpt?: boolean;
}

/** Whitespace is the one difference a quote may have from the person's words. */
const flat = (text: string) => text.normalize("NFC").replace(/\s+/gu, "");

/** Quote marks a session may put around the person's words. */
const MARKS: [string, string][] = [
	["「", "」"],
	["『", "』"],
	["“", "”"],
	["‘", "’"],
	['"', '"'],
	["'", "'"],
];

function unquoted(text: string): string | null {
	for (const [open, close] of MARKS) {
		if (text.length > open.length + close.length && text.startsWith(open) && text.endsWith(close)) {
			return text.slice(open.length, text.length - close.length).trim();
		}
	}
	return null;
}

/** The part of `text` that is `length` characters from `start` once whitespace is left out. */
function span(text: string, start: number, length: number): string {
	const source = text.normalize("NFC");
	let seen = 0;
	let from = 0;
	let to = source.length;
	for (let index = 0; index < source.length; index++) {
		if (/\s/u.test(source[index] as string)) continue;
		if (seen === start) from = index;
		seen++;
		if (seen === start + length) {
			to = index + 1;
			break;
		}
	}
	return source.slice(from, to);
}

const clip = (text: string) => {
	const line = text.replace(/\s+/g, " ");
	return [...line].length > 60 ? `${[...line].slice(0, 60).join("")}…` : line;
};

type Found = { source: QuoteSource; whole: boolean; start: number; length: number };

/** All of what the person wrote first, wherever it is; then part of it, in the order of `sources`. */
function find(wanted: string, sources: QuoteSource[], flats: string[]): Found | "short" | null {
	const needle = flat(wanted);
	if (!needle) return null;
	let short = false;
	let part: Found | null = null;
	for (const [index, source] of sources.entries()) {
		const hay = flats[index] as string;
		if (hay === needle) return { source, whole: true, start: 0, length: needle.length };
		if (part || source.wholeOnly) continue;
		const at = hay.indexOf(needle);
		if (at < 0) continue;
		if ([...needle].length < SHORT) short = true;
		else part = { source, whole: false, start: at, length: needle.length };
	}
	return part ?? (short ? "short" : null);
}

/**
 * The person's words a session wants a letter to carry, as Yew found them in `sources`. The text kept
 * is the person's own, never the session's copy of it. A quote Yew cannot find stops the letter: the
 * session corrects it or leaves it out.
 */
export function matchQuotes(wanted: unknown, sources: () => QuoteSource[]): PersonQuote[] {
	if (wanted === undefined || wanted === null) return [];
	if (!Array.isArray(wanted))
		throw invalid("quotes must be a list of the person's words.", "quotes");
	if (wanted.length === 0) return [];
	if (wanted.length > QUOTES_MAX) {
		throw invalid(`A letter can carry at most ${QUOTES_MAX} quotes.`, "quotes");
	}
	const all = sources();
	const flats = all.map((source) => flat(source.text));
	return wanted.map((item, index) => {
		const number = index + 1;
		if (typeof item !== "string" || !item.trim()) {
			throw invalid(`Quote ${number} is empty.`, "quotes");
		}
		const text = item.trim();
		if ([...text].length > QUOTE_MAX) {
			throw invalid(
				`Quote ${number} is longer than ${QUOTE_MAX} characters; quote the part that matters.`,
				"quotes",
			);
		}
		let found = find(text, all, flats);
		const inner = found === null || found === "short" ? unquoted(text) : null;
		if (inner) found = find(inner, all, flats) ?? found;
		if (found === "short") {
			throw invalid(
				`Quote ${number} ("${clip(text)}") is a few characters out of something longer the person wrote. Quote at least ${SHORT} characters, or all of it.`,
				"quotes",
			);
		}
		if (!found) {
			throw invalid(
				`Quote ${number} ("${clip(text)}") is not something the person wrote or chose. Yew looks in their messages to you, their answers to your questions, their decisions, and the quotes in letters you received. Copy their words exactly, or leave the quote out.`,
				"quotes",
			);
		}
		const { source, whole, start, length } = found;
		return {
			text: whole ? source.text.normalize("NFC").trim() : span(source.text, start, length),
			...source.origin,
			...(!whole || source.excerpt ? { excerpt: true } : {}),
		};
	});
}

/** What the person wrote in an entry: not a letter, not Yew's note or a hook's output. */
function personText(entry: Entry): string | null {
	if (entry.role !== "user" || entry.letter) return null;
	const text = messageText(entry.message).trim();
	return text && !isOwnNote(text) ? text : null;
}

/** Where the person wrote an entry: a forked session starts with copies of its opener's messages. */
function writtenIn(store: Store, session: Session, entry: Entry): Session {
	let where = session;
	while (where.parentId) {
		let parent: Session;
		try {
			parent = store.getSession(where.parentId);
		} catch {
			break;
		}
		const same = store.entryAt(parent.id, entry.seq);
		if (same?.role !== "user" || same.createdAt !== entry.createdAt) break;
		where = parent;
	}
	return where;
}

/** The person's answer to a session's question: words they typed, and options they picked. */
function answerSources(approval: Approval, session: Session): QuoteSource[] {
	const response = approval.response;
	if (!response) return [];
	const origin = {
		source: "answer" as const,
		sessionId: session.id,
		sessionName: session.name,
		at: approval.resolvedAt ?? approval.createdAt,
	};
	if (!response.answers) {
		const words = response.answer?.trim();
		return words ? [{ text: words, origin }] : [];
	}
	const questions = questionsOf(approval.request as QuestionRequest);
	return response.answers.flatMap((answer, index) => {
		const options = questions[index]?.options ?? [];
		const picked: QuoteSource[] = answer.choices.flatMap((choice) => {
			const label = options[choice]?.label;
			return label ? [{ text: label, origin: { ...origin, chosen: true }, wholeOnly: true }] : [];
		});
		const words = answer.text?.trim();
		return words ? [...picked, { text: words, origin }] : picked;
	});
}

/**
 * Where a session may find the person's words to pass on, in the order a part of them is looked for:
 * what the person wrote to it (a forked session's copies count for the session they were written in),
 * their answers to its questions, words of the person in letters it received, and decisions. Only
 * what the session has seen, or could look up with check_decision: since a quote that is not found
 * says so and costs nothing, words it never saw could be guessed out of a source piece by piece. The
 * person's message that started a chain of letters reaches the next sessions only as quotes in the
 * letters, put there by the session the person wrote to.
 */
export function quoteSources(store: Store, mail: MailStore, session: Session): QuoteSource[] {
	const sources: QuoteSource[] = [];
	const answered = store.answeredQuestions(session.id);
	// An answer to a question at the end of a reply also reaches the session as a message, which may
	// hold the session's options: it counts as the answer.
	const asAnswers = new Set(
		answered
			.filter((approval) => (approval.request as QuestionRequest).fromReply)
			.map((approval) => approval.response?.answer?.trim() ?? ""),
	);
	const entries = store.allEntries(session.id);
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as Entry;
		const text = personText(entry);
		if (!text || asAnswers.has(text)) continue;
		const where = writtenIn(store, session, entry);
		sources.push({
			text,
			origin: {
				source: "message",
				sessionId: where.id,
				sessionName: where.name,
				at: entry.createdAt,
			},
		});
	}
	for (const approval of answered) sources.push(...answerSources(approval, session));
	for (const quote of mail.receivedQuotes(session.id)) {
		const { text, excerpt, ...origin } = quote;
		sources.push({
			text,
			origin,
			...(origin.chosen ? { wholeOnly: true } : {}),
			...(excerpt ? { excerpt: true } : {}),
		});
	}
	for (const card of mail.listCards({ status: "decided", limit: DECISIONS }).items) {
		const origin = {
			source: "decision" as const,
			sessionId: null,
			sessionName: null,
			card: card.number,
			at: card.decidedAt ?? card.updatedAt,
		};
		const label = card.choice === null ? null : card.options[card.choice]?.label;
		if (label) sources.push({ text: label, origin: { ...origin, chosen: true }, wholeOnly: true });
		if (card.note?.trim()) sources.push({ text: card.note.trim(), origin });
	}
	return sources;
}
