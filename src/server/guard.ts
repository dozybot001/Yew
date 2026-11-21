import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { findRepositories } from "./repositories.ts";

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
 * - it cannot have a program that already runs outside the guard do the work for it: no container
 *   engine (a container can mount any folder, the closed ones too) unless the person lets the
 *   session use containers, and on macOS no ssh to this computer;
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

/** What a session's setting opens in the guard for its commands. */
export interface GuardReach {
	/** The person lets the session use container engines (Docker and the like). */
	containers?: boolean;
}

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

/**
 * Where container engines take orders on this computer: Docker Desktop, OrbStack, Colima, Lima,
 * Rancher Desktop, Podman, Multipass and Apple's container tool. Folders whose sockets are all
 * closed, and socket files elsewhere; each both as written and with links resolved, since the
 * system checks a socket by where it really is.
 */
export function containerPlaces(
	home: string,
	temporary: string = tmpdir(),
): { folders: string[]; files: string[] } {
	const both = (paths: string[]) => [...new Set(paths.flatMap((path) => [path, resolved(path)]))];
	return {
		folders: both([
			...[
				".docker",
				"Library/Containers/com.docker.docker",
				".orbstack",
				".colima",
				".config/colima",
				".lima",
				".rd",
				"Library/Application Support/rancher-desktop",
				"Library/Application Support/com.apple.container",
				".local/share/containers",
			].map((path) => join(home, path)),
			join(temporary, "podman"),
		]),
		files: both([
			"/var/run/docker.sock",
			"/run/docker.sock",
			"/run/podman/podman.sock",
			"/var/run/multipass_socket",
			"/run/multipass_socket",
			"/var/snap/multipass/common/multipass_socket",
		]),
	};
}

/**
 * Ports on this computer that let a command reach past the guard: the Docker engine's own (2375,
 * 2376) and Kubernetes' (6443), which a container engine's cluster listens on, closed with the
 * engines' sockets; ssh's (22) always.
 */
const CONTAINER_PORTS = [2375, 2376, 6443];
const SSH_PORT = 22;

/**
 * The services that start virtual machines, by the start of their names: Apple's Virtualization
 * framework, and the background service Apple's container tool takes its orders through.
 */
const MACHINE_SERVICES = ["com.apple.Virtualization.", "com.apple.container."];

/** A line of output about a container engine, and one that says it could not be reached. */
const CONTAINER_LINE =
	/\b(?:docker|podman|colima|lima|limactl|orbstack|rancher|multipass|kubectl)\b|:(?:2375|2376|6443)\b/i;
const REFUSED = /operation not permitted|permission denied|cannot connect|refused/i;
/** What Apple's container tool prints when it cannot reach its background service. */
const CONTAINER_SERVICE = /container system service has been started/i;

/**
 * What a command's result says when the guard kept a container engine from it, so the session does
 * not take it for an engine that is not running and knows who can open it. Null otherwise.
 */
export function containersNote(output: string): string | null {
	const refused = output
		.split("\n")
		.some(
			(line) => (CONTAINER_LINE.test(line) && REFUSED.test(line)) || CONTAINER_SERVICE.test(line),
		);
	if (!refused) return null;
	return "The command could not reach a container engine. Outside the sandbox, Yew Harness keeps container engines (Docker, Podman, Colima, Lima, OrbStack, Rancher Desktop, Multipass, Apple's container tool) and local Kubernetes closed to this session's commands, because a container can open any folder on this computer. The person can allow containers in this session's settings; ask them if the task needs it.";
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

/**
 * The macOS profile: everything allowed, except what the guard closes for `mode`. Container engines'
 * folders are closed like the places, so their sockets and the keys to their machines are out of
 * reach too, unless `reach` opens them.
 */
export function guardProfile(
	places: string[],
	home: string,
	mode: GuardMode = "default",
	writable: string[] = [],
	reach: GuardReach = {},
): string {
	const startup = startupPlaces(home);
	const gitPatterns = [...GIT_HOOKS, ...GIT_CONFIGS];
	const engines = reach.containers ? { folders: [], files: [] } : containerPlaces(home);
	const closed = [...places, ...engines.folders];
	const ports = [...(reach.containers ? [] : CONTAINER_PORTS), SSH_PORT];
	const lines = [
		"(version 1)",
		"(allow default)",
		`(deny file-read* file-write* ${closed.map((place) => `(subpath ${quoted(place)})`).join(" ")})`,
		`(deny file-write* ${[
			...startup.files.map((file) => `(literal ${quoted(file)})`),
			...startup.folders.map((folder) => `(subpath ${quoted(folder)})`),
			...gitPatterns.map((pattern) => `(regex #"${pattern}")`),
		].join(" ")})`,
		`(deny network-outbound ${[
			...engines.folders.map((folder) => `(remote unix-socket (subpath ${quoted(folder)}))`),
			...engines.files.map((file) => `(remote unix-socket (path-literal ${quoted(file)}))`),
			...ports.map((port) => `(remote ip "localhost:${port}")`),
		].join(" ")})`,
	];
	// A virtual machine started with Apple's Virtualization framework shares folders through the
	// framework's own services, and Apple's container tool starts its machines through a service of
	// its own; both run outside the guard: closed with the container engines.
	if (!reach.containers) {
		const names = MACHINE_SERVICES.map(
			(name) => `(global-name-prefix "${name}") (xpc-service-name-prefix "${name}")`,
		);
		lines.push(`(deny mach-lookup ${names.join(" ")})`);
	}
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
	reach: GuardReach = {},
): { file: string; args: string[] } | null {
	if (state.kind === "none" || !state.program || state.places.length === 0) return null;
	const closed = [...new Set([...state.places, ...state.hidden().map(resolved)])];
	if (state.kind === "macos") {
		return {
			file: state.program,
			args: ["-p", guardProfile(closed, state.home, mode, writable, reach), shell, "-lc", command],
		};
	}
	// An empty folder over each closed folder; bubblewrap cannot lay one over a file. What runs by
	// itself later is bound read-only where it exists: a placeholder for a missing one would be made
	// in the person's real home folder. A container engine's socket outside its folders gets an empty
	// file laid over it, which nothing can connect to. bubblewrap cannot close single ports.
	const isFolder = (path: string) => existsSync(path) && statSync(path).isDirectory();
	const engines = reach.containers
		? { folders: [], files: [] }
		: containerPlaces(state.home, tmpdir());
	const covers = [...new Set([...closed, ...engines.folders.map(resolved)])]
		.concat(state.runtime ? [state.runtime] : [])
		.filter(isFolder)
		.flatMap((place) => ["--tmpfs", place]);
	const sockets = [...new Set(engines.files.map(resolved))]
		.filter((path) => existsSync(path) && !isFolder(path))
		.flatMap((path) => ["--ro-bind", "/dev/null", path]);
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
		args: ["--dev-bind", "/", "/", ...covers, ...sockets, ...readOnly, "--", shell, "-lc", command],
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
