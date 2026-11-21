import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, extname } from "node:path";
import type { FileOpener } from "../shared/types.ts";
import { conflict, YewError } from "./errors.ts";

/** Runs a program with its arguments, without a shell; rejects when it cannot start or fails. */
export type RunCommand = (command: string, args: string[]) => Promise<void>;

export const runProgram: RunCommand = (command, args) =>
	new Promise((resolve, reject) => {
		execFile(command, args, { timeout: 15_000 }, (error) => (error ? reject(error) : resolve()));
	});

/** What the interface calls the file manager on this system, or null where Yew knows none. */
export type RevealKind = "finder" | "files" | null;

export function revealKind(platform: string = process.platform): RevealKind {
	return platform === "darwin" ? "finder" : platform === "linux" ? "files" : null;
}

/**
 * The program that shows a folder in the system's file manager, or null where Yew knows none.
 * `inside` opens the folder itself; otherwise Finder opens the folder that holds it, with it selected.
 */
export function revealCommand(
	dir: string,
	platform: string = process.platform,
	inside = false,
): { command: string; args: string[] } | null {
	if (platform === "darwin") return { command: "open", args: inside ? [dir] : ["-R", dir] };
	if (platform === "linux") return { command: "xdg-open", args: [dir] };
	return null;
}

/**
 * Shows a folder in the file manager. The caller decides which folder: it is never a path taken from
 * a request. `field` names the request field in the problem when this system has no file manager
 * Yew knows.
 */
export async function showInFileManager(
	dir: string,
	options: { platform?: string; run?: RunCommand; inside?: boolean; field: string },
): Promise<void> {
	const program = revealCommand(dir, options.platform, options.inside);
	if (!program) {
		throw conflict(
			"Showing a folder in the file manager works on macOS and Linux.",
			{ field: options.field },
			"not-on-this-system",
		);
	}
	try {
		await (options.run ?? runProgram)(program.command, program.args);
	} catch {
		throw new YewError("reveal-failed", 500, "The folder could not be shown.");
	}
}

function encodeFileUrlPath(absPath: string): string {
	return absPath
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
}

/**
 * Builds the command that opens a local file or folder with the chosen program, jumping to
 * `line`/`column` when the editor supports it. Never invokes a shell.
 */
export function openFileCommand(
	targetPath: string,
	options: {
		opener: FileOpener;
		line?: number;
		column?: number;
		platform?: string;
		isDir?: boolean;
		/** Show the target in the file manager whatever the opener (see `revealOnly`). */
		reveal?: boolean;
	},
): { command: string; args: string[] } | null {
	const platform = options.platform ?? process.platform;
	const { line, column, isDir } = options;
	const opener = options.reveal ? "finder" : options.opener;
	const lineSuffix =
		!isDir && line && line > 0 ? `:${line}${column && column > 0 ? `:${column}` : ""}` : "";
	if (platform === "darwin") {
		switch (opener) {
			case "system":
				return { command: "open", args: [targetPath] };
			case "finder":
				return { command: "open", args: ["-R", targetPath] };
			case "vscode":
				return lineSuffix
					? {
							command: "open",
							args: [`vscode://file${encodeFileUrlPath(targetPath)}${lineSuffix}`],
						}
					: { command: "open", args: ["-a", "Visual Studio Code", targetPath] };
			case "cursor":
				return lineSuffix
					? {
							command: "open",
							args: [`cursor://file${encodeFileUrlPath(targetPath)}${lineSuffix}`],
						}
					: { command: "open", args: ["-a", "Cursor", targetPath] };
			case "zed":
				return lineSuffix
					? { command: "open", args: [`zed://file${encodeFileUrlPath(targetPath)}${lineSuffix}`] }
					: { command: "open", args: ["-a", "Zed", targetPath] };
		}
	}
	if (platform === "linux") {
		switch (opener) {
			case "system":
				return { command: "xdg-open", args: [targetPath] };
			case "finder":
				return { command: "xdg-open", args: [isDir ? targetPath : dirname(targetPath)] };
			case "vscode":
				return lineSuffix
					? { command: "code", args: ["--goto", `${targetPath}${lineSuffix}`] }
					: { command: "code", args: [targetPath] };
			case "cursor":
				return lineSuffix
					? { command: "cursor", args: ["--goto", `${targetPath}${lineSuffix}`] }
					: { command: "cursor", args: [targetPath] };
			case "zed":
				return { command: "zed", args: [lineSuffix ? `${targetPath}${lineSuffix}` : targetPath] };
		}
	}
	return null;
}

/**
 * What the system default may open: documents, pictures, PDFs, audio and video. Anything else could be
 * run, installed or followed by the program registered for it (scripts, apps, profiles, installers),
 * and third-party apps register more of those, so only this list is opened.
 * The old Office formats (.doc, .xls, .ppt) can carry macros and are left out; the new ones cannot.
 */
const DOCUMENT_TYPES = new Set(
	(
		"txt md markdown rst log csv tsv json jsonl yaml yml toml " +
		"png jpg jpeg gif webp heic heif bmp tif tiff ico pdf " +
		"mp3 m4a wav aac flac ogg opus mp4 m4v mov webm mkv avi " +
		"rtf docx xlsx pptx odt ods odp pages numbers key"
	)
		.split(" ")
		.map((type) => `.${type}`),
);

/** Files an editor opens as a project or installs rather than shows: they load tasks and settings. */
const EDITOR_PROJECT_TYPES = new Set([".code-workspace", ".vsix"]);

/**
 * True when the target is only shown in the file manager. A link in a reply is written by the model,
 * and one click must not run anything outside the sandbox. With the system default, a folder whose
 * name has an extension (an app is a folder), a file that is not a known document, and an executable
 * file are only shown. With an editor, a folder or a workspace file is only shown: the editor would
 * load the project's tasks and settings (`.vscode/tasks.json` can run a command when a folder
 * opens); a single file opened on its own loads none of them.
 */
export function revealOnly(
	targetPath: string,
	stat: { isDirectory(): boolean; mode: number } | null,
	opener: FileOpener,
): boolean {
	if (opener === "finder") return false;
	// What it is could not be read (it may have been swapped since it was checked): only show it.
	if (stat === null) return true;
	const type = extname(targetPath).toLowerCase();
	const isDir = stat.isDirectory();
	if (opener !== "system") return isDir || EDITOR_PROJECT_TYPES.has(type);
	if (isDir) return type !== "";
	return !DOCUMENT_TYPES.has(type) || (stat.mode & 0o111) !== 0;
}

/** Opens a verified local file or folder in the person's configured editor or file manager. */
export async function openLocalFile(
	targetPath: string,
	options: {
		opener: FileOpener;
		line?: number;
		column?: number;
		platform?: string;
		run?: RunCommand;
	},
): Promise<void> {
	let stat: ReturnType<typeof statSync> | null = null;
	try {
		stat = statSync(targetPath);
	} catch {
		// Caller already verified existence; treat as file if stat races.
	}
	const isDir = stat?.isDirectory() ?? false;
	const reveal = revealOnly(targetPath, stat, options.opener);
	const program = openFileCommand(targetPath, { ...options, isDir, reveal });
	if (!program) {
		throw conflict(
			"Opening local files works on macOS and Linux.",
			{ field: "path" },
			"not-on-this-system",
		);
	}
	try {
		await (options.run ?? runProgram)(program.command, program.args);
	} catch {
		throw new YewError(
			"open-file-failed",
			500,
			`Could not open ${targetPath} with ${options.opener}. Check that the app is installed.`,
		);
	}
}
