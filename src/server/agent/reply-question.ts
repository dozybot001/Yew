import type { JsonObject } from "../../shared/messages.ts";
import type { Approval, Question, QuestionRequest, Session } from "../../shared/types.ts";
import type { ModelGateway } from "../model/gateway.ts";
import type { Store } from "../store.ts";
import { choicesFrom } from "../tools/misc.ts";
import { clip } from "./context.ts";
import { REPLY_QUESTION_PROMPT } from "./prompt.ts";
import { sideCall } from "./side.ts";

/** How much of the end of a reply the model reads. */
const REPLY_END_CHARS = 3000;
const MAX_QUESTION_CHARS = 600;

/**
 * What a model made of the end of a reply (REPLY_QUESTION_PROMPT): the question it asks the person,
 * with choices when the model wrote usable ones. Null when the reply asks nothing, and when what the
 * model wrote is not the JSON it was asked for.
 */
export function questionFrom(text: string): Question | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end < start) return null;
	let wrote: JsonObject;
	try {
		wrote = JSON.parse(text.slice(start, end + 1)) as JsonObject;
	} catch {
		return null;
	}
	const question = typeof wrote.question === "string" ? wrote.question.trim() : "";
	if (wrote.asks !== true || !question) return null;
	return { question: clip(question, MAX_QUESTION_CHARS), ...(choicesFrom(text) ?? {}) };
}

/**
 * What the session is told when its question became a card, so it knows where the answer comes from.
 * The words are fixed. The entry is a system message, and the question and the answers on the card
 * were written by a model from a reply that may repeat a page or a file: put in here, such text
 * would reach the session with the weight of a system message.
 */
export const CARD_NOTE = [
	"Your last reply left the person a question, so Yew put it in their approval center as a card.",
	"They pick one of the answers Yew wrote for it or write their own, and what they answer arrives as their next message to you.",
	"If they write to you first, the card is withdrawn.",
].join(" ");

export interface ReplyQuestionsOptions {
	store: Store;
	gateway: ModelGateway;
	log: (line: string) => void;
	/** The main conversation's id, if there is one. */
	mainId: () => string | null;
	isRunning: (sessionId: string) => boolean;
	/** A reply has been read: letters that waited for the reading can start the session now. */
	settled: (sessionId: string) => void;
	/** False to leave replies unread. */
	enabled: boolean;
}

/** The questions Yew puts in the approval center for sessions that asked at the end of a reply. */
export class ReplyQuestions {
	readonly #store: Store;
	readonly #gateway: ModelGateway;
	readonly #log: (line: string) => void;
	readonly #mainId: () => string | null;
	readonly #isRunning: (sessionId: string) => boolean;
	readonly #settled: (sessionId: string) => void;
	readonly #enabled: boolean;
	/** Sessions whose latest reply is being read: stopped when the person steps in. */
	readonly #reading = new Map<string, AbortController>();

	constructor(options: ReplyQuestionsOptions) {
		this.#store = options.store;
		this.#gateway = options.gateway;
		this.#log = options.log;
		this.#mainId = options.mainId;
		this.#isRunning = options.isRunning;
		this.#settled = options.settled;
		this.#enabled = options.enabled;
	}

	/** Whether the session's latest reply is still being read. Letters wait until it is. */
	reading(sessionId: string): boolean {
		return this.#reading.has(sessionId);
	}

	/**
	 * A code session ended its turn with a reply that nobody else reads. A model reads the end of it,
	 * the one for jobs beside a conversation (side.ts), and says whether it asks the person
	 * something: no list of words decides that. A question goes to the approval center with the
	 * likely answers as its choices, the session shows that it waits, and the session is told that
	 * the card is there. The latest such question replaces an older one; the person's next message,
	 * or continuing, takes it away.
	 */
	ask(session: Session, said: string): void {
		if (!this.#enabled) return;
		if (!session.cwd || session.archivedAt !== null || session.id === this.#mainId()) return;
		// An older question stands until this reply is found to ask a new one.
		if (this.pending(session.id).length > 0) this.#store.setStatus(session.id, "waiting", null);
		if (!said.trim()) return;
		this.#reading.get(session.id)?.abort();
		const reading = new AbortController();
		this.#reading.set(session.id, reading);
		this.#read(session, said, reading.signal)
			.catch((error: unknown) =>
				this.#log(
					`session ${session.id}: its reply was not read for a question: ${(error as Error).message}`,
				),
			)
			.finally(() => {
				if (this.#reading.get(session.id) !== reading) return;
				this.#reading.delete(session.id);
				this.#settled(session.id);
			});
	}

	async #read(session: Session, said: string, signal: AbortSignal): Promise<void> {
		const wrote = await sideCall({
			store: this.#store,
			gateway: this.#gateway,
			session,
			systemPrompt: REPLY_QUESTION_PROMPT,
			content: `The end of the reply:\n${said.slice(-REPLY_END_CHARS)}`,
			signal,
		});
		const question = wrote === null ? null : questionFrom(wrote);
		if (!question || signal.aborted) return;
		// Archived or at work again meanwhile: the question is no longer what the session waits on.
		if (this.#store.getSession(session.id).archivedAt !== null || this.#isRunning(session.id))
			return;
		this.#store.tx(() => {
			for (const older of this.pending(session.id)) this.#store.cancelApproval(older.id);
			this.#store.createApproval({
				sessionId: session.id,
				toolCallId: null,
				kind: "question",
				request: { questions: [question], fromReply: true },
			});
			// Yew's word to the session, like a change of its name: not the person's, and no client shows it as theirs.
			this.#store.appendEntry(session.id, {
				role: "system",
				message: { role: "system", content: CARD_NOTE, timestamp: Date.now() },
			});
			this.#store.setStatus(session.id, "waiting", null);
		});
	}

	pending(sessionId: string): Approval[] {
		return this.#store
			.pendingApprovals(sessionId)
			.filter((approval) => (approval.request as QuestionRequest).fromReply === true);
	}

	/** The person stepped in: the reading stops and the questions from replies go. */
	drop(sessionId: string): void {
		this.#reading.get(sessionId)?.abort();
		this.#reading.delete(sessionId);
		for (const approval of this.pending(sessionId)) this.#store.cancelApproval(approval.id);
	}
}
