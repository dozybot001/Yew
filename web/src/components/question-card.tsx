import { type ReactNode, useId, useState } from "react";
import {
	type Approval,
	type Question,
	type QuestionRequest,
	questionsOf,
} from "../../../src/shared/types.ts";
import { answerApproval } from "../actions.ts";
import { formatWaited, t } from "../i18n.ts";
import { QuestionIcon, SendIcon } from "./icons.tsx";
import { Button, CardHead, ErrorBox, useAction, useNow } from "./ui.tsx";

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
