import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Db } from "../db/database.ts";
import { YewError } from "../errors.ts";
import type { AppEnv } from "./problem.ts";

const KEEP_MS = 24 * 60 * 60 * 1000;
const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

/**
 * `Idempotency-Key` for create requests (IETF draft): a repeat with the same key and body
 * returns the first response without running the handler again; the same key with a different body is
 * rejected, and so is a repeat that arrives while the first is still running.
 */
export function idempotent(db: Db): MiddlewareHandler<AppEnv> {
	const inFlight = new Set<string>();
	const find = db.prepare(
		"SELECT fingerprint, status, body FROM idempotency_keys WHERE scope = ? AND key = ?",
	);
	const save = db.prepare(
		`INSERT INTO idempotency_keys (scope, key, fingerprint, status, body, created_at)
		VALUES (?, ?, ?, ?, ?, ?)`,
	);
	const expire = db.prepare("DELETE FROM idempotency_keys WHERE created_at < ?");

	return async (c, next) => {
		const key = c.req.header("Idempotency-Key");
		if (key === undefined) return next();
		if (!KEY_PATTERN.test(key)) {
			throw new YewError(
				"invalid-request",
				400,
				"Idempotency-Key must be 1–255 visible characters.",
			);
		}
		const scope = `${c.req.method} ${c.req.path}`;
		const fingerprint = createHash("sha256")
			.update(await c.req.text())
			.digest("hex");
		const saved = find.get(scope, key) as
			| { fingerprint: string; status: number; body: string }
			| undefined;
		if (saved) {
			if (saved.fingerprint !== fingerprint) {
				throw new YewError(
					"idempotency-key-reused",
					422,
					"This Idempotency-Key was already used with a different request body.",
				);
			}
			return c.newResponse(saved.body, saved.status as ContentfulStatusCode, {
				"Content-Type": "application/json",
				"Idempotent-Replayed": "true",
			});
		}
		const slot = `${scope} ${key}`;
		if (inFlight.has(slot)) {
			throw new YewError(
				"idempotency-key-in-use",
				409,
				"A request with this Idempotency-Key is still being processed.",
			);
		}
		inFlight.add(slot);
		try {
			await next();
			if (c.res.status < 500) {
				expire.run(Date.now() - KEEP_MS);
				save.run(scope, key, fingerprint, c.res.status, await c.res.clone().text(), Date.now());
			}
		} finally {
			inFlight.delete(slot);
		}
	};
}
