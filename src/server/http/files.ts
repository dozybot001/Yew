import { spawn } from "node:child_process";
import { type Dirent, existsSync, readdirSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Session } from "../../shared/types.ts";
import { invalid } from "../errors.ts";
import { canonical, isSecretPath } from "../permissions/paths.ts";

// Files the person reaches from a session: a path clicked in a reply, and the composer's `@` picker.

/** Resolves a file:// URI, ~/path, absolute path or session-relative path to an absolute filesystem path. */
export function resolveOpenFileTarget(
	raw: string,
	options: { homeDir: string; session: Session | null },
): string {
	let target = raw;
	if (/^file:\/\//i.test(target)) {
		try {
			target = fileURLToPath(target);
		} catch {
			throw invalid("Invalid file:// URL.", "path");
		}
	} else if (target === "~" || target.startsWith("~/")) {
		target = join(options.homeDir, target.slice(2));
	}
	if (isAbsolute(target)) return resolve(target);

	const session = options.session;
	const roots: string[] = [];
	if (session?.cwd) roots.push(session.cwd);
	for (const extra of session?.options.extraDirs ?? []) {
		roots.push(extra.path);
	}
	if (roots.length === 0) {
		throw invalid("Relative file links need a session working folder.", "path");
	}
	for (const root of roots) {
		const candidate = resolve(root, target);
		if (existsSync(candidate)) return candidate;
	}
	return resolve(roots[0] as string, target);
}

export interface SessionFileItem {
	path: string;
	label: string;
	root: "cwd" | "extra";
}

const MAX_FILE_SCAN_BYTES = 2 * 1024 * 1024;
const MAX_FALLBACK_FILES = 2000;
const SKIP_DIRS = new Set([".git", "node_modules", ".DS_Store"]);

function walkFallback(rootDir: string, offLimits: string[]): string[] {
	const out: string[] = [];
	const stack = [rootDir];
	while (stack.length > 0 && out.length < MAX_FALLBACK_FILES) {
		const dir = stack.pop() as string;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (SKIP_DIRS.has(entry.name)) continue;
			const full = join(dir, entry.name);
			if (isSecretPath(resolve(full), offLimits)) continue;
			if (entry.isDirectory()) {
				stack.push(full);
			} else if (entry.isFile() || entry.isSymbolicLink()) {
				out.push(relative(rootDir, full).replaceAll("\\", "/"));
				if (out.length >= MAX_FALLBACK_FILES) break;
			}
		}
	}
	return out;
}

function listRootFiles(rootDir: string, offLimits: string[]): Promise<string[]> {
	return new Promise((resolveFiles) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 3000);
		const child = spawn(
			"rg",
			[
				"--no-config",
				"--color=never",
				"--files",
				"--hidden",
				"--glob",
				"!.git",
				"--glob",
				"!node_modules",
				"--glob",
				"!.DS_Store",
			],
			{ cwd: rootDir, signal: controller.signal, stdio: ["ignore", "pipe", "ignore"] },
		);
		let stdout = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
			if (stdout.length > MAX_FILE_SCAN_BYTES) child.kill();
		});
		child.on("error", (error: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			if (error.code === "ENOENT") {
				resolveFiles(walkFallback(rootDir, offLimits));
			} else {
				resolveFiles([]);
			}
		});
		child.on("close", () => {
			clearTimeout(timer);
			const lines = stdout
				.split(/\r?\n/)
				.map((line) => line.trim().replaceAll("\\", "/"))
				.filter((line) => line.length > 0);
			resolveFiles(lines);
		});
	});
}

function scoreFileMatch(label: string, query: string): number | null {
	if (!query) return 0;
	const lower = label.toLowerCase();
	const base = basename(lower);
	if (base.startsWith(query)) return 0;
	if (base.includes(query)) return 1;
	if (lower.includes(query)) return 2;
	let qi = 0;
	for (let i = 0; i < lower.length && qi < query.length; i++) {
		if (lower[i] === query[qi]) qi++;
	}
	return qi === query.length ? 3 : null;
}

export async function listSessionFiles(
	session: Session,
	query: string,
	limit: number,
	offLimits: string[],
): Promise<SessionFileItem[]> {
	const roots: { dir: string; root: "cwd" | "extra"; prefix: string }[] = [];
	if (session.cwd) roots.push({ dir: session.cwd, root: "cwd", prefix: "" });
	for (const extra of session.options.extraDirs ?? []) {
		roots.push({ dir: extra.path, root: "extra", prefix: basename(extra.path) });
	}
	if (roots.length === 0) return [];

	const needle = query.toLowerCase();
	const candidates: { item: SessionFileItem; abs: string; score: number }[] = [];
	for (const entry of roots) {
		if (isSecretPath(canonical(entry.dir), offLimits)) continue;
		const rels = await listRootFiles(entry.dir, offLimits);
		for (const rel of rels) {
			const abs = resolve(entry.dir, rel);
			if (isSecretPath(abs, offLimits)) continue;
			const label = entry.root === "cwd" ? rel : `${entry.prefix}/${rel}`;
			const score = scoreFileMatch(label, needle);
			if (score === null) continue;
			candidates.push({
				item: {
					path: entry.root === "cwd" ? rel : abs,
					label,
					root: entry.root,
				},
				abs,
				score,
			});
		}
	}
	candidates.sort(
		(a, b) =>
			a.score - b.score ||
			a.item.label.length - b.item.label.length ||
			a.item.label.localeCompare(b.item.label),
	);
	const out: SessionFileItem[] = [];
	for (const candidate of candidates) {
		if (out.length >= limit) break;
		if (isSecretPath(canonical(candidate.abs), offLimits)) continue;
		out.push(candidate.item);
	}
	return out;
}
