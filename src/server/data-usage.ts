import { lstatSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { conflict } from "./errors.ts";

/**
 * What the data folder takes on disk, by kind (docs/data-inventory.md), and
 * the one cleanup Yew offers: the over-long command output under `tmp`. Sizes are the files' lengths.
 * Links are never followed, so a link in the folder counts as a link and nothing outside is touched.
 */
export type DataPartId = "database" | "artifacts" | "attachments" | "logs" | "temp" | "other";

export interface TempUsage {
	/** Files under `tmp`, and what they take. */
	files: number;
	bytes: number;
	/** The ones a cleanup would delete now: not of a session with a command that may still write. */
	removableFiles: number;
	removableBytes: number;
}

export interface DataUsage {
	folder: string;
	totalBytes: number;
	parts: { id: DataPartId; bytes: number }[];
	temp: TempUsage;
	readAt: number;
}

export interface CleanupResult {
	deletedFiles: number;
	freedBytes: number;
	/** Left in place: files of sessions with a running command, links, and files that would not go. */
	skippedFiles: number;
}

/** Whether a session has a command that may still be writing or reading its output files. */
export type InUse = (sessionId: string) => boolean;

const DATABASE_FILES = new Set(["yew.db", "yew.db-wal", "yew.db-shm"]);
const FOLDERS: Record<string, DataPartId> = {
	artifacts: "artifacts",
	attachments: "attachments",
	logs: "logs",
	tmp: "temp",
};

function entries(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

/** The bytes under a path, without following links; what cannot be read counts as nothing. */
function sizeOf(path: string): number {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch {
		return 0;
	}
	if (!stat.isDirectory()) return stat.size;
	let bytes = 0;
	for (const name of entries(path)) bytes += sizeOf(join(path, name));
	return bytes;
}

interface TempScan {
	removable: { path: string; bytes: number }[];
	/** Folders of sessions that are not in use, deepest first, to remove once they are empty. */
	folders: string[];
	keptFiles: number;
	keptBytes: number;
}

const EMPTY_SCAN: TempScan = { removable: [], folders: [], keptFiles: 0, keptBytes: 0 };

/**
 * Lists what is under `tmp`. The folder must really be `<data folder>/tmp`: when it is a link, or
 * resolves to somewhere else, nothing is listed and the cleanup refuses. Below it only real folders
 * are entered and only regular files are offered for deletion.
 */
function scanTemp(home: string, inUse: InUse): TempScan {
	const tmp = join(home, "tmp");
	let real: string;
	try {
		if (lstatSync(tmp).isSymbolicLink()) throw outside();
		real = realpathSync(tmp);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_SCAN;
		throw error;
	}
	if (real !== join(realpathSync(home), "tmp")) throw outside();
	const scan: TempScan = { removable: [], folders: [], keptFiles: 0, keptBytes: 0 };
	const walk = (dir: string, kept: boolean, top: boolean) => {
		for (const name of entries(dir)) {
			const path = join(dir, name);
			let stat: ReturnType<typeof lstatSync>;
			try {
				stat = lstatSync(path);
			} catch {
				continue;
			}
			// Directly under tmp a folder is a session's, named by its id.
			const keep = kept || (top && stat.isDirectory() && inUse(name));
			if (stat.isDirectory()) {
				walk(path, keep, false);
				if (!keep) scan.folders.push(path);
			} else if (stat.isFile() && !keep) {
				scan.removable.push({ path, bytes: stat.size });
			} else {
				scan.keptFiles += 1;
				scan.keptBytes += stat.size;
			}
		}
	};
	walk(real, false, true);
	return scan;
}

const outside = () =>
	conflict(
		"The tmp folder in Yew Harness's data folder is a link to somewhere else. Yew Harness does not delete through it.",
		undefined,
		"temp-outside",
	);

export function dataUsage(home: string, inUse: InUse = () => false, now = Date.now()): DataUsage {
	const bytes: Record<DataPartId, number> = {
		database: 0,
		artifacts: 0,
		attachments: 0,
		logs: 0,
		temp: 0,
		other: 0,
	};
	for (const name of entries(home)) {
		const part: DataPartId = DATABASE_FILES.has(name) ? "database" : (FOLDERS[name] ?? "other");
		bytes[part] += sizeOf(join(home, name));
	}
	let scan = EMPTY_SCAN;
	try {
		scan = scanTemp(home, inUse);
	} catch {
		// A tmp folder that is a link: its size is the link's, and nothing in it is offered.
	}
	const removableBytes = scan.removable.reduce((sum, file) => sum + file.bytes, 0);
	const parts = (Object.keys(bytes) as DataPartId[]).map((id) => ({ id, bytes: bytes[id] }));
	return {
		folder: home,
		totalBytes: parts.reduce((sum, part) => sum + part.bytes, 0),
		parts,
		temp: {
			files: scan.removable.length + scan.keptFiles,
			bytes: removableBytes + scan.keptBytes,
			removableFiles: scan.removable.length,
			removableBytes,
		},
		readAt: now,
	};
}

/**
 * Deletes the files under `tmp`, except those of sessions with a command that may still be writing.
 * It runs in one go without waiting, so no command can start in between. Emptied folders go too; the
 * `tmp` folder itself stays.
 */
export function cleanTemp(home: string, inUse: InUse = () => false): CleanupResult {
	const scan = scanTemp(home, inUse);
	const result: CleanupResult = { deletedFiles: 0, freedBytes: 0, skippedFiles: scan.keptFiles };
	for (const file of scan.removable) {
		try {
			unlinkSync(file.path);
			result.deletedFiles += 1;
			result.freedBytes += file.bytes;
		} catch {
			result.skippedFiles += 1;
		}
	}
	for (const folder of scan.folders) {
		try {
			rmdirSync(folder);
		} catch {
			// Not empty: something in it was kept.
		}
	}
	return result;
}
