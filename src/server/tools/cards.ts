import type { CardOption } from "../../shared/types.ts";
import { decisionReport } from "../mail/envelope.ts";
import type { CardInput } from "../mail/post.ts";
import { attempt } from "./mail.ts";
import { int, str, type ToolDefinition, ToolInputError, type ToolResult, text } from "./types.ts";

const CARD_PROPERTIES = {
	title: { type: "string", description: "The question to decide, short enough for one line." },
	context: {
		type: "string",
		description: "What the person needs to know to decide, in two or three short sentences.",
	},
	options: {
		type: "array",
		maxItems: 6,
		description:
			"The choices. Give them whenever the decision is a choice, so the person decides with one click; they can also answer with a note.",
		items: {
			type: "object",
			properties: {
				label: { type: "string", description: "A few words, such as the action to take." },
				detail: {
					type: "string",
					description:
						"What happens if the person picks it, in a short sentence. Leave it out when the label says it.",
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
	deadline: {
		type: "string",
		description:
			'When it must be decided, in a few words, such as "2026-11-12" or "before the release".',
	},
	sessions: {
		type: "array",
		items: { type: "string" },
		description: "Ids of other sessions involved, besides the one that asked and you.",
	},
	undoable: {
		type: "boolean",
		description: "Whether the decision can be undone after it is carried out.",
	},
	reversible: {
		type: "string",
		description:
			"How to undo it, or what cannot be undone, in a few words. Leave it out when that is obvious.",
	},
	after: {
		type: "string",
		description:
			"Who does what once it is decided, when the options do not say it. Leave it out when the decision only goes back to the session that asked.",
	},
} as const;

function cardInput(args: Record<string, unknown>): CardInput {
	const input: CardInput = {};
	for (const key of ["title", "context", "deadline", "reversible", "after"] as const) {
		const value = args[key];
		if (value !== undefined) {
			if (typeof value !== "string") throw new ToolInputError(`${key} must be text.`);
			input[key] = value;
		}
	}
	if (args.options !== undefined) {
		if (!Array.isArray(args.options)) throw new ToolInputError("options must be a list.");
		input.options = args.options.map((option) => {
			if (!option || typeof option !== "object")
				throw new ToolInputError("Each option needs a label.");
			const { label, detail } = option as Record<string, unknown>;
			if (typeof label !== "string") throw new ToolInputError("Each option needs a label.");
			return (typeof detail === "string" && detail ? { label, detail } : { label }) as CardOption;
		});
	}
	if (args.recommended !== undefined) {
		const value = args.recommended;
		if (value === null) input.recommended = null;
		else if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
			throw new ToolInputError("recommended must count from 1.");
		} else input.recommended = value - 1;
	}
	if (args.undoable !== undefined) {
		if (typeof args.undoable !== "boolean")
			throw new ToolInputError("undoable must be true or false.");
		input.undoable = args.undoable;
	}
	if (args.sessions !== undefined) {
		if (!Array.isArray(args.sessions) || args.sessions.some((id) => typeof id !== "string")) {
			throw new ToolInputError("sessions must be a list of session ids.");
		}
		input.sessions = args.sessions as string[];
	}
	return input;
}

const maintainers = (_session: unknown, roles: { canPostCards: boolean }) => roles.canPostCards;

function cardText(number: number, title: string, verb: string): ToolResult {
	return { content: [text(`#${number} ${verb}: ${title}`)] };
}

export const postCardTool: ToolDefinition = {
	name: "post_card",
	description:
		"Put a decision card in the approval center for the person. Their decision goes to the requesting session and to you.",
	parameters: {
		type: "object",
		properties: {
			...CARD_PROPERTIES,
			requested_by: {
				type: "string",
				description:
					"The session whose request this is; the decision goes back to it. Without it, Yew uses the one session whose request is open with you, if there is one.",
			},
			replaces: {
				type: "array",
				items: { type: "integer" },
				description: "Numbers of waiting cards this one replaces; they are withdrawn.",
			},
		},
		required: ["title", "undoable"],
		additionalProperties: false,
	},
	readOnly: false,
	needsFolder: false,
	offered: maintainers,
	subject() {
		return { kind: "none" };
	},
	async run(args, ctx): Promise<ToolResult> {
		const requestedBy = str(args, "requested_by");
		const replaces = args.replaces;
		if (
			replaces !== undefined &&
			(!Array.isArray(replaces) || replaces.some((n) => !Number.isInteger(n)))
		) {
			throw new ToolInputError("replaces must be a list of card numbers.");
		}
		const card = attempt(() =>
			ctx.mail.post.postCard(ctx.session, {
				...cardInput(args),
				...(requestedBy ? { requestedBy } : {}),
				...(replaces ? { replaces: replaces as number[] } : {}),
			}),
		);
		return {
			...cardText(card.number, card.title, "is in the approval center"),
			detail: { cardNumber: card.number },
		};
	},
};

export const updateCardTool: ToolDefinition = {
	name: "update_card",
	description:
		"Change a card that is still waiting for the person. Give its number and only the fields that change.",
	parameters: {
		type: "object",
		properties: { number: { type: "integer", minimum: 1 }, ...CARD_PROPERTIES },
		required: ["number"],
		additionalProperties: false,
	},
	readOnly: false,
	needsFolder: false,
	offered: maintainers,
	subject() {
		return { kind: "none" };
	},
	async run(args, ctx): Promise<ToolResult> {
		const number = int(args, "number", 1, Number.MAX_SAFE_INTEGER) as number;
		const card = attempt(() => ctx.mail.post.updateCard(ctx.session, number, cardInput(args)));
		return { ...cardText(card.number, card.title, "was updated"), detail: { cardNumber: number } };
	},
};

export const withdrawCardTool: ToolDefinition = {
	name: "withdraw_card",
	description:
		"Take a card that no longer needs deciding out of the approval center, with the reason.",
	parameters: {
		type: "object",
		properties: { number: { type: "integer", minimum: 1 }, reason: { type: "string" } },
		required: ["number", "reason"],
		additionalProperties: false,
	},
	readOnly: false,
	needsFolder: false,
	offered: maintainers,
	subject() {
		return { kind: "none" };
	},
	async run(args, ctx): Promise<ToolResult> {
		const number = int(args, "number", 1, Number.MAX_SAFE_INTEGER) as number;
		const card = attempt(() =>
			ctx.mail.post.withdrawCard(ctx.session, number, str(args, "reason", true)),
		);
		return {
			...cardText(card.number, card.title, "was withdrawn"),
			detail: { cardNumber: number },
		};
	},
};

export const listCardsTool: ToolDefinition = {
	name: "list_cards",
	description: "List the cards waiting in the approval center and the ten latest decisions.",
	parameters: { type: "object", properties: {}, additionalProperties: false },
	readOnly: true,
	needsFolder: false,
	offered: maintainers,
	subject() {
		return { kind: "none" };
	},
	async run(_args, ctx): Promise<ToolResult> {
		const post = ctx.mail.post;
		const names = (id: string) => post.sessionName(id);
		const pending = post.mail.pendingCards();
		const decided = post.mail.listCards({ status: "decided", limit: 10 }).items;
		const parts = [
			pending.length > 0
				? `Waiting for the person:\n\n${pending.map((card) => decisionReport(card, names)).join("\n\n")}`
				: "No cards are waiting for the person.",
		];
		if (decided.length > 0) {
			parts.push(
				`Latest decisions:\n\n${decided.map((card) => decisionReport(card, names)).join("\n\n")}`,
			);
		}
		return { content: [text(parts.join("\n\n"))] };
	},
};
