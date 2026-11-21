import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerConfig } from "./mcp.ts";
import type { BrowserMode } from "./settings.ts";

/**
 * The MCP servers Yew sets up by itself (blueprint 6.10, item 38): a browser and control of this
 * computer. Yew does not build these in; it runs two open-source servers.
 *
 * - browser: Playwright MCP by Microsoft (Apache-2.0). By default it drives the person's own Chrome
 *   through Playwright's extension, with their sign-ins, in the tabs they hand it;
 *   set to a separate window, it opens a Chrome of its own with a profile kept in Yew's data folder.
 * - computer: computer-use-mcp by Adam Jones (MIT). Screenshots, mouse and keyboard for the whole
 *   screen; macOS asks once for Screen Recording and Accessibility for the program that runs Yew.
 *
 * What runs is fixed by `mcp-builtin/package-lock.json`, which ships with Yew: every package of
 * both dependency trees at one version with its hash. The first time a server is needed Yew installs
 * exactly that into its data folder (`npm ci`, without install scripts) and from then on starts the
 * servers with node from there. Nothing is resolved at run time, so what runs changes only when Yew
 * is updated.
 *
 * An entry of the same name in mcp.json replaces one of these; `{"disabled": true}` turns it off.
 * `YEW_MCP_BUILTIN=off` leaves them out, for a throwaway Yew that should start nothing.
 */
const SOURCE = fileURLToPath(new URL("../../mcp-builtin/", import.meta.url));
const FILES = ["package.json", "package-lock.json"] as const;

/** Where the servers are installed. */
const installDir = (yewHome: string) => join(yewHome, "mcp-builtin");

/**
 * The common servers Yew adds that run on this computer (Gitee, Notion, Sentry; blueprint 6.11, item
 * 40) are installed the same way, each from its own lock file in `mcp-builtin/presets/<id>`, into
 * `<data folder>/mcp-presets/<id>`, the first time it is used. This is where each one's program is in
 * its package.
 */
const PRESET_PROGRAMS: Record<string, string> = {
	gitee: "@gitee/mcp-gitee/bin/index.js",
	notion: "@notionhq/notion-mcp-server/bin/cli.mjs",
	sentry: "@sentry/mcp-server/dist/sentry-mcp.cjs",
};
export const INSTALLED_PRESETS = Object.keys(PRESET_PROGRAMS);

/** The services the presets talk to: what they may reach from the system sandbox (sandbox.ts). */
export const PRESET_SITES: Record<string, string[]> = {
	gitee: ["gitee.com"],
	notion: ["api.notion.com"],
	sentry: ["sentry.io", "*.sentry.io"],
};

/**
 * How the preset `id` is started: with node from Yew's data folder, with a small part of Yew's
 * environment and the entry's own variables (its token). Null for a preset Yew does not install.
 */
export function presetMcp(yewHome: string, id: string): McpServerConfig | null {
	const program = Object.hasOwn(PRESET_PROGRAMS, id) ? PRESET_PROGRAMS[id] : undefined;
	if (!program) return null;
	return {
		command: process.execPath,
		args: [join(yewHome, "mcp-presets", id, "node_modules", ...program.split("/"))],
		ownEnv: true,
		preset: id,
	};
}

export function builtinMcp(
	yewHome: string,
	env: NodeJS.ProcessEnv = process.env,
	/** Yew Harness's own port, which the browser is kept from. */
	port?: number,
	/** The person's own Chrome (the settings' default), or a separate window of its own. */
	browser: BrowserMode = "own",
): Record<string, McpServerConfig> {
	if (env.YEW_MCP_BUILTIN === "off") return {};
	const modules = join(installDir(yewHome), "node_modules");
	return {
		browser: {
			command: process.execPath,
			args: [
				join(modules, "@playwright", "mcp", "cli.js"),
				// The person's Chrome, through Playwright's extension: they approve the connection there and
				// choose the tabs it may use. Otherwise a Chrome of its own, its profile in the data folder.
				...(browser === "own" ? ["--extension"] : ["--user-data-dir", join(yewHome, "browser")]),
				// Page snapshots and screenshots it saves; otherwise they land in the folder Yew was started in.
				"--output-dir",
				join(yewHome, "tmp", "browser"),
				// One more layer over Yew Harness's own port.
				...(port ? ["--blocked-origins", `http://127.0.0.1:${port};http://localhost:${port}`] : []),
			],
			// Its root for files: uploads and named screenshots stay in this empty folder, not the whole
			// computer, and file:// pages are refused (it is started without unrestricted file access).
			cwd: join(yewHome, "browser-files"),
			ownEnv: true,
		},
		computer: {
			command: process.execPath,
			args: [join(modules, "computer-use-mcp", "dist", "main.js")],
			ownEnv: true,
		},
	};
}

/** Runs `npm ci` in a folder; rejects with the end of npm's output when it fails. */
function npmCi(folder: string, env: NodeJS.ProcessEnv): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
			cwd: folder,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		const keep = (chunk: Buffer) => {
			output = (output + chunk.toString("utf8")).slice(-2000);
		};
		child.stdout.on("data", keep);
		child.stderr.on("data", keep);
		child.on("error", (error) => reject(new Error(`npm could not be started: ${error.message}`)));
		child.on("close", (code) =>
			code === 0 ? resolve() : reject(new Error(`npm ci failed (${code}): ${output.trim()}`)),
		);
	});
}

export interface InstallOptions {
	yewHome: string;
	env?: NodeJS.ProcessEnv;
	log?: (line: string) => void;
	/**
	 * The folder package.json and package-lock.json are read from, with the presets' in its
	 * `presets` folder; tests give their own.
	 */
	source?: string;
	/** Installs what the lock file in the folder names; tests replace it. */
	install?: (folder: string, env: NodeJS.ProcessEnv) => Promise<void>;
}

/**
 * Makes sure what a lock file names is installed in a folder. Done once per lock file: a marker holds
 * its hash, so an update of Yew that changes the lock installs again and anything else returns at
 * once. A failed install leaves no marker and is tried again next time.
 */
function lockedInstaller(
	options: InstallOptions,
	source: string,
	folder: string,
	what: string,
): () => Promise<void> {
	const marker = join(folder, ".installed");
	const install = options.install ?? npmCi;
	let running: Promise<void> | null = null;
	const run = async () => {
		const wanted = createHash("sha256")
			.update(readFileSync(join(source, "package-lock.json")))
			.digest("hex");
		if (existsSync(marker) && readFileSync(marker, "utf8").trim() === wanted) return;
		options.log?.(`mcp: installing ${what} from npm`);
		mkdirSync(folder, { recursive: true });
		for (const file of FILES) copyFileSync(join(source, file), join(folder, file));
		await install(folder, serverEnv(options.env ?? process.env));
		writeFileSync(marker, `${wanted}\n`);
	};
	return () => {
		running ??= run().finally(() => {
			running = null;
		});
		return running;
	};
}

/** Makes sure Yew's own two servers are installed as the lock file that ships with this Yew says. */
export function builtinInstaller(options: InstallOptions): () => Promise<void> {
	return lockedInstaller(
		options,
		options.source ?? SOURCE,
		installDir(options.yewHome),
		"Yew Harness's own servers (browser, computer control)",
	);
}

/**
 * What the hub calls before it starts a server Yew runs from its data folder: installs Yew's own
 * servers, or the preset the server is.
 */
export function mcpInstaller(options: InstallOptions): (config: McpServerConfig) => Promise<void> {
	const builtin = builtinInstaller(options);
	const presets = new Map<string, () => Promise<void>>();
	return (config) => {
		const id = config.preset;
		if (!id) return builtin();
		let install = presets.get(id);
		if (!install) {
			install = lockedInstaller(
				options,
				join(options.source ?? SOURCE, "presets", id),
				join(options.yewHome, "mcp-presets", id),
				`the ${id} server`,
			);
			presets.set(id, install);
		}
		return install();
	};
}

/**
 * What a server Yew sets up by itself is given of Yew's environment: where programs and the home
 * folder are, the language, and proxy settings. Not the rest, which in a person's shell often
 * holds keys for other services.
 */
const PASSED = new Set([
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TMPDIR",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
	"DISPLAY",
	"WAYLAND_DISPLAY",
	"XAUTHORITY",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
	"no_proxy",
]);

export function serverEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(env).filter(([name]) => PASSED.has(name)));
}
