import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AppHost } from "../src/cli/app.ts";
import { SERVICE_LABEL, type ServiceHost } from "../src/cli/service.ts";
import { systemControl } from "../src/cli/system.ts";
import { createApp } from "../src/server/http/app.ts";
import { MemoryKeyStore } from "../src/server/keys.ts";
import { MailStore } from "../src/server/mail/store.ts";
import { McpHub } from "../src/server/mcp.ts";
import { type Clear, type Note, Notifier } from "../src/server/push.ts";
import { SearchAccess } from "../src/server/tools/web-search.ts";
import { DEFAULT_RELAY_URL } from "../src/shared/types.ts";
import { newStore, sessionInput, tempDir } from "./helpers/store.ts";

/**
 * Defaults for new sessions, search services, MCP servers, starting at login and notifications in
 * the settings: their routes, their validation and who may call them.
 */

// biome-ignore lint/suspicious/noExplicitAny: test assertions read arbitrary JSON
type Json = any;

const mcpServer = fileURLToPath(new URL("./helpers/mcp-server.mjs", import.meta.url));

function caller(app: ReturnType<typeof createApp>) {
	const send = async (method: string, path: string, body?: unknown, device?: string) => {
		const response = await app.fetch(
			new Request(`http://localhost${path}`, {
				method,
				...(body === undefined
					? {}
					: { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
			}),
			device ? { device } : {},
		);
		const text = await response.text();
		return { status: response.status, body: (text ? JSON.parse(text) : null) as Json, text };
	};
	return {
		call: (method: string, path: string, body?: unknown) => send(method, path, body),
		/** The same request as a paired phone sends it through the relay. */
		phone: (method: string, path: string, body?: unknown) => send(method, path, body, "phone-1"),
	};
}

async function until(check: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
	const start = Date.now();
	while (!(await check())) {
		if (Date.now() - start > ms) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("settings: defaults for new sessions", () => {
	function setup() {
		const { store } = newStore();
		return { store, ...caller(createApp({ store, log: () => {} })) };
	}

	test("new sessions start with the default permission mode; an unknown mode is refused", async () => {
		const { call } = setup();
		assert.equal((await call("GET", "/api/settings")).body.defaultPermissionMode, "default");
		const saved = await call("PATCH", "/api/settings", { defaultPermissionMode: "skip" });
		assert.equal(saved.body.defaultPermissionMode, "skip");
		const session = await call("POST", "/api/sessions", { name: "新的" });
		assert.equal(session.body.options.permissionMode, "skip");
		const wrong = await call("PATCH", "/api/settings", { defaultPermissionMode: "always" });
		assert.equal(wrong.status, 400);
		assert.equal(wrong.body.field, "defaultPermissionMode");
		assert.equal((await call("GET", "/api/settings")).body.defaultPermissionMode, "skip");
	});

	test("the default workspace is one of the saved ones, and is forgotten when that one is removed", async () => {
		const { call } = setup();
		const folder = tempDir("yew-ws-");
		const missing = await call("PATCH", "/api/settings", { defaultWorkspaceId: "w1" });
		assert.equal(missing.status, 400);
		assert.equal(missing.body.field, "defaultWorkspaceId");
		await call("PATCH", "/api/settings", {
			workspaces: [{ id: "w1", name: "官网", path: folder }],
		});
		const chosen = await call("PATCH", "/api/settings", { defaultWorkspaceId: "w1" });
		assert.equal(chosen.body.defaultWorkspaceId, "w1");
		const removed = await call("PATCH", "/api/settings", { workspaces: [] });
		assert.equal(removed.body.defaultWorkspaceId, null);
		const none = await call("PATCH", "/api/settings", { defaultWorkspaceId: null });
		assert.equal(none.status, 200);
	});

	test("notification kinds are all on at first; a change names only the kinds it changes", async () => {
		const { call } = setup();
		const all = { waiting: true, error: true, task: true, budget: true };
		assert.deepEqual((await call("GET", "/api/settings")).body.notify, all);
		const saved = await call("PATCH", "/api/settings", { notify: { task: false } });
		assert.deepEqual(saved.body.notify, { ...all, task: false });
		const wrong = await call("PATCH", "/api/settings", { notify: { budget: "no" } });
		assert.equal(wrong.status, 400);
		assert.deepEqual((await call("GET", "/api/settings")).body.notify, { ...all, task: false });
	});

	test("the relay address is checked, null restores the default, and a phone cannot change it", async () => {
		const { call, phone } = setup();
		const own = await call("PATCH", "/api/settings", {
			remote: { relayUrl: " wss://relay.example.com " },
		});
		assert.equal(own.body.remote.relayUrl, "wss://relay.example.com");
		const wrong = await call("PATCH", "/api/settings", {
			remote: { relayUrl: "ws://relay.example.com" },
		});
		assert.equal(wrong.status, 400);
		assert.equal(wrong.body.field, "remote");
		const back = await call("PATCH", "/api/settings", { remote: { relayUrl: null } });
		assert.equal(back.body.remote.relayUrl, DEFAULT_RELAY_URL);
		const refused = await phone("PATCH", "/api/settings", {
			remote: { relayUrl: "wss://relay.example.com" },
		});
		assert.equal(refused.status, 400);
		assert.equal((await call("GET", "/api/settings")).body.remote.relayUrl, DEFAULT_RELAY_URL);
	});
});

describe("settings: search services", () => {
	function setup(initial: Record<string, string> = {}) {
		const { store } = newStore();
		const keys = new MemoryKeyStore(initial);
		const search = new SearchAccess(keys);
		return { keys, search, ...caller(createApp({ store, log: () => {}, search })) };
	}

	test("the list says which services have a key and which one is used, never the key", async () => {
		const { call } = setup({ "search-tavily": "tvly-test-value" });
		const listed = await call("GET", "/api/search-services");
		const row = (id: string, name: string, region: string, hasKey: boolean, active: boolean) => ({
			id,
			name,
			region,
			hasKey,
			provider: null,
			active,
		});
		assert.deepEqual(listed.body.items, [
			row("search-bocha", "Bocha web search", "cn", false, false),
			row("search-tavily", "Tavily search", "global", true, true),
			row("search-brave", "Brave Search", "global", false, false),
			// Built in with the model's DeepSeek key, which is set with the model providers.
			{ ...row("search-deepseek", "DeepSeek search", "cn", false, false), provider: "deepseek" },
		]);
		assert.doesNotMatch(listed.text, /tvly-test-value/);
		// Its key is the model provider's: not saved or deleted from here.
		const refused = await call("PUT", "/api/search-services/search-deepseek/key", { key: "sk" });
		assert.equal(refused.status, 400);
	});

	test("a key is saved to the key store, replaces the old one, and can be deleted", async () => {
		const { call, keys, search } = setup();
		assert.equal(search.service?.id, undefined);
		const saved = await call("PUT", "/api/search-services/search-bocha/key", { key: " k-one \n" });
		assert.equal(saved.status, 204);
		assert.equal(await keys.get("search-bocha"), "k-one");
		// Web search is offered at once, without waiting for the next look at the keychain.
		assert.equal(search.service?.id, "search-bocha");
		await call("PUT", "/api/search-services/search-bocha/key", { key: "k-two" });
		assert.equal(await keys.get("search-bocha"), "k-two");
		const removed = await call("DELETE", "/api/search-services/search-bocha/key");
		assert.equal(removed.status, 204);
		assert.equal(await keys.get("search-bocha"), null);
		assert.equal(search.service?.id, undefined);
	});

	test("an empty key and an unknown service are refused", async () => {
		const { call, keys } = setup();
		const empty = await call("PUT", "/api/search-services/search-bocha/key", { key: "  " });
		assert.equal(empty.status, 400);
		assert.equal(empty.body.field, "key");
		// A model provider's key is not reachable through these routes.
		const other = await call("PUT", "/api/search-services/deepseek/key", { key: "k" });
		assert.equal(other.status, 404);
		assert.equal(await keys.get("deepseek"), null);
		assert.equal((await call("DELETE", "/api/search-services/nope/key")).status, 404);
	});

	test("a paired phone cannot read or change search keys", async () => {
		const { phone, keys } = setup({ "search-brave": "b-test" });
		assert.equal((await phone("GET", "/api/search-services")).status, 403);
		const put = await phone("PUT", "/api/search-services/search-bocha/key", { key: "k" });
		assert.equal(put.status, 403);
		assert.equal((await phone("DELETE", "/api/search-services/search-brave/key")).status, 403);
		assert.equal(await keys.get("search-bocha"), null);
		assert.equal(await keys.get("search-brave"), "b-test");
	});
});

describe("settings: MCP servers", () => {
	function setup(file?: string) {
		const { store } = newStore();
		const home = tempDir("yew-home-");
		const path = join(home, "mcp.json");
		if (file !== undefined) writeFileSync(path, file);
		const hub = new McpHub({ yewHome: home, version: "0.0.0", env: {}, log: () => {} });
		const app = createApp({ store, log: () => {}, mcp: { home, hub } });
		const saved = () => JSON.parse(readFileSync(path, "utf8"));
		return { home, hub, path, saved, ...caller(app) };
	}
	const stateOf = async (call: ReturnType<typeof caller>["call"], name: string) =>
		(await call("GET", "/api/mcp")).body.items.find((item: Json) => item.name === name);

	test("an added server is written to mcp.json and started without a restart; values stay out of answers", async () => {
		const { call, hub, path, saved } = setup();
		try {
			assert.deepEqual((await call("GET", "/api/mcp")).body, { items: [], nextCursor: null });
			const added = await call("POST", "/api/mcp", {
				name: "test",
				command: process.execPath,
				args: [mcpServer],
				env: { GREETING: "s3cret-greeting" },
			});
			assert.equal(added.status, 201);
			assert.equal(added.body.state, "connecting");
			assert.deepEqual(added.body.envNames, ["GREETING"]);
			assert.doesNotMatch(added.text, /s3cret-greeting/);
			// The file keeps the usual shape, and only the person can read it.
			assert.deepEqual(saved(), {
				mcpServers: {
					test: {
						command: process.execPath,
						args: [mcpServer],
						env: { GREETING: "s3cret-greeting" },
					},
				},
			});
			assert.equal(statSync(path).mode & 0o777, 0o600);

			await until(async () => (await stateOf(call, "test"))?.state === "ready");
			const listed = await call("GET", "/api/mcp");
			assert.deepEqual(listed.body.items, [
				{
					name: "test",
					kind: "stdio",
					builtin: false,
					disabled: false,
					command: process.execPath,
					args: [mcpServer],
					envNames: ["GREETING"],
					url: null,
					headerNames: [],
					oauthClient: false,
					state: "ready",
					error: null,
					tools: ["echo", "env", "wipe"],
					signedIn: false,
				},
			]);
			assert.doesNotMatch(listed.text, /s3cret-greeting/);
			assert.deepEqual(
				hub.tools().map((tool) => tool.name),
				["mcp__test__echo", "mcp__test__env", "mcp__test__wipe"],
			);
		} finally {
			hub.stop();
		}
	});

	test("a server can be turned off and on, its values typed again, and removed", async () => {
		const { call, hub, saved } = setup();
		try {
			await call("POST", "/api/mcp", {
				name: "test",
				command: process.execPath,
				args: [mcpServer],
			});
			await until(async () => (await stateOf(call, "test"))?.state === "ready");

			const off = await call("PATCH", "/api/mcp/test", { disabled: true });
			assert.equal(off.body.state, "disabled");
			assert.deepEqual(off.body.tools, []);
			assert.equal(saved().mcpServers.test.disabled, true);
			await hub.reload();
			assert.deepEqual(hub.tools(), []);
			assert.equal(hub.status()[0]?.state, "disabled");

			const on = await call("PATCH", "/api/mcp/test", { disabled: false, env: { TOKEN: "t-1" } });
			assert.equal(on.status, 200);
			assert.deepEqual(on.body.envNames, ["TOKEN"]);
			assert.doesNotMatch(on.text, /t-1/);
			assert.deepEqual(saved().mcpServers.test, {
				command: process.execPath,
				args: [mcpServer],
				env: { TOKEN: "t-1" },
			});
			await until(async () => (await stateOf(call, "test"))?.state === "ready");

			await call("PATCH", "/api/mcp/test", { env: { TOKEN: null } });
			assert.equal(saved().mcpServers.test.env, undefined);

			assert.equal((await call("DELETE", "/api/mcp/test")).status, 204);
			assert.deepEqual(saved(), { mcpServers: {} });
			await hub.reload();
			assert.deepEqual(hub.status(), []);
			assert.deepEqual(hub.tools(), []);
			assert.equal((await call("DELETE", "/api/mcp/test")).status, 404);
			assert.equal((await call("PATCH", "/api/mcp/test", { disabled: true })).status, 404);
		} finally {
			hub.stop();
		}
	});

	test("a server that does not start is listed as failed with the reason", async () => {
		const { call, hub, home } = setup();
		try {
			await call("POST", "/api/mcp", { name: "broken", command: join(home, "no-such-program") });
			await until(async () => (await stateOf(call, "broken"))?.state === "error");
			assert.match((await stateOf(call, "broken")).error, /could not start/);
		} finally {
			hub.stop();
		}
	});

	test("what the person wrote by hand stays: other keys, entries Yew skips, header values", async () => {
		const { call, hub, saved } = setup(
			JSON.stringify({
				note: "mine",
				servers: {
					remote: {
						url: "https://mcp.example.com/mcp",
						headers: { Authorization: "Bearer h-1" },
						disabled: true,
					},
					"odd name": { command: "x" },
				},
			}),
		);
		try {
			const listed = await call("GET", "/api/mcp");
			assert.deepEqual(listed.body.items, [
				{
					name: "remote",
					kind: "http",
					builtin: false,
					disabled: true,
					command: null,
					args: [],
					envNames: [],
					url: "https://mcp.example.com/mcp",
					headerNames: ["Authorization"],
					oauthClient: false,
					state: "disabled",
					error: null,
					tools: [],
					signedIn: false,
				},
			]);
			assert.doesNotMatch(listed.text, /h-1/);
			const added = await call("POST", "/api/mcp", {
				name: "more",
				url: "https://more.example.com/mcp",
				headers: { "X-Key": "h-2" },
			});
			assert.equal(added.status, 201);
			assert.doesNotMatch(added.text, /h-2/);
			await call("PATCH", "/api/mcp/more", { disabled: true });
			const file = saved();
			assert.equal(file.note, "mine");
			assert.equal(file.mcpServers, undefined);
			assert.deepEqual(file.servers["odd name"], { command: "x" });
			assert.equal(file.servers.remote.headers.Authorization, "Bearer h-1");
			assert.deepEqual(file.servers.more, {
				url: "https://more.example.com/mcp",
				headers: { "X-Key": "h-2" },
				disabled: true,
			});
		} finally {
			hub.stop();
		}
	});

	test("names, commands, URLs and values are checked; a taken name is a conflict", async () => {
		const { call, hub, path } = setup();
		try {
			const bad = async (body: unknown, field: string) => {
				const response = await call("POST", "/api/mcp", body);
				assert.equal(response.status, 400, JSON.stringify(body));
				assert.equal(response.body.field, field, JSON.stringify(body));
				assert.match(response.body.type, /invalid-request$/);
			};
			await bad({ name: "has space", command: "x" }, "server");
			await bad({ name: "none" }, "command");
			await bad({ name: "both", command: "x", url: "https://example.com" }, "url");
			await bad({ name: "ftp", url: "ftp://example.com" }, "url");
			await bad({ name: "creds", url: "https://user:pw@example.com/mcp" }, "url");
			await bad({ name: "args", command: "x", args: [1] }, "args");
			await bad({ name: "env", command: "x", env: { "1BAD": "v" } }, "env");
			await bad({ name: "env2", command: "x", env: { OK: 5 } }, "env");
			await bad({ name: "head", url: "https://example.com", headers: { "a b": "v" } }, "headers");
			assert.equal(existsSync(path), false);

			await call("POST", "/api/mcp", { name: "one", url: "https://example.com/mcp" });
			const again = await call("POST", "/api/mcp", { name: "one", url: "https://example.com/mcp" });
			assert.equal(again.status, 409);
			assert.match(again.body.type, /mcp-exists$/);
			const env = await call("PATCH", "/api/mcp/one", { env: { A: "b" } });
			assert.equal(env.status, 400);
		} finally {
			hub.stop();
		}
	});

	test("a file that is not valid JSON is left alone", async () => {
		const { call, hub, path } = setup("{ not json");
		try {
			for (const [method, route, body] of [
				["GET", "/api/mcp", undefined],
				["POST", "/api/mcp", { name: "x", command: "y" }],
				["DELETE", "/api/mcp/x", undefined],
			] as const) {
				const response = await call(method, route, body);
				assert.equal(response.status, 409, route);
				assert.match(response.body.type, /mcp-unreadable$/);
			}
			assert.equal(readFileSync(path, "utf8"), "{ not json");
		} finally {
			hub.stop();
		}
	});

	test("a paired phone cannot list, add, change or remove servers", async () => {
		const { call, phone, hub, path } = setup();
		try {
			await call("POST", "/api/mcp", { name: "one", url: "https://example.com/mcp" });
			const before = readFileSync(path, "utf8");
			for (const [method, route, body] of [
				["GET", "/api/mcp", undefined],
				["POST", "/api/mcp", { name: "x", command: "y" }],
				["PATCH", "/api/mcp/one", { disabled: true }],
				["DELETE", "/api/mcp/one", undefined],
			] as const) {
				const response = await phone(method, route, body);
				assert.equal(response.status, 403, `${method} ${route}`);
				assert.match(response.body.type, /mac-only$/);
			}
			assert.equal(readFileSync(path, "utf8"), before);
		} finally {
			hub.stop();
		}
	});
});

describe("settings: starting at login and the launcher icon", () => {
	function setup(platform: NodeJS.Platform = "darwin", fail = false) {
		const { store } = newStore();
		const calls: string[] = [];
		const homeDir = tempDir("yew-user-");
		const home = tempDir("yew-home-");
		let enabled = false;
		const run = (command: string, args: string[]) => {
			calls.push([command, ...args].join(" "));
			if (command === "systemctl") {
				if (args[1] === "is-enabled") return enabled ? 0 : 1;
				if (args[1] === "enable") {
					if (fail) return 5;
					enabled = true;
				}
				if (args[1] === "disable") enabled = false;
			}
			if (command === "iconutil") writeFileSync(args[4] as string, "icns");
			return 0;
		};
		const service: ServiceHost = {
			platform,
			homeDir,
			uid: 501,
			node: "/opt/node/bin/node",
			entry: "/opt/yew/src/cli/main.ts",
			run,
		};
		const appHost: AppHost = {
			platform,
			homeDir,
			node: "/opt/node/bin/node",
			entry: "/opt/yew/src/cli/main.ts",
			icon: join(homeDir, "app-icon.png"),
			program: null,
			run,
		};
		const system = systemControl({
			home,
			env: { YEW_HOME: home, PATH: "/opt/homebrew/bin:/usr/bin" },
			service,
			app: appHost,
		});
		const app = createApp({ store, log: () => {}, system });
		return { calls, homeDir, home, ...caller(app) };
	}

	test("on macOS the switch writes the LaunchAgent for the next login and leaves the running Yew alone", async () => {
		const { call, calls, homeDir, home } = setup();
		const file = join(homeDir, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
		const launcher = join(homeDir, "Applications", "Yew.app");
		assert.deepEqual((await call("GET", "/api/system")).body, {
			startAtLogin: { supported: true, on: false, file },
			launcher: { supported: true, on: false, path: launcher },
		});
		const on = await call("PATCH", "/api/system", { startAtLogin: true });
		assert.equal(on.status, 200);
		assert.equal(on.body.startAtLogin.on, true);
		const plist = readFileSync(file, "utf8");
		assert.match(plist, /<string>serve<\/string>/);
		assert.match(plist, /<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/);
		assert.match(plist, new RegExp(`<key>YEW_HOME</key>\\s*<string>${home}</string>`));
		// Nothing is loaded or stopped now: that would start a second Yew, or stop this one.
		assert.deepEqual(calls, []);
		const off = await call("PATCH", "/api/system", { startAtLogin: false });
		assert.equal(off.body.startAtLogin.on, false);
		assert.equal(existsSync(file), false);
		assert.deepEqual(calls, []);
	});

	test("on Linux the unit is enabled and disabled without starting or stopping it", async () => {
		const { call, calls, homeDir } = setup("linux");
		const file = join(homeDir, ".config", "systemd", "user", "yew.service");
		const before = await call("GET", "/api/system");
		assert.deepEqual(before.body.startAtLogin, { supported: true, on: false, file });
		assert.deepEqual(before.body.launcher, { supported: false, on: false, path: null });
		calls.length = 0;
		const on = await call("PATCH", "/api/system", { startAtLogin: true });
		assert.equal(on.body.startAtLogin.on, true);
		assert.match(readFileSync(file, "utf8"), /ExecStart=.* serve/);
		assert.ok(calls.includes("systemctl --user enable yew.service"));
		const off = await call("PATCH", "/api/system", { startAtLogin: false });
		assert.equal(off.body.startAtLogin.on, false);
		assert.ok(calls.includes("systemctl --user disable yew.service"));
		assert.equal(
			calls.some((line) => line.includes("--now")),
			false,
		);
		assert.equal(existsSync(file), false);
	});

	test("a system command that fails is reported as a problem", async () => {
		const { call } = setup("linux", true);
		const failed = await call("PATCH", "/api/system", { startAtLogin: true });
		assert.equal(failed.status, 409);
		assert.match(failed.body.type, /service-failed$/);
	});

	test("the launcher switch makes and removes Yew.app", async () => {
		const { call, homeDir } = setup();
		const launcher = join(homeDir, "Applications", "Yew.app", "Contents", "MacOS", "yew-launcher");
		const on = await call("PATCH", "/api/system", { launcher: true });
		assert.equal(on.body.launcher.on, true);
		assert.match(
			readFileSync(launcher, "utf8"),
			/'\/opt\/node\/bin\/node' '\/opt\/yew\/src\/cli\/main\.ts' serve/,
		);
		const off = await call("PATCH", "/api/system", { launcher: false });
		assert.equal(off.body.launcher.on, false);
		assert.equal(existsSync(launcher), false);
	});

	test("where the system does not support a switch it says so and changes nothing", async () => {
		const { call, calls, homeDir } = setup("win32");
		assert.deepEqual((await call("GET", "/api/system")).body, {
			startAtLogin: { supported: false, on: false, file: null },
			launcher: { supported: false, on: false, path: null },
		});
		for (const patch of [{ startAtLogin: true }, { launcher: true }]) {
			const refused = await call("PATCH", "/api/system", patch);
			assert.equal(refused.status, 409);
			assert.match(refused.body.type, /not-on-this-system$/);
		}
		assert.equal((await call("PATCH", "/api/system", { launcher: "yes" })).status, 400);
		assert.deepEqual(calls, []);
		assert.equal(existsSync(join(homeDir, "Applications")), false);
	});

	test("a paired phone cannot read or flip the switches", async () => {
		const { phone, homeDir } = setup();
		assert.equal((await phone("GET", "/api/system")).status, 403);
		const refused = await phone("PATCH", "/api/system", { startAtLogin: true, launcher: true });
		assert.equal(refused.status, 403);
		assert.equal(existsSync(join(homeDir, "Library")), false);
		assert.equal(existsSync(join(homeDir, "Applications")), false);
	});
});

describe("settings: which kinds of events notify the phone", () => {
	function setup() {
		const { store, bus } = newStore();
		const sent: { note: Note | Clear; mode: string }[] = [];
		let now = 1_800_000_000_000;
		const notifier = new Notifier({
			store,
			mail: new MailStore(store),
			bus,
			send: (note, mode) => {
				sent.push({ note, mode });
				return 1;
			},
			now: () => now,
		});
		const session = store.createSession(sessionInput("官网"));
		notifier.start();
		return {
			store,
			notifier,
			session,
			ask: (summary: string) =>
				store.createApproval({
					sessionId: session.id,
					toolCallId: null,
					kind: "permission",
					request: { tool: "shell", summary, mustConfirm: true },
				}),
			budget: () =>
				store.appendEntry(session.id, {
					role: "notice",
					notice: {
						kind: "budget",
						text: "",
						data: { code: "budget-reached", scope: "session", spent: 2.13, limit: 2 },
						timestamp: Date.now(),
					},
				}),
			pass(ms: number) {
				now += ms;
				notifier.tick();
			},
			kinds: () =>
				sent.filter((item) => item.mode === "alert").map((item) => (item.note as Note).kind),
			only: (kinds: Record<string, boolean>) =>
				store.setSetting("notify", {
					waiting: false,
					error: false,
					task: false,
					budget: false,
					...kinds,
				}),
		};
	}

	test("a kind that is off is not sent; the others still are", () => {
		const { store, session, ask, budget, pass, kinds, only, notifier } = setup();
		only({ error: true });
		ask("git push");
		budget();
		store.setStatus(session.id, "working");
		store.setStatus(session.id, "error", "The model request failed.");
		pass(2000);
		pass(20_000);
		assert.deepEqual(kinds(), ["error"]);
		notifier.stop();
	});

	test("things waiting for you and spending are sent when only they are on", () => {
		const { store, session, ask, budget, pass, kinds, only, notifier } = setup();
		only({ waiting: true, budget: true });
		store.setStatus(session.id, "working");
		store.setStatus(session.id, "error", "The model request failed.");
		pass(2000);
		assert.deepEqual(kinds(), []);
		ask("git push");
		pass(100);
		pass(2000);
		assert.deepEqual(kinds(), ["permission"]);
		budget();
		pass(20_000);
		assert.deepEqual(kinds(), ["permission", "budget"]);
		notifier.stop();
	});

	test("turning a kind on later does not send what came while it was off; turning it off drops what waits", () => {
		const { ask, pass, kinds, only, notifier } = setup();
		only({});
		ask("git push");
		pass(100);
		pass(2000);
		only({ waiting: true });
		pass(20_000);
		assert.deepEqual(kinds(), []);
		ask("npm publish");
		pass(100);
		only({});
		pass(20_000);
		assert.deepEqual(kinds(), []);
		notifier.stop();
	});

	test("a finished task session and a scheduled task belong to the task kind", () => {
		const { store, pass, kinds, only, notifier } = setup();
		const task = store.createSession({ ...sessionInput("查资料"), kind: "task" });
		only({ task: false, waiting: true, error: true, budget: true });
		store.setOutcome(task.id, "done");
		pass(20_000);
		assert.deepEqual(kinds(), []);
		const second = store.createSession({ ...sessionInput("再查"), kind: "task" });
		only({ task: true });
		store.setOutcome(second.id, "done");
		pass(20_000);
		assert.deepEqual(kinds(), ["task"]);
		notifier.stop();
	});
});
