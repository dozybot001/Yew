import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { GuardMode } from "../guard.ts";
import { canonical, isInside } from "./paths.ts";
import { mustConfirmReason } from "./shell.ts";
import { parseShell } from "./shell-parse.ts";

// How far the outer guard opens for one command the person let run outside the sandbox: a plain
// local repository setup, or opening an app installed for everyone. See guard.ts for the guard.

/** git config keys that only name things and never make git run a program. */
const SAFE_CONFIG_KEY =
	/^(user\.[a-z0-9-]+|remote\.[^\s=]+\.(url|pushurl|fetch)|branch\.[^\s=]+\.(remote|merge|rebase|pushremote|description)|init\.defaultbranch)$/i;
/** git config flags that keep to the repository's own file and do nothing else. */
const CONFIG_FLAGS = new Set([
	"--local",
	"--unset",
	"--unset-all",
	"--add",
	"--replace-all",
	"--bool",
	"--int",
	"--path",
]);

/** git init and clone options that never run anything, in full. */
const SETUP_FLAGS = new Set([
	"--depth",
	"--branch",
	"-b",
	"--single-branch",
	"--no-single-branch",
	"--no-tags",
	"--origin",
	"-o",
	"--quiet",
	"-q",
	"--progress",
	"--filter",
	"--bare",
	"--initial-branch",
]);
/** Those of them that take a value. */
const SETUP_VALUE_FLAGS = new Set([
	"--depth",
	"--branch",
	"-b",
	"--origin",
	"-o",
	"--filter",
	"--initial-branch",
]);

/**
 * Whether `git ...` is a plain local repository setup the guard may let write its repository's
 * settings: no options before the subcommand (--git-dir, -c and the like point git elsewhere or set
 * things; a single -C is taken off before, by withoutFolder), no clone or init option that runs a
 * program or uses a template, and for git config only keys that never make git run anything.
 */
function plainGitSetup(argv: string[]): boolean {
	const sub = argv[1];
	if (!sub || sub.startsWith("-")) return false;
	const rest = argv.slice(2);
	// init and clone: only options that cannot run anything, written out in full. git takes any
	// unambiguous abbreviation of a long option, so a list of refused ones would not hold.
	if (sub === "init" || sub === "clone") {
		for (let index = 0; index < rest.length; index++) {
			const arg = rest[index] as string;
			if (arg === "--") break;
			if (!arg.startsWith("-")) continue;
			const name = arg.split("=")[0] as string;
			if (!SETUP_FLAGS.has(name)) return false;
			if (SETUP_VALUE_FLAGS.has(name) && !arg.includes("=")) index++;
		}
		return true;
	}
	if (sub === "remote") return true;
	if (sub === "config") {
		let words = rest;
		if (words[0] === "set" || words[0] === "unset") words = words.slice(1);
		let key: string | null = null;
		for (const [index, word] of words.entries()) {
			if (word.startsWith("-")) {
				if (!CONFIG_FLAGS.has(word) && !word.startsWith("--type=")) return false;
				continue;
			}
			key = word;
			// Nothing that looks like an option after the key either.
			if (words.slice(index + 1).some((later) => later.startsWith("-"))) return false;
			break;
		}
		return key !== null && SAFE_CONFIG_KEY.test(key);
	}
	return false;
}

/**
 * What a shell might expand in a word, quoted or not (`#` and `^` are patterns in zsh with
 * extendedglob): a path with one is not taken as written.
 */
const EXPANDS = /[$`~*?[\]{}#^]/;

/**
 * The folder `git -C <path>` points a repository setup at, when the guard may let it through: an
 * absolute path written out as is, with nothing the shell would expand and no `..`, to a folder that
 * is there and, links resolved, inside one the session may write (its working folder or an extra
 * folder it may write). Null otherwise.
 */
function setupFolder(path: string | undefined, writable: string[]): string | null {
	if (!path || !isAbsolute(path) || EXPANDS.test(path) || path.split("/").includes("..")) {
		return null;
	}
	let real: string;
	try {
		real = realpathSync(path);
	} catch {
		return null;
	}
	return writable.some((root) => isInside(real, canonical(resolve(root)))) ? real : null;
}

/**
 * A git command with its one `-C <folder>` taken off, and that folder; one without `-C` as it is.
 * Null when `-C` does not name a folder setupFolder lets through; a second `-C` stays in the command,
 * where plainGitSetup refuses it like any other option before the subcommand.
 */
function withoutFolder(
	argv: string[],
	writable: string[],
): { argv: string[]; folder: string | null } | null {
	if (argv[1] !== "-C") return { argv, folder: null };
	const folder = setupFolder(argv[2], writable);
	return folder ? { argv: ["git", ...argv.slice(3)], folder } : null;
}

/**
 * How git reports that it may not write a repository's settings file, or the hooks folder that init
 * and clone fill: macOS refuses the write, bubblewrap's read-only file cannot be replaced.
 */
const GIT_SETTINGS_REFUSED =
	/(?:could not (?:write|lock) config file [^\n]*\.git\/[^\n]*|\.git\/hooks\/?): (?:Operation not permitted|Permission denied|Read-only file system|Device or resource busy)/;

/**
 * What a command's result says when git was refused a repository's settings: when Yew Harness lets
 * them through (classifyGuardMode and the guard's profile), so the session can run the command that
 * way and does not take it for a protection it cannot get past. Null when git was not refused them.
 */
export function gitSettingsNote(output: string): string | null {
	if (!GIT_SETTINGS_REFUSED.test(output)) return null;
	return "git could not change the repository's settings (.git/config): Yew Harness keeps them closed to commands. It opens them for one command when all of this holds: it runs outside the sandbox; it is a git init, clone, remote or config on its own, run in the working folder or with one -C and the full path of a folder this session may write, written out (no cd, -c, ~, $, wildcards, environment variables or other commands on the line); git config sets only user.*, remote.<name>.url, pushurl or fetch, branch.<name>.remote, merge, rebase, pushRemote or description, or init.defaultBranch; and the repository is in a folder this session may write. Settings that can make git run programs are for the person to change.";
}

/** Desktop apps that would run commands for whoever asks them: never launched with the guard open. */
const COMMAND_APPS =
	/^(terminal|iterm|iterm2|warp|ghostty|alacritty|kitty|wezterm|hyper|tabby|script editor|automator|shortcuts|console)$/i;

/** The app `open -a <name>` names, when it is one installed for everyone; null otherwise. */
export function launchableApp(
	argv: string[],
	folders: string[] = ["/Applications", "/System/Applications"],
): string | null {
	if (argv.length !== 3 || argv[1] !== "-a") return null;
	const name = (argv[2] ?? "").replace(/\.app$/i, "");
	if (!name || name.includes("/") || name.startsWith(".") || COMMAND_APPS.test(name)) return null;
	for (const folder of folders) {
		const app = join(folder, `${name}.app`);
		if (existsSync(app)) return app;
	}
	return null;
}

/** Where a command runs and what it may change, for picking how far the outer guard opens. */
export interface GuardFolders {
	/** The folders the session may write: its working folder and the extra folders it may write. */
	writable?: string[];
	/** Where apps installed for everyone are; the system's folders when not given. */
	apps?: string[];
}

/** A command's guard mode, with the git command it judged and the folder a `-C` names in it. */
function guardChoice(
	command: string,
	folders: GuardFolders,
): { mode: GuardMode; argv: string[]; folder: string | null } {
	const none = { mode: "default" as const, argv: [], folder: null };
	const parsed = parseShell(command);
	if (!parsed.understood || parsed.segments.length !== 1) return none;
	const segment = parsed.segments[0];
	if (!segment || segment.dynamic || segment.redirects.length > 0) return none;
	const argv = segment.argv;
	const name = argv[0] ?? "";
	if (name === "git" && mustConfirmReason(argv) === "git-setup") {
		const plain = withoutFolder(argv, folders.writable ?? []);
		if (plain && plainGitSetup(plain.argv)) return { mode: "git-setup", ...plain };
		return none;
	}
	if (name === "open" && launchableApp(argv, folders.apps)) {
		return { mode: "launch-app", argv, folder: null };
	}
	return none;
}

/**
 * Picks the outer guard relaxation mode for a human-approved command running outside the sandbox.
 * Only one plain command, written out as is (no environment assignments, `env` or other wrapper in
 * front), gets the single-purpose unlock: a local repository setup (plainGitSetup), run in the
 * working folder or with one `-C` naming a folder the session may write (setupFolder), or opening an
 * app installed for everyone that is not a terminal or a script runner (launchableApp). Anything
 * else runs in the full guard.
 */
export function classifyGuardMode(command: string, folders: GuardFolders = {}): GuardMode {
	return guardChoice(command, folders).mode;
}

/**
 * The repository a git-setup command changes, as an absolute path: the folder git init or clone
 * makes or fills, or the repository around the folder it runs in.
 */
export function gitSetupTarget(argv: string[], cwd: string): string {
	const sub = argv[1];
	const operands: string[] = [];
	for (let index = 2; index < argv.length; index++) {
		const arg = argv[index] as string;
		if (!arg.startsWith("-")) operands.push(arg);
		else if (SETUP_VALUE_FLAGS.has(arg)) index++;
	}
	if (sub === "init") return resolve(cwd, operands[0] ?? ".");
	if (sub === "clone") {
		const [source, folder] = operands;
		if (folder) return resolve(cwd, folder);
		const last = (source ?? "").replace(/\/+$/, "").split(/[/:]/).at(-1) ?? "";
		return resolve(cwd, last.replace(/\.git$/, "") || ".");
	}
	let dir = resolve(cwd);
	while (!existsSync(join(dir, ".git"))) {
		const up = dirname(dir);
		if (up === dir) return resolve(cwd);
		dir = up;
	}
	return dir;
}

/** A command's guard mode and, for a repository setup, the repository it changes. */
export function guardFor(
	command: string,
	cwd: string,
	folders: GuardFolders = {},
): { mode: GuardMode; repository: string | null } {
	const { mode, argv, folder } = guardChoice(command, folders);
	return { mode, repository: mode === "git-setup" ? gitSetupTarget(argv, folder ?? cwd) : null };
}

/** What a card for a command that opens the guard says, besides the command; null for any other. */
export function guardPreview(
	command: string,
	cwd: string | null,
	folders: GuardFolders = {},
): string | null {
	const { mode, argv, folder } = guardChoice(command, folders);
	if (mode === "git-setup") {
		return `Changes the git repository at ${gitSetupTarget(argv, folder ?? cwd ?? process.cwd())}: only its own settings file is let through the outer guard for this one command.`;
	}
	if (mode === "launch-app") {
		return `Opens ${launchableApp(argv, folders.apps)}. The app runs outside Yew Harness's protection and can do anything you can.`;
	}
	return null;
}
