import { join } from "node:path";
import {
	type EntryBody,
	type JsonObject,
	plainLine,
	type ToolCallBlock,
	type ToolResultMessage,
} from "../../shared/messages.ts";
import {
	type ApprovalDecision,
	type PermissionNote,
	type PermissionRequest,
	permissionModeOf,
	personOnly,
	type QuestionAnswer,
	type Session,
	type ToolCallView,
} from "../../shared/types.ts";
import { conflict } from "../errors.ts";
import type { PostOffice } from "../mail/post.ts";
import type { Manager } from "../manage.ts";
import type { ModelGateway } from "../model/gateway.ts";
import type { PermissionEngine } from "../permissions/engine.ts";
import type { Store } from "../store.ts";
import type { Jobs } from "../tools/jobs.ts";
import { ReadState } from "../tools/read-state.ts";
import {
	type Lookup,
	type MailContext,
	type ToolContext,
	type ToolDefinition,
	ToolInputError,
	type ToolResult,
} from "../tools/types.ts";
import { notice } from "./compaction.ts";
import { clip, hookNote } from "./context.ts";
import { runHelper } from "./helper.ts";
import type { Mailroom } from "./mailroom.ts";
import { helperPrompt } from "./prompt.ts";
import { reviewStep } from "./review.ts";
import type { SessionHooks } from "./session-hooks.ts";

/** What the person answered on a card: a decision on a permission request, or an answer to a question. */
export type Answer = {
	decision?: ApprovalDecision;
	reason?: string;
	answer?: string;
	answers?: QuestionAnswer[];
};

/** A session at work: how to stop it, when it ends, and the cards its calls wait on. */
export interface Live {
	controller: AbortController;
	done: Promise<void>;
	waiters: Map<string, (answer: Answer | null) => void>;
}

export interface CallsOptions {
	store: Store;
	gateway: ModelGateway;
	permissions: PermissionEngine;
	home: string;
	version: string;
	post: PostOffice;
	mail: Mailroom;
	manager: Manager;
	hooks: SessionHooks;
	/** The tools a session may call now. */
	tools: (session: Session) => ToolDefinition[];
	readState: (sessionId: string) => ReadState;
	jobs: (sessionId: string) => Jobs;
}

/** The result of a call that was running when Yew stopped. */
const RESTARTED =
	"Yew restarted while this call was running. It may or may not have finished; check the current state before running it again.";

function resultEntry(
	call: { callId: string; tool: string },
	result: ToolResult,
	started: number,
): EntryBody {
	const message: ToolResultMessage = {
		role: "toolResult",
		toolCallId: call.callId,
		toolName: call.tool,
		content: result.content,
		isError: result.isError ?? false,
		timestamp: Date.now(),
		durationMs: Date.now() - started,
	};
	return { role: "toolResult", message };
}

export const failure = (text: string): ToolResult => ({
	content: [{ type: "text", text }],
	isError: true,
});

/**
 * A session's tool calls: every call of a batch is checked first (the person's hooks, the permission
 * rules, the automatic mode's check, and the person where a card is due), then the allowed ones run.
 */
export class Calls {
	readonly #store: Store;
	readonly #gateway: ModelGateway;
	readonly #permissions: PermissionEngine;
	readonly #home: string;
	readonly #version: string;
	readonly #post: PostOffice;
	readonly #mail: Mailroom;
	readonly #manager: Manager;
	readonly #hooks: SessionHooks;
	readonly #tools: (session: Session) => ToolDefinition[];
	readonly #readState: (sessionId: string) => ReadState;
	readonly #jobs: (sessionId: string) => Jobs;
	/** By tool call: what ran without being asked about (skip mode) or was allowed by the check. */
	readonly #permissionNotes = new Map<string, PermissionNote>();
	/** A session's or team's name by id, for what the person reads on permission cards. */
	readonly #names = (id: string): string | null => {
		const session = this.#post.sessionName(id);
		if (session) return session;
		try {
			return this.#store.getGroup(id).name;
		} catch {
			return null;
		}
	};

	constructor(options: CallsOptions) {
		this.#store = options.store;
		this.#gateway = options.gateway;
		this.#permissions = options.permissions;
		this.#home = options.home;
		this.#version = options.version;
		this.#post = options.post;
		this.#mail = options.mail;
		this.#manager = options.manager;
		this.#hooks = options.hooks;
		this.#tools = options.tools;
		this.#readState = options.readState;
		this.#jobs = options.jobs;
	}

	/** What tools may look up while Yew checks a call of `session`. */
	#lookup(session: Session): Lookup {
		return { name: this.#names, plan: (args) => this.#manager.plan(session, args) };
	}

	/**
	 * The conversation moves on: calls left over from an interrupted run will not be run later. Calls that
	 * were running when Yew stopped may have finished, so they say that rather than "not run".
	 */
	dropLeftovers(sessionId: string, reason: string): void {
		this.#store.tx(() => {
			for (const call of this.#store.toolCallsByStatus(sessionId, ["pending", "needs_review"])) {
				const text = call.status === "needs_review" ? RESTARTED : reason;
				this.finish(call, failure(text), "error", Date.now());
			}
		});
	}

	/**
	 * Checks every call of a batch first (asking where needed), then runs the allowed ones
	 * (docs/prior-art.md, 4.1).
	 */
	async run(
		sessionId: string,
		rows: ToolCallView[],
		calls: (ToolCallBlock | null)[],
		live: Live,
	): Promise<void> {
		const signal = live.controller.signal;
		const current = this.#store.getSession(sessionId);
		const byName = new Map(this.#tools(current).map((tool) => [tool.name, tool]));
		const results = new Map<
			string,
			{ result: ToolResult; status: "done" | "error" | "denied"; started: number }
		>();
		const approved: { row: ToolCallView; tool: ToolDefinition }[] = [];

		for (const [index, row] of rows.entries()) {
			const started = Date.now();
			if (signal.aborted) {
				results.set(row.id, {
					result: failure("Not run: stopped by the person."),
					status: "error",
					started,
				});
				continue;
			}
			const tool = byName.get(row.tool);
			const argumentsError = calls[index]?.argumentsError;
			if (!tool) {
				results.set(row.id, {
					result: failure(`There is no tool named ${row.tool}.`),
					status: "error",
					started,
				});
				continue;
			}
			if (argumentsError) {
				results.set(row.id, {
					result: failure(`The arguments were not valid JSON: ${argumentsError}`),
					status: "error",
					started,
				});
				continue;
			}
			const session = this.#store.getSession(sessionId);
			const activeRun = this.#mail.run(sessionId);
			// Scheduled unattended runs can never self-escalate by modifying schedules or widening permissions (even in skip mode).
			if (activeRun?.unattended && row.tool === "manage_yew") {
				let blockedReason: string | null = null;
				if (Array.isArray((row.args as { schedules?: unknown }).schedules)) {
					blockedReason = "Scheduled unattended runs cannot create or modify scheduled tasks.";
				} else {
					try {
						if (this.#manager.plan(session, row.args).tier === "widen") {
							blockedReason =
								"Scheduled unattended runs cannot widen permissions or runtime boundaries.";
						}
					} catch {
						// Invalid arguments will be caught normally below.
					}
				}
				if (blockedReason) {
					activeRun.refused.push(blockedReason);
					results.set(row.id, {
						result: { ...failure(`Refused: ${blockedReason}`), detail: { code: "unattended" } },
						status: "denied",
						started,
					});
					continue;
				}
			}
			// The person's PreToolUse hooks can stop a call before anything else (hooks.ts).
			if (this.#hooks.has("PreToolUse", row.tool)) {
				const before = await this.#hooks.run("PreToolUse", sessionId, {}, row.tool, row.args);
				if (before.block) {
					results.set(row.id, {
						result: failure(hookNote("PreToolUse", `It stopped this call: ${before.block}`)),
						status: "denied",
						started,
					});
					continue;
				}
			}
			let decision: ReturnType<PermissionEngine["decide"]>;
			try {
				// In the automatic mode the model asks for a person's approval itself, with `confirm`.
				const flagged = (row.args as { confirm?: unknown }).confirm === true;
				const subject = tool.subject(row.args, session, this.#lookup(session));
				decision = this.#permissions.decide(subject, this.#mail.withRunMode(session), flagged);
			} catch (error) {
				const message =
					error instanceof ToolInputError
						? error.message
						: `Could not check this call: ${(error as Error).message}`;
				results.set(row.id, { result: failure(message), status: "error", started });
				continue;
			}
			if (decision.effect === "deny") {
				results.set(row.id, {
					result: failure(`Refused by Yew: ${decision.reason}`),
					status: "denied",
					started,
				});
				continue;
			}
			if (decision.effect === "allow" && decision.note) this.#notePermission(row.id, decision.note);
			// The automatic mode: the check decides first; the person is asked when it does not allow.
			if (decision.effect === "ask" && decision.review) {
				const verdict = await reviewStep({
					gateway: this.#gateway,
					store: this.#store,
					session,
					request: decision.request,
					signal: live.controller.signal,
				});
				if (verdict.allow) {
					this.#notePermission(row.id, {
						reviewed: verdict.reason,
						checked: decision.request.reasons ?? [],
					});
					this.#recordReview(sessionId, decision.request, verdict.reason);
					approved.push({ row, tool });
					continue;
				}
				decision.request.review = verdict.reason;
			}
			const run = this.#mail.run(sessionId);
			if (decision.effect === "ask" && run?.unattended) {
				// Nobody is there to say yes: refuse now rather than wait.
				run.refused.push(decision.request.summary);
				results.set(row.id, {
					result: {
						...failure(
							`Refused: this turn runs for the scheduled task "${run.name}" and nobody is watching, so nobody can approve it. Do what you can without it; Yew lists what was refused in the report.`,
						),
						detail: { code: "unattended" },
					},
					status: "denied",
					started,
				});
				continue;
			}
			if (decision.effect === "ask") {
				this.#store.updateToolCall(row.id, { status: "waiting" });
				const approval = this.#store.createApproval({
					sessionId,
					toolCallId: row.id,
					kind: "permission",
					// What the call is for and what it would change, so the person decides on what they see.
					request: {
						...decision.request,
						...tool.preview?.(row.args, session, this.#lookup(session)),
					},
				});
				const answer = await this.#waitFor(sessionId, approval.id, live);
				if (!answer || answer.decision === "deny" || answer.decision === undefined) {
					const reason = answer?.reason?.trim();
					const text = !answer
						? "Not run: stopped before the person decided."
						: reason
							? `The person declined this call: ${reason}`
							: "The person declined this call.";
					results.set(row.id, { result: failure(text), status: "denied", started });
					continue;
				}
				if (answer.decision === "allow_always" && decision.request.rememberRules) {
					const current = this.#store.getSession(sessionId);
					this.#store.updateSession(sessionId, {
						rules: [...current.rules, ...decision.request.rememberRules],
					});
				}
				// Clear "waiting" immediately once approved so the UI never keeps showing "Needs your permission".
				this.#store.updateToolCall(row.id, { status: "pending" });
			}
			approved.push({ row, tool });
		}

		const execute = async ({ row, tool }: { row: ToolCallView; tool: ToolDefinition }) => {
			const started = Date.now();
			if (signal.aborted) {
				results.set(row.id, {
					result: failure("Not run: stopped by the person."),
					status: "error",
					started,
				});
				return;
			}
			// How it was allowed is on the row from the start, so the interface can show a push as one.
			const allowed = this.#permissionNotes.get(row.id);
			this.#store.updateToolCall(row.id, {
				status: "running",
				startedAt: started,
				...(allowed ? { detail: { permission: allowed as unknown as JsonObject } } : {}),
			});
			let result: ToolResult;
			try {
				result = await tool.run(row.args, this.#toolContext(sessionId, row, live));
			} catch (error) {
				result = failure(
					error instanceof ToolInputError
						? error.message
						: `The tool failed: ${(error as Error).message}`,
				);
			}
			// The person's PostToolUse hooks see what it did, and may add a word for the model (hooks.ts).
			if (!result.isError && this.#hooks.has("PostToolUse", row.tool)) {
				const said = result.content
					.map((block) => (block.type === "text" ? block.text : ""))
					.join("\n")
					.slice(0, 10_000);
				const after = await this.#hooks.run(
					"PostToolUse",
					sessionId,
					{ tool_response: { content: said } },
					row.tool,
					row.args,
				);
				if (after.block) {
					result = {
						...result,
						content: [
							...result.content,
							{ type: "text", text: hookNote("PostToolUse", after.block) },
						],
					};
				}
			}
			results.set(row.id, { result, status: result.isError ? "error" : "done", started });
		};
		// Run contiguous read-only calls concurrently while preserving exact order around mutating calls.
		for (let i = 0; i < approved.length; ) {
			const currentCall = approved[i];
			if (!currentCall) break;
			if (!currentCall.tool.readOnly) {
				await execute(currentCall);
				i++;
				continue;
			}
			const start = i;
			while (i < approved.length && approved[i]?.tool.readOnly) i++;
			await Promise.all(approved.slice(start, i).map(execute));
		}

		// Results go into the transcript in the order the model made the calls.
		this.#store.tx(() => {
			for (const row of rows) {
				const outcome = results.get(row.id) ?? {
					result: failure("Not run."),
					status: "error" as const,
					started: Date.now(),
				};
				this.finish(row, outcome.result, outcome.status, outcome.started);
			}
		});
	}

	finish(
		row: Pick<ToolCallView, "id" | "callId" | "tool" | "sessionId">,
		result: ToolResult,
		status: "done" | "error" | "denied",
		started: number,
	): void {
		const entry = this.#store.appendEntry(row.sessionId, resultEntry(row, result, started));
		const detail = (result.detail as JsonObject | undefined) ?? null;
		const note = this.#permissionNotes.get(row.id);
		this.#permissionNotes.delete(row.id);
		this.#store.updateToolCall(row.id, {
			status,
			// The row shows what ran unasked with its risk, or what the check allowed.
			detail: note ? { ...detail, permission: note as unknown as JsonObject } : detail,
			resultMessageId: entry.id,
			finishedAt: Date.now(),
		});
		// A letter this call waited for is now in the transcript, inside the result.
		const handed = this.#mail.takeHanded(row.id);
		if (handed) this.#post.mail.setLetterEntry(handed, entry.id);
	}

	/** Adds to what a call's row says about how it was allowed. */
	#notePermission(callId: string, note: PermissionNote): void {
		const current = this.#permissionNotes.get(callId) ?? {};
		const risk = [...new Set([...(current.risk ?? []), ...(note.risk ?? [])])];
		const reviewed = [current.reviewed, note.reviewed].filter((text) => text !== undefined);
		const checked = [...new Set([...(current.checked ?? []), ...(note.checked ?? [])])];
		this.#permissionNotes.set(callId, {
			...(risk.length > 0 ? { risk } : {}),
			...(checked.length > 0 ? { checked } : {}),
			...(reviewed.length > 0 ? { reviewed: reviewed.filter(Boolean).join(" ") } : {}),
		});
	}

	/**
	 * A permission a running command asks for, such as reaching a site: what only the person gives in
	 * the session's mode goes to them; otherwise skip mode allows it, and the automatic mode's check
	 * decides first. True when allowed; else the request to ask the person with.
	 */
	async #settlePermit(
		sessionId: string,
		callId: string,
		request: PermissionRequest,
		live: Live,
	): Promise<PermissionRequest | true> {
		const session = this.#store.getSession(sessionId);
		const mode = permissionModeOf(this.#mail.withRunMode(session).options);
		if (personOnly(request.reasons ?? [], mode)) return { ...request, matter: true };
		if (mode === "skip") {
			this.#notePermission(callId, { risk: request.reasons ?? [] });
			return true;
		}
		if (mode !== "review") return request;
		const verdict = await reviewStep({
			gateway: this.#gateway,
			store: this.#store,
			session,
			request,
			signal: live.controller.signal,
		});
		if (!verdict.allow) return { ...request, review: verdict.reason };
		this.#notePermission(callId, { reviewed: verdict.reason, checked: request.reasons ?? [] });
		this.#recordReview(sessionId, request, verdict.reason);
		return true;
	}

	/** Each step the check let run stays in the session to look back on. */
	#recordReview(sessionId: string, request: PermissionRequest, reason: string): void {
		notice(this.#store, sessionId, "reviewed", reason, {
			tool: request.tool,
			summary: request.summary.slice(0, 300),
			reason,
		});
	}

	/** After a restart: calls that were running get an honest "unknown" result; calls that never ran are checked again. */
	async resume(sessionId: string, live: Live): Promise<void> {
		const unknown = this.#store.toolCallsByStatus(sessionId, ["needs_review"]);
		this.#store.tx(() => {
			for (const call of unknown) this.finish(call, failure(RESTARTED), "error", Date.now());
		});
		const pending = this.#store.toolCallsByStatus(sessionId, ["pending"]);
		if (pending.length > 0)
			await this.run(
				sessionId,
				pending,
				pending.map(() => null),
				live,
			);
	}

	#waitFor(sessionId: string, approvalId: string, live: Live): Promise<Answer | null> {
		const signal = live.controller.signal;
		this.#store.setStatus(sessionId, "waiting");
		return new Promise<Answer | null>((resolve) => {
			const finish = (answer: Answer | null) => {
				live.waiters.delete(approvalId);
				signal.removeEventListener("abort", onAbort);
				if (!signal.aborted) this.#store.setStatus(sessionId, "working");
				resolve(answer);
			};
			const onAbort = () => {
				this.#store.cancelApproval(approvalId);
				finish(null);
			};
			live.waiters.set(approvalId, finish);
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	#toolContext(sessionId: string, row: ToolCallView, live: Live): ToolContext {
		const session = this.#store.getSession(sessionId);
		const model = this.#gateway.model(session.provider, session.model);
		let tail = "";
		let timer: ReturnType<typeof setTimeout> | null = null;
		let permits: Promise<boolean> = Promise.resolve(true);
		const context: ToolContext = {
			session,
			signal: live.controller.signal,
			readState: this.#readState(sessionId),
			jobs: this.#jobs(sessionId),
			tmpDir: join(this.#home, "tmp", sessionId),
			acceptsImages: model?.input.includes("image") ?? false,
			version: this.#version,
			output: (chunk) => {
				tail = (tail + chunk).slice(-4000);
				if (timer) return;
				timer = setTimeout(() => {
					timer = null;
					this.#store.live(sessionId, { type: "toolOutput", toolCallId: row.id, output: tail });
				}, 200);
			},
			setTodos: (todos) => this.#store.setTodos(sessionId, todos),
			offLimits: (path) => this.#permissions.offLimits(path),
			ask: async (request) => {
				const run = this.#mail.run(sessionId);
				if (run?.unattended) {
					const first = request.questions?.[0]?.question ?? request.question ?? "";
					run.refused.push(`Question: ${clip(plainLine(first), 200)}`);
					throw new ToolInputError(
						`Nobody can answer now: this turn runs for the scheduled task "${run.name}" and nobody is watching. Decide what you can yourself and say in your reply what is still open.`,
					);
				}
				const approval = this.#store.createApproval({
					sessionId,
					toolCallId: row.id,
					kind: "question",
					request,
				});
				const answer = await this.#waitFor(sessionId, approval.id, live);
				if (!answer?.answer) throw new ToolInputError("Stopped before the person answered.");
				return answer.answer;
			},
			permit: (asked, until) => {
				// One card at a time for a call; the next waits until the person has answered.
				const next = permits.then(async () => {
					if (until?.aborted) return false;
					const request = await this.#settlePermit(sessionId, row.id, asked, live);
					if (request === true) return true;
					const run = this.#mail.run(sessionId);
					if (run?.unattended) {
						run.refused.push(request.summary);
						return false;
					}
					this.#store.updateToolCall(row.id, { status: "waiting" });
					const approval = this.#store.createApproval({
						sessionId,
						toolCallId: row.id,
						kind: "permission",
						request,
					});
					// The need passed before the person answered: the card is withdrawn.
					const withdraw = () => {
						if (this.#store.getApproval(approval.id).status !== "pending") return;
						this.#store.cancelApproval(approval.id);
						live.waiters.get(approval.id)?.(null);
					};
					until?.addEventListener("abort", withdraw, { once: true });
					const answer = await this.#waitFor(sessionId, approval.id, live);
					until?.removeEventListener("abort", withdraw);
					if (!live.controller.signal.aborted) {
						this.#store.updateToolCall(row.id, { status: "running" });
					}
					if (answer?.decision === "allow_always" && request.rememberRules) {
						const newDomains = request.rememberRules
							.filter((rule) => rule.tool === "sandbox_site" && rule.pattern)
							.map((rule) => rule.pattern as string);
						if (newDomains.length > 0) {
							const current = this.#store.getSession(sessionId);
							const merged = [
								...new Set([...(current.options.allowedDomains ?? []), ...newDomains]),
							];
							this.#store.updateSession(sessionId, { options: { allowedDomains: merged } });
						}
					}
					return answer?.decision === "allow_once" || answer?.decision === "allow_always";
				});
				permits = next.catch(() => false);
				return next;
			},
			mail: this.#mailContext(sessionId, live, row.id),
			helper: (task) => {
				const parent = this.#store.getSession(sessionId);
				return runHelper({
					gateway: this.#gateway,
					permissions: this.#permissions,
					session: this.#mail.withRunMode(parent),
					tools: this.#tools(parent),
					lookup: this.#lookup(parent),
					// Its own reads, so they do not count as the session's before an edit; no questions.
					context: {
						...context,
						readState: new ReadState(),
						output: () => {},
						setTodos: () => {},
						ask: async () => {
							throw new ToolInputError("A helper cannot ask the person.");
						},
						permit: async () => false,
					},
					systemPrompt: helperPrompt(parent.name, parent.cwd),
					task,
					signal: live.controller.signal,
					onStep: (line) => context.output(`${line}\n`),
					onUsage: (usage) =>
						this.#store.addUsage(sessionId, usage, this.#store.getSession(sessionId).contextTokens),
				});
			},
		};
		return context;
	}

	#mailContext(sessionId: string, live: Live, callId: string): MailContext {
		return {
			post: this.#post,
			canPostCards: this.#post.canPostCards(this.#store.getSession(sessionId)),
			send: (out) => {
				const session = this.#store.getSession(sessionId);
				const originEntryId = this.#mail.originOf(sessionId);
				return this.#mail.sent(
					sessionId,
					this.#post.send(
						{ kind: "session", session },
						{ ...out, ...(originEntryId ? { originEntryId } : {}) },
					),
				);
			},
			wait: (letter) => this.#mail.awaitReply(sessionId, letter, live.controller.signal, callId),
			open: (input) => this.#mail.openChild(this.#store.getSession(sessionId), input, callId),
			finish: (outcome) => this.#store.setOutcome(sessionId, outcome),
			manage: (args) => {
				const by = this.#store.getSession(sessionId);
				if (!this.#post.canOrganize(by)) {
					throw conflict(
						"Only the main conversation, or a session the person allowed, can manage Yew.",
						undefined,
						"not-allowed",
					);
				}
				return this.#manager.apply(by, args);
			},
			schedules: (id) => this.#manager.schedulesOf(id),
		};
	}
}
