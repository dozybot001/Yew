import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { InstallKind, UpdateState } from "../shared/types.ts";
import { conflict, invalid } from "./errors.ts";
import type { Store } from "./store.ts";

/**
 * Versions and updates: what runs, what is installed on this computer, and the newest version on
 * npm.
 *
 * Once a day, unless turned off, Yew Harness asks the npm registry the person's npm uses for the
 * newest version of the package: nothing but that request, with `yew/<version>` as the user agent.
 * A source checkout is not checked, and neither is a copy of one installed with
 * scripts/install-local.mjs; it is told only that its service runs older code than is there now. An
 * update is installed with the npm that comes with the Node.js running Yew
 * Harness, into the folder it is installed in, without install scripts; then Yew Harness restarts
 * once no session is at work, or at once when the person says so. Where it cannot do that itself
 * (another kind of install, a folder it may not write), it shows the command instead. Only the
 * person starts an update or a restart: the routes are for the Mac's browser only (security.ts),
 * and no tool reaches them.
 */
export const PACKAGE = "@tenonai/yew";
const DAY_MS = 24 * 60 * 60 * 1000;
const TICK_MS = 5 * 60 * 1000;
const PENDING_MS = 5000;
const MAX_OUTPUT = 32 * 1024;
const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;

/** Whether version `a` is newer than `b`: x.y.z, anything after a hyphen left out. */
export function newer(a: string, b: string): boolean {
	const parts = (version: string) =>
		(version.split("-")[0] ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0);
	const x = parts(a);
	const y = parts(b);
	for (let i = 0; i < 3; i++) {
		const left = x[i] ?? 0;
		const right = y[i] ?? 0;
		if (left !== right) return left > right;
	}
	return false;
}

/**
 * What the service loads from the package's folder. A commit that changed nothing here (the
 * interface, the documents, the tests) is taken up without a restart.
 */
export const SERVICE_PATHS = [
	"src",
	"bin",
	"mcp-builtin",
	"skills-builtin",
	"package.json",
	"package-lock.json",
] as const;

/**
 * In a copy installed with scripts/install-local.mjs: its commit, then the id of its code. Not
 * "BUILD": the checkout has a folder called build, and macOS takes the two names for one.
 */
export const COMMIT_FILE = "COMMIT";

export interface Build {
	/** The short commit. */
	build: string;
	/** An id of what the service loads at that commit; null when it could not be worked out. */
	code: string | null;
}

/** The commit `rev` of the checkout in `root`; null when git does not answer. */
export function buildAt(root: string, rev = "HEAD"): Build | null {
	const git = (args: string[]) =>
		execFileSync("git", args, {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		}).trim();
	let build: string;
	try {
		build = git(["rev-parse", "--short", `${rev}^{commit}`]);
	} catch {
		return null;
	}
	try {
		const ids = git(["rev-parse", ...SERVICE_PATHS.map((path) => `${rev}:${path}`)]);
		return { build, code: createHash("sha256").update(ids).digest("hex").slice(0, 16) };
	} catch {
		return { build, code: null };
	}
}

/**
 * The build of the code in `root`: from git in Yew's own checkout, from the COMMIT file in a copy
 * installed from one; null otherwise. An npm install can sit inside another repository (Homebrew's
 * /opt/homebrew is one), where git would answer with that one's commit, so only a `.git` in the
 * folder itself counts.
 */
export function buildIn(root: string): Build | null {
	if (existsSync(join(root, ".git"))) return buildAt(root);
	let words: string[];
	try {
		words = readFileSync(join(root, COMMIT_FILE), "utf8").split(/\s+/).filter(Boolean);
	} catch {
		return null;
	}
	const id = /^[0-9a-f]{7,40}$/;
	const [build, code] = words;
	if (!build || !id.test(build)) return null;
	return { build, code: code && id.test(code) ? code : null };
}

/** How the package in `root` was installed. */
export function installKind(root: string): InstallKind {
	if (existsSync(join(root, ".git")) || buildIn(root)) return "source";
	// `npm install --global` puts it at <prefix>/lib/node_modules/@tenonai/yew. The folder may come
	// with a slash at the end, as a URL turned into a path does.
	return resolve(root).split(sep).slice(-4).join("/") === `lib/node_modules/${PACKAGE}`
		? "npm"
		: "other";
}

/** The folder a global npm install of the package in `root` went into. */
export function globalPrefix(root: string): string {
	return dirname(dirname(dirname(dirname(resolve(root)))));
}

/** A path with its links resolved; null when it does not exist. */
function realOrNull(path: string): string | null {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}

/** npm's own program next to a Node.js: the npm that came with it. */
export function npmNextTo(node: string): string {
	return join(dirname(node), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
}

export interface Run {
	code: number | null;
	output: string;
}

function runFile(file: string, args: string[], cwd: string, timeoutMs: number): Promise<Run> {
	return new Promise((done) => {
		execFile(
			file,
			args,
			{ cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
			(error, stdout, stderr) => {
				const output = `${stdout}${stderr}`.slice(-MAX_OUTPUT);
				if (!error) return done({ code: 0, output });
				const code = typeof error.code === "number" ? error.code : null;
				done({ code, output: output || error.message });
			},
		);
	});
}

export interface UpdateOptions {
	/** Running now. */
	version: string;
	build: string | null;
	/** The id of the code this process loaded (`Build.code`); null when not known. */
	code?: string | null;
	/** The package's folder, where its package.json is. */
	root: string;
	/** The Node.js running Yew Harness; its npm installs the update. */
	node: string;
	store: Store;
	/** Sessions at work now. */
	busy: () => number;
	/** Replaces this process with one running what is installed now (serve.ts). */
	restart: () => void;
	/** After an update: puts the Mac app's new program in place when the app is installed. */
	refreshApp?: (root: string) => Promise<void>;
	log: (line: string) => void;
	fetch?: typeof fetch;
	run?: (file: string, args: string[], cwd: string, timeoutMs: number) => Promise<Run>;
	now?: () => number;
	/** Whether this process may write the install's folders; tests stand in for the file system. */
	writable?: (path: string) => boolean;
	platform?: NodeJS.Platform;
}

interface Latest {
	version: string;
	checkedAt: number;
}

export class Updates {
	readonly #o: UpdateOptions;
	readonly #kind: InstallKind;
	/** The package's folder, without a slash at the end. */
	readonly #root: string;
	readonly #run: NonNullable<UpdateOptions["run"]>;
	readonly #now: () => number;
	#job: UpdateState["job"] = null;
	#registry: string | null = null;
	#pending: NodeJS.Timeout | null = null;
	#timer: NodeJS.Timeout | null = null;
	#checking: Promise<UpdateState> | null = null;
	/**
	 * A mirror's package that is not npm's own got installed: no restart and no new Mac app until it
	 * is installed again from npm's registry.
	 */
	#blocked: { command: string; cleared: () => boolean } | null = null;

	constructor(options: UpdateOptions) {
		this.#o = options;
		this.#root = resolve(options.root);
		this.#kind = installKind(this.#root);
		this.#run = options.run ?? runFile;
		this.#now = options.now ?? Date.now;
	}

	/** Checks when a day has passed since the last check, and starts a restart that waits. */
	start(): void {
		const tick = () => {
			if (this.#due()) void this.check().catch(() => {});
		};
		setTimeout(tick, 60_000).unref();
		this.#timer = setInterval(tick, TICK_MS);
		this.#timer.unref();
	}

	stop(): void {
		if (this.#timer) clearInterval(this.#timer);
		if (this.#pending) clearInterval(this.#pending);
		this.#timer = null;
		this.#pending = null;
	}

	#checks(): boolean {
		return this.#o.store.getSetting("updateCheck", true);
	}

	#latest(): Latest | null {
		return this.#o.store.getSetting<Latest | null>("updateLatest", null);
	}

	#due(): boolean {
		if (this.#kind === "source" || !this.#checks()) return false;
		const latest = this.#latest();
		return !latest || this.#now() - latest.checkedAt >= DAY_MS;
	}

	/** What is installed now: package.json read again, and the build of a checkout or a copy of one. */
	#installed(): UpdateState["installed"] & { code: string | null } {
		let version = this.#o.version;
		try {
			const pkg = JSON.parse(readFileSync(join(this.#root, "package.json"), "utf8")) as {
				version?: unknown;
			};
			if (typeof pkg.version === "string") version = pkg.version;
		} catch {
			// A package being replaced right now: the running version stands.
		}
		const built = this.#kind === "source" ? buildIn(this.#root) : null;
		return { version, build: built?.build ?? null, code: built?.code ?? null };
	}

	/** The command that installs `version` here, when Yew Harness cannot run it itself; else null. */
	#manual(version: string): string | null {
		const command = `npm install --global ${PACKAGE}@${version}`;
		if (this.#kind !== "npm") return command;
		const writable =
			this.#o.writable ??
			((path: string) => {
				try {
					accessSync(path, constants.W_OK);
					return true;
				} catch {
					return false;
				}
			});
		const prefix = globalPrefix(this.#root);
		const places = [dirname(this.#root), join(prefix, "bin")];
		const ok = existsSync(npmNextTo(this.#o.node)) && places.every((place) => writable(place));
		return ok ? null : command;
	}

	state(): UpdateState {
		const { code, ...installed } = this.#installed();
		const latest = this.#kind === "source" ? null : this.#latest();
		const available = latest !== null && newer(latest.version, installed.version);
		// Installed again as it should be: the block is lifted.
		if (this.#blocked?.cleared()) this.#blocked = null;
		// A newer commit whose code is what this process loaded needs no restart; where the code's id
		// is not known, any other commit counts.
		const running = this.#o.code ?? null;
		const changed =
			code !== null && running !== null
				? code !== running
				: installed.build !== null && this.#o.build !== null && installed.build !== this.#o.build;
		const restart = this.#blocked === null && (installed.version !== this.#o.version || changed);
		return {
			version: this.#o.version,
			build: this.#o.build,
			installed,
			restart,
			kind: this.#kind,
			checks: this.#checks(),
			latest,
			available,
			manual: this.#blocked?.command ?? (available && latest ? this.#manual(latest.version) : null),
			job: this.#job,
			busy: this.#o.busy(),
			restartPending: this.#pending !== null,
		};
	}

	/** The registry the person's npm uses, asked once. */
	async #registryUrl(): Promise<string> {
		if (this.#registry) return this.#registry;
		let registry = DEFAULT_REGISTRY;
		const npm = npmNextTo(this.#o.node);
		if (existsSync(npm)) {
			const result = await this.#run(
				this.#o.node,
				[npm, "config", "get", "registry"],
				dirname(this.#root),
				15_000,
			);
			const said = result.output.trim().split("\n").at(-1)?.trim() ?? "";
			if (result.code === 0 && /^https?:\/\/\S+$/.test(said)) {
				registry = said.endsWith("/") ? said : `${said}/`;
			}
		}
		this.#registry = registry;
		return registry;
	}

	/** Asks npm for the newest version now. A source checkout is not checked. */
	check(): Promise<UpdateState> {
		if (this.#kind === "source") return Promise.resolve(this.state());
		this.#checking ??= this.#check().finally(() => {
			this.#checking = null;
		});
		return this.#checking;
	}

	async #check(): Promise<UpdateState> {
		const registry = await this.#registryUrl();
		const fetcher = this.#o.fetch ?? fetch;
		let version: unknown;
		try {
			const response = await fetcher(new URL(`${PACKAGE}/latest`, registry), {
				headers: { "User-Agent": `yew/${this.#o.version}`, Accept: "application/json" },
				signal: AbortSignal.timeout(15_000),
			});
			if (!response.ok) throw new Error(`the registry answered ${response.status}`);
			version = ((await response.json()) as { version?: unknown }).version;
		} catch (error) {
			this.#o.log(`update check: ${(error as Error).message}`);
			throw conflict(
				"Could not reach the npm registry to check for a new version.",
				undefined,
				"update-check-failed",
			);
		}
		if (typeof version !== "string" || !PLAIN_VERSION.test(version)) {
			throw conflict(
				"The npm registry did not say which version is newest.",
				undefined,
				"update-check-failed",
			);
		}
		this.#o.store.setSetting("updateLatest", { version, checkedAt: this.#now() });
		return this.state();
	}

	/** Installs the newest version from npm; the state shows how it goes. */
	install(version: string): UpdateState {
		if (!PLAIN_VERSION.test(version)) throw invalid("version must look like 1.2.3.", "version");
		if (this.#job?.state === "installing") {
			throw conflict("An update is already being installed.", undefined, "update-running");
		}
		const state = this.state();
		if (!state.available || state.latest?.version !== version) {
			throw conflict(
				`${version} is not the new version found on npm.`,
				undefined,
				"update-not-available",
			);
		}
		if (state.manual) {
			throw conflict(
				`Yew Harness cannot install it here; run: ${state.manual}`,
				undefined,
				"update-manual",
			);
		}
		this.#job = { state: "installing", version, output: "" };
		void this.#install(version);
		return this.state();
	}

	/** A version's integrity as a registry gives it; null when it cannot be read. */
	async #integrity(registry: string, version: string): Promise<string | null> {
		const fetcher = this.#o.fetch ?? fetch;
		try {
			const response = await fetcher(new URL(`${PACKAGE}/${version}`, registry), {
				headers: { "User-Agent": `yew/${this.#o.version}`, Accept: "application/json" },
				signal: AbortSignal.timeout(15_000),
			});
			if (!response.ok) return null;
			const body = (await response.json()) as {
				name?: unknown;
				version?: unknown;
				dist?: { integrity?: unknown };
			};
			if (body.name !== PACKAGE || body.version !== version) return null;
			return typeof body.dist?.integrity === "string" ? body.dist.integrity : null;
		} catch {
			return null;
		}
	}

	/** The integrity npm recorded for the package it installed in a global folder. */
	#installedIntegrity(prefix: string): string | null {
		try {
			const lock = JSON.parse(
				readFileSync(join(prefix, "lib", "node_modules", ".package-lock.json"), "utf8"),
			) as { packages?: Record<string, { integrity?: unknown }> };
			const integrity = lock.packages?.[`node_modules/${PACKAGE}`]?.integrity;
			return typeof integrity === "string" ? integrity : null;
		} catch {
			return null;
		}
	}

	async #install(version: string): Promise<void> {
		const prefix = globalPrefix(this.#root);
		const registry = await this.#registryUrl();
		// From a mirror, the package must be the one npm's own registry has: a different one is not
		// installed. When npm's registry cannot be reached, it goes ahead.
		let official: string | null = null;
		if (registry !== DEFAULT_REGISTRY) {
			const [mirror, fromNpm] = await Promise.all([
				this.#integrity(registry, version),
				this.#integrity(DEFAULT_REGISTRY, version),
			]);
			official = fromNpm;
			if (official !== null && mirror !== official) {
				this.#job = {
					state: "failed",
					version,
					output: `${registry} gives a different package for ${PACKAGE}@${version} than ${DEFAULT_REGISTRY} does, so it was not installed.`,
				};
				this.#o.log(`update: ${PACKAGE}@${version} from ${registry} does not match npm's`);
				return;
			}
		}
		this.#o.log(`update: installing ${PACKAGE}@${version}`);
		const result = await this.#run(
			this.#o.node,
			[
				npmNextTo(this.#o.node),
				"install",
				"--global",
				"--prefix",
				prefix,
				`${PACKAGE}@${version}`,
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
			],
			prefix,
			10 * 60_000,
		);
		if (result.code !== 0) {
			this.#job = { state: "failed", version, output: result.output };
			this.#o.log(`update: npm ended with ${result.code ?? "no exit code"}`);
			return;
		}
		// What npm put there must be the package and version asked for before its app is run.
		let installed: { name?: unknown; version?: unknown } = {};
		try {
			installed = JSON.parse(readFileSync(join(this.#root, "package.json"), "utf8"));
		} catch {
			// Checked just below.
		}
		if (installed.name !== PACKAGE || installed.version !== version) {
			const root = this.#root;
			this.#blocked = {
				command: `npm install --global ${PACKAGE}@${version}`,
				cleared: () => {
					try {
						const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
							name?: unknown;
							version?: unknown;
						};
						return pkg.name === PACKAGE && pkg.version === version;
					} catch {
						return false;
					}
				},
			};
			this.#job = {
				state: "failed",
				version,
				output: `${result.output}\nAfter npm ran, ${this.#root} does not hold ${PACKAGE}@${version}; the Mac app was left as it was.`,
			};
			this.#o.log(`update: ${this.#root} does not hold ${PACKAGE}@${version} after npm`);
			return;
		}
		// npm asks the mirror again while it installs: what it put there is checked against npm's own.
		if (official !== null && this.#installedIntegrity(prefix) !== official) {
			const command = `npm install --global ${PACKAGE}@${version} --registry=${DEFAULT_REGISTRY}`;
			this.#blocked = {
				command,
				cleared: () => this.#installedIntegrity(prefix) === official,
			};
			this.#job = {
				state: "failed",
				version,
				output: `${result.output}\nWhat npm installed from ${registry} is not the package ${DEFAULT_REGISTRY} has. Yew Harness was not restarted and the Mac app was left as it was. Install it again from npm's own registry: ${command}`,
			};
			this.#o.log(`update: the installed ${PACKAGE}@${version} does not match npm's`);
			return;
		}
		// Installed by a Yew Harness that an app before 1.8.2 started, the files would carry the mark
		// macOS puts on downloads: they come from npm, checked above, so it comes off.
		// Only the package folder itself, where npm put it: not when it is reached through a link.
		if (
			(this.#o.platform ?? process.platform) === "darwin" &&
			realOrNull(this.#root) === this.#root
		) {
			await this.#run("xattr", ["-r", "-d", "com.apple.quarantine", this.#root], prefix, 60_000);
		}
		let output = result.output;
		try {
			await this.#o.refreshApp?.(this.#root);
		} catch (error) {
			output += `\nThe Mac app was not updated: ${(error as Error).message}. Run: yew app install`;
		}
		this.#job = { state: "installed", version, output };
		this.#o.log(`update: installed ${version}`);
	}

	/**
	 * Restarts Yew Harness on what is installed now: at once, or when no session is at work any more
	 * (then the state says it waits).
	 */
	restart(now: boolean): UpdateState & { restarting: boolean } {
		if (this.#job?.state === "installing") {
			throw conflict("Wait until the update is installed.", undefined, "update-running");
		}
		if (this.#blocked) {
			throw conflict(
				`Install it again first: ${this.#blocked.command}`,
				undefined,
				"update-not-npm",
			);
		}
		if (!now && this.#o.busy() > 0) {
			this.#pending ??= setInterval(() => {
				if (this.#o.busy() > 0) return;
				this.stop();
				this.#o.restart();
			}, PENDING_MS);
			return { ...this.state(), restarting: false };
		}
		this.stop();
		// The answer goes out first.
		setTimeout(() => this.#o.restart(), 300);
		return { ...this.state(), restarting: true };
	}
}
