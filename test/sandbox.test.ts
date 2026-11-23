import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { McpHub } from "../src/server/mcp.ts";
import { PermissionEngine } from "../src/server/permissions/engine.ts";
import {
	admitRepository,
	checkRepositories,
	closedPaths,
	gitInternals,
	noteRepositories,
	settleRepositories,
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
 * trying to get out is tested separately, with probes of its own; the two ways to leave git a
 * program to run that were found there are kept here, so they stay closed.
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
		// The copy installed from a checkout, with what is beside it in its folder.
		assert.ok(denied.includes(join(homedir(), ".yew-install")));
		assert.ok(denied.includes(join(homedir(), "Library", "LaunchAgents")));
		assert.ok(denied.includes(join(homedir(), "Applications", "Yew.app")));
		assert.ok(denied.includes(join(homedir(), ".config", "systemd", "user")));
		// The hooks and settings of submodules and worktrees under the working folder.
		for (const pattern of gitInternals(work, "darwin")) assert.ok(denied.includes(pattern));
		assert.equal(files.allowGitConfig, false);
	});

	test("on macOS a repository's hooks, settings and the files that send git elsewhere are covered by patterns, in any case", () => {
		const patterns = gitInternals("/w", "darwin");
		assert.ok(patterns.includes("/w/.git/**/[hH][oO][oO][kK][sS]"));
		assert.ok(patterns.includes("/w/**/.git/**/[cC][oO][nN][fF][iI][gG]"));
		assert.ok(patterns.includes("/w/.git/**/[cC][oO][mM][mM][oO][nN][dD][iI][rR]"));
		assert.ok(patterns.includes("/w/**/.git/**/[gG][iI][tT][dD][iI][rR]"));
		// bubblewrap takes no patterns: there the paths that exist are listed.
		assert.deepEqual(gitInternals("/w", "linux"), []);
	});

	test("what is closed by name has its characters taken as they are", () => {
		const odd = join(work, "app", "[id]", ".git");
		const closed = commandFilesystem(places, policy, { writable: [work] }, "linux", [
			odd,
		]).denyWrite;
		assert.ok(closed.some((entry) => typeof entry !== "string" && entry.path === odd));
	});

	test("after an approved repository setup, a hook it added or changed is moved aside, and what it made is said", () => {
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

/** A git folder as git lays one out, without running git: enough for git to take it for one. */
const layOut = (git: string, parts: { hooks?: boolean; config?: boolean } = {}) => {
	mkdirSync(join(git, "objects"), { recursive: true });
	mkdirSync(join(git, "refs"));
	writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
	if (parts.hooks !== false) mkdirSync(join(git, "hooks"));
	if (parts.config !== false) writeFileSync(join(git, "config"), "[core]\n\tbare = false\n");
};
const ASIDE = ".blocked-by-yew";

describe("the repositories in a command's folders", () => {
	test("before a command, the hooks and settings that are there and the .git files are listed to close", async () => {
		const repo = folder("repo-closed");
		// The working folder's own repository, with a submodule and a worktree.
		layOut(join(repo, ".git"));
		layOut(join(repo, ".git", "modules", "lib"));
		const other = join(repo, ".git", "worktrees", "other");
		mkdirSync(other, { recursive: true });
		writeFileSync(join(other, "HEAD"), "ref: refs/heads/other\n");
		writeFileSync(join(other, "commondir"), "../..\n");
		writeFileSync(join(other, "gitdir"), "/elsewhere/other/.git\n");
		writeFileSync(join(other, "config.worktree"), "");
		// A repository further down, a submodule's checkout (its .git a file) and one in dependencies.
		layOut(join(repo, "tools", "inner", ".git"));
		mkdirSync(join(repo, "lib"));
		writeFileSync(join(repo, "lib", ".git"), "gitdir: ../.git/modules/lib\n");
		layOut(join(repo, "node_modules", "dep", ".git"));
		// A bare repository, and a repository whose git folder is kept beside it.
		layOut(join(repo, "store.git"));
		layOut(join(repo, "kept", "git"), { hooks: false });
		mkdirSync(join(repo, "apart"));
		writeFileSync(join(repo, "apart", ".git"), "gitdir: ../kept/git\n");
		const before = await noteRepositories([repo]);
		assert.deepEqual([...before.closed].sort(), [
			join(repo, ".git", "config"),
			join(repo, ".git", "hooks"),
			join(repo, ".git", "modules", "lib", "config"),
			join(repo, ".git", "modules", "lib", "hooks"),
			join(other, "commondir"),
			join(other, "config.worktree"),
			join(other, "gitdir"),
			join(repo, "apart", ".git"),
			join(repo, "kept", "git", "config"),
			join(repo, "lib", ".git"),
			join(repo, "node_modules", "dep", ".git", "config"),
			join(repo, "node_modules", "dep", ".git", "hooks"),
			join(repo, "store.git", "config"),
			join(repo, "store.git", "hooks"),
			join(repo, "tools", "inner", ".git", "config"),
			join(repo, "tools", "inner", ".git", "hooks"),
		]);
		assert.deepEqual(closedPaths(before, "linux"), before.closed);
		// On macOS the patterns close what is inside a .git: one path in each such git folder holds
		// it in place. What no pattern covers is closed by name.
		assert.deepEqual(closedPaths(before, "darwin").sort(), [
			join(repo, ".git", "hooks"),
			join(repo, ".git", "modules", "lib", "hooks"),
			join(other, "config.worktree"),
			join(repo, "apart", ".git"),
			join(repo, "kept", "git", "config"),
			join(repo, "lib", ".git"),
			join(repo, "node_modules", "dep", ".git", "hooks"),
			join(repo, "store.git", "config"),
			join(repo, "store.git", "hooks"),
			join(repo, "tools", "inner", ".git", "hooks"),
		]);
		// Only so many git folders are held in place; what no pattern covers stays closed.
		assert.deepEqual(closedPaths(before, "darwin", 1).sort(), [
			join(repo, ".git", "hooks"),
			join(repo, "apart", ".git"),
			join(repo, "kept", "git", "config"),
			join(repo, "lib", ".git"),
			join(repo, "store.git", "config"),
			join(repo, "store.git", "hooks"),
		]);
		// Nothing changed, so nothing is moved.
		assert.deepEqual(await settleRepositories(before), []);
	});

	test("a .git a command made is moved aside: a file that points elsewhere, a folder, a folder moved into place", async () => {
		const work = folder("left-made");
		layOut(join(work, ".git"));
		const before = await noteRepositories([work]);
		layOut(join(work, "tools", "g"));
		mkdirSync(join(work, "sub"));
		writeFileSync(join(work, "sub", ".git"), "gitdir: ../tools/g\n");
		layOut(join(work, "made", ".git"));
		layOut(join(work, "prepared"));
		mkdirSync(join(work, "moved"));
		renameSync(join(work, "prepared"), join(work, "moved", ".git"));
		const notes = await settleRepositories(before);
		for (const place of ["sub", "made", "moved"]) {
			assert.ok(!existsSync(join(work, place, ".git")), place);
			assert.ok(existsSync(join(work, place, `.git${ASIDE}`)), place);
			assert.ok(notes.some((note) => note.includes(`appeared at ${join(work, place)} `)));
		}
		// The folder laid out as a git folder is one no longer: git takes none without a HEAD.
		assert.ok(!existsSync(join(work, "tools", "g", "HEAD")));
		assert.ok(existsSync(join(work, "tools", "g", `HEAD${ASIDE}`)));
		// One line each, and one that says how such things are made.
		assert.equal(notes.length, 5);
		assert.match(notes.at(-1) ?? "", /outside_sandbox/);
		assert.ok(existsSync(join(work, ".git", "HEAD")), "the repository that was there stays");
		// What was moved aside is not there before the next command: put back, it is moved again.
		const again = await noteRepositories([work]);
		assert.deepEqual(await settleRepositories(again), []);
		renameSync(join(work, "made", `.git${ASIDE}`), join(work, "made", ".git"));
		renameSync(join(work, "tools", "g", `HEAD${ASIDE}`), join(work, "tools", "g", "HEAD"));
		assert.equal((await settleRepositories(again)).length, 3);
		assert.ok(!existsSync(join(work, "made", ".git")));
		assert.ok(!existsSync(join(work, "tools", "g", "HEAD")));
	});

	test("a repository that was there stays wherever it is moved; what is put in its place is moved aside", async () => {
		const work = folder("left-replaced");
		layOut(join(work, ".git"));
		layOut(join(work, "packages", "inner", ".git"));
		const before = await noteRepositories([work]);
		renameSync(join(work, "packages", "inner"), join(work, "packages", "old"));
		layOut(join(work, "packages", "inner", ".git"));
		const notes = await settleRepositories(before);
		assert.equal(notes.length, 2);
		assert.ok(existsSync(join(work, "packages", "old", ".git", "HEAD")));
		assert.ok(!existsSync(join(work, "packages", "inner", ".git")));
		assert.ok(existsSync(join(work, "packages", "inner", `.git${ASIDE}`)));
	});

	test("hooks, settings or a commondir that appear in a repository are moved aside, a link as it is", async () => {
		const work = folder("left-parts");
		layOut(join(work, ".git"), { hooks: false });
		layOut(join(work, "other", ".git"), { hooks: false });
		const elsewhere = join(work, "elsewhere");
		mkdirSync(elsewhere);
		writeFileSync(join(elsewhere, "pre-commit"), "#!/bin/sh\n", { mode: 0o755 });
		const before = await noteRepositories([work]);
		mkdirSync(join(work, ".git", "hooks"));
		writeFileSync(join(work, ".git", "hooks", "pre-commit"), "#!/bin/sh\n");
		writeFileSync(join(work, ".git", "commondir"), "../elsewhere\n");
		symlinkSync(elsewhere, join(work, "other", ".git", "hooks"));
		const notes = await settleRepositories(before);
		assert.equal(notes.length, 3);
		assert.ok(!existsSync(join(work, ".git", "hooks")));
		assert.ok(existsSync(join(work, ".git", `hooks${ASIDE}`, "pre-commit")));
		assert.ok(!existsSync(join(work, ".git", "commondir")));
		assert.ok(existsSync(join(work, ".git", "config")), "the settings that were there stay");
		// The link is moved, and nothing it points to is touched.
		assert.ok(lstatSync(join(work, "other", ".git", `hooks${ASIDE}`)).isSymbolicLink());
		assert.equal(lstatSync(join(elsewhere, "pre-commit")).mode & 0o777, 0o755);
	});

	test("a submodule's git folder moved into a repository, and a folder dressed as a git folder, lose their HEAD", async () => {
		const work = folder("left-inside");
		layOut(join(work, ".git"));
		layOut(join(work, ".git", "modules", "lib"));
		mkdirSync(join(work, "lib"));
		writeFileSync(join(work, "lib", ".git"), "gitdir: ../.git/modules/lib\n");
		mkdirSync(join(work, "src", "deep"), { recursive: true });
		const before = await noteRepositories([work]);
		layOut(join(work, "prepared"));
		renameSync(join(work, "prepared"), join(work, ".git", "modules", "planted"));
		layOut(join(work, "src"));
		// Dressing a folder up does not hide what is put further down in it.
		writeFileSync(join(work, "src", "deep", ".git"), "gitdir: ../../src\n");
		const notes = await settleRepositories(before);
		assert.equal(notes.length, 4);
		assert.ok(existsSync(join(work, ".git", "modules", "planted", `HEAD${ASIDE}`)));
		assert.ok(existsSync(join(work, "src", `HEAD${ASIDE}`)));
		assert.ok(existsSync(join(work, "src", "deep", `.git${ASIDE}`)));
		assert.ok(existsSync(join(work, ".git", "modules", "lib", "HEAD")));
		assert.ok(existsSync(join(work, "lib", ".git")));
	});

	test("a .git file is followed the way git follows it, or not at all", async () => {
		const work = folder("left-files");
		layOut(join(work, ".git"));
		mkdirSync(join(work, "dangling"));
		writeFileSync(join(work, "dangling", ".git"), "gitdir: ../nowhere\n");
		mkdirSync(join(work, "node_modules", "deep"), { recursive: true });
		const before = await noteRepositories([work]);
		assert.deepEqual(await settleRepositories(before), [], "one that led nowhere stays as it is");
		// Text that reads as the repository that was there, and that git takes elsewhere: cut short
		// at a NUL, or through a link, where `..` is not the folder the text names.
		layOut(join(work, "prepared"));
		layOut(join(work, "node_modules", ".git"));
		symlinkSync(join(work, "node_modules", "deep"), join(work, "link"));
		for (const [name, text] of [
			["cut", `gitdir: ${work}/prepared\0/../.git\n`],
			["linked", `gitdir: ${work}/link/../.git\n`],
			["long", `gitdir: ${work}/.git/${"./".repeat(5000)}../prepared\n`],
		] as const) {
			mkdirSync(join(work, name));
			writeFileSync(join(work, name, ".git"), text);
		}
		// And the one that led nowhere now leads somewhere.
		layOut(join(work, "nowhere"));
		await settleRepositories(before);
		for (const name of ["cut", "linked", "long", "dangling", "node_modules"]) {
			assert.ok(!existsSync(join(work, name, ".git")), name);
			assert.ok(existsSync(join(work, name, `.git${ASIDE}`)), name);
		}
	});

	test("what the limits kept from being read is left alone, and a repository an approved setup made stays", async () => {
		const work = folder("left-limits");
		layOut(join(work, "far", ".git"));
		const before = await noteRepositories([work], { folders: 1, ms: 1000, fresh: 100 });
		assert.ok(before.beyond.has(join(work, "far")));
		layOut(join(work, ".git"));
		const limited = await settleRepositories(before);
		assert.equal(limited.length, 3);
		// What was not looked through is said after the command.
		const unseen = limited.at(-1) ?? "";
		assert.match(unseen, /1 were not looked through for repositories, such as .*far\./);
		assert.ok(existsSync(join(work, `.git${ASIDE}`)));
		assert.ok(existsSync(join(work, "far", ".git", "HEAD")));
		// A git init or clone the person approved while the command ran.
		layOut(join(work, "cloned", ".git"));
		layOut(join(work, "mirror.git"));
		admitRepository(before, join(work, "cloned"));
		admitRepository(before, join(work, "mirror.git"));
		assert.deepEqual(await settleRepositories(before), [unseen]);
		assert.ok(existsSync(join(work, "cloned", ".git", "HEAD")));
		assert.ok(existsSync(join(work, "mirror.git", "HEAD")));
	});
});

/** git as the person runs it outside the sandbox, without their own settings. */
const personGit = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=Yew", "-c", "user.email=yew@example.com", ...args], {
		cwd,
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
		stdio: "pipe",
	});

describe("a command in the sandbox leaves git no program to run", { skip }, () => {
	/** A repository with one commit, and the steps that put a hook where git will find it. */
	const planted = (name: string, how: "commondir" | "git-file") => {
		const repo = folder(name);
		personGit(repo, "init", "-q", "-b", "main");
		personGit(repo, "commit", "-q", "--allow-empty", "-m", "First");
		const marker = join(base, `${name}-ran`);
		const steps = [
			"mkdir -p .cache/g/hooks sub",
			"cp -R .git/objects .git/refs .git/HEAD .cache/g/",
			`printf '#!/bin/sh\\ntouch %s\\n' '${marker}' > .cache/g/hooks/pre-commit`,
			"chmod +x .cache/g/hooks/pre-commit",
			how === "commondir"
				? `printf '%s\\n' "$PWD/.cache/g" > .git/commondir`
				: "printf 'gitdir: ../.cache/g\\n' > sub/.git",
			"true",
		].join("; ");
		const commit = () =>
			personGit(
				how === "commondir" ? repo : join(repo, "sub"),
				"commit",
				"-q",
				"--allow-empty",
				"-m",
				"Next",
			);
		return { repo, marker, steps, commit };
	};

	for (const how of ["commondir", "git-file"] as const) {
		const what =
			how === "commondir"
				? "a commondir that sends the repository to hooks of the command's making"
				: "a .git file in a subfolder that points to a git folder of the command's making";
		test(`${what}: the person's commit does not run them`, async () => {
			// The same steps outside the sandbox do run the hook: this is a way that works.
			const open = planted(`plant-open-${how}`, how);
			execFileSync("sh", ["-c", open.steps], { cwd: open.repo });
			open.commit();
			assert.ok(existsSync(open.marker), "outside the sandbox the hook runs");

			const closed = planted(`plant-closed-${how}`, how);
			const result = await run(closed.steps, closed.repo);
			assert.equal(result.code, 0, result.output);
			closed.commit();
			assert.ok(!existsSync(closed.marker), result.output);
			assert.ok(!existsSync(join(closed.repo, ".git", "commondir")));
			assert.ok(!existsSync(join(closed.repo, "sub", ".git")));
			if (how === "git-file") {
				assert.ok(existsSync(join(closed.repo, "sub", `.git${ASIDE}`)));
				assert.match(result.output, /A repository appeared at .*sub while the command ran/);
			}
		});
	}
});

describe("everyday work in the sandbox", { skip }, () => {
	test("it is the sandbox commands run in", () => {
		assert.equal(activeSandbox(), process.platform === "darwin" ? "macos" : "linux");
	});

	// On Linux the command has its own process ids, which end with it.
	const leftover = process.platform === "darwin" ? false : "process ids differ inside the sandbox";
	test("what a command left running in the background ends with it", {
		skip: leftover,
	}, async () => {
		const result = await run("sleep 60 > /dev/null 2>&1 & echo $!", folder("leftover"));
		assert.equal(result.code, 0, result.output);
		const pid = Number(/^(\d+)$/m.exec(result.output)?.[1]);
		assert.ok(pid > 0, result.output);
		assert.throws(() => process.kill(pid, 0), /ESRCH/);
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
