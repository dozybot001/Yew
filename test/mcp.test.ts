import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { YewError } from "../src/server/errors.ts";
import { decisionFromPhone } from "../src/server/http/agents.ts";
import {
	McpHub,
	namesHarness,
	outward,
	ownBrowser,
	readMcpConfig,
	special as specialFor,
} from "../src/server/mcp.ts";
import {
	builtinInstaller,
	builtinMcp,
	INSTALLED_PRESETS,
	mcpInstaller,
	serverEnv,
} from "../src/server/mcp-builtin.ts";
import {
	addMcpEntry,
	listMcpEntries,
	patchMcpEntry,
	removeMcpEntry,
} from "../src/server/mcp-config.ts";
import { inheritableRules, PermissionEngine } from "../src/server/permissions/engine.ts";
import type { ToolContext, ToolDefinition } from "../src/server/tools/types.ts";
import { MCP_PRESETS, presetEntry } from "../src/shared/mcp-presets.ts";
import type { JsonObject } from "../src/shared/messages.ts";
import type { Session } from "../src/shared/types.ts";
import { tempDir } from "./helpers/store.ts";

const server = fileURLToPath(new URL("./helpers/mcp-server.mjs", import.meta.url));
const ctx = { signal: new AbortController().signal, acceptsImages: false } as ToolContext;

function home(servers: unknown) {
	const yewHome = tempDir("yew-home-");
	writeFileSync(join(yewHome, "mcp.json"), JSON.stringify({ mcpServers: servers }));
	return yewHome;
}

const textOf = (result: { content: { type: string; text?: string }[] }) =>
	result.content.map((block) => block.text ?? "").join("");

describe("MCP configuration", () => {
	test("reads the usual mcpServers shape; names in braces come from the environment; odd entries are skipped", () => {
		const yewHome = home({
			files: { command: "node", args: ["server.js", `\${ROOT}`], env: { TOKEN: `\${TOKEN}` } },
			search: {
				url: "https://mcp.example.com/mcp",
				headers: { Authorization: `Bearer \${TOKEN}` },
			},
			"bad name": { command: "x" },
			nothing: { type: "stdio" },
			local: { url: "ftp://example.com" },
		});
		assert.deepEqual(readMcpConfig(yewHome, { ROOT: "/data", TOKEN: "t0" }), {
			files: { command: "node", args: ["server.js", "/data"], env: { TOKEN: "t0" } },
			search: { url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer t0" } },
		});
		assert.deepEqual(readMcpConfig(tempDir("yew-home-")), {});
	});
});

describe("common official servers", () => {
	test("each becomes the entry a person would write, and the settings accept it", () => {
		const yewHome = tempDir("yew-home-");
		for (const preset of MCP_PRESETS) {
			const entry = presetEntry(preset, preset.token?.optional ? "" : "  tok-123  ");
			const shown = addMcpEntry(yewHome, entry);
			assert.equal(shown.name, preset.id);
			if ("url" in preset.connect) {
				assert.equal(shown.url, preset.connect.url);
				assert.match(shown.url ?? "", /^https:\/\//);
			} else {
				// Installed by Yew at one exact version.
				assert.equal(shown.package, preset.connect.package);
				assert.match(preset.connect.package, /.@\d+\.\d+\.\d+$/);
			}
		}
		const config = readMcpConfig(yewHome, {});
		assert.deepEqual(config.github?.headers, { Authorization: "Bearer tok-123" });
		assert.deepEqual(config.gitee?.env, { GITEE_ACCESS_TOKEN: "tok-123" });
		// Run with node from the data folder, with little of Yew's environment.
		assert.equal(config.notion?.command, process.execPath);
		assert.deepEqual(config.notion?.args, [
			join(
				yewHome,
				"mcp-presets",
				"notion",
				"node_modules",
				"@notionhq",
				"notion-mcp-server",
				"bin",
				"cli.mjs",
			),
		]);
		assert.equal(config.notion?.ownEnv, true);
		assert.equal(config.notion?.preset, "notion");
		assert.equal(config.context7?.headers, undefined, "an optional token can be left out");
		assert.equal(new Set(MCP_PRESETS.map((preset) => preset.id)).size, MCP_PRESETS.length);
	});

	test("the ones that run on this computer are pinned by lock files that ship with Yew", () => {
		const root = fileURLToPath(new URL("../mcp-builtin/presets/", import.meta.url));
		const local = MCP_PRESETS.filter((preset) => "package" in preset.connect);
		assert.deepEqual(local.map((preset) => preset.id).sort(), [...INSTALLED_PRESETS].sort());
		for (const preset of local) {
			const spec = (preset.connect as { package: string }).package;
			const at = spec.lastIndexOf("@");
			const wanted = JSON.parse(readFileSync(join(root, preset.id, "package.json"), "utf8")) as {
				dependencies: Record<string, string>;
			};
			assert.deepEqual(wanted.dependencies, { [spec.slice(0, at)]: spec.slice(at + 1) });
			const lock = JSON.parse(readFileSync(join(root, preset.id, "package-lock.json"), "utf8")) as {
				packages: Record<string, { integrity?: string; version?: string }>;
			};
			const packages = Object.entries(lock.packages).filter(([path]) => path !== "");
			assert.ok(packages.length > 0, preset.id);
			for (const [path, entry] of packages) {
				assert.match(entry.integrity ?? "", /^sha512-/, `${preset.id}: ${path}`);
			}
		}
	});

	test("a preset is installed into its own folder the first time it starts; Yew's own servers apart", async () => {
		const yewHome = tempDir("yew-home-");
		const source = tempDir("yew-source-");
		for (const folder of [source, join(source, "presets", "notion")]) {
			mkdirSync(folder, { recursive: true });
			writeFileSync(join(folder, "package.json"), "{}");
			writeFileSync(join(folder, "package-lock.json"), `{"in":"${folder}"}`);
		}
		const runs: string[] = [];
		const prepare = mcpInstaller({
			yewHome,
			source,
			install: async (folder) => {
				runs.push(folder);
			},
		});
		await prepare({ command: "node", preset: "notion", ownEnv: true });
		await prepare({ command: "node", preset: "notion", ownEnv: true });
		await prepare({ command: "node", ownEnv: true });
		assert.deepEqual(runs, [join(yewHome, "mcp-presets", "notion"), join(yewHome, "mcp-builtin")]);
	});

	test("a preset Yew does not know, or one with a command or URL, is refused", () => {
		const yewHome = tempDir("yew-home-");
		assert.throws(() => addMcpEntry(yewHome, { name: "x", preset: "nothing" }), /no preset named/);
		assert.throws(
			() => addMcpEntry(yewHome, { name: "x", preset: "notion", command: "npx" }),
			/neither a command nor a URL/,
		);
		writeFileSync(
			join(yewHome, "mcp.json"),
			JSON.stringify({ mcpServers: { odd: { preset: "nothing" } } }),
		);
		assert.deepEqual(readMcpConfig(yewHome, {}), {}, "an unknown preset is not started");
	});

	test("a server one signs in to with a client of one's own keeps the client and scopes in its entry", () => {
		const yewHome = tempDir("yew-home-");
		const gmail = MCP_PRESETS.find((preset) => preset.id === "gmail");
		assert.ok(gmail?.signIn?.ownClient);
		const shown = addMcpEntry(yewHome, presetEntry(gmail, "", { id: " cid ", secret: " shh " }));
		assert.equal(shown.oauthClient, true);
		assert.deepEqual(readMcpConfig(yewHome, {}).gmail?.oauth, {
			clientId: "cid",
			clientSecret: "shh",
			scopes: gmail.signIn.ownClient.scopes,
		});
		// One that registers itself needs nothing in its entry.
		const linear = MCP_PRESETS.find((preset) => preset.id === "linear");
		assert.ok(linear);
		assert.deepEqual(presetEntry(linear, ""), {
			name: "linear",
			url: "https://mcp.linear.app/mcp",
		});
	});
});

describe("servers Yew sets up by itself", () => {
	const builtin = {
		browser: { command: "npx", args: ["-y", "a-browser@1.0.0"] },
		computer: { command: "npx", args: ["-y", "a-computer@1.0.0"] },
	};

	test("run without anything in mcp.json, beside the person's own", () => {
		assert.deepEqual(readMcpConfig(tempDir("yew-home-"), {}, builtin), builtin);
		const yewHome = home({ files: { command: "node", args: ["server.js"] } });
		assert.deepEqual(Object.keys(readMcpConfig(yewHome, {}, builtin)), [
			"browser",
			"computer",
			"files",
		]);
		assert.deepEqual(
			listMcpEntries(yewHome, builtin).map((entry) => [entry.name, entry.builtin, entry.disabled]),
			[
				["browser", true, false],
				["computer", true, false],
				["files", false, false],
			],
		);
	});

	test("are turned off and on from the settings; the file only records that one is off", () => {
		const yewHome = tempDir("yew-home-");
		assert.equal(patchMcpEntry(yewHome, "computer", { disabled: true }, builtin).disabled, true);
		assert.deepEqual(readMcpConfig(yewHome, {}, builtin).computer, {
			...builtin.computer,
			disabled: true,
		});
		assert.deepEqual(readMcpConfig(yewHome, {}, builtin).browser, builtin.browser);
		assert.equal(listMcpEntries(yewHome, builtin)[1]?.disabled, true);
		assert.equal(patchMcpEntry(yewHome, "computer", { disabled: false }, builtin).disabled, false);
		assert.deepEqual(readMcpConfig(yewHome, {}, builtin), builtin);
	});

	test("cannot be removed, and an entry of the same name in mcp.json replaces one", () => {
		assert.throws(
			() => removeMcpEntry(tempDir("yew-home-"), "browser", builtin),
			(e) => e instanceof YewError && e.code === "mcp-builtin",
		);
		const yewHome = home({ browser: { command: "node", args: ["my-browser.js"] } });
		assert.deepEqual(readMcpConfig(yewHome, {}, builtin).browser, {
			command: "node",
			args: ["my-browser.js"],
		});
		const shown = listMcpEntries(yewHome, builtin).find((entry) => entry.name === "browser");
		assert.deepEqual([shown?.builtin, shown?.command], [false, "node"]);
		// The person's own entry is theirs to remove; Yew's own then comes back.
		removeMcpEntry(yewHome, "browser", builtin);
		assert.deepEqual(readMcpConfig(yewHome, {}, builtin).browser, builtin.browser);
	});

	test("are pinned by a lock file that ships with Yew: every package has its hash", () => {
		const root = fileURLToPath(new URL("../mcp-builtin/", import.meta.url));
		const wanted = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
			dependencies: Record<string, string>;
		};
		for (const version of Object.values(wanted.dependencies))
			assert.match(version, /^\d+\.\d+\.\d+$/);
		const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as {
			packages: Record<string, { integrity?: string; version?: string }>;
		};
		const packages = Object.entries(lock.packages).filter(([path]) => path !== "");
		assert.ok(packages.length > 50);
		for (const [path, entry] of packages) {
			assert.match(entry.integrity ?? "", /^sha512-/, path);
			assert.match(entry.version ?? "", /^\d+\.\d+\.\d+/, path);
		}
		const pkg = JSON.parse(readFileSync(join(root, "..", "package.json"), "utf8")) as {
			files: string[];
		};
		assert.ok(pkg.files.includes("mcp-builtin"), "the lock file goes out with the package");
	});

	test("are started with node from Yew's data folder, with their files kept there", () => {
		const servers = builtinMcp("/data/yew", {});
		assert.equal(servers.browser?.command, process.execPath);
		// The person's own Chrome by default, through Playwright's extension.
		assert.deepEqual(servers.browser?.args, [
			"/data/yew/mcp-builtin/node_modules/@playwright/mcp/cli.js",
			"--extension",
			"--output-dir",
			"/data/yew/tmp/browser",
		]);
		// A window of its own, its profile in the data folder.
		assert.deepEqual(builtinMcp("/data/yew", {}, undefined, "separate").browser?.args, [
			"/data/yew/mcp-builtin/node_modules/@playwright/mcp/cli.js",
			"--user-data-dir",
			"/data/yew/browser",
			"--output-dir",
			"/data/yew/tmp/browser",
		]);
		assert.equal(servers.browser?.cwd, "/data/yew/browser-files");
		// Neither way is it started with tools for cookies or a site's storage.
		for (const mode of ["own", "separate"] as const) {
			const args = builtinMcp("/data/yew", {}, 4777, mode).browser?.args ?? [];
			assert.ok(!args.some((arg) => arg.startsWith("--caps")), mode);
		}
		assert.deepEqual(servers.computer?.args, [
			"/data/yew/mcp-builtin/node_modules/computer-use-mcp/dist/main.js",
		]);
		assert.deepEqual(builtinMcp("/data/yew", { YEW_MCP_BUILTIN: "off" }), {});
	});

	test("are installed once per lock file, and again after a failure or a new lock", async () => {
		const yewHome = tempDir("yew-home-");
		const source = tempDir("yew-source-");
		writeFileSync(join(source, "package.json"), "{}");
		writeFileSync(join(source, "package-lock.json"), '{"v":1}');
		const runs: string[] = [];
		let fail = true;
		const prepare = builtinInstaller({
			yewHome,
			source,
			env: { PATH: "/bin", OPENAI_API_KEY: "sk-not-passed" },
			install: async (folder, env) => {
				runs.push(readFileSync(join(folder, "package-lock.json"), "utf8"));
				assert.deepEqual(env, { PATH: "/bin" });
				if (fail) throw new Error("no network");
			},
		});
		await assert.rejects(prepare(), /no network/);
		fail = false;
		await Promise.all([prepare(), prepare()]);
		await prepare();
		assert.equal(runs.length, 2, "once failed, once done; then nothing");
		writeFileSync(join(source, "package-lock.json"), '{"v":2}');
		await prepare();
		assert.deepEqual(runs.at(-1), '{"v":2}');
	});

	test("get little of Yew's environment", () => {
		assert.deepEqual(
			serverEnv({
				PATH: "/bin",
				HOME: "/h",
				HTTPS_PROXY: "http://p",
				ANTHROPIC_API_KEY: "x",
				AWS_SECRET: "y",
			}),
			{ PATH: "/bin", HOME: "/h", HTTPS_PROXY: "http://p" },
		);
	});

	test("start again when the settings change which browser", async () => {
		let mode = "own";
		const hub = new McpHub({
			yewHome: tempDir("yew-home-"),
			version: "0.0.0",
			log: () => {},
			builtin: () => ({ browser: { command: "node", args: [server], env: { MODE: mode } } }),
		});
		const modeNow = async () => {
			const tool = hub.tools().find((t) => t.name === "mcp__browser__env");
			assert.ok(tool);
			return textOf(await tool.run({ name: "MODE" }, ctx));
		};
		try {
			await hub.refresh();
			assert.equal(await modeNow(), "own");
			await hub.refresh();
			assert.equal(await modeNow(), "own", "nothing changed: the same server");
			mode = "separate";
			await hub.refresh();
			assert.equal(await modeNow(), "separate");
		} finally {
			hub.stop();
		}
	});

	test("a failed install is the servers' error, and the person's own servers still start", async () => {
		const yewHome = home({ mine: { command: "node", args: [server] } });
		const hub = new McpHub({
			yewHome,
			version: "0.0.0",
			log: () => {},
			builtin: { browser: { command: "node", args: ["nowhere.js"], ownEnv: true } },
			prepare: async () => {
				throw new Error("npm ci failed (1): no network");
			},
		});
		try {
			await hub.refresh();
			const status = Object.fromEntries(hub.status().map((s) => [s.name, [s.state, s.error]]));
			assert.deepEqual(status.browser, ["error", "npm ci failed (1): no network"]);
			assert.equal(status.mine?.[0], "ready");
		} finally {
			hub.stop();
		}
	});
});

describe("the browser and computer control", () => {
	const engine = new PermissionEngine(tempDir("yew-home-"));
	const session = (rules: Session["rules"], mode: "skip" | "default" = "default") =>
		({ id: "s1", cwd: null, rules, options: { permissionMode: mode } }) as unknown as Session;
	async function tools(name: string) {
		const hub = new McpHub({
			yewHome: home({ [name]: { command: "node", args: [server] } }),
			version: "0.0.0",
			log: () => {},
		});
		await hub.refresh();
		const echo = hub.tools().find((tool) => tool.name === `mcp__${name}__echo`);
		assert.ok(echo);
		return { hub, echo };
	}
	const lookup = {} as Parameters<ToolDefinition["subject"]>[2];

	test("an action of computer control is asked about every time and cannot be remembered", async () => {
		const { hub, echo } = await tools("computer");
		try {
			const allowed = session([{ effect: "allow", tool: "mcp__computer__echo" }]);
			for (const action of ["left_click", "type", "key", "scroll", "mouse_move", "something_new"]) {
				const decision = engine.decide(echo.subject({ action }, allowed, lookup), allowed);
				assert.equal(decision.effect, "ask", action);
				if (decision.effect !== "ask") continue;
				assert.equal(decision.request.mustConfirm, true, action);
				assert.deepEqual(decision.request.reasons, ["computer-control"]);
				assert.equal(decision.request.rememberRules, undefined);
			}
			// Skip mode lets it run and marks it.
			const skipping = session([], "skip");
			assert.deepEqual(
				engine.decide(echo.subject({ action: "left_click" }, skipping, lookup), skipping),
				{ effect: "allow", note: { risk: ["computer-control"] } },
			);
			// Looking can be remembered, and a remembered rule then covers looking only.
			const fresh = session([]);
			const look = engine.decide(echo.subject({ action: "get_screenshot" }, fresh, lookup), fresh);
			assert.ok(look.effect === "ask" && look.request.rememberRules?.length === 1);
			assert.equal(
				engine.decide(echo.subject({ action: "get_screenshot" }, allowed, lookup), allowed).effect,
				"allow",
			);
		} finally {
			hub.stop();
		}
	});

	test("an action in the browser can be remembered, with a warning about what that covers", async () => {
		const { hub, echo } = await tools("browser");
		try {
			const fresh = session([]);
			const decision = engine.decide(echo.subject({}, fresh, lookup), fresh);
			assert.ok(decision.effect === "ask");
			assert.equal(decision.request.warning, "acts-as-you");
			assert.equal(decision.request.rememberRules?.length, 1);
		} finally {
			hub.stop();
		}
		const other = await tools("files");
		try {
			const fresh = session([]);
			const decision = engine.decide(other.echo.subject({}, fresh, lookup), fresh);
			assert.ok(decision.effect === "ask" && decision.request.warning === undefined);
		} finally {
			other.hub.stop();
		}
	});

	test("opening an address counts as acting; going back does not", async () => {
		const { hub } = await tools("browser");
		try {
			const fresh = session([]);
			const warningOf = (tool: string) => {
				const subject = { kind: "act", tool: `mcp__browser__${tool}`, summary: "", always: true };
				// The hub decides by the tool's name; ask it through the definition it would build.
				const definition = hub.tools()[0];
				assert.ok(definition);
				return engine.decide({ ...subject, ...specialFor("browser", tool) } as never, fresh);
			};
			const go = warningOf("browser_navigate");
			assert.ok(go.effect === "ask" && go.request.warning === "acts-as-you");
			const back = warningOf("browser_navigate_back");
			assert.ok(back.effect === "ask" && back.request.warning === undefined);
		} finally {
			hub.stop();
		}
	});

	test("a tool that sends, publishes or deletes in its service is asked about every time", async () => {
		for (const name of [
			"send_message",
			"sendEmail",
			"gmail_send_message",
			"deploy_to_vercel",
			"trash_thread",
			"delete_issue",
			"invite_user",
			"share_file",
			"merge_pull_request",
			"push_files",
			"create_permission",
		]) {
			assert.equal(outward(name), true, name);
		}
		for (const name of [
			"create_draft",
			"search_threads",
			"get_merge_request",
			"list_deleted_files",
			"update_issue",
			"get_file_permissions",
		]) {
			assert.equal(outward(name), false, name);
		}
		const { hub, echo } = await tools("mail");
		try {
			// In the mode that asks nothing, with a rule for each tool.
			const allowed = session([
				{ effect: "allow", tool: "mcp__mail__wipe" },
				{ effect: "allow", tool: "mcp__mail__echo" },
				{ effect: "allow", tool: "mcp__mail__send_message" },
			]);
			const wipe = hub.tools().find((tool) => tool.name === "mcp__mail__wipe");
			assert.ok(wipe);
			const marked = engine.decide(wipe.subject({}, allowed, lookup), allowed);
			assert.ok(marked.effect === "ask", "its server marks it destructive");
			assert.equal(marked.request.mustConfirm, true);
			assert.deepEqual(marked.request.reasons, ["service-action"]);
			assert.equal(marked.request.rememberRules, undefined);
			const named = engine.decide(
				{
					kind: "act",
					tool: "mcp__mail__send_message",
					summary: "",
					always: true,
					...specialFor("mail", "send_message"),
				} as never,
				allowed,
			);
			assert.ok(named.effect === "ask" && named.request.mustConfirm, "its name says it sends");
			// Google's calendar server: these invite the event's attendees, which their names do not say.
			assert.deepEqual(specialFor("google-calendar", "create_event"), {
				reasons: ["service-action"],
			});
			assert.deepEqual(specialFor("google-calendar", "list_events"), {});
			assert.deepEqual(specialFor("gmail", "create_draft"), {});
			// Renamed in mcp.json, it is still known by its address.
			const renamed = { url: "https://calendarmcp.googleapis.com/mcp/v1" };
			assert.deepEqual(specialFor("my-calendar", "create_event", {}, false, renamed), {
				reasons: ["service-action"],
			});
			const plain = engine.decide(echo.subject({ text: "hi" }, allowed, lookup), allowed);
			assert.equal(plain.effect, "allow");
		} finally {
			hub.stop();
		}
	});

	test("always-allow from a phone, for a request that carries the warning, allows once", () => {
		assert.equal(decisionFromPhone("allow_always", { warning: "acts-as-you" }), "allow_once");
		assert.equal(decisionFromPhone("allow_always", { tool: "shell" }), "allow_always");
		assert.equal(decisionFromPhone("deny", { warning: "acts-as-you" }), "deny");
		assert.equal(decisionFromPhone("allow_once", { warning: "acts-as-you" }), "allow_once");
	});

	test("always-allow for these tools is not taken over by a new session", () => {
		const rules: Session["rules"] = [
			{ effect: "allow", tool: "mcp__browser__browser_click" },
			{ effect: "allow", tool: "mcp__computer__computer" },
			{ effect: "deny", tool: "mcp__browser__browser_evaluate" },
			{ effect: "allow", tool: "mcp__files__read" },
			{ effect: "allow", tool: "shell", pattern: "npm test" },
		];
		assert.deepEqual(inheritableRules(rules), rules.slice(2));
	});
});

describe("the browser in the person's own Chrome", () => {
	const engine = new PermissionEngine(tempDir("yew-home-"));
	const session = (rules: Session["rules"], mode = "default") =>
		({ id: "s1", cwd: null, rules, options: { permissionMode: mode } }) as unknown as Session;
	const lookup = {} as Parameters<ToolDefinition["subject"]>[2];
	const PORT = 4777;
	const SAFE_TABS = "- 0: (current) [Mail](https://mail.example.com/)";
	/** A server named browser with Playwright's tool names; `own` starts it with --extension. */
	async function browser(
		own: boolean,
		env: Record<string, string> = {},
		port: number | null = PORT,
	) {
		const hub = new McpHub({
			yewHome: home({
				browser: {
					command: "node",
					args: own ? [server, "--extension"] : [server],
					env: {
						EXTRA_TOOLS: [
							"browser_run_code_unsafe",
							"browser_cookie_list",
							"browser_cookie_set",
							"browser_localstorage_get",
							"browser_sessionstorage_set",
							"browser_storage_state",
							"browser_set_storage_state",
							"browser_tabs",
							"browser_click",
							"browser_evaluate",
							"browser_snapshot",
							"browser_navigate",
							"browser_navigate_back",
							"browser_close",
							"browser_resize",
							"browser_emulate_media",
							"browser_hover",
							"browser_find",
						].join(","),
						TABS: SAFE_TABS,
						...env,
					},
				},
			}),
			version: "0.0.0",
			log: () => {},
			...(port ? { port } : {}),
		});
		await hub.refresh();
		const tool = (name: string) => {
			const found = hub.tools().find((t) => t.name === `mcp__browser__${name}`);
			assert.ok(found, name);
			return found;
		};
		return { hub, tool };
	}

	test("browser_run_code_unsafe and cookie or storage tools are not offered in either mode", async () => {
		for (const own of [true, false]) {
			const { hub } = await browser(own);
			try {
				const names = hub.tools().map((t) => t.name);
				assert.ok(names.includes("mcp__browser__browser_click"));
				// Not offered, so a session that calls one anyway is told there is no such tool.
				const refused = names.filter((name) => /run_code_unsafe|cookie|storage/i.test(name));
				assert.deepEqual(refused, [], `own: ${own}`);
				const listed = hub.status()[0]?.tools ?? [];
				assert.deepEqual(
					listed.filter((name) => /run_code_unsafe|cookie|storage/i.test(name)),
					[],
				);
			} finally {
				hub.stop();
			}
		}
	});

	test("its own Chrome is told by --extension or PLAYWRIGHT_MCP_EXTENSION", () => {
		assert.equal(ownBrowser({ args: ["cli.js", "--extension"] }), true);
		assert.equal(ownBrowser({ args: ["cli.js", "--extension=chrome"] }), true);
		assert.equal(ownBrowser({ env: { PLAYWRIGHT_MCP_EXTENSION: "1" } }), true);
		assert.equal(ownBrowser({}, { PLAYWRIGHT_MCP_EXTENSION: "true" }), true);
		assert.equal(ownBrowser({}, { PLAYWRIGHT_MCP_EXTENSION: "false" }), false);
		// A server Yew runs from its data folder does not get Yew's environment.
		assert.equal(ownBrowser({ ownEnv: true }, { PLAYWRIGHT_MCP_EXTENSION: "1" }), false);
		assert.equal(ownBrowser({ args: ["cli.js", "--user-data-dir", "/x"] }), false);
	});

	test("an action on a page is asked about every time; a remembered allow does not cover it", async () => {
		const { hub, tool } = await browser(true);
		try {
			const allowed = session(
				[
					"browser_click",
					"browser_evaluate",
					"browser_tabs",
					"browser_snapshot",
					"browser_navigate_back",
					"browser_close",
					"browser_resize",
					"browser_emulate_media",
					"browser_hover",
					"browser_find",
				].map((name) => ({ effect: "allow" as const, tool: `mcp__browser__${name}` })),
			);
			const asked = (name: string, args: JsonObject = {}) => {
				const decision = engine.decide(tool(name).subject(args, allowed, lookup), allowed);
				assert.ok(decision.effect === "ask", name);
				assert.equal(decision.request.mustConfirm, true, name);
				assert.equal(decision.request.rememberRules, undefined, name);
				return decision.request.reasons;
			};
			assert.deepEqual(asked("browser_click"), ["browser-action"]);
			assert.deepEqual(asked("browser_navigate", { url: "https://example.com/" }), [
				"browser-action",
			]);
			assert.deepEqual(asked("browser_evaluate", { function: "() => 1" }), ["browser-script"]);
			// Opening a new tab at an address is opening an address.
			assert.deepEqual(asked("browser_tabs", { action: "new", url: "https://example.com/" }), [
				"browser-action",
			]);
			// So is changing the tabs and windows the person works in.
			for (const name of [
				"browser_navigate_back",
				"browser_close",
				"browser_resize",
				"browser_emulate_media",
			]) {
				assert.deepEqual(asked(name), ["browser-action"], name);
			}
			for (const action of ["select", "close", "new"]) {
				assert.deepEqual(asked("browser_tabs", { action, index: 1 }), ["browser-action"], action);
			}
			// Looking can be remembered, and the remembered rule covers it.
			assert.equal(
				engine.decide(tool("browser_snapshot").subject({}, allowed, lookup), allowed).effect,
				"allow",
			);
			assert.equal(
				engine.decide(tool("browser_tabs").subject({ action: "list" }, allowed, lookup), allowed)
					.effect,
				"allow",
			);
			for (const name of ["browser_hover", "browser_find"]) {
				assert.equal(
					engine.decide(tool(name).subject({}, allowed, lookup), allowed).effect,
					"allow",
					name,
				);
			}
			const fresh = session([]);
			const look = engine.decide(tool("browser_snapshot").subject({}, fresh, lookup), fresh);
			assert.ok(look.effect === "ask" && look.request.rememberRules?.length === 1);
		} finally {
			hub.stop();
		}
		// In a window of its own, an action can still be remembered, with the warning.
		const separate = await browser(false);
		try {
			const fresh = session([]);
			const click = engine.decide(separate.tool("browser_click").subject({}, fresh, lookup), fresh);
			assert.ok(click.effect === "ask" && click.request.warning === "acts-as-you");
			assert.equal(click.request.rememberRules?.length, 1);
			// Closing a page there is still looking-class, as before.
			const close = engine.decide(separate.tool("browser_close").subject({}, fresh, lookup), fresh);
			assert.ok(close.effect === "ask" && close.request.warning === undefined);
			assert.equal(close.request.rememberRules?.length, 1);
		} finally {
			separate.hub.stop();
		}
	});

	test("Yew Harness's address is found however it is written", () => {
		for (const text of [
			"- 1: (current) [Yew Harness](http://127.0.0.1:4777/)",
			"http://localhost:4777",
			"localhost.:4777/api",
			"view-source:http://127.0.0.1:4777/",
			"blob:http://localhost:4777/0b3e",
			"ws://127.0.0.1:4777/api/events",
			"http://127.1:4777/",
			"http://0x7f000001:4777/",
			"http:\\\\127.0.0.1:4777",
			"http://[::1]:4777/",
			"https://someone@LOCALHOST:4777/",
		]) {
			assert.equal(namesHarness(text, PORT), true, text);
		}
		for (const text of [
			"http://127.0.0.1:47770/",
			"http://127.0.0.1:4778/",
			"https://example.com/?page=4777",
			"http://192.168.1.2:4777/",
			"- 0: (current) [Mail](https://mail.example.com/)",
		]) {
			assert.equal(namesHarness(text, PORT), false, text);
		}
	});

	test("no browser tool runs while a shared tab has Yew Harness open", async () => {
		const harness = `${SAFE_TABS}\n- 1: [Yew Harness](http://127.0.0.1:${PORT}/)`;
		const open = await browser(true, { TABS: harness });
		try {
			const result = await open.tool("browser_click").run({ ref: "e1" }, ctx);
			assert.equal(result.isError, true);
			assert.match(textOf(result), /take that tab out of the shared tabs/);
		} finally {
			open.hub.stop();
		}
		// Without it, the call goes through.
		const shared = await browser(true);
		try {
			const result = await shared.tool("browser_click").run({ ref: "e1" }, ctx);
			assert.equal(result.isError, undefined);
			assert.equal(textOf(result), 'browser_click {"ref":"e1"}');
		} finally {
			shared.hub.stop();
		}
		// Tabs that cannot be listed, or a port Yew Harness does not know: the browser is not used.
		const failing = await browser(true, { TABS: "error" });
		try {
			const result = await failing.tool("browser_click").run({ ref: "e1" }, ctx);
			assert.equal(result.isError, true);
			assert.match(textOf(result), /could not be listed/);
		} finally {
			failing.hub.stop();
		}
		const unknown = await browser(true, {}, null);
		try {
			const result = await unknown.tool("browser_click").run({ ref: "e1" }, ctx);
			assert.equal(result.isError, true);
			assert.match(textOf(result), /does not know its own port/);
		} finally {
			unknown.hub.stop();
		}
		// A window of its own does not hold Yew Harness's sign-in: its tabs are not listed first.
		const separate = await browser(false, { TABS: harness });
		try {
			const result = await separate.tool("browser_click").run({ ref: "e1" }, ctx);
			assert.equal(result.isError, undefined);
		} finally {
			separate.hub.stop();
		}
	});

	test("a call whose arguments name Yew Harness's address is refused, in either mode", async () => {
		for (const own of [true, false]) {
			const { hub, tool } = await browser(own);
			try {
				for (const url of [
					`http://127.0.0.1:${PORT}/`,
					`http://localhost:${PORT}/#t=abc`,
					`http://127.1:${PORT}`,
					`view-source:http://[::1]:${PORT}/`,
				]) {
					const result = await tool("browser_navigate").run({ url }, ctx);
					assert.equal(result.isError, true, url);
					assert.match(textOf(result), /own address is not opened/);
				}
				const elsewhere = await tool("browser_navigate").run({ url: "https://example.com/" }, ctx);
				assert.equal(elsewhere.isError, undefined);
			} finally {
				hub.stop();
			}
		}
	});

	test("the extension's token does not reach the browser server", async () => {
		const { hub, tool } = await browser(false, {
			PLAYWRIGHT_MCP_EXTENSION_TOKEN: "t0",
			GREETING: "hi",
		});
		try {
			const read = async (name: string) => textOf(await tool("env").run({ name }, ctx));
			assert.equal(await read("PLAYWRIGHT_MCP_EXTENSION_TOKEN"), "(unset)");
			assert.equal(await read("GREETING"), "hi");
		} finally {
			hub.stop();
		}
	});
});

describe("MCP servers", () => {
	test("a stdio server is started, its tools are offered by name, and a call goes through", async () => {
		const yewHome = home({
			test: { command: process.execPath, args: [server], env: { GREETING: "你好" } },
			broken: { command: join(missingHome(), "no-such-program") },
		});
		const hub = new McpHub({ yewHome, version: "0.0.0", log: () => {} });
		try {
			await hub.refresh();
			const status = hub.status();
			assert.deepEqual(
				status.find((s) => s.name === "test"),
				{
					name: "test",
					kind: "stdio",
					state: "ready",
					error: null,
					tools: ["echo", "env", "wipe"],
					signedIn: false,
				},
			);
			// A server that cannot start is reported and does not stand in the others' way.
			assert.equal(status.find((s) => s.name === "broken")?.state, "error");
			const tools = hub.tools();
			assert.deepEqual(
				tools.map((tool) => tool.name),
				["mcp__test__echo", "mcp__test__env", "mcp__test__wipe"],
			);
			const echo = tools[0];
			// Every MCP tool asks the first time, in every permission mode, and can be remembered.
			assert.deepEqual(echo?.subject({ text: "hi" }, {} as Session), {
				kind: "act",
				tool: "mcp__test__echo",
				summary: 'test: echo {"text":"hi"}',
				always: true,
			});
			assert.equal(echo?.readOnly, false);
			assert.equal(
				textOf(await (echo as NonNullable<typeof echo>).run({ text: "hi" }, ctx)),
				"echo: hi",
			);
			const env = tools[1] as NonNullable<(typeof tools)[number]>;
			assert.equal(textOf(await env.run({ name: "GREETING" }, ctx)), "你好");
			const failed = await env.run({ name: "FAIL" }, ctx);
			assert.equal(failed.isError, true);
		} finally {
			hub.stop();
		}
	});

	test("an HTTP server is called with POST, answers as JSON or an event stream, and keeps its session", async () => {
		const yewHome = home({
			web: { url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer k" } },
		});
		const requests: { headers: Record<string, string>; body: JsonObject }[] = [];
		const fetcher = (async (_url: string, init: RequestInit) => {
			if (init.method === "DELETE") return new Response(null, { status: 204 });
			const body = JSON.parse(init.body as string) as JsonObject;
			requests.push({ headers: init.headers as Record<string, string>, body });
			const reply = (result: unknown, stream = false) =>
				new Response(
					stream
						? `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`
						: JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
					{
						headers: {
							"Content-Type": stream ? "text/event-stream" : "application/json",
							"Mcp-Session-Id": "s-1",
						},
					},
				);
			if (body.method === "initialize")
				return reply({ protocolVersion: "2025-06-18", capabilities: {} });
			if (body.method === "tools/list") {
				return reply({
					tools: [{ name: "lookup", description: "Looks up.", inputSchema: { type: "object" } }],
				});
			}
			if (body.method === "tools/call")
				return reply({ content: [{ type: "text", text: "found" }] }, true);
			return new Response(null, { status: 202 });
		}) as unknown as typeof fetch;
		const hub = new McpHub({ yewHome, version: "1.2.3", fetch: fetcher, log: () => {} });
		try {
			await hub.refresh();
			assert.deepEqual(hub.status()[0]?.tools, ["lookup"]);
			const [tool] = hub.tools();
			assert.equal(textOf(await (tool as NonNullable<typeof tool>).run({ q: "x" }, ctx)), "found");
			const call = requests.find((request) => request.body.method === "tools/call");
			assert.equal(call?.headers.Authorization, "Bearer k");
			assert.equal(call?.headers["Mcp-Session-Id"], "s-1");
			assert.equal(call?.headers["User-Agent"], "yew/1.2.3");
			assert.deepEqual(call?.body.params, { name: "lookup", arguments: { q: "x" } });
			// The configuration is read again only when the file changed.
			const before = requests.length;
			await hub.refresh();
			assert.equal(requests.length, before);
		} finally {
			hub.stop();
		}
	});
});

function missingHome(): string {
	return tempDir("yew-none-");
}
