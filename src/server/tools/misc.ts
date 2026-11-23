import type { JsonObject } from "../../shared/messages.ts";
import {
	type Question,
	type QuestionAnswer,
	type QuestionOption,
	type QuestionRequest,
	questionsOf,
	type Todo,
} from "../../shared/types.ts";
import { invalid } from "../errors.ts";
import { str, type ToolDefinition, ToolInputError, type ToolResult, text } from "./types.ts";

const STATUSES = ["pending", "in_progress", "done"] as const;

export const todoTool: ToolDefinition = {
	name: "todo",
	description:
		"Keep this session's task list, which the person sees next to the conversation. Send the whole list each time; mark one item in_progress while you work on it and done when finished.",
	parameters: {
		type: "object",
		properties: {
			items: {
				type: "array",
				maxItems: 50,
				items: {
					type: "object",
					properties: {
						text: { type: "string" },
						status: { type: "string", enum: [...STATUSES] },
					},
					required: ["text", "status"],
					additionalProperties: false,
				},
			},
		},
		required: ["items"],
		additionalProperties: false,
	},
	readOnly: false,
	needsFolder: false,
	subject() {
		return { kind: "none" };
	},
	async run(args, ctx): Promise<ToolResult> {
		const items = args.items;
		if (!Array.isArray(items) || items.length > 50)
			throw new ToolInputError("items must be a list of at most 50.");
		const todos: Todo[] = items.map((item) => {
			if (!item || typeof item !== "object" || Array.isArray(item))
				throw new ToolInputError("Each item needs text and status.");
			const record = item as Record<string, unknown>;
			const status = record.status;
			if (typeof record.text !== "string" || !STATUSES.includes(status as Todo["status"])) {
				throw new ToolInputError(
					"Each item needs text and a status of pending, in_progress or done.",
				);
			}
			return { text: record.text.slice(0, 500), status: status as Todo["status"] };
		});
		ctx.setTodos(todos);
		const marks = { pending: "[ ]", in_progress: "[~]", done: "[x]" } as const;
		const list = todos.map((todo) => `${marks[todo.status]} ${todo.text}`).join("\n");
		return { content: [text(list ? `Task list updated:\n${list}` : "Task list cleared.")] };
	},
};

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 6;

/**
 * The questions of an ask_user call. Calls written before a card could hold several questions (one
 * question with plain options) are read the same way.
 */
export function parseQuestions(args: JsonObject): Question[] {
	if (args.questions === undefined && typeof args.question === "string") {
		return parseQuestions({
			questions: [{ question: args.question, options: args.options ?? [] }],
		});
	}
	const list = args.questions;
	if (!Array.isArray(list) || list.length === 0) {
		throw new ToolInputError("questions must list at least one question.");
	}
	if (list.length > MAX_QUESTIONS) {
		throw new ToolInputError(`Ask at most ${MAX_QUESTIONS} questions at once.`);
	}
	return list.map((raw, index) => {
		const item = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
		const question = typeof item.question === "string" ? item.question.trim() : "";
		if (!question) throw new ToolInputError(`Question ${index + 1} is empty.`);
		const rawOptions = Array.isArray(item.options) ? item.options : [];
		if (rawOptions.length > MAX_OPTIONS) {
			throw new ToolInputError(`Question ${index + 1} has more than ${MAX_OPTIONS} options.`);
		}
		const options = rawOptions.map((option) => {
			const fields = (typeof option === "string" ? { label: option } : option) as Record<
				string,
				unknown
			>;
			const label = typeof fields?.label === "string" ? fields.label.trim() : "";
			if (!label) throw new ToolInputError(`An option of question ${index + 1} has no label.`);
			const detail = typeof fields.detail === "string" ? fields.detail.trim() : "";
			return detail ? { label: label.slice(0, 200), detail: detail.slice(0, 500) } : { label };
		});
		let recommended: number | undefined;
		if (item.recommended !== undefined) {
			const value = item.recommended;
			if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > options.length) {
				throw new ToolInputError(
					`recommended of question ${index + 1} must name one of its options.`,
				);
			}
			recommended = (value as number) - 1;
		}
		const header = typeof item.header === "string" ? item.header.trim().slice(0, 24) : "";
		return {
			question: question.slice(0, 2000),
			...(header ? { header } : {}),
			...(options.length > 0 ? { options } : {}),
			...(recommended === undefined ? {} : { recommended }),
			...(item.multiple === true && options.length > 1 ? { multiple: true } : {}),
		};
	});
}

/**
 * The choices a model wrote for a question a reply ended with (REPLY_QUESTION_PROMPT), checked like a
 * session's own: JSON with "options" and perhaps "recommended", anywhere in its reply. Null when that
 * is not what it wrote, or when it gave fewer than two: one choice is no choice.
 */
export function choicesFrom(text: string): Pick<Question, "options" | "recommended"> | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end < start) return null;
	try {
		const wrote = JSON.parse(text.slice(start, end + 1)) as JsonObject;
		const options = Array.isArray(wrote.options) ? wrote.options.slice(0, MAX_OPTIONS) : [];
		if (options.length < 2) return null;
		const pick = wrote.recommended;
		const named =
			typeof pick === "number" && Number.isInteger(pick) && pick >= 1 && pick <= options.length;
		const [question] = parseQuestions({
			questions: [{ question: "?", options, ...(named ? { recommended: pick } : {}) }],
		});
		return {
			options: question?.options ?? [],
			...(question?.recommended === undefined ? {} : { recommended: question.recommended }),
		};
	} catch {
		return null;
	}
}

/**
 * Checks the person's answer against the questions and writes it as the session reads it: the options
 * picked, then their own words. Several questions get one line each.
 */
export function settleAnswer(
	request: QuestionRequest,
	answer: { answer?: string; answers?: QuestionAnswer[] },
): { text: string; answers?: QuestionAnswer[] } {
	const questions = questionsOf(request);
	if (!answer.answers) {
		const words = answer.answer?.trim();
		if (!words) throw invalid("The answer is empty.", "answer");
		return { text: words };
	}
	if (answer.answers.length !== questions.length)
		throw invalid("Answer every question.", "answers");
	const answers: QuestionAnswer[] = [];
	const parts = questions.map((question, index) => {
		const given = answer.answers?.[index] as QuestionAnswer;
		const options = question.options ?? [];
		const choices = [...new Set(given.choices)];
		if (
			choices.some((choice) => !Number.isInteger(choice) || choice < 0 || choice >= options.length)
		) {
			throw invalid("An answer picks an option that does not exist.", "answers");
		}
		if (!question.multiple && choices.length > 1) {
			throw invalid("Pick one option for this question.", "answers");
		}
		const words = given.text?.trim() ?? "";
		if (choices.length === 0 && !words) throw invalid("Answer every question.", "answers");
		answers.push({ choices, ...(words ? { text: words } : {}) });
		const labels = choices.map((choice) => (options[choice] as QuestionOption).label).join(", ");
		return labels && words ? `${labels}; ${words}` : labels || words;
	});
	const text =
		questions.length === 1
			? (parts[0] as string)
			: parts
					.map((part, index) => `${index + 1}. ${questions[index]?.question} → ${part}`)
					.join("\n");
	return { text, answers };
}

export const askUserTool: ToolDefinition = {
	name: "ask_user",
	description:
		"Ask the person and wait for the answer; it waits for them in the approval center. Use it when you cannot go on without an answer only they can give. Up to 4 questions at once. When the answer is a choice, give the options and the one you recommend, so the person answers with one click; leave them out only for what the person has to put in their own words, such as a name or a number. They can always answer in their own words.",
	parameters: {
		type: "object",
		properties: {
			questions: {
				type: "array",
				minItems: 1,
				maxItems: MAX_QUESTIONS,
				items: {
					type: "object",
					properties: {
						question: {
							type: "string",
							description: "The question, understandable on its own.",
						},
						header: {
							type: "string",
							description: "A tag of one to three words shown before it, such as its topic.",
						},
						options: {
							type: "array",
							minItems: 2,
							maxItems: MAX_OPTIONS,
							items: {
								type: "object",
								properties: {
									label: { type: "string", description: "A few words." },
									detail: {
										type: "string",
										description: "What this choice means or leads to, in a short sentence.",
									},
								},
								required: ["label"],
								additionalProperties: false,
							},
						},
						recommended: {
							type: "integer",
							minimum: 1,
							description: "The option you recommend, counting from 1.",
						},
						multiple: {
							type: "boolean",
							description: "The person may pick more than one option.",
						},
					},
					required: ["question"],
					additionalProperties: false,
				},
			},
		},
		required: ["questions"],
		additionalProperties: false,
	},
	readOnly: false,
	needsFolder: false,
	subject() {
		return { kind: "none" };
	},
	async run(args, ctx): Promise<ToolResult> {
		const questions = parseQuestions(args);
		const answer = await ctx.ask({ questions });
		return {
			content: [
				text(
					questions.length === 1
						? `The person answered: ${answer}`
						: `The person answered:\n${answer}`,
				),
			],
		};
	},
};

/** Hands a task to a helper and returns its answer. */
export const delegateTool: ToolDefinition = {
	name: "delegate",
	description:
		"Give a self-contained task to a helper that works in a context of its own and returns only its answer. It can read files, search, fetch pages and run commands that change nothing; it cannot change anything or ask the person. Several delegate calls in one step run at the same time. Use it for searches and investigations whose details you do not need to keep, so your own context stays short.",
	parameters: {
		type: "object",
		properties: {
			task: {
				type: "string",
				description:
					"What to find out and what to report. The helper sees nothing of this conversation, so include what it needs to know.",
			},
		},
		required: ["task"],
		additionalProperties: false,
	},
	// It only looks, so several run at once; each of its own calls is checked as it goes.
	readOnly: true,
	needsFolder: false,
	subject: () => ({ kind: "none" }),
	async run(args, ctx): Promise<ToolResult> {
		const task = str(args, "task", true).trim();
		if (!task) throw new ToolInputError("The task is empty.");
		const result = await ctx.helper(task);
		const note = result.stopped
			? `[The helper stopped before it finished: ${result.stopped}. Above is what it had.]`
			: "";
		const answer =
			[result.text, note].filter(Boolean).join("\n\n") || "(The helper gave no answer.)";
		return {
			content: [{ type: "text", text: answer }],
			detail: { calls: result.calls, ...(result.stopped ? { stopped: result.stopped } : {}) },
			...(result.stopped && !result.text ? { isError: true } : {}),
		};
	},
};
