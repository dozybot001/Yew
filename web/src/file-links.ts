/** Local file links in replies: where they point and, when given, the line and column to open at. */
export interface ParsedFileLink {
	path: string;
	line?: number;
	column?: number;
}

/** Web and mail links, opened as they are. */
export const SAFE_PROTOCOLS = /^(https?:|mailto:)/i;

export function decodeSafe(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/**
 * Recognizes local file links in Markdown (`file://...`, `/abs/path`, `~/path`, `./rel`, `dir/file.md`),
 * with optional `#L12`, `#L12-L20`, `:12` or `:12:5` line/column anchors. Rejects unknown URI schemes.
 */
export function parseLocalFileHref(raw: string): ParsedFileLink | null {
	const trimmed = raw.trim();
	if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) return null;
	if (SAFE_PROTOCOLS.test(trimmed)) return null;

	let body = trimmed;
	let line: number | undefined;
	let column: number | undefined;

	const hashIndex = body.indexOf("#");
	if (hashIndex >= 0) {
		const fragment = body.slice(hashIndex + 1);
		body = body.slice(0, hashIndex);
		const match = /^L?(\d+)(?:-L?\d+)?$/i.exec(fragment);
		if (match) line = Number.parseInt(match[1] as string, 10);
	}

	const isFileUrl = /^file:\/\//i.test(body);
	const lineMatch = /:(\d+)(?::(\d+))?$/.exec(body);
	if (lineMatch && lineMatch.index > (isFileUrl ? 7 : 0)) {
		if (line === undefined) line = Number.parseInt(lineMatch[1] as string, 10);
		if (lineMatch[2]) column = Number.parseInt(lineMatch[2], 10);
		body = body.slice(0, lineMatch.index);
	}

	if (!body) return null;
	if (isFileUrl) {
		return {
			path: body,
			...(line !== undefined ? { line } : {}),
			...(column !== undefined ? { column } : {}),
		};
	}

	// Refuse any non-file URI scheme such as javascript:, data:, vbscript:, tel:, etc.
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(body)) return null;
	return {
		path: decodeSafe(body),
		...(line !== undefined ? { line } : {}),
		...(column !== undefined ? { column } : {}),
	};
}

/** Top folders of macOS and Linux. Other absolute-looking code, such as `/api/cards`, is a route. */
const SYSTEM_ROOTS = new Set([
	"Applications",
	"Library",
	"System",
	"Users",
	"Volumes",
	"bin",
	"etc",
	"home",
	"mnt",
	"opt",
	"private",
	"root",
	"srv",
	"tmp",
	"usr",
	"var",
]);
/** Spaces, globs, placeholders, variables, options and markup: a command or a pattern, not one path. */
const NOT_A_PATH = /[\s*?<>{}[\]|$"'`\\#;,=]/;
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;
const LINE_SUFFIX = /:(\d+)(?::(\d+)|-\d+)?$/;

/**
 * A local path written as inline code in a reply, such as `~/notes/plan.md`, `./src`, `/etc/hosts` or
 * `src/app.ts:12`: home, dot and absolute paths, and relative paths with a folder and a file extension,
 * with an optional `:line`, `:line:column` or `:line-line`. Commands, globs, placeholders, web addresses
 * and routes stay code. Relative paths are opened from the session's folder.
 */
export function codeSpanPath(text: string): ParsedFileLink | null {
	if (text.length > 1024 || NOT_A_PATH.test(text) || text.includes("//")) return null;
	let path = text;
	let line: number | undefined;
	let column: number | undefined;
	const suffix = LINE_SUFFIX.exec(path);
	if (suffix) {
		line = Number.parseInt(suffix[1] as string, 10);
		if (suffix[2]) column = Number.parseInt(suffix[2], 10);
		path = path.slice(0, suffix.index);
	}
	if (path.includes(":") || path.startsWith("-") || !isPath(path)) return null;
	return {
		path,
		...(line !== undefined && line > 0 ? { line } : {}),
		...(column !== undefined && column > 0 ? { column } : {}),
	};
}

function isPath(path: string): boolean {
	if (path.startsWith("~")) return path.startsWith("~/") && path.length > 2;
	if (path.startsWith("./") || path.startsWith("../"))
		return path.replace(/^(\.\.?\/)+/, "") !== "";
	const parts = path.split("/");
	if (path.startsWith("/")) {
		const first = parts[1] ?? "";
		return SYSTEM_ROOTS.has(first) || (parts.length > 2 && EXTENSION.test(parts.at(-1) ?? ""));
	}
	// Relative: a folder and a file with an extension. A first part like `example.com` is a web address.
	const first = parts[0] ?? "";
	return (
		parts.length > 1 &&
		first !== "" &&
		(!first.includes(".") || first.startsWith(".")) &&
		EXTENSION.test(parts.at(-1) ?? "")
	);
}
