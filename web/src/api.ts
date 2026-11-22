/** Thin client for Yew's local API. Errors arrive as RFC 9457 problems with a request ID. */

export class ApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly requestId: string | undefined;
	readonly field: string | undefined;
	readonly provider: string | undefined;

	constructor(
		status: number,
		code: string,
		message: string,
		requestId?: string,
		field?: string,
		provider?: string,
	) {
		super(message);
		this.status = status;
		this.code = code;
		this.requestId = requestId;
		this.field = field;
		this.provider = provider;
	}
}

interface Problem {
	type?: string;
	title?: string;
	detail?: string;
	requestId?: string;
	field?: string;
	provider?: string;
}

export async function api<T = unknown>(
	method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
	path: string,
	body?: unknown,
	/** `keepalive`: the request outlives the page, for what is saved as the page goes away. */
	options: { idempotent?: boolean; keepalive?: boolean } = {},
): Promise<T> {
	const headers: Record<string, string> = {};
	if (body !== undefined) headers["Content-Type"] = "application/json";
	if (options.idempotent) headers["Idempotency-Key"] = crypto.randomUUID();
	let response: Response;
	try {
		response = await fetch(path, {
			method,
			headers,
			credentials: "same-origin",
			...(options.keepalive ? { keepalive: true } : {}),
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	} catch {
		throw new ApiError(0, "network", "network");
	}
	if (response.status === 204) return undefined as T;
	const text = await response.text();
	if (!response.ok) throw toApiError(response, text);
	return (text ? JSON.parse(text) : undefined) as T;
}

function toApiError(response: Response, text: string): ApiError {
	let problem: Problem = {};
	try {
		problem = JSON.parse(text) as Problem;
	} catch {
		// Not a problem document; fall back to the status line.
	}
	const code = problem.type?.split("/").pop() ?? "error";
	return new ApiError(
		response.status,
		code,
		problem.detail ?? problem.title ?? response.statusText,
		problem.requestId ?? response.headers.get("X-Request-Id") ?? undefined,
		problem.field,
		problem.provider,
	);
}

/** Uploads a file as multipart/form-data (for message attachments). */
export async function uploadFile<T = unknown>(path: string, file: File): Promise<T> {
	const form = new FormData();
	form.append("file", file, file.name || "attachment");
	let response: Response;
	try {
		response = await fetch(path, {
			method: "POST",
			credentials: "same-origin",
			body: form,
		});
	} catch {
		throw new ApiError(0, "network", "network");
	}
	const text = await response.text();
	if (!response.ok) throw toApiError(response, text);
	return (text ? JSON.parse(text) : undefined) as T;
}

/** Fetches a file the interface saves, such as a Markdown export. */
export async function downloadFile(path: string): Promise<{ blob: Blob; filename: string | null }> {
	let response: Response;
	try {
		response = await fetch(path, { credentials: "same-origin" });
	} catch {
		throw new ApiError(0, "network", "network");
	}
	if (!response.ok) throw toApiError(response, await response.text());
	return {
		blob: await response.blob(),
		filename: filenameFrom(response.headers.get("Content-Disposition")),
	};
}

/** Prefers the UTF-8 file name (RFC 5987); falls back to the plain ASCII one. */
function filenameFrom(header: string | null): string | null {
	const extended = /filename\*=UTF-8''([^;]+)/i.exec(header ?? "");
	if (extended?.[1]) {
		try {
			return decodeURIComponent(extended[1]);
		} catch {
			// A broken header is no reason to fail the download.
		}
	}
	return /filename="([^"]+)"/i.exec(header ?? "")?.[1] ?? null;
}

/** Follows `nextCursor` until a paginated list is complete. */
export async function all<T>(path: string): Promise<T[]> {
	const items: T[] = [];
	let cursor: string | null = null;
	do {
		const separator = path.includes("?") ? "&" : "?";
		const page: { items: T[]; nextCursor: string | null } = await api(
			"GET",
			`${path}${separator}limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
		);
		items.push(...page.items);
		cursor = page.nextCursor;
	} while (cursor);
	return items;
}
