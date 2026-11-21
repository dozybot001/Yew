import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { Card, Letter, Session } from "../shared/types.ts";
import { ArtifactStore } from "./artifacts.ts";
import { AttachmentStore } from "./attachments.ts";
import { invalid } from "./errors.ts";
import { type ExportLanguage, sessionMarkdown } from "./export.ts";
import { MailStore } from "./mail/store.ts";
import { ScheduleBook } from "./schedules.ts";
import { readSettings } from "./settings.ts";
import type { Store } from "./store.ts";

/**
 * Everything Yew keeps, as files a person can read without Yew: each session as Markdown, and
 * letters, cards, scheduled tasks and settings as JSON.
 * Left out: API keys (they are in the keychain), paired phones and their tokens, sign-in tokens.
 */
export interface ExportCounts {
	sessions: number;
	letters: number;
	cards: number;
	schedules: number;
	artifacts: number;
	attachments: number;
	files: number;
}

const PAGE = 200;

function all<T, C>(page: (cursor: C | null) => { items: T[]; nextCursor: C | null }): T[] {
	const items: T[] = [];
	let cursor: C | null = null;
	do {
		const next = page(cursor);
		items.push(...next.items);
		cursor = next.nextCursor;
	} while (cursor !== null);
	return items;
}

/** A file name from a session's name: readable, and safe on every file system. */
function fileNameOf(name: string, taken: Set<string>): string {
	const base =
		name
			.replace(/[\\/:*?"<>|\p{Cc}]/gu, " ")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 80) || "session";
	let candidate = base;
	for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${base} ${n}`;
	taken.add(candidate.toLowerCase());
	return `${candidate}.md`;
}

/** A safe file name for an exported attachment, preserving its extension and avoiding collisions. */
function attachmentFileName(name: string, taken: Set<string>): string {
	const ext = extname(name)
		.replace(/[\\/:*?"<>|\p{Cc}]/gu, "")
		.slice(0, 16);
	const rawStem = ext ? name.slice(0, -ext.length) : name;
	const stem =
		rawStem
			.replace(/[\\/:*?"<>|\p{Cc}]/gu, " ")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 80) || "attachment";
	let candidate = `${stem}${ext}`;
	for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${stem} ${n}${ext}`;
	taken.add(candidate.toLowerCase());
	return candidate;
}

export function exportAll(
	store: Store,
	folder: string,
	now = Date.now(),
	yewHome: string | null = null,
): ExportCounts {
	if (existsSync(folder) && readdirSync(folder).length > 0) {
		throw invalid(`${folder} is not empty. Export into a new or empty folder.`, "folder");
	}
	const settings = readSettings(store);
	const language: ExportLanguage = settings.language === "en" ? "en" : "zh";
	const mail = new MailStore(store);
	let files = 0;
	const write = (path: string, content: string | Buffer) => {
		writeFileSync(join(folder, path), content, { mode: 0o600 });
		files += 1;
	};
	const json = (value: unknown) => `${JSON.stringify(value, null, "\t")}\n`;
	mkdirSync(join(folder, "sessions"), { recursive: true, mode: 0o700 });

	const sessions: Session[] = [
		...all<Session, string>((cursor) => store.listSessions({ cursor, limit: PAGE })),
		...all<Session, string>((cursor) =>
			store.listSessions({ archived: true, cursor, limit: PAGE }),
		),
	];
	const groups = new Map(store.listGroups().map((group) => [group.id, group.name]));
	const attachmentStore = yewHome ? new AttachmentStore(store, yewHome) : null;
	let attachments = 0;
	const taken = new Set<string>();
	const index = sessions.map((session) => {
		const file = fileNameOf(session.name, taken);
		const sessionFolder = file.replace(/\.md$/, "");
		const links = new Map<string, string>();
		if (attachmentStore) {
			const list = attachmentStore.listForSession(session.id);
			const usedNames = new Set<string>();
			for (const item of list) {
				if (!existsSync(item.filePath)) continue;
				const dir = join("attachments", sessionFolder);
				mkdirSync(join(folder, dir), { recursive: true, mode: 0o700 });
				const outName = attachmentFileName(item.name, usedNames);
				write(join(dir, outName), readFileSync(item.filePath));
				links.set(item.id, `../attachments/${sessionFolder}/${outName}`);
				attachments += 1;
			}
		}
		write(
			join("sessions", file),
			sessionMarkdown({
				session,
				groupName: session.groupId ? (groups.get(session.groupId) ?? null) : null,
				entries: store.allEntries(session.id),
				toolCalls: store.toolCallsForSession(session.id),
				language,
				now,
				...(links.size > 0 ? { attachmentPath: (ref) => links.get(ref.id) ?? null } : {}),
			}),
		);
		// The record is in the Markdown file; this lists what the session is.
		const { rules, options, todos, ...summary } = session;
		return {
			...summary,
			team: session.groupId ? (groups.get(session.groupId) ?? null) : null,
			file,
		};
	});
	write("sessions.json", json(index));

	const letters = all<Letter, string>((cursor) => mail.listLetters({ cursor, limit: PAGE }));
	write("letters.json", json(letters));
	const cards = all<Card, string>((cursor) =>
		mail.listCards({ cursor: cursor === null ? null : Number(cursor), limit: PAGE }),
	);
	write("cards.json", json(cards));
	const schedules = new ScheduleBook(store).list();
	write("schedules.json", json(schedules));
	write("settings.json", json({ exportedAt: new Date(now).toISOString(), ...settings }));
	// Artifacts: every version's file under the session's and the artifact's name, with a list.
	let artifacts = 0;
	if (yewHome) {
		const kept = new ArtifactStore(store, yewHome);
		const names = new Map(index.map((entry) => [entry.id, entry.file.replace(/\.md$/, "")]));
		const used = new Set<string>();
		for (const artifact of kept.list({ limit: 100_000 })) {
			const dir = join(
				"artifacts",
				names.get(artifact.sessionId) ?? artifact.sessionId,
				fileNameOf(artifact.name, used).replace(/\.md$/, ""),
			);
			mkdirSync(join(folder, dir), { recursive: true, mode: 0o700 });
			const versions = kept.versions(artifact.id);
			for (const { version } of versions) {
				const extension = { markdown: "md", html: "html", json: "json", chart: "json" }[
					artifact.kind
				];
				write(join(dir, `v${version}.${extension}`), kept.content(artifact.id, version).content);
			}
			write(join(dir, "artifact.json"), json({ ...artifact, versions }));
			artifacts += 1;
		}
	}
	return {
		artifacts,
		attachments,
		sessions: sessions.length,
		letters: letters.length,
		cards: cards.length,
		schedules: schedules.length,
		files,
	};
}
