/**
 * Keeps what the model is sent in bounds while a session works: a system prompt that stays the same
 * between turns, and a transcript that is summarized when it nears the model's context window.
 */
import { type JsonObject, messageText, type Notice } from "../../shared/messages.ts";
import {
	defaultCompactAt,
	type Entry,
	normalizePermissionMode,
	permissionModeOf,
	type Session,
} from "../../shared/types.ts";
import type { ModelGateway, ModelInfo } from "../model/gateway.ts";
import type { Store } from "../store.ts";
import {
	estimateTokens,
	isOwnNote,
	isPrunableToolResult,
	PRUNED_PLACEHOLDER_TOKENS,
	toolResultTokens,
	transcriptForSummary,
	usageTotals,
} from "./context.ts";
import {
	type ContextSnapshot,
	type InstructionExtras,
	loadInstructions,
	MAIN_ROLE,
	PERMISSION_MODE,
	type Placement,
	RENEW_PROMPT,
	renderInstructions,
	type SessionRef,
	SUMMARY_PROMPT,
	type Told,
	takeSnapshot,
	today,
} from "./prompt.ts";

const KEEP_RECENT_TOKENS = 20_000;
/** Layer-1 tool-result folding succeeds when it brings context down to at most this share of the threshold. */
const L1_TARGET_RATIO = 0.75;

/** What an attempt to shorten the context came to. "nothing": there was nothing older to summarize. */
export type Compacted = "done" | "nothing" | "failed";

const MAX_REQUEST_CHARS = 20_000;

/** The context size at which a session's history is compacted: its own number, else the default. */
function compactAt(session: Session, model: ModelInfo): number {
	return session.options.compactAt ?? defaultCompactAt(model.contextWindow);
}

/** A message from the person or a letter, not one of Yew's own notes to the model. */
function isRequest(entry: Entry): boolean {
	return entry.role === "user" && !isOwnNote(messageText(entry.message));
}

function clipRequest(text: string): string {
	return text.length > MAX_REQUEST_CHARS
		? `${text.slice(0, MAX_REQUEST_CHARS)}\n[cut by Yew: the message was longer]`
		: text;
}

/** What a session is told when the person's main conversation changes. */
function mainUpdate(session: Session, before: SessionRef | null, now: SessionRef | null): string {
	if (now?.id === session.id) return `The person made you their main conversation.\n${MAIN_ROLE}`;
	if (before?.id === session.id) {
		return `You are no longer the person's main conversation.${now ? ` Their main conversation is now "${now.name}" (id ${now.id}).` : ""}`;
	}
	if (now) {
		return `The person's main conversation is now "${now.name}" (id ${now.id}). When something needs the person's decision, send it a request; it puts the question in the approval center.`;
	}
	return "The person has no main conversation now. When something needs the person's decision, ask them with ask_user.";
}

/** What a session is told when its role changes. */
function roleUpdate(before: string, now: string): string {
	if (!now) return "Your role was removed. You have no written role now.";
	return `${before ? "Your role changed. This is the current one; it replaces the earlier one." : "You were given a role."}\n${now}`;
}

/** A line in the record for the person, not for the model. */
export function notice(
	store: Store,
	sessionId: string,
	kind: Notice["kind"],
	text: string,
	data?: JsonObject,
): void {
	store.appendEntry(sessionId, {
		role: "notice",
		notice: data
			? { kind, text, data, timestamp: Date.now() }
			: { kind, text, timestamp: Date.now() },
	});
}

export interface ContextKeeperOptions {
	store: Store;
	gateway: ModelGateway;
	home: string;
	/** Where the session stands among the others: main conversation, parent, team. */
	placement: (session: Session) => Placement;
	/** Memory folders and where the person's own skills and instructions are. */
	extras: () => InstructionExtras;
}

export class ContextKeeper {
	readonly #store: Store;
	readonly #gateway: ModelGateway;
	readonly #home: string;
	readonly #placement: (session: Session) => Placement;
	readonly #extras: () => InstructionExtras;

	constructor(options: ContextKeeperOptions) {
		this.#store = options.store;
		this.#gateway = options.gateway;
		this.#home = options.home;
		this.#placement = options.placement;
		this.#extras = options.extras;
	}

	/**
	 * Keeps the system prompt the same between turns. The environment and instruction files are saved at the
	 * first turn; when the files, the date, the approval mode, the main conversation or the session's
	 * name, team or role change later, an update is appended to the transcript instead, and the prompt
	 * keeps its saved inputs until the next compaction, so the provider's prompt cache stays valid
	 * (prior-art 4.5).
	 */
	refresh(session: Session): ContextSnapshot {
		const placement = this.#placement(session);
		const saved = this.#store.getContextSnapshot<ContextSnapshot>(session.id);
		if (!saved) {
			const snapshot = takeSnapshot(session, this.#home, placement, this.#extras());
			this.#store.setContextSnapshot(session.id, snapshot);
			return snapshot;
		}
		// A session switched between chat and code gets a fresh environment: folder, git status and files.
		if (saved.cwd !== session.cwd) {
			const snapshot = takeSnapshot(session, this.#home, placement, this.#extras());
			this.#store.setContextSnapshot(session.id, snapshot);
			this.#store.appendEntry(session.id, {
				role: "system",
				message: {
					role: "system",
					content: session.cwd
						? `The working folder is now ${session.cwd}. File and shell tools work there.`
						: "This session no longer has a working folder. It is a chat now, without file or shell tools.",
					timestamp: Date.now(),
				},
			});
			return snapshot;
		}
		const mode = permissionModeOf(session.options);
		// Snapshots from before a field existed learn it quietly; the prompt reads the same either way.
		const team = placement.team ?? null;
		const { told: _told, ...prompt } = {
			...saved,
			// Snapshots from before 1.7 name the earlier modes ("auto", "manual"): both read as default.
			permissionMode: normalizePermissionMode(saved.permissionMode) ?? mode,
			main: saved.main === undefined ? null : saved.main,
			parent: saved.parent === undefined ? placement.parent : saved.parent,
			name: saved.name ?? session.name,
			team: saved.team === undefined ? team : saved.team,
			role: saved.role ?? session.responsibility,
		};
		const told: Told = saved.told ?? {
			date: prompt.date,
			instructions: prompt.instructions,
			permissionMode: prompt.permissionMode,
			main: prompt.main,
		};
		const toldName = told.name ?? prompt.name;
		const toldTeam = told.team === undefined ? prompt.team : told.team;
		const toldExtraDirs = told.extraDirs ?? prompt.extraDirs ?? [];
		const toldRole = (told.role ?? prompt.role).trim();
		const role = session.responsibility.trim();
		const currentExtraDirs = session.options.extraDirs ?? [];
		const updates: string[] = [];
		const date = today();
		if (date !== told.date) updates.push(`Today's date is now ${date}.`);
		const current = loadInstructions(session.cwd, this.#home, this.#extras());
		if (JSON.stringify(current) !== JSON.stringify(told.instructions)) {
			updates.push(
				current.length > 0
					? `The instruction files changed. These are the current versions; they replace the earlier ones.\n\n${renderInstructions(current, session.cwd)}`
					: "The instruction files were removed.",
			);
		}
		if (told.permissionMode !== mode) {
			updates.push(`The person changed the permission mode. ${PERMISSION_MODE[mode]}`);
		}
		const sameMain = (told.main?.id ?? null) === (placement.main?.id ?? null);
		if (!sameMain) updates.push(mainUpdate(session, told.main, placement.main));
		if (session.name !== toldName) updates.push(`Your name is now "${session.name}".`);
		if (team !== toldTeam) {
			updates.push(team ? `You now belong to the team "${team}".` : "You are no longer in a team.");
		}
		if (role !== toldRole) updates.push(roleUpdate(toldRole, role));
		if (JSON.stringify(currentExtraDirs) !== JSON.stringify(toldExtraDirs)) {
			updates.push(
				currentExtraDirs.length > 0
					? `Additional folders for this session are now: ${currentExtraDirs.map((d) => `${d.path} (${d.access === "write" ? "read-write" : "read-only"})`).join(", ")}.`
					: "This session no longer has additional folders outside its working folder.",
			);
		}
		if (updates.length > 0) {
			this.#store.appendEntry(session.id, {
				role: "system",
				message: { role: "system", content: updates.join("\n\n"), timestamp: Date.now() },
			});
		}
		const next: ContextSnapshot = {
			...prompt,
			told: {
				date,
				instructions: current,
				permissionMode: mode,
				main: sameMain ? told.main : placement.main,
				name: session.name,
				team,
				extraDirs: currentExtraDirs,
				role: session.responsibility,
			},
		};
		if (JSON.stringify(next) !== JSON.stringify(saved)) {
			this.#store.setContextSnapshot(session.id, next);
		}
		return prompt;
	}

	async compactIfNeeded(
		session: Session,
		model: ModelInfo,
		signal: AbortSignal,
	): Promise<Compacted> {
		const threshold = compactAt(session, model);
		if (session.contextTokens < threshold) return "nothing";
		// Layer 1 (zero LLM call, lossless to conversation flow): fold earlier large/image tool results.
		if (this.#tryPruneToolResults(session, threshold)) return "done";
		// Layer 2 (semantic summary): only when conversation & reasoning itself still exceed the limit.
		return this.compact(session, model, signal, false);
	}

	/**
	 * Layer-1 compaction: folds older large or image-bearing tool results in one pulse batch once the
	 * session crosses `threshold`, keeping recent turns and all user/assistant prose untouched. Stops
	 * compaction when estimated tokens drop to at most `L1_TARGET_RATIO` of `threshold`.
	 */
	#tryPruneToolResults(session: Session, threshold: number): boolean {
		const entries = this.#store.contextEntries(session.id);
		const keep = Math.min(KEEP_RECENT_TOKENS, Math.floor(threshold / 4));
		let kept = 0;
		let firstKept: Entry | null = null;
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as Entry;
			kept += estimateTokens(entry);
			if (entry.role === "user" || entry.role === "system" || entry.role === "assistant") {
				if (kept > keep && firstKept) break;
				firstKept = entry;
			}
		}
		if (!firstKept) return false;
		const saved = this.#store.getContextSnapshot<ContextSnapshot>(session.id);
		const prevPruned = saved?.prunedBeforeSeq ?? 0;
		if (firstKept.seq <= prevPruned) return false;
		let prunedCount = 0;
		let savedTokens = 0;
		for (const entry of entries) {
			if (entry.role !== "toolResult") continue;
			if (entry.seq < prevPruned || entry.seq >= firstKept.seq) continue;
			if (!isPrunableToolResult(entry.message)) continue;
			prunedCount++;
			savedTokens += Math.max(0, toolResultTokens(entry.message) - PRUNED_PLACEHOLDER_TOKENS);
		}
		if (prunedCount === 0 || savedTokens === 0) return false;
		const estimatedAfter = Math.max(0, session.contextTokens - savedTokens);
		if (estimatedAfter > Math.floor(threshold * L1_TARGET_RATIO)) return false;
		this.#store.tx(() => {
			const base =
				saved ?? takeSnapshot(session, this.#home, this.#placement(session), this.#extras());
			this.#store.setContextSnapshot(session.id, { ...base, prunedBeforeSeq: firstKept.seq });
			this.#store.setContextTokens(session.id, estimatedAfter);
			notice(
				this.#store,
				session.id,
				"compacted",
				`Folded ${prunedCount} earlier large tool results to save context (${session.contextTokens} tokens before).`,
				{ tier: "prune", prunedCount },
			);
		});
		return true;
	}

	/**
	 * Summarizes older history with the session's own model and keeps roughly the last 20,000 tokens
	 * (less for a model with a small context window, so that what is kept fits well under the limit).
	 * The kept part starts at a message or at a step of the model, never at a tool result, so a tool
	 * call is never separated from its result (prior-art 4.4). A turn of hundreds of steps after one
	 * message is cut inside the turn; the message being worked on is then carried over word for word,
	 * because a summary only paraphrases it and loses its constraints. The next prompt is built fresh,
	 * with a new environment snapshot.
	 */
	async compact(
		session: Session,
		model: ModelInfo,
		signal: AbortSignal,
		force: boolean,
	): Promise<Compacted> {
		const entries = this.#store.contextEntries(session.id);
		const keep = Math.min(KEEP_RECENT_TOKENS, Math.floor(compactAt(session, model) / 4));
		let kept = 0;
		let firstKept: Entry | null = null;
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as Entry;
			kept += estimateTokens(entry);
			if (entry.role === "user" || entry.role === "system" || entry.role === "assistant") {
				if (kept > keep && firstKept) break;
				firstKept = entry;
			}
		}
		if (!firstKept) return "nothing";
		const older = entries.filter((entry) => entry.seq < (firstKept as Entry).seq);
		if (older.length === 0 || (!force && older.every((entry) => entry.role === "compaction")))
			return "nothing";
		const remaining = entries.filter((entry) => entry.seq >= (firstKept as Entry).seq);
		let request: string | undefined;
		if (!remaining.some(isRequest)) {
			const asked = older.findLast(isRequest);
			const before = older.find((entry) => entry.role === "compaction");
			request =
				asked?.role === "user"
					? clipRequest(messageText(asked.message))
					: before?.role === "compaction"
						? before.compaction.request
						: undefined;
		}

		this.#store.live(session.id, { type: "draftCleared" });
		const summary = await this.#gateway.stream({
			provider: session.provider,
			model: model.id,
			thinking: "off",
			systemPrompt: SUMMARY_PROMPT,
			messages: [
				{
					role: "user",
					content: transcriptForSummary(older),
					timestamp: Date.now(),
				},
			],
			tools: [],
			signal,
		});
		this.#store.addUsage(session.id, usageTotals(summary), session.contextTokens);
		const text = summary.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();
		if (summary.stopReason !== "stop" || !text) {
			if (!signal.aborted)
				notice(
					this.#store,
					session.id,
					"error",
					summary.errorMessage ?? "The summary came back empty.",
					{
						code: "compact-failed",
					},
				);
			return "failed";
		}
		this.#store.tx(() => {
			this.#store.appendEntry(session.id, {
				role: "compaction",
				compaction: {
					summary: text,
					...(request ? { request } : {}),
					firstKeptSeq: (firstKept as Entry).seq,
					tokensBefore: session.contextTokens,
					timestamp: Date.now(),
				},
			});
			notice(
				this.#store,
				session.id,
				"compacted",
				`Earlier history was summarized to save context (${session.contextTokens} tokens before).`,
			);
			this.#store.setContextSnapshot(
				session.id,
				takeSnapshot(session, this.#home, this.#placement(session), this.#extras()),
			);
			this.#store.setContextTokens(
				session.id,
				remaining.reduce(
					(sum, entry) => sum + estimateTokens(entry),
					Math.ceil((text.length + (request?.length ?? 0)) / 4),
				),
			);
		});
		return "done";
	}

	/**
	 * Starts a fresh context window in place: everything before this point
	 * stays in the database for scrolling and search, while the model starts from a clean slate (or a
	 * concise carry-over brief when `summarize` is true). Any open incoming requests are restated in a
	 * system entry after the boundary so the session does not forget who is waiting on it.
	 */
	async renew(
		session: Session,
		model: ModelInfo | null,
		signal: AbortSignal,
		summarize: boolean,
		openRequestNote: string | null = null,
	): Promise<Compacted> {
		const entries = this.#store.contextEntries(session.id);
		const hasHistory = entries.some(
			(entry) =>
				entry.role === "user" ||
				entry.role === "assistant" ||
				entry.role === "system" ||
				(entry.role === "compaction" && entry.compaction.summary.trim().length > 0),
		);
		if (!hasHistory) return "nothing";

		let summaryText = "";
		if (summarize) {
			if (!model) return "failed";
			this.#store.live(session.id, { type: "draftCleared" });
			const summary = await this.#gateway.stream({
				provider: session.provider,
				model: model.id,
				thinking: "off",
				systemPrompt: RENEW_PROMPT,
				messages: [
					{
						role: "user",
						content: transcriptForSummary(entries),
						timestamp: Date.now(),
					},
				],
				tools: [],
				signal,
			});
			this.#store.addUsage(session.id, usageTotals(summary), session.contextTokens);
			const text = summary.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n")
				.trim();
			if (summary.stopReason !== "stop" || !text) {
				if (!signal.aborted) {
					notice(
						this.#store,
						session.id,
						"error",
						summary.errorMessage ?? "The carry-over summary came back empty.",
						{ code: "compact-failed" },
					);
				}
				return "failed";
			}
			summaryText = text;
		} else {
			this.#store.live(session.id, { type: "draftCleared" });
		}

		this.#store.tx(() => {
			const seqRow = this.#store.db
				.prepare("SELECT message_seq FROM sessions WHERE id = ?")
				.get(session.id) as { message_seq: number } | undefined;
			const firstKeptSeq = (seqRow?.message_seq ?? 0) + 2;
			this.#store.appendEntry(session.id, {
				role: "compaction",
				compaction: {
					kind: "renew",
					summary: summaryText,
					firstKeptSeq,
					tokensBefore: session.contextTokens,
					timestamp: Date.now(),
				},
			});
			if (openRequestNote) {
				this.#store.appendEntry(session.id, {
					role: "system",
					message: { role: "system", content: openRequestNote, timestamp: Date.now() },
				});
			}
			notice(
				this.#store,
				session.id,
				"renewed",
				summaryText
					? "Started a fresh context with a carry-over brief. Earlier history is still above."
					: "Started a fresh context. Earlier history is still above.",
			);
			this.#store.setContextSnapshot(
				session.id,
				takeSnapshot(session, this.#home, this.#placement(session), this.#extras()),
			);
			const carriedChars = summaryText.length + (openRequestNote?.length ?? 0);
			this.#store.setContextTokens(session.id, carriedChars > 0 ? Math.ceil(carriedChars / 4) : 0);
		});
		return "done";
	}
}
