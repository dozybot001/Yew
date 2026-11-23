import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { McpHub, readMcpConfig } from "../src/server/mcp.ts";
import { INSTALLED_PRESETS, mcpInstaller } from "../src/server/mcp-builtin.ts";
import { addMcpEntry } from "../src/server/mcp-config.ts";
import { MCP_PRESETS, presetEntry } from "../src/shared/mcp-presets.ts";
import type { JsonObject } from "../src/shared/messages.ts";
import type { Session } from "../src/shared/types.ts";
import { ctx, home, server, textOf } from "./helpers/mcp.ts";
import { tempDir } from "./helpers/store.ts";

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

describe("MCP servers", () => {
	test("tools keep their order when a server is connected again", async () => {
		const yewHome = home({
			zeta: { command: process.execPath, args: [server] },
			alpha: { command: process.execPath, args: [server] },
		});
		const hub = new McpHub({ yewHome, version: "0.0.0", log: () => {} });
		try {
			void hub.refresh();
			// Waiting for the servers that are connecting ends when they have connected.
			await hub.settled(20_000);
			const names = hub.tools().map((tool) => tool.name);
			assert.equal(names.length, 6);
			assert.deepEqual(names, [...names].sort());
			await hub.reconnect("alpha");
			assert.deepEqual(
				hub.tools().map((tool) => tool.name),
				names,
			);
		} finally {
			hub.stop();
		}
	});

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
