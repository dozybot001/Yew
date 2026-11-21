import { Hono } from "hono";
import type { QuestionAnswer } from "../../shared/types.ts";
import type { Agents } from "../agent/runner.ts";
import { invalid } from "../errors.ts";
import type { Store } from "../store.ts";
import { idempotent } from "./idempotency.ts";
import { optArray, optBoolean, optEnum, optString, readJson, reqString } from "./input.ts";
import type { AppEnv } from "./problem.ts";

/** One answer of a structured question card: option indexes and the person's own words. */
function questionAnswer(value: unknown): QuestionAnswer {
	const fields = (value && typeof value === "object" ? value : null) as Record<
		string,
		unknown
	> | null;
	const choices = fields?.choices;
	if (!fields || !Array.isArray(choices) || choices.some((choice) => !Number.isInteger(choice))) {
		throw invalid("Each answer needs a list of option numbers in choices.", "answers");
	}
	const text = fields.text;
	if (text !== undefined && (typeof text !== "string" || text.length > 10_000)) {
		throw invalid("An answer's text must be text of at most 10000 characters.", "answers");
	}
	return { choices: choices as number[], ...(typeof text === "string" ? { text } : {}) };
}

/** Sending messages, stopping, continuing, and answering approvals and questions. */
/**
 * A decision made on a paired phone. "Always allow" for a tool that acts with the person's sign-ins
 * is only given where its scope is said: older phone builds that do not send
 * `confirmedWarning: true` are safely downgraded to `allow_once`; updated builds that display the
 * warning and require explicit confirmation pass `confirmedWarning: true`.
 */
export function decisionFromPhone<T extends string>(
	decision: T,
	request: unknown,
	confirmedWarning = false,
): T | "allow_once" {
	const warned = (request as { warning?: unknown } | null)?.warning !== undefined;
	return decision === "allow_always" && warned && !confirmedWarning ? "allow_once" : decision;
}

export function agentRoutes(
	store: Store,
	agents: Agents,
	log: (line: string) => void,
): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	const once = idempotent(store.db);

	// The person deletes all archived sessions for good (settings, data); the interface asks first.
	app.delete("/sessions/archived", (c) => c.json({ deleted: agents.deleteArchived() }));

	app.post("/sessions/:id/messages", once, async (c) => {
		const fields = await readJson(c);
		const text = optString(fields, "text", 100_000) ?? "";
		const rawAttachments = optArray(fields, "attachments");
		let attachmentIds: string[] | undefined;
		if (rawAttachments !== undefined) {
			if (
				rawAttachments.length > 10 ||
				rawAttachments.some(
					(item) => typeof item !== "string" || item.length === 0 || item.length > 100,
				)
			) {
				throw invalid("attachments must be a list of at most 10 attachment ids.", "attachments");
			}
			attachmentIds = rawAttachments as string[];
		}
		const result = agents.send(c.req.param("id"), text, attachmentIds);
		return c.json(result, "entry" in result ? 201 : 202);
	});

	app.post("/sessions/:id/stop", (c) => {
		const id = c.req.param("id");
		store.getSession(id);
		agents.stop(id);
		return c.body(null, 204);
	});

	app.post("/sessions/:id/continue", (c) => {
		const id = c.req.param("id");
		agents.continue(id);
		return c.json(store.getSession(id), 202);
	});

	// The conversation goes back to a reply, or to just before one of the person's messages.
	app.post("/sessions/:id/rewind", async (c) => {
		const id = c.req.param("id");
		const withdrawn = agents.rewind(id, reqString(await readJson(c), "entryId", 100));
		return c.json({ withdrawn, session: store.getSession(id) });
	});

	app.post("/sessions/:id/compact", (c) => {
		const id = c.req.param("id");
		store.getSession(id);
		void agents.compactNow(id).catch((error: Error) => log(`compact ${id}: ${error.message}`));
		return c.body(null, 202);
	});

	app.post("/sessions/:id/renew", async (c) => {
		const id = c.req.param("id");
		store.getSession(id);
		const contentType = c.req.header("Content-Type") ?? "";
		const fields = /^application\/json\b/i.test(contentType) ? await readJson(c) : {};
		const summarize = optBoolean(fields, "summarize") ?? true;
		const status = await agents.renewNow(id, summarize);
		return c.json({ status, session: store.getSession(id) });
	});

	app.post("/approvals/:id", async (c) => {
		const fields = await readJson(c);
		const asked = optEnum(fields, "decision", ["allow_once", "allow_always", "deny"] as const);
		const confirmedWarning = optBoolean(fields, "confirmedWarning") ?? false;
		const decision =
			asked && c.env?.device
				? decisionFromPhone(asked, store.getApproval(c.req.param("id")).request, confirmedWarning)
				: asked;
		const reason = optString(fields, "reason", 2000);
		const answer = optString(fields, "answer", 10_000);
		const answers = optArray(fields, "answers")?.map(questionAnswer);
		return c.json(
			agents.answer(c.req.param("id"), {
				...(decision ? { decision } : {}),
				...(reason ? { reason } : {}),
				...(answer !== undefined ? { answer } : {}),
				...(answers ? { answers } : {}),
			}),
		);
	});

	return app;
}
