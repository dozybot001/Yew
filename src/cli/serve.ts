import { execFile, execFileSync, spawn } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { VERSION } from "../shared/version.ts";
import { type CliIo, EXIT_ERROR, EXIT_OK, UsageError } from "./io.ts";
import type { Command } from "./run.ts";

export const DEFAULT_PORT = 4777;
const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** How often the service looks for letters from `yew send`, which writes to the database directly. */
const LETTER_SWEEP_MS = 2000;
/** How often the service checks whether phone access was turned on or off. */
const REMOTE_SYNC_MS = 5000;

const SERVE_HELP = `Usage: yew serve [options]

Start Yew Harness's local service. It listens on 127.0.0.1 only, keeps running
while the browser is closed, and prints a one-time link to open the web
interface.

Options:
  -p, --port <n>  Port to listen on (default ${DEFAULT_PORT})
      --open      Open the link in the default browser
  -h, --help      Show this help
`;

const OPEN_HELP = `Usage: yew open [options]

Open the web interface of the running Yew Harness service with a new one-time
link.

Options:
      --print  Print the link instead of opening a browser
  -h, --help   Show this help
`;

interface ServeFile {
	port: number;
	pid: number;
	startedAt: number;
}

const serveFile = (home: string) => join(home, "serve.json");

/** How often the sites of model providers with a key are read again for the sandbox. */
const PROVIDER_SITES_MS = 60_000;

/**
 * The sites of the model providers that have a key, which commands in the sandbox may reach
 * (blueprint, section 11). Providers on this computer are left out: local ports stay closed.
 */
async function modelSites(gateway: {
	providers(): { id: string; baseUrl: string }[];
	hasKey(provider: string): Promise<boolean>;
}): Promise<string[]> {
	const sites: string[] = [];
	for (const provider of gateway.providers()) {
		let url: URL;
		try {
			url = new URL(provider.baseUrl);
		} catch {
			continue;
		}
		const host = url.hostname;
		if (host === "localhost" || host.endsWith(".localhost") || host === "[::1]") continue;
		if (/^127\./.test(host) || host === "0.0.0.0") continue;
		if (!(await gateway.hasKey(provider.id).catch(() => false))) continue;
		sites.push(url.port ? `${host}:${url.port}` : host);
	}
	return [...new Set(sites)];
}

/** The exit that has the login service start Yew Harness again (KeepAlive, Restart=on-failure). */
const EXIT_RESTART = 75;

/**
 * Starts Yew Harness again, the same way, once this process has ended: for a restart after an update
 * when no login service would. Its output goes to the log the app's start script and the service use.
 */
function startReplacement(home: string): void {
	const log = join(home, "logs", "serve.log");
	mkdirSync(dirname(log), { recursive: true });
	const out = openSync(log, "a");
	// Not --open again: the page already open comes back by itself.
	const args = process.argv.slice(1).filter((arg) => arg !== "--open");
	spawn(
		"/bin/sh",
		[
			"-c",
			'pid=$1; shift; while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done; exec "$@"',
			"yew-restart",
			String(process.pid),
			process.execPath,
			...process.execArgv,
			...args,
		],
		{ detached: true, stdio: ["ignore", out, out] },
	).unref();
	closeSync(out);
}

/**
 * The short commit of Yew's own source checkout; null otherwise. An npm install can sit inside
 * another repository (Homebrew's /opt/homebrew is one), where git would answer with that one's commit.
 */
export function shortCommit(
	root: string = fileURLToPath(new URL("../..", import.meta.url)),
): string | null {
	if (!existsSync(join(root, ".git"))) return null;
	try {
		return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

export function openBrowser(url: string): void {
	const [command, args] =
		process.platform === "darwin"
			? ["open", [url]]
			: process.platform === "win32"
				? ["cmd", ["/c", "start", "", url]]
				: ["xdg-open", [url]];
	spawn(command as string, args as string[], { detached: true, stdio: "ignore" }).unref();
}

export function serveCommand(): Command {
	return {
		name: "serve",
		summary: "Start Yew Harness's local service",
		async run(args: string[], io: CliIo): Promise<number> {
			const { values } = parseArgs({
				args,
				options: {
					port: { type: "string", short: "p" },
					open: { type: "boolean" },
					help: { type: "boolean", short: "h" },
				},
				strict: true,
			});
			if (values.help) {
				io.stdout.write(SERVE_HELP);
				return EXIT_OK;
			}
			const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
			if (!Number.isInteger(port) || port < 1 || port > 65535) {
				throw new UsageError("--port must be a whole number from 1 to 65535");
			}

			const { openRuntime } = await import("../server/runtime.ts");
			const { serve } = await import("@hono/node-server");
			const { Agents } = await import("../server/agent/runner.ts");
			const { PermissionEngine } = await import("../server/permissions/engine.ts");
			const { createApp } = await import("../server/http/app.ts");
			const { issueLoginToken } = await import("../server/http/security.ts");
			const { MailStore } = await import("../server/mail/store.ts");
			const { Scheduler } = await import("../server/schedules.ts");

			const runtime = openRuntime({ env: io.env });
			const { store, bus, gateway, home } = runtime;
			// Sessions' commands and the MCP servers people add go into the system sandbox, set up before
			// anything can start one (blueprint, section 11): on macOS by default, on Linux once tested.
			const sandbox = await import("../server/sandbox.ts");
			let providerSites: string[] = [];
			const refreshProviderSites = async () => {
				providerSites = await modelSites(gateway);
			};
			if (!sandbox.sandboxWanted(io.env.YEW_SANDBOX)) {
				io.stderr.write(
					io.env.YEW_SANDBOX === "off"
						? "The system sandbox is off (YEW_SANDBOX=off): sessions' commands run as your user account.\n"
						: `No system sandbox on ${process.platform} yet: sessions' commands run as your user account.\n`,
				);
			} else {
				const { homedir } = await import("node:os");
				await refreshProviderSites();
				const started = await sandbox
					.startSandbox(
						{
							home,
							install: sandbox.INSTALL_DIR,
							userHome: homedir(),
							port,
							root: sandbox.sandboxRoot(homedir(), process.platform, io.env as NodeJS.ProcessEnv),
						},
						() => ({
							sites: [...providerSites, ...store.getSetting<string[]>("sandboxAllowedDomains", [])],
							credentials: store.getSetting("sandboxCredentials", false),
							hidden: store.getSetting<string[]>("hiddenFolders", []),
						}),
						io.env as NodeJS.ProcessEnv,
					)
					.catch((error: Error) => ({ kind: "none" as const, problems: [error.message] }));
				io.stderr.write(
					started.kind === "none"
						? `The system sandbox could not start, so sessions' commands run as your user account: ${started.problems.join("; ")}\n`
						: `Sessions' commands run in the system sandbox (sandbox-runtime, ${started.kind === "macos" ? "Seatbelt" : "bubblewrap"}).\n${started.problems.map((line) => `sandbox: ${line}\n`).join("")}`,
				);
			}
			// Commands that do not run in the sandbox still cannot reach Yew's data or the Mac app's
			// sign-in (guard.ts).
			const { homedir: userHome } = await import("node:os");
			const { startGuard, guardKind } = await import("../server/guard.ts");
			const guardState = startGuard(
				[home, ...sandbox.appWebData({ userHome: userHome() })],
				userHome(),
				(name) => sandbox.findProgram(name, io.env as NodeJS.ProcessEnv),
				process.platform,
				// The folders the person keeps from sessions stay closed outside the sandbox too.
				() => store.getSetting<string[]>("hiddenFolders", []),
			);
			if (guardState.kind === "none") {
				io.stderr.write(
					`Commands outside the sandbox have no guard${guardState.problem ? ` (${guardState.problem})` : ""}, so running one, or naming Yew Harness's own data, is asked about in every permission mode.\n`,
				);
			}
			const stuck = store.recoverAfterRestart();
			if (stuck.length > 0) {
				io.stderr.write(
					`${stuck.length} session(s) were working when Yew Harness last stopped. They are marked for review; nothing was redone.\n`,
				);
			}
			store.pruneEvents(Date.now() - EVENT_RETENTION_MS);
			// Answers handed to a waiting call whose result was never stored come back as letters.
			new MailStore(store).requeueHandedOff();
			const log = (line: string) => io.stderr.write(`${line}\n`);
			// Tools beyond the built-in ones: web search when a search service has a key (M4 plan).
			const { ALL_TOOLS } = await import("../server/tools/registry.ts");
			const { SearchAccess, webSearchTool } = await import("../server/tools/web-search.ts");
			const search = new SearchAccess(runtime.keys);
			// MCP servers from mcp.json in the data folder; their tools ask before the first use.
			const { McpHub } = await import("../server/mcp.ts");
			const { McpAuth } = await import("../server/mcp-oauth.ts");
			const { systemKeys } = await import("../server/keys.ts");
			const { builtinMcp, mcpInstaller } = await import("../server/mcp-builtin.ts");
			const mcp = new McpHub({
				yewHome: home,
				version: VERSION,
				log,
				// The browser is kept off Yew Harness's own page.
				port,
				// Asked again at each refresh: the settings say which browser it drives.
				builtin: () =>
					builtinMcp(home, io.env as NodeJS.ProcessEnv, port, store.getSetting("browser", "own")),
				prepare: mcpInstaller({ yewHome: home, env: io.env as NodeJS.ProcessEnv, log }),
				// Sign-ins to MCP servers: tokens in the keychain; the browser comes back to this port.
				auth: new McpAuth({
					keys: systemKeys("mcp", io.env as NodeJS.ProcessEnv),
					redirectUri: `http://127.0.0.1:${port}/oauth/callback`,
					version: VERSION,
				}),
			});
			const { skillTool } = await import("../server/skills.ts");
			const { homedir } = await import("node:os");
			const { ArtifactStore, saveArtifactTool } = await import("../server/artifacts.ts");
			const artifacts = new ArtifactStore(store, home);
			const extraTools = [
				webSearchTool(search, { version: VERSION }),
				skillTool(home, homedir(), () => store.getSetting<string[]>("disabledSkills", [])),
				saveArtifactTool(artifacts),
			];
			const { setOwnPort } = await import("../server/tools/web.ts");
			setOwnPort(port);
			const permissions = new PermissionEngine(home);
			permissions.guarded = () => guardKind() !== "none";
			// The person's hooks, from hooks.json in the data folder (hooks.ts).
			const { Hooks } = await import("../server/hooks.ts");
			const agents = new Agents({
				store,
				gateway,
				permissions,
				hooks: new Hooks(home),
				home,
				version: VERSION,
				log,
				tools: () => [...ALL_TOOLS, ...extraTools, ...mcp.tools()],
				userHome: homedir(),
			});
			agents.attachments.pruneOrphans();
			const { RemoteAccess } = await import("../remote/access.ts");
			// A paired phone's requests run in-process against the same app, as that device.
			let handle: ((request: Request, device: string) => Promise<Response>) | null = null;
			const remote = new RemoteAccess(store, systemKeys("remote"), {
				version: VERSION,
				log,
				handle: async (request, device) => {
					if (!handle) throw new Error("Yew Harness is still starting.");
					return handle(request, device.id);
				},
			});
			// Notifications to paired phones, sealed for each; the relay passes them to Apple's service.
			const { Notifier } = await import("../server/push.ts");
			const { NoteStreams } = await import("../server/http/notes.ts");
			const notes = new NoteStreams(store);
			const notifier = new Notifier({
				store,
				mail: agents.post.mail,
				bus,
				schedules: () => agents.schedules.list(),
				// iPhones through Apple's service; phones that keep their own connection directly.
				send: (note, mode, id) => remote.push(note, mode, id) + notes.send(note),
			});
			const { systemControl } = await import("./system.ts");
			// Versions and updates (blueprint, "版本与更新"): a restart replaces this process.
			const { Updates } = await import("../server/updates.ts");
			const { startedByService } = await import("./service.ts");
			const { appInstalled, realAppHost } = await import("./app.ts");
			const build = shortCommit();
			let stopWith: ((code: number) => void) | null = null;
			const updates = new Updates({
				version: VERSION,
				build,
				root: fileURLToPath(new URL("../..", import.meta.url)),
				node: process.execPath,
				store,
				busy: () => agents.busy(),
				log,
				// Under the login service, an exit with an error has the service start it again;
				// otherwise a new process starts once this one has ended.
				restart: () => {
					const managed = startedByService();
					if (!managed) startReplacement(home);
					stopWith?.(managed ? EXIT_RESTART : EXIT_OK);
				},
				// The Mac app's program comes with the package: the new one goes into the app.
				refreshApp: async (root) => {
					if (!appInstalled(realAppHost())) return;
					await new Promise<void>((done, fail) => {
						execFile(
							process.execPath,
							[join(root, "bin", "yew.js"), "app", "install"],
							{ timeout: 60_000 },
							(error) => (error ? fail(error) : done()),
						);
					});
				},
			});
			// Scheduled tasks run from the service, whether or not a page is open (blueprint 6.5).
			const scheduler = new Scheduler(store, agents.post, agents.schedules, log);
			const app = createApp({
				store,
				gateway,
				agents,
				bus,
				log,
				security: { port },
				webRoot: fileURLToPath(new URL("../../web/dist", import.meta.url)),
				build,
				remote,
				scheduler,
				onPresence: () => notifier.seen(),
				notes,
				artifacts,
				mcp: { home, hub: mcp },
				skills: { home, userHome: homedir() },
				data: { home },
				search,
				system: systemControl({ home, env: io.env }),
				updates,
			});
			handle = async (request, device) => app.fetch(request, { device });

			const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
			const started = await new Promise<boolean>((resolve) => {
				server.once("listening", () => resolve(true));
				server.once("error", (error: NodeJS.ErrnoException) => {
					io.stderr.write(
						error.code === "EADDRINUSE"
							? `yew: port ${port} is in use. Is Yew Harness already running? Try 'yew open', or pick another port with --port.\n`
							: `yew: could not start: ${error.message}\n`,
					);
					resolve(false);
				});
			});
			if (!started) {
				await sandbox.stopSandbox().catch(() => {});
				runtime.close();
				return EXIT_ERROR;
			}
			// Letters that were waiting when Yew stopped, and letters from `yew send`, start their sessions.
			agents.wakeQueued();
			const sweep = setInterval(() => agents.wakeQueued(), LETTER_SWEEP_MS);
			// Runs missed while Yew was not running are run or skipped now, as each task says.
			scheduler.start();
			notifier.start();
			updates.start();
			// Phone access follows the settings, which `yew remote` may change while Yew runs.
			const syncRemote = () => {
				void remote.sync().catch((error: Error) => log(`remote access: ${error.message}`));
				// A search key saved with `yew key set` while Yew runs is picked up here.
				void search.refresh().catch(() => {});
				// A changed mcp.json is read again: new servers start, removed ones stop.
				void mcp.refresh().catch((error: Error) => log(`mcp: ${error.message}`));
			};
			syncRemote();
			const remoteSweep = setInterval(syncRemote, REMOTE_SYNC_MS);
			// A model provider's key saved since is a site commands in the sandbox may reach.
			const sitesSweep =
				sandbox.activeSandbox() === "none"
					? null
					: setInterval(() => void refreshProviderSites().catch(() => {}), PROVIDER_SITES_MS);
			const info: ServeFile = { port, pid: process.pid, startedAt: Date.now() };
			writeFileSync(serveFile(home), JSON.stringify(info), { mode: 0o600 });

			const url = `http://127.0.0.1:${port}/#t=${issueLoginToken(store)}`;
			io.stdout.write(
				`Yew Harness ${VERSION} is running at http://127.0.0.1:${port}/\nSign in with this link (works once, within 10 minutes):\n${url}\nStop with Ctrl-C. For a new link later, run: yew open\n`,
			);
			if (values.open) openBrowser(url);

			return await new Promise<number>((resolve) => {
				const stop = (code: number = EXIT_OK) => {
					io.stderr.write(
						code === EXIT_OK ? "Stopping Yew Harness…\n" : "Restarting Yew Harness…\n",
					);
					clearInterval(sweep);
					clearInterval(remoteSweep);
					if (sitesSweep) clearInterval(sitesSweep);
					scheduler.stop();
					notifier.stop();
					updates.stop();
					mcp.stop();
					remote.stop();
					agents.shutdown();
					server.close();
					// Open event streams would keep the process alive; end them too.
					if ("closeAllConnections" in server) server.closeAllConnections();
					rmSync(serveFile(home), { force: true });
					// The sandbox's proxies stop once the commands and servers in it have been ended.
					void sandbox
						.stopSandbox()
						.catch((error: Error) => log(`sandbox: ${error.message}`))
						.finally(() => {
							runtime.close();
							resolve(code);
						});
				};
				stopWith = stop;
				process.once("SIGINT", () => stop());
				process.once("SIGTERM", () => stop());
			});
		},
	};
}

/** True when a Yew service is running for this data directory. */
export function serviceRunning(home: string): boolean {
	try {
		const info = JSON.parse(readFileSync(serveFile(home), "utf8")) as ServeFile;
		process.kill(info.pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function openCommand(): Command {
	return {
		name: "open",
		summary: "Open the web interface with a new sign-in link",
		async run(args: string[], io: CliIo): Promise<number> {
			const { values } = parseArgs({
				args,
				options: { print: { type: "boolean" }, help: { type: "boolean", short: "h" } },
				strict: true,
			});
			if (values.help) {
				io.stdout.write(OPEN_HELP);
				return EXIT_OK;
			}
			const { yewHome } = await import("../server/paths.ts");
			const home = yewHome(io.env);
			let info: ServeFile;
			try {
				info = JSON.parse(readFileSync(serveFile(home), "utf8")) as ServeFile;
				process.kill(info.pid, 0);
			} catch {
				io.stderr.write("yew: Yew Harness is not running. Start it with: yew serve\n");
				return EXIT_ERROR;
			}
			const { openDatabase } = await import("../server/db/database.ts");
			const { EventBus } = await import("../server/events.ts");
			const { Store } = await import("../server/store.ts");
			const { dbPath } = await import("../server/paths.ts");
			const { issueLoginToken } = await import("../server/http/security.ts");
			const db = openDatabase(dbPath(home));
			try {
				const url = `http://127.0.0.1:${info.port}/#t=${issueLoginToken(new Store(db, new EventBus()))}`;
				if (values.print) {
					io.stdout.write(`${url}\n`);
				} else {
					openBrowser(url);
					io.stdout.write(`Opened Yew Harness in the browser (http://127.0.0.1:${info.port}/).\n`);
				}
				return EXIT_OK;
			} finally {
				db.close();
			}
		},
	};
}
