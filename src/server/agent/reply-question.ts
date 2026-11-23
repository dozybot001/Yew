import type { Approval, QuestionRequest, Session } from "../../shared/types.ts";
import type { ModelGateway } from "../model/gateway.ts";
import type { Store } from "../store.ts";
import { choicesFrom } from "../tools/misc.ts";
import { CHOICES_PROMPT } from "./prompt.ts";
import { sideCall } from "./side.ts";

/** Words a reply uses to offer a next step instead of asking outright. */
const OFFER =
	/如需|需要的话|要不要|是否需要|告诉我|说一声|let me know|tell me if|shall i|should i|would you like|do you want/i;

/**
 * The question a reply ends with, if it ends with one: its last paragraph (outside code) when that asks
 * something or offers a next step. A session that asks the person this way goes idle, so Yew puts the
 * question in the approval center for it: Yew's code carries this, not a rule in the prompt.
 */
export function askedInReply(text: string): string | null {
	const prose = text.replace(/```[\s\S]*?(```|$)/g, "").trim();
	const last =
		prose
			.split(/\n\s*\n/)
			.at(-1)
			?.trim() ?? "";
	if (!last) return null;
	const end = last.replace(/[\s*_`)\]）」』"'”’]+$/u, "");
	if (!/[?？]$/.test(end) && !OFFER.test(last)) return null;
	return last.length > 600 ? `…${last.slice(-600)}` : last;
}

export interface ReplyQuestionsOptions {
	store: Store;
	gateway: ModelGateway;
	log: (line: string) => void;
	/** The main conversation's id, if there is one. */
	mainId: () => string | null;
}

/** The questions Yew puts in the approval center for sessions that asked at the end of a reply. */
export class ReplyQuestions {
	readonly #store: Store;
	readonly #gateway: ModelGateway;
	readonly #log: (line: string) => void;
	readonly #mainId: () => string | null;
	/** Sessions whose question from a reply is getting its choices: stopped when the question goes. */
	readonly #choosing = new Map<string, AbortController>();

	constructor(options: ReplyQuestionsOptions) {
		this.#store = options.store;
		this.#gateway = options.gateway;
		this.#log = options.log;
		this.#mainId = options.mainId;
	}

	/**
	 * A code session's last reply that nobody else reads, ending with a question or an offer, becomes a
	 * question in the approval center, and the session shows that it waits. The latest such question
	 * replaces an older one; the person's next message, or continuing, takes it away.
	 */
	ask(session: Session, said: string): void {
		if (!session.cwd || session.archivedAt !== null || session.id === this.#mainId()) {
			return;
		}
		const older = this.pending(session.id);
		const asked = askedInReply(said);
		if (asked) {
			this.drop(session.id);
			const card = this.#store.createApproval({
				sessionId: session.id,
				toolCallId: null,
				kind: "question",
				request: { questions: [{ question: asked }], fromReply: true },
			});
			const choosing = new AbortController();
			this.#choosing.set(session.id, choosing);
			this.#offerChoices(session, card.id, asked, said, choosing.signal)
				.catch((error: unknown) =>
					this.#log(
						`session ${session.id}: no choices for its question: ${(error as Error).message}`,
					),
				)
				.finally(() => {
					if (this.#choosing.get(session.id) === choosing) this.#choosing.delete(session.id);
				});
		}
		if (asked || older.length > 0) this.#store.setStatus(session.id, "waiting", null);
	}

	/**
	 * Gives a question taken from a reply its choices, so the person answers with one click. A model
	 * writes them from the end of the reply: the provider's small one when it has one, else the
	 * session's own. The card is there meanwhile, and
	 * stays as it is when this fails, when the question has no fixed answers, or when the person has
	 * answered by then.
	 */
	async #offerChoices(
		session: Session,
		approvalId: string,
		asked: string,
		said: string,
		signal: AbortSignal,
	): Promise<void> {
		const wrote = await sideCall({
			store: this.#store,
			gateway: this.#gateway,
			session,
			systemPrompt: CHOICES_PROMPT,
			content: `The end of the reply:\n${said.slice(-3000)}\n\nThe question:\n${asked}`,
			signal,
		});
		const choices = wrote === null ? null : choicesFrom(wrote);
		if (!choices || signal.aborted) return;
		this.#store.amendApproval(approvalId, {
			questions: [{ question: asked, ...choices }],
			fromReply: true,
		});
	}

	pending(sessionId: string): Approval[] {
		return this.#store
			.pendingApprovals(sessionId)
			.filter((approval) => (approval.request as QuestionRequest).fromReply === true);
	}

	drop(sessionId: string): void {
		this.#choosing.get(sessionId)?.abort();
		this.#choosing.delete(sessionId);
		for (const approval of this.pending(sessionId)) this.#store.cancelApproval(approval.id);
	}
}
