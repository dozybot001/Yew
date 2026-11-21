import type { CardOption, Letter, TaskOutcome } from "../../shared/types.ts";
import { TASK_OUTCOMES, THINKING_LEVELS } from "../../shared/types.ts";
import { YewError } from "../errors.ts";
import { decisionReport, directoryLine, neutralize } from "../mail/envelope.ts";
import { type CardInput, reasonText } from "../mail/post.ts";
import { QUOTES_MAX } from "../mail/quotes.ts";
import {
	bool,
	CONFIRM_ARGUMENT,
	errorResult,
	int,
	type Lookup,
	type MailContext,
	str,
	type ToolDefinition,
	ToolInputError,
	type ToolResult,
	text,
	type WaitResult,
} from "./types.ts";

/** Yew's domain errors become messages the model can act on. */
function attempt<T>(fn: () => T): T {
	try {
		return fn();
	} catch (error) {
		if (error instanceof YewError) throw new ToolInputError(error.message);
		throw error;
	}
}

function choice<T extends string>(
	args: Record<string, unknown>,
	key: string,
	values: readonly T[],
): T | undefined {
	const value = args[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || !values.includes(value as T)) {
		throw new ToolInputError(`${key} must be one of: ${values.join(", ")}.`);
	}
	return value as T;
}

function nameOf(mail: MailContext, id: string): string {
	return mail.post.sessionName(id) ?? id;
}

/** What a waiting call returns. The other session's words cannot pass for Yew's own tags. */
function waitText(name: string, result: WaitResult): ToolResult {
	switch (result.kind) {
		case "letter": {
			const letter = result.letter;
			const words = neutralize(`${letter.summary}${letter.body ? `\n\n${letter.body}` : ""}`);
			return {
				content: [text(`${name} wrote back (letter ${letter.id}, ${letter.kind}):\n${words}`)],
			};
		}
		case "ended": {
			const said = neutralize(result.text.trim());
			if (result.stopped) {
				return errorResult(
					`The person stopped ${name} before it finished.${said ? ` Its last reply:\n${said}` : ""} When it goes on, its reply comes to you as a letter.`,
				);
			}
			if (result.status === "error") {
				return errorResult(
					`${name} stopped with an error: ${result.detail ?? "unknown error"}\nWhen it goes on, its reply comes to you as a letter.`,
				);
			}
			return {
				content: [
					text(`${name} finished its turn. Its last reply:\n${said || "(no written reply)"}`),
				],
			};
		}
		case "timeout":
			return {
				content: [
					text(
						`${name} is still working after 30 minutes. Its reply will come to you as a letter.`,
					),
				],
			};
		case "cycle":
			return {
				content: [
					text(
						`Not waiting: ${name} is already waiting for you, directly or through other sessions. The letter was sent; its reply will come to you as a letter.`,
					),
				],
			};
		case "not-running":
			return {
				content: [
					text(
						`${name} is not running (${result.status}); the letter waits until the person continues it. Its reply will come to you as a letter.`,
					),
				],
			};
		case "stopped":
			return errorResult(`Stopped while waiting for ${name}.`);
		case "archived":
			return errorResult(`${name} was archived before it read the letter; it will not answer.`);
	}
}

/** What happened to a letter, for the sender. Undelivered letters are errors so the model notices. */
function sentText(mail: MailContext, letter: Letter): ToolResult | null {
	const name = nameOf(mail, letter.toSession);
	if (letter.status === "refused" || letter.status === "dropped") {
		return errorResult(`Not sent to ${name}: ${reasonText(letter.statusReason)}.`);
	}
	if (letter.status === "held") {
		return {
			content: [
				text(
					`Letter ${letter.id} to ${name} is held: ${reasonText(letter.statusReason)}. The person can release it in the approval center; do not send it again.`,
				),
			],
		};
	}
	return null;
}

/** The quotes parameter of send_letter and open_session. */
const QUOTES_ARGUMENT = {
	type: "array",
	maxItems: QUOTES_MAX,
	items: { type: "string" },
	description:
		"The person's words you pass on, each copied exactly from a message they wrote to you, their answer to your question, a decision of theirs, or a quote in a letter you received; part of a message is fine. Yew finds each one and shows it with the letter as the person's own words, so the recipient need not check it. A quote Yew cannot find stops the letter.",
} as const;

/** What the sender hears about the quotes Yew attached. */
function quotesNote(letter: Letter): string {
	const count = letter.quotes?.length ?? 0;
	if (count === 0) return "";
	return count === 1
		? ", with the person's words Yew found"
		: `, with ${count} quotes of the person's words Yew found`;
}

function letterDetail(mail: MailContext, letter: Letter) {
	return {
		letterId: letter.id,
		to: letter.toSession,
		toName: nameOf(mail, letter.toSession),
		kind: letter.kind,
		status: letter.status,
		...(letter.statusReason ? { reason: letter.statusReason } : {}),
	};
}

export const listSessionsTool: ToolDefinition = {
	name: "list_sessions",
	description:
		"List the sessions (id, name, kind, status, team, model, permission mode and the first line of each role), the teams and Yew's settings.",
	parameters: { type: "object", properties: {}, additionalProperties: false },
	readOnly: true,
	needsFolder: false,
	subject() {
		return { kind: "none" };
	},
	async run(_args, ctx): Promise<ToolResult> {
		const post = ctx.mail.post;
		const { sessions, groups } = post.directory();
		const main = post.mainSessionId();
		const lines = sessions.map((session) =>
			directoryLine(session, {
				you: session.id === ctx.session.id,
				main: session.id === main,
				parentName: session.parentId ? nameOf(ctx.mail, session.parentId) : null,
				group: session.groupId ? (groups.get(session.groupId) ?? null) : null,
			}),
		);
		const teams = [...groups].map(([id, name]) => `- ${id} · ${name}`);
		const settings = post.settings();
		const workspaces = settings.workspaces.map((workspace) => workspace.path).join(", ");
		const yew = [
			`- default model: ${settings.defaultModel.provider}/${settings.defaultModel.model} (${settings.defaultModel.thinking})`,
			`- decision log: ${settings.decisionLog ?? "none"}`,
			`- daily budget for all sessions: ${settings.dailyBudget ? `$${settings.dailyBudget}` : "none"}`,
			`- workspaces: ${workspaces || "none"}`,
			`- theme: ${settings.theme}; language: ${settings.language}`,
		];
		return {
			content: [
				text(
					`Sessions (id · name · kind · status · …):\n${lines.join("\n")}\n\nTeams (id · name):\n${teams.length > 0 ? teams.join("\n") : "(none)"}\n\nSettings:\n${yew.join("\n")}`,
				),
			],
		};
	},
};

export const sendLetterTool: ToolDefinition = {
	name: "send_letter",
	description:
		"Send a letter to another session. A notice is for information; a request asks the recipient to do or answer something, and its final reply comes back to you as a letter; a report gives the result of something you were asked. With wait, this call waits until the recipient replies to this letter or finishes its turn (at most 30 minutes) and returns its answer. Do not write only to acknowledge or thank.",
	parameters: {
		type: "object",
		properties: {
			to: { type: "string", description: "The recipient, by name or id." },
			kind: { type: "string", enum: ["notice", "request", "report"] },
			summary: { type: "string", description: "One line that makes sense on its own." },
			body: {
				type: "string",
				description: "Details, if any. Plain text; refer to files by their path.",
			},
			reply_to: {
				type: "string",
				description:
					"The letter this answers. A report to a session whose request you have open is linked to it without this.",
			},
			quotes: QUOTES_ARGUMENT,
			wait: {
				type: "boolean",
				description: "Wait for the recipient's answer and get it as this call's result.",
			},
		},
		required: ["to", "kind", "summary"],
		additionalProperties: false,
	},
	readOnly: false,
	needsFolder: false,
	subject() {
		return { kind: "none" };
	},
	async run(args, ctx): Promise<ToolResult> {
		const kind = choice(args, "kind", ["notice", "request", "report"] as const) ?? "notice";
		const body = str(args, "body");
		const replyTo = str(args, "reply_to");
		const letter = attempt(() =>
			ctx.mail.send({
				to: str(args, "to", true),
				kind,
				summary: str(args, "summary", true),
				...(body !== undefined ? { body } : {}),
				...(replyTo !== undefined ? { replyTo } : {}),
				...(args.quotes !== undefined ? { quotes: args.quotes } : {}),
			}),
		);
		const detail = letterDetail(ctx.mail, letter);
		const problem = sentText(ctx.mail, letter);
		if (problem) return { ...problem, detail };
		const name = nameOf(ctx.mail, letter.toSession);
		if (bool(args, "wait")) {
			return { ...waitText(name, await ctx.mail.wait(letter)), detail };
		}
		const after =
			kind === "request" ? ` When ${name} finishes, its reply comes back to you as a letter.` : "";
		return {
			content: [text(`Letter ${letter.id} sent to ${name}${quotesNote(letter)}.${after}`)],
			detail,
		};
	},
};

export const checkDecisionTool: ToolDefinition = {
	name: "check_decision",
	description:
		"Look up a decision the person made in the approval center, by its number: the question, the person's choice and note. Use it before you act on a decision another session tells you about.",
	parameters: {
		type: "object",
		properties: { number: { type: "integer", minimum: 1 } },
		required: ["number"],
		additionalProperties: false,
	},
	readOnly: true,
	needsFolder: false,
	subject() {
		return { kind: "none" };
	},
	async run(args, ctx): Promise<ToolResult> {
		const number = int(args, "number", 1, Number.MAX_SAFE_INTEGER) as number;
		const post = ctx.mail.post;
		let card: ReturnType<typeof post.mail.cardByNumber>;
		try {
			card = post.mail.cardByNumber(number);
		} catch {
			return errorResult(`There is no decision #${number}.`);
		}
		return { content: [text(decisionReport(card, (id) => post.sessionName(id)))] };
	},
};

export const openSessionTool: ToolDefinition = {
	name: "open_session",
	description:
		"Open a task session for one job and give it a brief. It works with your permissions or fewer, in your working folder or a folder inside it, and its final replies come back to you as letters. With wait, this call waits until it finishes its first turn (at most 30 minutes) and returns its reply.",
	parameters: {
		type: "object",
		properties: {
			name: { type: "string", description: "A short name for the task session." },
			brief: {
				type: "string",
				description:
					"The task, written so the new session can work from it alone: the goal, what it needs to know, limits, and what to report.",
			},
			folder: {
				type: "string",
				description:
					'Its working folder: yours (the default), a folder inside yours, or "none" for a chat without files.',
			},
			model: { type: "string", description: '"provider/model" to use instead of yours.' },
			wait: { type: "boolean", description: "Wait for its first reply." },
			fork: {
				type: "boolean",
				description:
					"Give it a copy of this conversation so far, so it knows what you know and the brief can be short. Its first request carries all of that.",
			},
			quotes: QUOTES_ARGUMENT,
			confirm: CONFIRM_ARGUMENT,
		},
		required: ["name", "brief"],
		additionalProperties: false,
	},
	readOnly: false,
	needsFolder: false,
	subject(args) {
		return { kind: "act", tool: "open_session", summary: str(args, "name", true) };
	},
	preview(args) {
		const brief = typeof args.brief === "string" ? args.brief.trim() : "";
		return brief ? { description: brief.length > 600 ? `${brief.slice(0, 600)}…` : brief } : {};
	},
	async run(args, ctx): Promise<ToolResult> {
		const folder = str(args, "folder");
		const model = str(args, "model");
		let provider: string | undefined;
		let modelId: string | undefined;
		if (model) {
			const slash = model.indexOf("/");
			if (slash <= 0 || slash === model.length - 1) {
				throw new ToolInputError('model must look like "provider/model".');
			}
			provider = model.slice(0, slash);
			modelId = model.slice(slash + 1);
		}
		const opened = attempt(() =>
			ctx.mail.open({
				name: str(args, "name", true),
				brief: str(args, "brief", true),
				...(folder === undefined ? {} : { cwd: folder === "none" ? null : folder }),
				...(provider && modelId ? { provider, model: modelId } : {}),
				...(bool(args, "fork") ? { fork: true } : {}),
				...(args.quotes !== undefined ? { quotes: args.quotes } : {}),
			}),
		);
		const detail = {
			sessionId: opened.session.id,
			name: opened.session.name,
			letterId: opened.letter.id,
		};
		const problem = sentText(ctx.mail, opened.letter);
		if (problem) return { ...problem, detail };
		if (bool(args, "wait")) {
			return { ...waitText(opened.session.name, await ctx.mail.wait(opened.letter)), detail };
		}
		return {
			content: [
				text(
					`Opened the task session "${opened.session.name}" (id ${opened.session.id})${bool(args, "fork") ? " with a copy of this conversation so far" : ""}. It starts on the brief now${quotesNote(opened.letter)}; its report comes back to you as a letter.`,
				),
			],
			detail,
		};
	},
};

const TEXT = { type: "string" } as const;

/**
 * manage_yew: the model changes Yew itself. One call, all changes; Yew plans it
 * to rank how far it reaches and to show the person every change, then applies all or none.
 */
export const manageYewTool: ToolDefinition = {
	name: "manage_yew",
	description:
		"Change Yew itself when the person asks or the work needs it: sessions (create a standing one, or change its name, team, role, model, working folder, permission mode, how it receives letters, letter quota, rights, pinned, archived), teams, scheduled tasks, and settings. Put every change in one call; Yew checks them, asks the person when a change needs it, and applies all or none. Sessions, teams and tasks are named by name or id. API keys, pairing and deleting data are the person's.",
	parameters: {
		type: "object",
		properties: {
			teams: {
				type: "array",
				description: "Teams to create (name only) or rename (team and name).",
				items: {
					type: "object",
					properties: { team: TEXT, name: TEXT },
					required: ["name"],
					additionalProperties: false,
				},
			},
			sessions: {
				type: "array",
				description:
					"One entry per session with only what changes. Leave out session to create a standing session with that name.",
				items: {
					type: "object",
					properties: {
						session: TEXT,
						name: TEXT,
						team: { type: "string", description: 'A team, or "none".' },
						role: TEXT,
						model: { type: "string", description: '"provider/model".' },
						thinking: { type: "string", enum: [...THINKING_LEVELS] },
						folder: { type: "string", description: 'Its working folder, or "none" for a chat.' },
						permission: {
							type: "string",
							enum: ["default", "review", "skip"],
							description:
								"default: risky calls are asked about; review: a check by the model decides them first, and what cannot be taken back goes straight to the person; skip: no call is asked about.",
						},
						receive: { type: "string", enum: ["accept", "hold", "refuse"] },
						letter_quota: {
							type: "integer",
							minimum: 0,
							maximum: 100,
							description: "Letters it may send between the person's messages; 0 for the default.",
						},
						daily_budget: {
							type: "number",
							minimum: 0,
							description: "The most it may spend in a day, in US dollars; 0 for no limit.",
						},
						can_post_cards: { type: "boolean" },
						can_manage: { type: "boolean", description: "May use manage_yew." },
						extra_dirs: {
							type: "array",
							description:
								"Additional folders this session may read or write alongside its working folder.",
							items: {
								type: "object",
								properties: {
									path: TEXT,
									access: { type: "string", enum: ["read", "write"] },
								},
								required: ["path", "access"],
								additionalProperties: false,
							},
						},
						allowed_domains: {
							type: "array",
							description:
								"Additional domains this session's sandboxed commands may reach without asking.",
							items: TEXT,
						},
						pinned: { type: "boolean" },
						archived: { type: "boolean" },
					},
					additionalProperties: false,
				},
			},
			schedules: {
				type: "array",
				description:
					"Scheduled tasks: at the times of a cron expression, Yew sends a standing session a letter, and its last reply comes back to the main conversation as the report. Leave out schedule to create one; set enabled to false to turn one off.",
				items: {
					type: "object",
					properties: {
						schedule: TEXT,
						name: TEXT,
						cron: {
							type: "string",
							description:
								'Five fields in this computer\'s time zone: minute, hour, day of the month, month, day of the week. "0 9 * * 1-5" is 9:00 on weekdays.',
						},
						session: { type: "string", description: "The standing session the letter goes to." },
						message: { type: "string", description: "The letter: what to do each time." },
						permission: {
							type: "string",
							enum: ["session", "default", "review", "skip"],
							description:
								"Permission mode for its runs; session (the default) keeps the session's own.",
						},
						mode: {
							type: "string",
							enum: ["letter", "task_session"],
							description:
								"letter (default): sends a letter to the standing session; task_session: spawns a fresh isolated task session inheriting the standing session's config and reports back.",
						},
						auto_archive: {
							type: "boolean",
							description:
								"In task_session mode, automatically archive the temporary task session when it finishes cleanly (default true).",
						},
						catch_up: {
							type: "boolean",
							description: "Run once after a time missed while Yew was not running (default true).",
						},
						enabled: { type: "boolean" },
					},
					additionalProperties: false,
				},
			},
			settings: {
				type: "object",
				properties: {
					main: { type: "string", description: "The main conversation." },
					default_model: { type: "string", description: '"provider/model" for new sessions.' },
					default_thinking: { type: "string", enum: [...THINKING_LEVELS] },
					decision_log: {
						type: "string",
						description: 'A Markdown file every decision is added to, or "none".',
					},
					daily_budget: {
						type: "number",
						minimum: 0,
						description: "The most all sessions may spend in a day, in US dollars; 0 for no limit.",
					},
					add_workspace: { type: "string", description: "A folder to add to the workspaces." },
					remove_workspace: { type: "string", description: "A workspace, by folder or name." },
					sandbox_allowed_domains: {
						type: "array",
						description: "Additional domains all sandboxed commands may reach without asking.",
						items: TEXT,
					},
					theme: { type: "string", enum: ["system", "light", "dark"] },
					language: { type: "string", enum: ["system", "zh", "en"] },
				},
				additionalProperties: false,
			},
		},
		additionalProperties: false,
	},
	readOnly: false,
	needsFolder: false,
	offered: (_session, roles) => roles.canOrganize,
	subject(args, _session, lookup) {
		if (!lookup) return { kind: "act", tool: "manage_yew", summary: "manage_yew", always: true };
		let plan: ReturnType<Lookup["plan"]>;
		try {
			plan = lookup.plan(args);
		} catch (error) {
			if (error instanceof YewError) throw new ToolInputError(error.message);
			throw error;
		}
		return {
			kind: "act",
			tool: "manage_yew",
			summary: plan.summary.join("\n"),
			scope: plan.tier === "widen" ? undefined : plan.tier,
			always: plan.tier !== "organize",
			...(plan.tier === "widen" ? { reasons: plan.reasons } : {}),
		};
	},
	preview(args, _session, lookup) {
		try {
			return { changes: lookup.plan(args).steps };
		} catch {
			return {};
		}
	},
	async run(args, ctx): Promise<ToolResult> {
		const done = attempt(() => ctx.mail.manage(args));
		return { content: [text(done.join("\n"))] };
	},
};

export const finishTaskTool: ToolDefinition = {
	name: "finish_task",
	description:
		"Record how your task ended: done, given_up or failed. Then end your turn with your report: the result, what changed, how you checked it, and what is left.",
	parameters: {
		type: "object",
		properties: {
			result: { type: "string", enum: [...TASK_OUTCOMES] },
			next: {
				type: "string",
				description: "What is left, and who does it next. Leave it out when nothing is.",
			},
		},
		required: ["result"],
		additionalProperties: false,
	},
	readOnly: false,
	needsFolder: false,
	offered: (session) => session.kind === "task",
	subject() {
		return { kind: "none" };
	},
	async run(args, ctx): Promise<ToolResult> {
		const outcome = choice(args, "result", TASK_OUTCOMES) as TaskOutcome;
		if (!outcome) throw new ToolInputError("result is required.");
		// What is left is kept with the call itself, where an evaluation reads it (PROTOCOL_VERSION 1).
		if (args.next !== undefined && typeof args.next !== "string") {
			throw new ToolInputError("next is text: what is left, and who does it next.");
		}
		const session = ctx.mail.finish(outcome);
		const to = session.parentId
			? `It goes to ${nameOf(ctx.mail, session.parentId)}.`
			: "The person reads it here.";
		return { content: [text(`Recorded: ${outcome}. Now end your turn with your report. ${to}`)] };
	},
};

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
