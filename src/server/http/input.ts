import type { Context } from "hono";
import { invalid, YewError } from "../errors.ts";

export type Fields = Record<string, unknown>;

/** Reads a JSON object body. Requiring application/json also keeps out cross-site "simple" form posts. */
export async function readJson(c: Context): Promise<Fields> {
	const type = c.req.header("Content-Type") ?? "";
	if (!/^application\/json\b/i.test(type)) {
		throw new YewError("unsupported-media-type", 415, "Send the body as application/json.");
	}
	let value: unknown;
	try {
		value = await c.req.json();
	} catch {
		throw invalid("The body is not valid JSON.");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw invalid("The body must be a JSON object.");
	}
	return value as Fields;
}

export function optString(fields: Fields, key: string, max = 10_000): string | undefined {
	const value = fields[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw invalid(`${key} must be text.`, key);
	if (value.length > max) throw invalid(`${key} can be at most ${max} characters.`, key);
	return value;
}

export function reqString(fields: Fields, key: string, max = 10_000): string {
	const value = optString(fields, key, max);
	if (value === undefined) throw invalid(`${key} is required.`, key);
	return value;
}

export function optNullableString(
	fields: Fields,
	key: string,
	max = 10_000,
): string | null | undefined {
	if (fields[key] === null) return null;
	return optString(fields, key, max);
}

export function optBoolean(fields: Fields, key: string): boolean | undefined {
	const value = fields[key];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw invalid(`${key} must be true or false.`, key);
	return value;
}

export function optNumber(fields: Fields, key: string): number | undefined {
	const value = fields[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw invalid(`${key} must be a number.`, key);
	}
	return value;
}

export function optEnum<T extends string>(
	fields: Fields,
	key: string,
	values: readonly T[],
): T | undefined {
	const value = fields[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !values.includes(value as T)) {
		throw invalid(`${key} must be one of: ${values.join(", ")}.`, key);
	}
	return value as T;
}

export function optObject(fields: Fields, key: string): Fields | undefined {
	const value = fields[key];
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw invalid(`${key} must be an object.`, key);
	}
	return value as Fields;
}

export function optArray(fields: Fields, key: string): unknown[] | undefined {
	const value = fields[key];
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw invalid(`${key} must be a list.`, key);
	return value;
}

export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 200;

/** `limit` and `cursor` query parameters (every list is paginated and capped). */
export function pageParams(c: Context, max = MAX_PAGE): { limit: number; cursor: string | null } {
	const raw = c.req.query("limit");
	let limit = DEFAULT_PAGE;
	if (raw !== undefined) {
		limit = Number(raw);
		if (!Number.isInteger(limit) || limit < 1 || limit > max) {
			throw invalid(`limit must be a whole number from 1 to ${max}.`, "limit");
		}
	}
	return { limit, cursor: c.req.query("cursor") ?? null };
}

export function optIntQuery(c: Context, key: string): number | undefined {
	const raw = c.req.query(key);
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (!Number.isSafeInteger(value)) throw invalid(`${key} must be a whole number.`, key);
	return value;
}
