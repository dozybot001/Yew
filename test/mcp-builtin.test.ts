import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { YewError } from "../src/server/errors.ts";
import { McpHub, readMcpConfig } from "../src/server/mcp.ts";
import { builtinInstaller, builtinMcp, serverEnv } from "../src/server/mcp-builtin.ts";
import { listMcpEntries, patchMcpEntry, removeMcpEntry } from "../src/server/mcp-config.ts";
import { ctx, home, server, textOf } from "./helpers/mcp.ts";
import { tempDir } from "./helpers/store.ts";

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
