/**
 * Helpers: a session hands a self-contained task to a short loop of its own
 * model with its own context, and gets back only the answer. A helper looks and does not touch: it may
 * read files, search, fetch pages and run commands that change nothing. A call that would change
 * something, or that would need the person's approval, is refused, since a helper asks nobody. So
 * helpers never wait, several can run at the same time, and what they read stays out of the
 * session's own context.
 */
import type {
	AssistantMessage,
	ModelMessage,
	ToolCallBlock,
	ToolResultMessage,
} from "../../shared/messages.ts";
import type { Session, UsageTotals } from "../../shared/types.ts";
import { type ModelGateway, plainError } from "../model/gateway.ts";
import type { PermissionEngine } from "../permissions/engine.ts";
import { specs } from "../tools/registry.ts";
import {
	type Lookup,
	type ToolContext,
	type ToolDefinition,
	ToolInputError,
	type ToolResult,
} from "../tools/types.ts";
import { usageTotals } from "./context.ts";

/** The tools a helper may have, when its session has them. */
export const HELPER_TOOLS = ["read", "glob", "grep", "shell", "web_fetch", "web_search"] as const;
/** Model requests one helper makes at most before a final wrap-up turn. */
const MAX_STEPS = 80;
/** The most of its answer that goes back. */
const MAX_ANSWER_CHARS = 60_000;

export interface HelperOptions {
	gateway: ModelGateway;
	permissions: PermissionEngine;
	/** The session that sent the helper: its model, folder, permission mode and rules. */
	session: Session;
	/** The session's tools; the helper gets the looking ones among them. */
	tools: ToolDefinition[];
	lookup: Lookup;
	/** A context for the helper's own tool calls. */
	context: ToolContext;
	systemPrompt: string;
	task: string;
	signal: AbortSignal;
	/** One line for each step, for the person watching. */
	onStep?: (line: string) => void;
	/** What each model request cost, as it comes. */
	onUsage?: (usage: UsageTotals) => void;
	maxSteps?: number;
}

export interface HelperResult {
	/** The helper's answer, or what it had when it had to stop. */
	text: string;
	/** Tool calls it made. */
	calls: number;
	/** Why it stopped before it had an answer, if it did. */
	stopped?: string;
}

const textOf = (message: AssistantMessage) =>
	message.content
		.flatMap((block) => (block.type === "text" && block.text.trim() ? [block.text] : []))
		.join("\n\n");

const refusal = (text: string): ToolResult => ({
	content: [{ type: "text", text }],
	isError: true,
});

/** A few words on what a call looks at: its path, pattern, command or address. */
export function stepLine(call: ToolCallBlock): string {
	const args = call.arguments as Record<string, unknown>;
	const what = [args.path, args.pattern, args.command, args.url, args.query].find(
		(value) => typeof value === "string" && value,
	);
	const shown = typeof what === "string" ? what.replace(/\s+/g, " ").slice(0, 160) : "";
	return shown ? `${call.name} ${shown}` : call.name;
}

export async function runHelper(options: HelperOptions): Promise<HelperResult> {
	const { session, signal } = options;
	const tools = options.tools.filter((tool) =>
		(HELPER_TOOLS as readonly string[]).includes(tool.name),
	);
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	// The same session as a reader, which is asked before anything but looking: a command it lets run
	// unasked only looks.
	const asReader: Session = {
		...session,
		options: { ...session.options, readerOnly: true },
	};
	const messages: ModelMessage[] = [{ role: "user", content: options.task, timestamp: Date.now() }];
	let calls = 0;
	let said = "";

	const runCall = async (call: ToolCallBlock): Promise<ToolResultMessage> => {
		const started = Date.now();
		const tool = byName.get(call.name);
		let result: ToolResult;
		if (!tool) {
			result = refusal(`There is no tool named ${call.name}. A helper can only look.`);
		} else if (call.argumentsError) {
			result = refusal(`The arguments were not valid JSON: ${call.argumentsError}`);
		} else if ((call.arguments as { background?: unknown }).background === true) {
			result = refusal("Not run: a helper cannot leave commands running in the background.");
		} else {
			try {
				const subject = tool.subject(call.arguments, session, options.lookup);
				// Allowed for the session as it is; a command also has to be one that only looks.
				const allowed =
					options.permissions.decide(subject, session).effect === "allow" &&
					(tool.name !== "shell" ||
						options.permissions.decide(subject, asReader).effect === "allow");
				if (!allowed) {
					result = refusal(
						"Not run: a helper only looks and cannot ask the person, and this call would change something or needs their approval. Say in your answer what you could not check.",
					);
				} else {
					options.onStep?.(stepLine(call));
					result = await tool.run(call.arguments, options.context);
				}
			} catch (error) {
				if (signal.aborted) throw error;
				result = refusal(
					error instanceof ToolInputError
						? error.message
						: `The tool failed: ${(error as Error).message}`,
				);
			}
		}
		return {
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: result.content,
			isError: result.isError ?? false,
			timestamp: Date.now(),
			durationMs: Date.now() - started,
		};
	};

	const stop = (stopped: string): HelperResult => ({
		text: said.slice(0, MAX_ANSWER_CHARS),
		calls,
		stopped,
	});
	const maxSteps = options.maxSteps ?? MAX_STEPS;
	for (let step = 0; step < maxSteps; step++) {
		if (signal.aborted) return stop("stopped");
		const reply = await options.gateway.stream({
			provider: session.provider,
			model: session.model,
			thinking: session.thinking,
			systemPrompt: options.systemPrompt,
			messages,
			tools: specs(tools),
			signal,
		});
		options.onUsage?.(usageTotals(reply));
		if (reply.stopReason === "aborted" || signal.aborted) return stop("stopped");
		if (reply.stopReason === "error") {
			return stop(plainError(reply.errorMessage ?? "The model request failed."));
		}
		const text = textOf(reply);
		if (text) said = text;
		const asked = reply.content.filter(
			(block): block is ToolCallBlock => block.type === "toolCall",
		);
		if (asked.length === 0) {
			return reply.stopReason === "length"
				? stop("its answer was cut off at the output limit")
				: { text: said.slice(0, MAX_ANSWER_CHARS), calls };
		}
		messages.push(reply);
		calls += asked.length;
		// Everything a helper may do only looks, so its calls of one step run at the same time.
		messages.push(...(await Promise.all(asked.map(runCall))));
	}
	// Do not discard gathered work when the step budget runs out: ask once without tools so the helper
	// synthesizes everything it has found so far and notes what it did not get to check.
	if (!signal.aborted) {
		messages.push({
			role: "user",
			content:
				"You have reached your step limit. Stop calling tools and write your complete answer now from what you have already gathered, noting anything you did not get to check.",
			timestamp: Date.now(),
		});
		const wrap = await options.gateway.stream({
			provider: session.provider,
			model: session.model,
			thinking: session.thinking,
			systemPrompt: options.systemPrompt,
			messages,
			tools: [],
			signal,
		});
		options.onUsage?.(usageTotals(wrap));
		if (wrap.stopReason !== "aborted" && wrap.stopReason !== "error" && !signal.aborted) {
			const final = textOf(wrap);
			if (final) return { text: final.slice(0, MAX_ANSWER_CHARS), calls };
		}
	}
	return stop(`it used all ${maxSteps} of its steps`);
}
