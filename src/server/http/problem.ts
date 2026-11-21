import { randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { YewError } from "../errors.ts";

/**
 * `Bindings.device` is set only for requests a paired phone sends through the relay channel: the
 * connector calls the app in-process, so a request from the network can never carry it.
 */
export type AppEnv = { Variables: { requestId: string }; Bindings: { device?: string } };

/** Problem types are tag URIs (RFC 4151): stable identifiers that are not meant to be fetched. */
export const problemType = (code: string) => `tag:tenonai.cn,2026:yew/problem/${code}`;

export function problemResponse(
	c: Context<AppEnv>,
	status: number,
	code: string,
	title: string,
	detail?: string,
	extra?: Record<string, unknown>,
): Response {
	const body = {
		type: problemType(code),
		title,
		status,
		...(detail ? { detail } : {}),
		...extra,
		requestId: c.get("requestId"),
	};
	return c.newResponse(JSON.stringify(body), status as ContentfulStatusCode, {
		"Content-Type": "application/problem+json",
	});
}

const TITLES: Record<number, string> = {
	400: "Bad request",
	401: "Sign-in required",
	403: "Forbidden",
	404: "Not found",
	405: "Method not allowed",
	409: "Conflict",
	413: "Request too large",
	415: "Unsupported media type",
	421: "Misdirected request",
	422: "Unprocessable request",
	429: "Too many requests",
	500: "Internal error",
	503: "Unavailable",
};

export function titleFor(status: number): string {
	return TITLES[status] ?? "Error";
}

/** Gives every request an ID, returned in `X-Request-Id` and in problem bodies. */
export const requestId = (): MiddlewareHandler<AppEnv> => async (c, next) => {
	const id = randomUUID();
	c.set("requestId", id);
	await next();
	c.res.headers.set("X-Request-Id", id);
};

export function errorHandler(log: (line: string) => void) {
	return (error: Error, c: Context<AppEnv>): Response => {
		if (error instanceof YewError) {
			return problemResponse(
				c,
				error.status,
				error.code,
				titleFor(error.status),
				error.message,
				error.details,
			);
		}
		if (error instanceof HTTPException) {
			return problemResponse(c, error.status, "http-error", titleFor(error.status), error.message);
		}
		log(`[${c.get("requestId")}] ${c.req.method} ${c.req.path}: ${error.stack ?? error.message}`);
		return problemResponse(
			c,
			500,
			"internal-error",
			titleFor(500),
			"Something went wrong inside Yew Harness. The request ID is in the log.",
		);
	};
}
