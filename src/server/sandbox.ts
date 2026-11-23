import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxAskCallback, SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { secretLocations } from "./permissions/paths.ts";
import { checkRepositories, gitInternals, snapshotRepositories } from "./repositories.ts";
import { LOCAL_INSTALL } from "./updates.ts";

/**
 * The system sandbox for sessions' commands and the stdio MCP servers people add. It is Anthropic's
 * open-source sandbox-runtime (`@anthropic-ai/sandbox-runtime`: Seatbelt on macOS, bubblewrap on
 * Linux), used through its public interface only. This module is Yew Harness's
 * own layer over it, so its configuration format, which still changes, stays in this one file.
 *
 * What a command in it may do, as the configuration below says:
 * - write only in the session's working folder, the sandbox's own caches and the temporary
 *   folders; never in Yew Harness's data folder, its program, what starts at login, or the hooks and
 *   settings of a git repository (the library protects shell profiles and `.git/hooks`,
 *   `.git/config` itself; this adds those of submodules and worktrees);
 * - read what the person can, except Yew Harness's data folder, the keychain files, the folders the
 *   person keeps from sessions (a setting) and, unless a setting allows them, the usual credential
 *   files and the SSH agent;
 * - reach the package registries, the code hosts packages come from and the model providers that
 *   have a key; any other site is put to the person while the command runs. Yew Harness's own port,
 *   local ports, private networks and Unix sockets stay closed.
 *
 * On by default on macOS and Linux. `YEW_SANDBOX=off` turns it off; commands then run as the
 * person, as they did before. Where it cannot start or run a command, it stays off and `yew serve`
 * and the settings say so.
 */

/** Where the sandbox's commands run from, and what they must not touch. */
export interface SandboxPlaces {
	/** Yew Harness's data folder. */
	home: string;
	/** Where the running Yew Harness is installed: the folder with its package.json. */
	install: string;
	/** The person's home folder. */
	userHome: string;
	/** The port `yew serve` listens on. */
	port: number;
	/** The sandbox's own folder, outside the data folder, for commands' caches. */
	root: string;
}

/** What the person's settings and keys add to the configuration; read before each command. */
export interface SandboxPolicy {
	/** Sites besides the package registries that commands reach without asking: model providers. */
	sites: string[];
	/** Whether commands may use the SSH agent and the usual credential files (a setting, off by default). */
	credentials: boolean;
	/** Folders the person keeps from sessions (a setting): neither read nor written in the sandbox. */
	hidden: string[];
}

/** What one command may do besides the usual. */
export interface SandboxGrant {
	/** Folders it may change, such as the session's working folder. */
	writable?: string[];
	/** Folders inside the data folder it may read, such as the code of a preset MCP server. */
	readable?: string[];
	/** Sites it may reach without asking, such as the service an MCP server talks to. */
	sites?: string[];
}

export type SandboxKind = "macos" | "linux" | "none";

/** The folder with this Yew Harness's package.json: the repository, or the installed package. */
export const INSTALL_DIR = fileURLToPath(new URL("../..", import.meta.url));

/** Package registries and the code hosts packages are fetched from (git dependencies, releases). */
export const PACKAGE_SITES = [
	"registry.npmjs.org",
	"registry.yarnpkg.com",
	"repo.yarnpkg.com",
	"registry.npmmirror.com",
	"cdn.npmmirror.com",
	"jsr.io",
	"npm.jsr.io",
	"deno.land",
	"pypi.org",
	"files.pythonhosted.org",
	"pypi.tuna.tsinghua.edu.cn",
	"mirrors.aliyun.com",
	"crates.io",
	"index.crates.io",
	"static.crates.io",
	"proxy.golang.org",
	"sum.golang.org",
	"goproxy.cn",
	"rubygems.org",
	"index.rubygems.org",
	"repo.maven.apache.org",
	"repo1.maven.org",
	"plugins.gradle.org",
	"services.gradle.org",
	"cdn.cocoapods.org",
	"github.com",
	"codeload.github.com",
	"objects.githubusercontent.com",
	"raw.githubusercontent.com",
	"gitee.com",
];

/** Private networks: an allowed name that resolves into one of them is not dialed. */
const PRIVATE_RANGES = [
	"10.0.0.0/8",
	"172.16.0.0/12",
	"192.168.0.0/16",
	"100.64.0.0/10",
	"fc00::/7",
];

/** What tells a program where the SSH agent is. */
const AGENT_VARIABLES = ["SSH_AUTH_SOCK", "SSH_AGENT_PID"];

const real = (path: string) => {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
};

/**
 * The sandbox's own folder: in the system's cache folder, because commands cannot write in the data
 * folder. Commands' caches go to `cache` in it.
 */
export function sandboxRoot(
	userHome = homedir(),
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): string {
	if (platform === "darwin") return join(userHome, "Library", "Caches", "yew-sandbox");
	return join(env.XDG_CACHE_HOME || join(userHome, ".cache"), "yew-sandbox");
}

/**
 * Variables that send the usual tools' caches to the sandbox's own folder, so nothing a command
 * leaves in a cache is picked up by the person's own tools outside. (The library points TMPDIR at
 * its own temporary folder.)
 */
export function sandboxEnvironment(places: Pick<SandboxPlaces, "root">): Record<string, string> {
	const cache = join(places.root, "cache");
	return {
		XDG_CACHE_HOME: join(cache, "xdg"),
		npm_config_cache: join(cache, "npm"),
		YARN_CACHE_FOLDER: join(cache, "yarn"),
		COREPACK_HOME: join(cache, "corepack"),
		BUN_INSTALL_CACHE_DIR: join(cache, "bun"),
		DENO_DIR: join(cache, "deno"),
		PIP_CACHE_DIR: join(cache, "pip"),
		UV_CACHE_DIR: join(cache, "uv"),
		PYTHONPYCACHEPREFIX: join(cache, "pycache"),
		GOCACHE: join(cache, "go-build"),
		GOMODCACHE: join(cache, "go-mod"),
		GRADLE_USER_HOME: join(cache, "gradle"),
		ELECTRON_CACHE: join(cache, "electron"),
	};
}

/**
 * The keychain files: never readable, whatever the setting for credentials says, so the keychain's
 * items cannot be read from the sandbox. git over HTTPS with saved credentials and gh run outside
 * the sandbox.
 */
function keychains(places: Pick<SandboxPlaces, "userHome">): string {
	return join(real(places.userHome), "Library", "Keychains");
}

/**
 * What WebKit keeps for the Mac app (macos/, `yew app install`) on macOS: the cookie that signs its
 * window in to Yew Harness, the cache of the interface and its local storage. Closed like the data
 * folder, for reading and writing.
 */
export function appWebData(
	places: Pick<SandboxPlaces, "userHome">,
	platform: NodeJS.Platform = process.platform,
): string[] {
	if (platform !== "darwin") return [];
	const library = join(real(places.userHome), "Library");
	const id = "cn.tenonai.apps.yew.desktop";
	return [
		join(library, "HTTPStorages", id),
		join(library, "HTTPStorages", `${id}.binarycookies`),
		join(library, "WebKit", id),
		join(library, "Caches", id),
	];
}

/**
 * The usual credential files and folders (the ones file tools refuse), without the data folder and
 * the keychain files, which stay closed either way: what the setting for credentials opens.
 */
function credentialFiles(places: Pick<SandboxPlaces, "home" | "userHome">): string[] {
	const closed = new Set([real(places.home), keychains(places)]);
	return secretLocations(places.home).filter((path) => !closed.has(path));
}

/**
 * The temporary folders: /tmp, and on macOS the user's own (…/T), which `mktemp` and Apple's tools
 * use whatever TMPDIR says. Not the cache folder next to it (…/C): shared caches stay read-only.
 */
function temporary(platform: NodeJS.Platform): string[] {
	const folders = new Set(["/tmp", real("/tmp")]);
	const own = real(tmpdir());
	if (platform === "darwin" && /^\/private\/var\/folders\/[^/]+\/[^/]+\/T$/.test(own))
		folders.add(own);
	return [...folders];
}

/** Where Yew Harness's own port is: commands must not reach its local interface. */
function ownPort(port: number): string[] {
	return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
}

/** The file system part of one command's configuration: the base plus what the command is granted. */
export function commandFilesystem(
	places: SandboxPlaces,
	policy: SandboxPolicy,
	grant: SandboxGrant = {},
	platform: NodeJS.Platform = process.platform,
): SandboxRuntimeConfig["filesystem"] {
	const writable = (grant.writable ?? []).map(real);
	const user = real(places.userHome);
	return {
		allowWrite: [...writable, join(places.root, "cache"), ...temporary(platform)],
		denyWrite: [
			real(places.home),
			...appWebData(places, platform),
			real(places.install),
			// The copy this computer runs when it is installed from a checkout, whichever copy runs
			// now: a copy left beside it would be taken for the one before it.
			real(join(user, LOCAL_INSTALL)),
			join(user, "Library", "LaunchAgents"),
			join(user, "Applications", "Yew.app"),
			join(user, ".config", "systemd", "user"),
			join(user, ".config", "autostart"),
			...writable.flatMap((folder) => gitInternals(folder, platform)),
			...policy.hidden,
		],
		denyRead: [
			real(places.home),
			...appWebData(places, platform),
			keychains(places),
			...policy.hidden,
			...(policy.credentials ? [] : credentialFiles(places)),
		],
		allowRead: (grant.readable ?? []).map(real),
		allowGitConfig: false,
	};
}

/** The configuration the sandbox starts with; each command adds its own file system part. */
export function sandboxConfig(
	places: SandboxPlaces,
	policy: SandboxPolicy,
	options: { platform?: NodeJS.Platform; ripgrep?: string | null; agentSocket?: string } = {},
): SandboxRuntimeConfig {
	const platform = options.platform ?? process.platform;
	const agent = policy.credentials ? options.agentSocket : undefined;
	return {
		network: {
			allowedDomains: [...new Set([...PACKAGE_SITES, ...policy.sites])],
			deniedDomains: ownPort(places.port),
			deniedResolvedAddresses: PRIVATE_RANGES,
			allowLocalBinding: false,
			allowAllUnixSockets: false,
			// The SSH agent only when the setting allows it (macOS; Linux cannot single out a socket).
			...(agent ? { allowUnixSockets: [agent] } : {}),
		},
		filesystem: commandFilesystem(places, policy, {}, platform),
		...(policy.credentials
			? {}
			: {
					credentials: {
						files: credentialFiles(places).map((path) => ({ path, mode: "deny" as const })),
						envVars: AGENT_VARIABLES.map((name) => ({ name, mode: "deny" as const })),
					},
				}),
		allowAppleEvents: false,
		allowPty: false,
		enableWeakerNestedSandbox: false,
		enableWeakerNetworkIsolation: false,
		allowNestedUserNamespaces: false,
		...(options.ripgrep ? { ripgrep: { command: options.ripgrep } } : {}),
	};
}

/**
 * Whether `yew serve` starts the sandbox: on macOS and Linux unless `YEW_SANDBOX=off`.
 * `YEW_SANDBOX=on` asks for it elsewhere as well; startSandbox says why not.
 */
export function sandboxWanted(
	setting: string | undefined,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (setting === "on") return true;
	if (setting === "off") return false;
	return platform === "darwin" || platform === "linux";
}

/** A program's full path, from PATH and the usual places a service started at login may lack. */
export function findProgram(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
	const folders = [
		...(env.PATH ?? "").split(delimiter),
		"/opt/homebrew/bin",
		"/usr/local/bin",
		"/usr/bin",
		"/bin",
	];
	for (const folder of folders) {
		if (folder && existsSync(join(folder, name))) return join(folder, name);
	}
	return null;
}

type Manager = typeof import("@anthropic-ai/sandbox-runtime")["SandboxManager"];

/** Something running in the sandbox, as a card names it. */
export interface RunningItem {
	kind: "command" | "job" | "mcp";
	/** The command line, or the MCP server's name. */
	text: string;
}

/** A site a command wants to reach, put to the person. */
export interface SiteQuestion {
	host: string;
	port?: number;
	/**
	 * Present when the connection may come from something else that runs in the sandbox: everything
	 * running then, this command first. Allowing it then lets this one connection through.
	 */
	unsure?: RunningItem[];
}

/** A command in the sandbox while it runs. */
interface Running {
	/** What it is, for a card. */
	label: RunningItem;
	/** Puts a site to the person; absent where nobody can be asked (background jobs, MCP servers). */
	ask?: (question: SiteQuestion) => Promise<boolean>;
	/** Sites it may reach: granted when it started, or allowed by the person since. */
	allowed: string[];
	/** Sites the person turned down for it: not asked again. */
	refused: Set<string>;
	/** Questions on their way to the person, one per site. */
	asking: Map<string, Promise<boolean>>;
}

interface Active {
	kind: SandboxKind;
	manager: Manager;
	places: SandboxPlaces;
	policy: () => SandboxPolicy;
	options: { ripgrep: string | null; agentSocket?: string };
	/** The configuration last given to the library, to know when the settings changed it. */
	applied: string;
}

let active: Active | null = null;
const running = new Map<string, Running>();

/** How a site reads in an allow list: `host:port`, with brackets around an IPv6 address. */
const siteOf = (host: string, port: number | undefined) => {
	const name = host.includes(":") ? `[${host}]` : host;
	return port === undefined ? name : `${name}:${port}`;
};

/** Turned down, with a reason the command's output and the model can read. */
const refuse = (reason: string) => ({ allow: false as const, reason });

/**
 * Asked about a site no rule decides. The library does not say which command is connecting, so the
 * question goes to the one command that can ask (a session's command the person is there for); with
 * none or several, the site is turned down and the reason says why. While anything else runs in the
 * sandbox too (a background command, an MCP server), the card says the source is unsure and lists
 * what runs, and a yes lets only this connection through.
 */
const decideSite: SandboxAskCallback = async ({ host, port }) => {
	const site = siteOf(host, port);
	const askers = [...running.entries()].filter(([, command]) => command.ask);
	if (askers.length === 0) {
		return refuse(
			`${host} is not among the sites commands may reach, and nobody could be asked: run it as a command of a session the person is watching, or outside the sandbox`,
		);
	}
	if (askers.length > 1) {
		return refuse(
			`${host} is not among the sites commands may reach, and several commands were running, so Yew Harness could not tell whose connection this was: run the command again by itself`,
		);
	}
	const [id, command] = askers[0] as [string, Running];
	if (command.allowed.includes(site)) return true;
	if (command.refused.has(site)) return refuse(`The person did not allow ${host} for this command`);
	const others = [...running.entries()].filter(([other]) => other !== id);
	const unsure =
		others.length > 0 ? [command.label, ...others.map(([, other]) => other.label)] : undefined;
	let question = command.asking.get(site);
	if (!question) {
		const ask = command.ask as (question: SiteQuestion) => Promise<boolean>;
		question = ask({
			host,
			...(port === undefined ? {} : { port }),
			...(unsure ? { unsure } : {}),
		}).catch(() => false);
		command.asking.set(site, question);
	}
	const allowed = await question;
	command.asking.delete(site);
	if (!allowed) {
		command.refused.add(site);
		return refuse(`The person did not allow ${host} for this command`);
	}
	// Unsure whose connection it was: this one goes through, and the next one is asked about again.
	if (unsure) return true;
	if (!command.allowed.includes(site)) command.allowed.push(site);
	// The rest of this command's connections there go through without asking again.
	if (running.has(id))
		active?.manager.registerCommandNetworkLists(id, { allowedDomains: command.allowed });
	return true;
};

/**
 * Starts the sandbox once, when `yew serve` starts. Returns the kind in use, or "none" with the
 * reasons when this computer cannot run it (another system, or a missing program).
 */
export async function startSandbox(
	places: SandboxPlaces,
	policy: () => SandboxPolicy,
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ kind: SandboxKind; problems: string[] }> {
	if (process.platform !== "darwin" && process.platform !== "linux") {
		return { kind: "none", problems: [`${process.platform} has no sandbox Yew Harness can use`] };
	}
	const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
	if (!SandboxManager.isSupportedPlatform()) {
		return { kind: "none", problems: ["this system is not supported by the sandbox"] };
	}
	const ripgrep = findProgram("rg", env);
	const check = SandboxManager.checkDependencies(ripgrep ? { command: ripgrep } : undefined);
	if (check.errors.length > 0) return { kind: "none", problems: check.errors };
	mkdirSync(join(places.root, "cache"), { recursive: true, mode: 0o700 });
	const options = { ripgrep, ...(env.SSH_AUTH_SOCK ? { agentSocket: env.SSH_AUTH_SOCK } : {}) };
	const config = sandboxConfig(places, policy(), options);
	await SandboxManager.initialize(config, decideSite, true);
	// A system that cannot run a command in it (bubblewrap without user namespaces, say) gets no
	// sandbox, rather than sessions whose every command fails.
	const failed = await selfCheck(SandboxManager, places, policy());
	if (failed) {
		await SandboxManager.reset();
		return { kind: "none", problems: [failed] };
	}
	const kind: SandboxKind = process.platform === "darwin" ? "macos" : "linux";
	active = {
		kind,
		manager: SandboxManager,
		places,
		policy,
		options,
		applied: JSON.stringify(config),
	};
	return { kind, problems: check.warnings };
}

/** Runs `true` in the sandbox; null when it ran, otherwise why it did not. */
async function selfCheck(
	manager: Manager,
	places: SandboxPlaces,
	policy: SandboxPolicy,
): Promise<string | null> {
	const line = await manager.wrapWithSandbox("true", undefined, {
		filesystem: commandFilesystem(places, policy),
	});
	const outcome = await new Promise<string | null>((resolve) => {
		const child = spawn(line, { shell: true, stdio: ["ignore", "ignore", "pipe"] });
		let errors = "";
		child.stderr.on("data", (chunk: Buffer) => {
			errors = (errors + chunk.toString("utf8")).slice(-500);
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolve("a test command in the sandbox did not finish within 10 seconds");
		}, 10_000);
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve(`a test command in the sandbox could not start: ${error.message}`);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve(
				code === 0 ? null : `a test command in the sandbox failed (${code}): ${errors.trim()}`,
			);
		});
	});
	manager.cleanupAfterCommand();
	return outcome;
}

/** Stops the sandbox's helpers (its proxies) when `yew serve` stops. */
export async function stopSandbox(): Promise<void> {
	const current = active;
	active = null;
	running.clear();
	await current?.manager.reset();
}

/** The sandbox commands run in now; "none" when it is off. */
export function activeSandbox(): SandboxKind {
	return active?.kind ?? "none";
}

/** A command made ready to run in the sandbox. */
export interface Sandboxed {
	/** The command line to run with `spawn(line, { shell: true })`. */
	line: string;
	/** Variables to put over the command's environment. */
	env: Record<string, string>;
	/** Variables to leave out of it. */
	unset: string[];
	/**
	 * Call once the command has ended: the files and sites the sandbox kept from it, and on Linux
	 * what it did to the repositories in its folder (checkRepositories), one line each.
	 */
	finish(): { blocked: string[]; notes: string[] };
}

/**
 * Prepares `command` (a shell command line) to run in the sandbox; null when the sandbox is off.
 * `ask` puts a site the command wants to reach to the person and resolves whether they allowed it.
 */
export async function sandboxed(
	command: string,
	options: {
		grant?: SandboxGrant;
		ask?: (question: SiteQuestion) => Promise<boolean>;
		/** What the command is, for the sandbox's reports, when `command` is a wrapper around it. */
		text?: string;
		/** What it is on a card that lists what runs in the sandbox; a command by default. */
		label?: RunningItem;
	} = {},
): Promise<Sandboxed | null> {
	const current = active;
	if (!current) return null;
	const policy = current.policy();
	// A changed setting or a new key applies from the next command on.
	const config = sandboxConfig(current.places, policy, current.options);
	const applied = JSON.stringify(config);
	if (applied !== current.applied) {
		current.manager.updateConfig(config);
		current.applied = applied;
	}
	// On Linux what a command does to the repositories in its folder is looked at when it ends.
	const writable = (options.grant?.writable ?? []).map(real);
	const repositories =
		current.kind === "linux" && writable.length > 0 ? snapshotRepositories(writable) : null;
	// The id ties the command's connections to its allow list: random, never guessable.
	const id = randomBytes(16).toString("base64url");
	const line = await current.manager.wrapWithSandbox(
		command,
		undefined,
		{ filesystem: commandFilesystem(current.places, policy, options.grant) },
		undefined,
		{ commandId: id, commandText: options.text ?? command },
	);
	const allowed = [...(options.grant?.sites ?? [])];
	running.set(id, {
		label: options.label ?? { kind: "command", text: (options.text ?? command).slice(0, 300) },
		...(options.ask ? { ask: options.ask } : {}),
		allowed,
		refused: new Set(),
		asking: new Map(),
	});
	if (allowed.length > 0)
		current.manager.registerCommandNetworkLists(id, { allowedDomains: allowed });
	let finished: { blocked: string[]; notes: string[] } | null = null;
	return {
		line,
		env: sandboxEnvironment(current.places),
		unset: policy.credentials ? [] : AGENT_VARIABLES,
		finish: () => {
			if (finished) return finished;
			running.delete(id);
			if (active !== current) {
				finished = { blocked: [], notes: [] };
				return finished;
			}
			current.manager.unregisterCommandNetworkLists(id);
			const blocked = current.manager
				.getSandboxViolationStore()
				.getViolationsForCommand(id)
				.map((violation) => violation.line)
				// Files and connections; programs also look up system values they are not given, which
				// rarely matters and would only bury these.
				.filter((line) => /\b(file-|network)/.test(line));
			// Leftovers of commands (Linux mount points) go once none is running.
			if (running.size === 0) current.manager.cleanupAfterCommand();
			finished = { blocked, notes: repositories ? checkRepositories(repositories) : [] };
			return finished;
		},
	};
}

/** A word for a shell command line, in single quotes. */
export function quote(word: string): string {
	return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * Settings for a command the person approved to run outside the sandbox: git runs no hooks and no
 * file system monitor there, so one a command planted inside cannot come along with a push.
 */
export const OUTSIDE_GIT = {
	GIT_CONFIG_COUNT: "2",
	GIT_CONFIG_KEY_0: "core.hooksPath",
	GIT_CONFIG_VALUE_0: "/dev/null",
	GIT_CONFIG_KEY_1: "core.fsmonitor",
	GIT_CONFIG_VALUE_1: "false",
};
