import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { McpHub } from "../src/server/mcp.ts";
import { PermissionEngine } from "../src/server/permissions/engine.ts";
import {
	checkRepositories,
	gitInternals,
	snapshotRepositories,
} from "../src/server/repositories.ts";
import { RoleFiles } from "../src/server/role-files.ts";
import {
	activeSandbox,
	appWebData,
	commandFilesystem,
	INSTALL_DIR,
	PACKAGE_SITES,
	type SandboxPlaces,
	type SiteQuestion,
	sandboxConfig,
	sandboxEnvironment,
	sandboxWanted,
	startSandbox,
	stopSandbox,
} from "../src/server/sandbox.ts";
import { type RunningCommand, startCommand } from "../src/server/tools/process.ts";
import type { Session } from "../src/shared/types.ts";
import { newStore, sessionInput, tempDir } from "./helpers/store.ts";

/**
 * The system sandbox: its configuration, and everyday work in it. Whether it holds against a command
 * trying to get out is tested separately, with probes of its own.
 */

const base = realpathSync(tempDir("yew-sandbox-"));
const places: SandboxPlaces = {
	home: join(base, "yew-home"),
	install: INSTALL_DIR,
	userHome: homedir(),
	port: 4799,
	root: join(base, "sandbox"),
};
mkdirSync(places.home);
const hiddenFolder = join(base, "kept");
mkdirSync(hiddenFolder);
writeFileSync(join(hiddenFolder, "keys.txt"), "secret\n");
const policy = { sites: ["api.deepseek.com"], credentials: false, hidden: [hiddenFolder] };

describe("sandbox configuration", () => {
	const config = sandboxConfig(places, policy, { platform: "darwin" });
	const work = join(base, "work-config");
	mkdirSync(work);
	const files = commandFilesystem(places, policy, { writable: [work] }, "darwin");

	test("a command writes in its working folder, the sandbox's caches and temporary folders only", () => {
		assert.ok(files.allowWrite.includes(work));
		assert.ok(files.allowWrite.includes(join(places.root, "cache")));
		assert.ok(files.allowWrite.includes("/tmp"));
		assert.ok(!files.allowWrite.includes(homedir()));
		// Without a working folder, nothing of the person's is writable.
		assert.ok(!config.filesystem.allowWrite.includes(work));
	});

	test("the data folder, the program and what starts at login cannot be changed", () => {
		const denied = files.denyWrite;
		assert.ok(denied.includes(places.home));
		assert.ok(denied.includes(realpathSync(INSTALL_DIR)));
		assert.ok(denied.includes(join(homedir(), "Library", "LaunchAgents")));
		assert.ok(denied.includes(join(homedir(), "Applications", "Yew.app")));
		assert.ok(denied.includes(join(homedir(), ".config", "systemd", "user")));
		// The hooks and settings of submodules and worktrees under the working folder.
		for (const pattern of gitInternals(work, "darwin")) assert.ok(denied.includes(pattern));
		assert.equal(files.allowGitConfig, false);
	});

	test("on macOS repositories' git settings are covered by patterns; on Linux every repository there is listed", () => {
		assert.ok(gitInternals("/w", "darwin").includes("/w/.git/**/hooks"));
		assert.ok(gitInternals("/w", "darwin").includes("/w/**/.git/**/config"));
		const repo = join(base, "repo-linux");
		// The working folder's own repository, with a submodule and a worktree.
		mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
		writeFileSync(join(repo, ".git", "config"), "");
		mkdirSync(join(repo, ".git", "modules", "lib", "hooks"), { recursive: true });
		writeFileSync(join(repo, ".git", "modules", "lib", "config"), "");
		mkdirSync(join(repo, ".git", "worktrees", "other"), { recursive: true });
		writeFileSync(join(repo, ".git", "worktrees", "other", "config.worktree"), "");
		// A repository further down, a submodule's checkout (its .git a file) and one in dependencies.
		mkdirSync(join(repo, "tools", "inner", ".git", "hooks"), { recursive: true });
		writeFileSync(join(repo, "tools", "inner", ".git", "config"), "");
		mkdirSync(join(repo, "lib"), { recursive: true });
		writeFileSync(join(repo, "lib", ".git"), "gitdir: ../.git/modules/lib\n");
		mkdirSync(join(repo, "node_modules", "dep", ".git", "hooks"), { recursive: true });
		assert.deepEqual(gitInternals(repo, "linux").sort(), [
			join(repo, ".git", "config"),
			join(repo, ".git", "hooks"),
			join(repo, ".git", "modules", "lib", "config"),
			join(repo, ".git", "modules", "lib", "hooks"),
			join(repo, ".git", "worktrees", "other", "config.worktree"),
			join(repo, "lib", ".git"),
			join(repo, "tools", "inner", ".git", "config"),
			join(repo, "tools", "inner", ".git", "hooks"),
		]);
	});

	test("after a command, a hook it added or changed is moved aside, and what it made is said", () => {
		const folder = join(base, "repo-after");
		const git = join(folder, ".git");
		mkdirSync(join(git, "hooks"), { recursive: true });
		writeFileSync(join(git, "config"), "[core]\n\tbare = false\n");
		writeFileSync(join(git, "hooks", "pre-commit.sample"), "#!/bin/sh\n");
		writeFileSync(join(git, "hooks", "post-merge"), "#!/bin/sh\necho kept\n");
		const before = snapshotRepositories([folder]);
		// What a command could leave behind: a new hook, a repository it made with settings that run programs.
		writeFileSync(join(git, "hooks", "pre-push"), "#!/bin/sh\n");
		mkdirSync(join(folder, "made", ".git", "hooks"), { recursive: true });
		writeFileSync(join(folder, "made", ".git", "config"), "[core]\n\thooksPath = ../../x\n");
		writeFileSync(join(folder, "made", ".git", "hooks", "post-checkout"), "#!/bin/sh\n");
		const notes = checkRepositories(before);
		assert.ok(!existsSync(join(git, "hooks", "pre-push")));
		assert.ok(existsSync(join(git, "hooks", "pre-push.blocked-by-yew")));
		assert.ok(existsSync(join(git, "hooks", "post-merge")), "a hook from before stays");
		assert.ok(existsSync(join(folder, "made", ".git", "hooks", "post-checkout.blocked-by-yew")));
		assert.ok(notes.some((note) => note.includes("pre-push")));
		assert.ok(
			notes.some((note) => note.includes(join(folder, "made")) && note.includes("hookspath")),
		);
		assert.equal(notes.length, 3);
		// Nothing new the second time.
		assert.deepEqual(checkRepositories(snapshotRepositories([folder])), []);
	});

	test("a repository a command names is checked after it however deep it is, and once", () => {
		const folder = join(base, "repo-named");
		const deep = join(folder, ...Array.from({ length: 10 }, (_, index) => `d${index}`), "inner");
		const near = join(folder, "near");
		for (const place of [deep, near]) mkdirSync(place, { recursive: true });
		const walked = snapshotRepositories([folder]);
		const named = snapshotRepositories([folder, deep, near]);
		// What a git init or clone with -C can leave there: a repository, here one kept elsewhere.
		for (const place of [deep, near]) writeFileSync(join(place, ".git"), "gitdir: ../kept\n");
		// The walk through the folder does not go as deep as the first.
		const missed = checkRepositories(walked);
		assert.equal(missed.length, 1);
		assert.ok(missed[0]?.includes(near));
		const notes = checkRepositories(named);
		assert.equal(notes.length, 2);
		for (const place of [deep, near]) {
			assert.ok(notes.some((note) => note.includes(`made a repository at ${place}`)));
		}
	});

	test("the data folder cannot be read; credential files and the SSH agent only when the setting allows", () => {
		assert.ok(config.filesystem.denyRead.includes(places.home));
		assert.ok(config.filesystem.denyRead.includes(join(homedir(), ".ssh")));
		assert.ok(config.credentials?.files?.some((file) => file.path === join(homedir(), ".aws")));
		assert.ok(config.credentials?.files?.every((file) => file.mode === "deny"));
		assert.deepEqual(
			config.credentials?.envVars?.map((variable) => variable.name),
			["SSH_AUTH_SOCK", "SSH_AGENT_PID"],
		);
		assert.equal(config.network.allowUnixSockets, undefined);

		const allowed = sandboxConfig(
			places,
			{ ...policy, credentials: true },
			{ platform: "darwin", agentSocket: "/tmp/agent.sock" },
		);
		assert.equal(allowed.credentials, undefined);
		// The keychain files and the folders kept from sessions stay closed with the setting on.
		const keychains = join(homedir(), "Library", "Keychains");
		assert.deepEqual(allowed.filesystem.denyRead, [
			places.home,
			...appWebData(places, "darwin"),
			keychains,
			hiddenFolder,
		]);
		assert.deepEqual(allowed.network.allowUnixSockets, ["/tmp/agent.sock"]);
		assert.ok(config.filesystem.denyRead.includes(keychains));
		assert.ok(!config.credentials?.files?.some((file) => file.path === keychains));
	});

	test("what WebKit keeps for the Mac app's window can be neither read nor changed on macOS", () => {
		const library = join(homedir(), "Library");
		const kept = [
			join(library, "HTTPStorages", "cn.tenonai.apps.yew.desktop"),
			join(library, "HTTPStorages", "cn.tenonai.apps.yew.desktop.binarycookies"),
			join(library, "WebKit", "cn.tenonai.apps.yew.desktop"),
			join(library, "Caches", "cn.tenonai.apps.yew.desktop"),
		];
		assert.deepEqual(appWebData(places, "darwin"), kept);
		const mac = commandFilesystem(places, policy, { writable: [work] }, "darwin");
		for (const path of kept) {
			assert.ok(mac.denyRead.includes(path), path);
			assert.ok(mac.denyWrite.includes(path), path);
		}
		// There is no Mac app on Linux: nothing to close.
		assert.deepEqual(appWebData(places, "linux"), []);
	});

	test("folders the person keeps from sessions can be neither read nor changed", () => {
		assert.ok(files.denyRead.includes(hiddenFolder));
		assert.ok(files.denyWrite.includes(hiddenFolder));
	});

	test("package registries and model providers with a key are reachable; Yew Harness's port and private networks are not", () => {
		const network = config.network;
		assert.ok(network.allowedDomains.includes("registry.npmjs.org"));
		assert.ok(network.allowedDomains.includes("api.deepseek.com"));
		assert.equal(network.allowedDomains.length, new Set(network.allowedDomains).size);
		assert.equal(network.allowedDomains.length, PACKAGE_SITES.length + 1);
		assert.ok(network.deniedDomains.includes("127.0.0.1:4799"));
		assert.ok(network.deniedDomains.includes("localhost:4799"));
		assert.ok(network.deniedResolvedAddresses?.includes("192.168.0.0/16"));
		assert.equal(network.allowLocalBinding, false);
		assert.equal(network.allowAllUnixSockets, false);
	});

	test("nothing that would widen it is on", () => {
		assert.equal(config.allowAppleEvents, false);
		assert.equal(config.allowPty, false);
		assert.equal(config.enableWeakerNestedSandbox, false);
		assert.equal(config.enableWeakerNetworkIsolation, false);
		assert.equal(config.allowNestedUserNamespaces, false);
	});

	test("on by default on macOS and Linux; YEW_SANDBOX turns it on or off", () => {
		assert.equal(sandboxWanted(undefined, "darwin"), true);
		assert.equal(sandboxWanted(undefined, "linux"), true);
		assert.equal(sandboxWanted(undefined, "win32"), false);
		assert.equal(sandboxWanted("off", "linux"), false);
		assert.equal(sandboxWanted("on", "win32"), true);
	});

	test("the usual tools keep their caches in the sandbox's own folder", () => {
		const env = sandboxEnvironment(places);
		for (const name of ["npm_config_cache", "PIP_CACHE_DIR", "GOMODCACHE", "XDG_CACHE_HOME"]) {
			assert.ok(env[name]?.startsWith(join(places.root, "cache")), name);
		}
	});
});

describe("a command outside the sandbox", () => {
	const engine = new PermissionEngine(places.home);
	// It runs in the guard (guard.ts), which keeps it out of Yew's data.
	engine.guarded = () => true;
	const session = (mode: string) =>
		({
			id: "s1",
			cwd: base,
			rules: [{ effect: "allow", tool: "shell" }],
			options: { permissionMode: mode },
		}) as unknown as Session;
	const outside = { kind: "command" as const, tool: "shell", command: "ls", outsideSandbox: true };

	test("is asked about every time in the default mode, and cannot be remembered", () => {
		const decision = engine.decide(outside, session("default"));
		assert.equal(decision.effect, "ask");
		if (decision.effect !== "ask") return;
		assert.equal(decision.request.mustConfirm, true);
		assert.ok(decision.request.reasons?.includes("outside-sandbox"));
		assert.equal(decision.request.rememberRules, undefined);
	});

	test("is a permission: skip mode runs it and marks it, the automatic mode leaves it to the check", () => {
		assert.deepEqual(engine.decide(outside, session("skip")), {
			effect: "allow",
			note: { risk: ["outside-sandbox"] },
		});
		const reviewed = engine.decide(outside, session("review"));
		assert.ok(reviewed.effect === "ask" && reviewed.review);
	});

	test("without the guard it is asked about in every mode, since nothing else keeps it from Yew's data", () => {
		const unguarded = new PermissionEngine(places.home);
		for (const mode of ["default", "review", "skip"]) {
			const decision = unguarded.decide(outside, session(mode));
			assert.ok(decision.effect === "ask" && !decision.review, mode);
		}
	});
});

// Everyday work runs in the sandbox where this computer has one (macOS; Linux with bubblewrap).
const started =
	process.platform === "darwin" || process.platform === "linux"
		? await startSandbox(places, () => policy)
		: { kind: "none" as const, problems: [`${process.platform} has no sandbox`] };
after(() => stopSandbox());
const skip = started.kind === "none" ? `no sandbox here: ${started.problems.join("; ")}` : false;

/** Runs a command in the sandbox in `cwd`; resolves with its exit code and output. */
async function run(
	command: string,
	cwd: string,
	ask?: (question: SiteQuestion) => Promise<boolean>,
): Promise<{ code: number | null; output: string }> {
	const running = await startCommand({
		command,
		cwd,
		sessionId: "s1",
		logDir: join(base, "logs"),
		...(ask ? { ask } : {}),
	});
	const { exitCode } = await running.done;
	return { code: exitCode, output: running.output.render() };
}

const folder = (name: string) => {
	const path = join(base, name);
	mkdirSync(path, { recursive: true });
	return path;
};

describe("everyday work in the sandbox", { skip }, () => {
	test("it is the sandbox commands run in", () => {
		assert.equal(activeSandbox(), process.platform === "darwin" ? "macos" : "linux");
	});

	test("git: status, add, commit and log in a repository", async () => {
		const repo = folder("git");
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
		const result = await run(
			[
				"echo hello > note.txt",
				"git status --short",
				"git add note.txt",
				"git -c user.name=Yew -c user.email=yew@example.com commit -q -m 'First note'",
				"git log --oneline",
			].join(" && "),
			repo,
		);
		assert.equal(result.code, 0, result.output);
		assert.match(result.output, /\?\? note\.txt/);
		assert.match(result.output, /First note/);
	});

	test("the roles folder: Yew Harness's own git commits its changes from inside the sandbox", async () => {
		const repo = folder("roles");
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
		execFileSync("git", ["config", "user.name", "Yew"], { cwd: repo });
		execFileSync("git", ["config", "user.email", "yew@example.com"], { cwd: repo });
		const { store } = newStore();
		const roles = join(repo, "docs", "roles");
		store.setSetting("rolesFolder", roles);
		store.setSetting("language", "en");
		const session = store.createSession({
			...sessionInput("总办"),
			responsibility: "Runs the office.",
		});
		const files = new RoleFiles({ store, watch: false });
		assert.deepEqual(await files.sync(), {
			folder: roles,
			files: 1,
			commits: "on",
			problem: null,
		});
		store.updateSession(session.id, { responsibility: "Runs the office and the mail." });
		assert.equal((await files.sync()).problem, null);
		const log = execFileSync("git", ["log", "--format=%s"], { cwd: repo, encoding: "utf8" });
		assert.deepEqual(log.trim().split("\n"), [
			'Update the role of "总办"',
			"Update the role files (2 changes)",
		]);
		assert.equal(
			execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }),
			"",
		);
	});

	test("npm: install a local package and run a script", async () => {
		const project = folder("npm");
		mkdirSync(join(project, "greeting"));
		writeFileSync(
			join(project, "greeting", "package.json"),
			JSON.stringify({ name: "greeting", version: "1.0.0", main: "index.js" }),
		);
		writeFileSync(join(project, "greeting", "index.js"), "module.exports = 'hello';\n");
		writeFileSync(
			join(project, "package.json"),
			JSON.stringify({
				name: "project",
				version: "1.0.0",
				private: true,
				dependencies: { greeting: "file:./greeting" },
				scripts: { hello: `node -e "console.log(require('greeting'))"` },
			}),
		);
		const result = await run(
			"npm install --offline --no-audit --no-fund --loglevel=error && npm run --silent hello",
			project,
		);
		assert.equal(result.code, 0, result.output);
		assert.match(result.output, /hello/);
		assert.ok(existsSync(join(project, "package-lock.json")));
		assert.ok(existsSync(join(project, "node_modules", "greeting")));
	});

	test("build: TypeScript compiles into the working folder", async () => {
		const project = folder("build");
		writeFileSync(join(project, "index.ts"), "export const answer: number = 42;\n");
		const tsc = join(INSTALL_DIR, "node_modules", "typescript", "bin", "tsc");
		const result = await run(`node ${tsc} --outDir dist index.ts`, project);
		assert.equal(result.code, 0, result.output);
		assert.match(readFileSync(join(project, "dist", "index.js"), "utf8"), /answer = 42/);
	});

	test("temporary files: mktemp and node's temporary folder", async () => {
		const result = await run(
			`f=$(mktemp) && echo one > "$f" && cat "$f" && node -e "const p=require('path').join(require('os').tmpdir(),'yew-sandbox-test');require('fs').writeFileSync(p,'two');console.log(require('fs').readFileSync(p,'utf8'))"`,
			folder("temp"),
		);
		assert.equal(result.code, 0, result.output);
		assert.match(result.output, /one\ntwo/);
	});

	test("a site that is not on the list is put to the person, and stays closed when they decline", async () => {
		const asked: string[] = [];
		const result = await run(
			"curl -sS https://unlisted.example.invalid/",
			folder("ask"),
			async (question) => {
				asked.push(`${question.host}:${question.port}${question.unsure ? " unsure" : ""}`);
				return false;
			},
		);
		assert.deepEqual(asked, ["unlisted.example.invalid:443"]);
		assert.notEqual(result.code, 0);
		assert.match(result.output, /did not allow unlisted\.example\.invalid/);
	});

	test("while something else runs in it, the question says so and lists it, and a yes is for one connection", async () => {
		const cwd = folder("unsure");
		const job: RunningCommand = await startCommand({
			command: "sleep 20",
			cwd,
			sessionId: "s1",
			logDir: join(base, "logs"),
			background: true,
		});
		try {
			const asked: SiteQuestion[] = [];
			const command =
				"curl -sS https://twice.example.invalid/; curl -sS https://twice.example.invalid/";
			await run(command, cwd, async (question) => {
				asked.push(question);
				return true;
			});
			// Asked for each connection: a yes did not carry over to the next one.
			assert.equal(asked.length, 2);
			assert.deepEqual(asked[0]?.unsure, [
				{ kind: "command", text: command },
				{ kind: "job", text: "sleep 20" },
			]);
		} finally {
			job.stop();
			await job.done;
		}
	});

	test("the hooks and settings of a repository further down the working folder stay as they are", async () => {
		const cwd = folder("nested");
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
		const inner = join(cwd, "packages", "inner");
		mkdirSync(inner, { recursive: true });
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: inner });
		const config = readFileSync(join(inner, ".git", "config"), "utf8");
		const result = await run(
			"echo 'echo hi' > packages/inner/.git/hooks/pre-commit; printf '[core]\\n\\thooksPath = /tmp\\n' >> packages/inner/.git/config; true",
			cwd,
		);
		assert.equal(result.code, 0, result.output);
		assert.equal(readFileSync(join(inner, ".git", "config"), "utf8"), config);
		assert.ok(!existsSync(join(inner, ".git", "hooks", "pre-commit")));
	});

	test("a folder the person keeps from sessions cannot be read", async () => {
		const result = await run(`cat ${hiddenFolder}/keys.txt`, folder("kept-read"));
		assert.notEqual(result.code, 0);
		assert.doesNotMatch(result.output, /secret/);
	});

	test("a preset MCP server runs in it from its own folder in the data folder", async () => {
		const yewHome = folder("preset-home");
		// Where Yew installs the Gitee server; a stand-in that answers like one.
		const program = join(
			yewHome,
			"mcp-presets",
			"gitee",
			"node_modules",
			"@gitee",
			"mcp-gitee",
			"bin",
		);
		mkdirSync(program, { recursive: true });
		const server = fileURLToPath(new URL("./helpers/mcp-server.mjs", import.meta.url));
		writeFileSync(join(program, "index.js"), readFileSync(server, "utf8"));
		writeFileSync(join(program, "package.json"), JSON.stringify({ type: "module" }));
		writeFileSync(
			join(yewHome, "mcp.json"),
			JSON.stringify({ mcpServers: { gitee: { preset: "gitee" } } }),
		);
		const hub = new McpHub({ yewHome, version: "0.0.0", log: () => {} });
		try {
			await hub.refresh();
			const status = hub.status().find((entry) => entry.name === "gitee");
			assert.equal(status?.state, "ready", status?.error ?? "");
			assert.ok(hub.tools().some((tool) => tool.name === "mcp__gitee__echo"));
		} finally {
			hub.stop();
		}
	});

	test("a stdio MCP server someone added runs in it and its tools work", async () => {
		const yewHome = folder("mcp-home");
		const server = fileURLToPath(new URL("./helpers/mcp-server.mjs", import.meta.url));
		writeFileSync(
			join(yewHome, "mcp.json"),
			JSON.stringify({ mcpServers: { test: { command: "node", args: [server] } } }),
		);
		const hub = new McpHub({ yewHome, version: "0.0.0", log: () => {} });
		try {
			await hub.refresh();
			assert.equal(hub.status().find((status) => status.name === "test")?.state, "ready");
			const echo = hub.tools().find((tool) => tool.name === "mcp__test__echo");
			assert.ok(echo);
			const ctx = { signal: new AbortController().signal, acceptsImages: false } as Parameters<
				typeof echo.run
			>[1];
			const result = await echo.run({ text: "hi" }, ctx);
			assert.match(JSON.stringify(result.content), /hi/);
		} finally {
			hub.stop();
		}
	});
});
