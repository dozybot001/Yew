import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { findRepositories } from "./sandbox.ts";

/**
 * The outer guard. A session's command that does not run in the system
 * sandbox (one the person let run outside it, or every command where the sandbox is off) still runs
 * in a layer that keeps it from answering a decision in the person's place, even in skip mode, in
 * ways Yew cannot see in the command's text:
 *
 * - it cannot read or write where decisions are kept and answered: Yew Harness's data folder, and
 *   the Mac app's web storage, which holds its sign-in; nor the folders the person keeps from
 *   sessions (a setting), so that skip mode need not ask about a command that names one;
 * - it cannot start a program outside the guard: on macOS no LaunchServices (`open`) and no Apple
 *   Events (osascript telling another program); on Linux no session bus or user systemd
 *   (`/run/user/<uid>`), so no Secret Service either;
 * - it cannot write what runs later outside the guard by itself: login items, shells' start-up
 *   files, git's own settings, ssh's settings, and the hooks and settings of repositories.
 *
 * Everything else stays open: writing anywhere else, going online, using credentials. An address
 * to open goes through Yew's own open_url tool instead.
 *
 * macOS: sandbox-exec with a profile that allows everything but this. Linux: bubblewrap with the
 * whole system as it is, an empty folder over each closed folder and the protected files read-only.
 * This is not the system sandbox (sandbox.ts) and does not use its library, which cannot leave the
 * rest open.
 */
export type GuardKind = "macos" | "linux" | "none";

/**
 * Guard relaxation mode for the two operations that need one; the default and automatic modes ask
 * the person before each, skip mode does not:
 * - "default": full outer guard (blocks Yew data, WebKit storage, startup items, git hooks/config, lsopen, appleevent-send).
 * - "git-setup": unlocks `.git/config` ONLY in the repositories of the folders the session may write (Core Guard stays locked: Yew data, WebKit, startup items,
 *   `~/.gitconfig`, `~/.ssh/config`, `.git/hooks`, `lsopen`, `appleevent-send`). Paired with post-run `.git/config` audit.
 * - "launch-app": unlocks `lsopen` ONLY so `open -a <App>` works while all write locks stay in force.
 */
export type GuardMode = "default" | "git-setup" | "launch-app";

export interface Guard {
	kind: GuardKind;
	program: string | null;
	/** Closed for reading and writing. */
	places: string[];
	/** The folders the person keeps from sessions now (a setting): closed like the places. */
	hidden: () => string[];
	/** The person's home folder, where the files that run by themselves are. */
	home: string;
	/** Linux: the session bus and user systemd, closed. */
	runtime: string | null;
}

const NONE: Guard = {
	kind: "none",
	program: null,
	places: [],
	hidden: () => [],
	home: "",
	runtime: null,
};
let guard: Guard = NONE;

/** A path as the system sees it: links resolved, through its nearest folder that exists. */
export function resolved(path: string): string {
	if (existsSync(path)) return realpathSync(path);
	const parent = dirname(path);
	return parent === path ? path : join(resolved(parent), basename(path));
}

/**
 * Files and folders in the home folder that run by themselves later, outside the guard: login items,
 * the shells' start-up files, git's and ssh's settings.
 */
export function startupPlaces(home: string): { files: string[]; folders: string[] } {
	const at = (path: string) => resolved(join(home, path));
	return {
		files: [
			".zshrc",
			".zprofile",
			".zshenv",
			".zlogin",
			".zlogout",
			".bashrc",
			".bash_profile",
			".bash_login",
			".profile",
			".gitconfig",
			".ssh/config",
		].map(at),
		folders: [
			"Library/LaunchAgents",
			".config/fish",
			".config/git",
			".config/systemd",
			".config/autostart",
		].map(at),
	};
}

/** A string in a Seatbelt profile. */
const quoted = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Repositories' hooks, anywhere: always permanently locked in Core Guard. */
const GIT_HOOKS = ["/\\.git/(modules/.+/)?hooks(/.*)?$"];

/** Repositories' local config files: locked by default, unlocked only for human-approved `git-setup` decisions. */
const GIT_CONFIGS = [
	"/\\.git/(modules/.+/)?config(\\.worktree)?$",
	"/\\.git/worktrees/[^/]+/config(\\.worktree)?$",
];

/** The macOS profile: everything allowed, except what the guard closes for `mode`. */
export function guardProfile(
	places: string[],
	home: string,
	mode: GuardMode = "default",
	writable: string[] = [],
): string {
	const startup = startupPlaces(home);
	const gitPatterns = [...GIT_HOOKS, ...GIT_CONFIGS];
	const lines = [
		"(version 1)",
		"(allow default)",
		`(deny file-read* file-write* ${places.map((place) => `(subpath ${quoted(place)})`).join(" ")})`,
		`(deny file-write* ${[
			...startup.files.map((file) => `(literal ${quoted(file)})`),
			...startup.folders.map((folder) => `(subpath ${quoted(folder)})`),
			...gitPatterns.map((pattern) => `(regex #"${pattern}")`),
		].join(" ")})`,
	];
	// git-setup: repositories' own settings files, only under the folders the session may write;
	// a later rule wins in a Seatbelt profile.
	if (mode === "git-setup") {
		const configs = GIT_CONFIGS.map((pattern) => `(regex #"${pattern}")`).join(" ");
		for (const root of writable.map(resolved)) {
			lines.push(
				`(allow file-write* (require-all (subpath ${quoted(root)}) (require-any ${configs})))`,
			);
		}
	}
	if (mode !== "launch-app") lines.push("(deny lsopen)");
	lines.push("(deny appleevent-send)");
	return lines.join("\n");
}

/** Linux: the repositories under the working folder now, their hooks (and optionally configs) that exist. */
function repositoryInternals(cwd: string, includeConfigs = true): string[] {
	return findRepositories(cwd).flatMap((repository) => {
		if (!repository.folder) return includeConfigs ? [repository.git] : [];
		const paths: string[] = [];
		const walk = (git: string, depth: number) => {
			paths.push(join(git, "hooks"));
			if (includeConfigs) paths.push(join(git, "config"), join(git, "config.worktree"));
			const modules = join(git, "modules");
			if (depth < 4 && existsSync(modules)) {
				for (const name of readdirSync(modules)) walk(join(modules, name), depth + 1);
			}
			if (includeConfigs) {
				const worktrees = join(git, "worktrees");
				if (existsSync(worktrees)) {
					for (const name of readdirSync(worktrees)) {
						paths.push(join(worktrees, name, "config"), join(worktrees, name, "config.worktree"));
					}
				}
			}
		};
		walk(repository.git, 0);
		return paths.filter((path) => existsSync(path));
	});
}

/** How to run `shell -lc command` in the guard, in `cwd`; null when there is no guard. */
export function guardedArgs(
	shell: string,
	command: string,
	cwd: string,
	state: Guard = guard,
	mode: GuardMode = "default",
	writable: string[] = [cwd],
): { file: string; args: string[] } | null {
	if (state.kind === "none" || !state.program || state.places.length === 0) return null;
	const closed = [...new Set([...state.places, ...state.hidden().map(resolved)])];
	if (state.kind === "macos") {
		return {
			file: state.program,
			args: ["-p", guardProfile(closed, state.home, mode, writable), shell, "-lc", command],
		};
	}
	// An empty folder over each closed folder; bubblewrap cannot lay one over a file. What runs by
	// itself later is bound read-only where it exists: a placeholder for a missing one would be made
	// in the person's real home folder.
	const isFolder = (path: string) => existsSync(path) && statSync(path).isDirectory();
	const covers = [...closed, ...(state.runtime ? [state.runtime] : [])]
		.filter(isFolder)
		.flatMap((place) => ["--tmpfs", place]);
	const startup = startupPlaces(state.home);
	const readOnly = [
		...startup.files,
		...startup.folders,
		...repositoryInternals(cwd, mode !== "git-setup"),
	]
		.filter((path) => existsSync(path))
		.flatMap((path) => ["--ro-bind", path, path]);
	return {
		file: state.program,
		args: ["--dev-bind", "/", "/", ...covers, ...readOnly, "--", shell, "-lc", command],
	};
}

/**
 * Starts the guard for these places, and for the folders `hidden` names when a command starts. It
 * first runs a command in it that must not see an entry of the data folder; a system where that does
 * not work gets no guard, and the reason.
 */
export function startGuard(
	places: string[],
	home: string,
	find: (name: string) => string | null,
	platform: NodeJS.Platform = process.platform,
	hidden: () => string[] = () => [],
): { kind: GuardKind; problem: string | null } {
	const program =
		platform === "darwin" ? "/usr/bin/sandbox-exec" : platform === "linux" ? find("bwrap") : null;
	if (!program || !existsSync(program)) {
		guard = NONE;
		return { kind: "none", problem: platform === "linux" ? "bubblewrap is missing" : null };
	}
	const kind: GuardKind = platform === "darwin" ? "macos" : "linux";
	const uid = typeof process.getuid === "function" ? process.getuid() : null;
	const runtime = platform === "linux" && uid !== null ? `/run/user/${uid}` : null;
	const state: Guard = {
		kind,
		program,
		places: [...new Set(places.map(resolved))],
		hidden,
		home: resolved(home),
		runtime: runtime && existsSync(runtime) ? runtime : null,
	};
	// It must run a command, and that command must not see what is in a place (the data folder).
	const folder = state.places.find(
		(place) => existsSync(place) && statSync(place).isDirectory() && readdirSync(place).length > 0,
	);
	const entry = folder ? join(folder, readdirSync(folder)[0] as string) : null;
	const probe = guardedArgs(
		"/bin/sh",
		entry ? `test ! -e '${entry.replace(/'/g, "'\\''")}'` : "true",
		state.home,
		state,
	);
	const ran = probe
		? spawnSync(probe.file, probe.args, { stdio: "ignore", timeout: 10_000 })
		: null;
	if (ran?.status !== 0) {
		guard = NONE;
		const why = ran?.error?.message ?? `exit ${ran?.status}`;
		return { kind: "none", problem: `the guard did not keep a command out of Yew's data (${why})` };
	}
	guard = state;
	return { kind, problem: null };
}

export function guardKind(): GuardKind {
	return guard.kind;
}

/** For tests: no guard. */
export function stopGuard(): void {
	guard = NONE;
}
