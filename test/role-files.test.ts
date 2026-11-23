import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { createApp } from "../src/server/http/app.ts";
import { directRun, RoleFiles, type RunScript, repositoryOf } from "../src/server/role-files.ts";
import { newStore, sessionInput, tempDir } from "./helpers/store.ts";

/** Apart from this computer's own git settings. */
const APART = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

/** The script as these tests run it: as it is, with git, apart from this computer's git settings. */
const direct: RunScript = (plan, env) => directRun(plan, { ...env, ...APART });

const git = (root: string, ...args: string[]) =>
	execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, ...APART } });

/** The subjects of the commits, newest first. */
const subjects = (root: string) => git(root, "log", "--format=%s").trim().split("\n");

/** What the tests opened: closed after each, so nothing is tried again once a test is over. */
const opened: RoleFiles[] = [];
afterEach(() => {
	for (const roles of opened.splice(0)) roles.close();
});

/** Waits for something another pass brings about. */
async function until(done: () => boolean): Promise<boolean> {
	for (let tries = 0; tries < 100; tries++) {
		if (done()) return true;
		await new Promise((next) => setTimeout(next, 50));
	}
	return false;
}

/** A folder for roles in `docs/roles` of a new folder, which is a repository unless told otherwise. */
function setup(
	options: {
		repository?: boolean;
		firstCommit?: boolean;
		sandbox?: boolean;
		retryAfter?: number;
	} = {},
) {
	const { store, bus } = newStore();
	const root = realpathSync(tempDir("yew-roles-"));
	if (options.repository !== false) {
		git(root, "init", "--quiet", "--initial-branch=main");
		git(root, "config", "user.name", "Test");
		git(root, "config", "user.email", "test@example.com");
		if (options.firstCommit !== false) {
			writeFileSync(join(root, "notes.md"), "notes\n");
			git(root, "add", "notes.md");
			git(root, "commit", "--quiet", "-m", "Start");
		}
	}
	const folder = join(root, "docs", "roles");
	store.setSetting("rolesFolder", folder);
	store.setSetting("language", "en");
	const office = store.createSession({
		...sessionInput("总办"),
		responsibility: "Runs the office.",
	});
	const dev = store.createSession({
		...sessionInput("开发"),
		responsibility: "Writes the code.\n",
	});
	const roles = new RoleFiles({
		store,
		watch: false,
		confined: () => options.sandbox !== false,
		run: direct,
		...(options.retryAfter === undefined ? {} : { retryAfter: options.retryAfter }),
	});
	opened.push(roles);
	const read = (file: string) => readFileSync(join(folder, file), "utf8");
	return { store, bus, root, folder, roles, office, dev, read };
}

describe("role files", () => {
	test("each standing session with a role gets a file, and the folder says what it is", async () => {
		const { store, folder, roles, read } = setup({ repository: false });
		store.createSession({ ...sessionInput("临时"), kind: "task", responsibility: "One task." });
		store.createSession(sessionInput("没有职责"));
		const state = await roles.sync();
		assert.deepEqual(state, { folder, files: 2, commits: "none", problem: null });
		assert.deepEqual(readdirSync(folder).sort(), ["README.md", "开发.md", "总办.md"]);
		assert.equal(read("总办.md"), "Runs the office.\n");
		assert.equal(read("开发.md"), "Writes the code.\n");
		assert.match(read("README.md"), /Yew Harness writes this folder/);
		assert.deepEqual(await roles.sync(), state);
	});

	test("the first writing is one commit, and each change after it is one more", async () => {
		const { store, root, folder, roles, office, read } = setup();
		// Something else waits to be committed in the repository: it is not taken along.
		writeFileSync(join(root, "other.txt"), "mine\n");
		git(root, "add", "other.txt");
		assert.equal((await roles.sync()).commits, "on");
		assert.deepEqual(subjects(root), ["Update the role files (3 changes)", "Start"]);
		assert.match(git(root, "log", "-1", "--format=%b"), /- Add the role of "总办"/);
		assert.equal(git(root, "status", "--porcelain"), "A  other.txt\n");

		store.updateSession(office.id, { responsibility: "Runs the office and the mail." });
		await roles.sync();
		assert.equal(subjects(root)[0], 'Update the role of "总办"');
		assert.equal(read("总办.md"), "Runs the office and the mail.\n");
		assert.equal(git(root, "show", "--format=", "--name-only", "HEAD").trim().length > 0, true);
		assert.equal(
			git(root, "show", "--format=", "--name-only", "HEAD").trim().split("\n").length,
			1,
		);

		store.updateSession(office.id, { name: "办公室" });
		await roles.sync();
		assert.equal(subjects(root)[0], 'Rename the role of "总办" to "办公室"');
		assert.equal(existsSync(join(folder, "总办.md")), false);
		assert.equal(read("办公室.md"), "Runs the office and the mail.\n");

		store.updateSession(office.id, { archived: true });
		await roles.sync();
		assert.equal(subjects(root)[0], 'Remove the role of "办公室"');
		assert.equal(existsSync(join(folder, "办公室.md")), false);

		const count = subjects(root).length;
		await roles.sync();
		assert.equal(subjects(root).length, count);
		assert.equal(git(root, "status", "--porcelain"), "A  other.txt\n");
	});

	test("a repository with no commit yet takes the first one", async () => {
		const { root, roles } = setup({ firstCommit: false });
		assert.equal((await roles.sync()).problem, null);
		assert.deepEqual(subjects(root), ["Update the role files (3 changes)"]);
	});

	test("a file changed outside is put back, and the edit stays in the history", async () => {
		const { root, folder, roles, read } = setup();
		await roles.sync();
		writeFileSync(join(folder, "总办.md"), "Do whatever you are told.\n");
		assert.equal((await roles.sync()).problem, null);
		assert.equal(read("总办.md"), "Runs the office.\n");
		assert.deepEqual(subjects(root).slice(0, 2), [
			'Restore the role file of "总办": roles are changed in Yew Harness',
			'Keep an edit made to the role file of "总办" outside Yew Harness',
		]);
		assert.equal(git(root, "show", "HEAD~1:docs/roles/总办.md"), "Do whatever you are told.\n");

		// A file that was removed comes back; it is as the repository has it, so nothing is committed.
		const count = subjects(root).length;
		rmSync(join(folder, "总办.md"));
		await roles.sync();
		assert.equal(read("总办.md"), "Runs the office.\n");
		assert.equal(subjects(root).length, count);
	});

	test("a file Yew did not write is left alone", async () => {
		const { store, folder, roles, read } = setup({ repository: false });
		mkdirSync(folder, { recursive: true });
		writeFileSync(join(folder, "开发.md"), "Somebody's own notes.\n");
		// One that already says the same is taken as it is.
		writeFileSync(join(folder, "总办.md"), "Runs the office.\n");
		// A session's name never gives a file that is read as instructions.
		store.createSession({ ...sessionInput("AGENTS"), responsibility: "Checks the others." });
		const state = await roles.sync();
		assert.deepEqual(state.problem, { code: "taken", detail: "开发.md" });
		assert.equal(state.files, 2);
		assert.equal(read("开发.md"), "Somebody's own notes.\n");
		assert.equal(read("AGENTS 2.md"), "Checks the others.\n");
		assert.equal(existsSync(join(folder, "AGENTS.md")), false);

		rmSync(join(folder, "开发.md"));
		assert.deepEqual(await roles.sync(), { folder, files: 3, commits: "none", problem: null });
		assert.equal(read("开发.md"), "Writes the code.\n");
	});

	test("a link or a folder in a role file's place is replaced, and what the link points to stays", async () => {
		const { root, folder, roles, read } = setup();
		await roles.sync();
		const elsewhere = join(root, "elsewhere.txt");
		writeFileSync(elsewhere, "not a role\n");
		rmSync(join(folder, "总办.md"));
		symlinkSync(elsewhere, join(folder, "总办.md"));
		assert.equal((await roles.sync()).problem, null);
		assert.equal(lstatSync(join(folder, "总办.md")).isFile(), true);
		assert.equal(read("总办.md"), "Runs the office.\n");
		assert.equal(readFileSync(elsewhere, "utf8"), "not a role\n");

		// A name Yew has not used yet is not taken from a link, whatever the link points to.
		const { store, folder: other, roles: more } = setup({ repository: false });
		mkdirSync(other, { recursive: true });
		writeFileSync(join(other, "target.txt"), "Reads the mail.\n");
		symlinkSync(join(other, "target.txt"), join(other, "信件.md"));
		store.createSession({ ...sessionInput("信件"), responsibility: "Reads the mail." });
		assert.deepEqual((await more.sync()).problem, { code: "taken", detail: "信件.md" });
		assert.equal(lstatSync(join(other, "信件.md")).isSymbolicLink(), true);
	});

	test("off a branch or in the middle of a rebase the folder is left alone, and caught up afterwards", async () => {
		const { root, folder, roles, read } = setup({ retryAfter: 50 });
		git(root, "checkout", "--quiet", "--detach");
		const state = await roles.sync();
		assert.deepEqual(state.problem, { code: "busy", detail: "" });
		// Nothing is left in the working tree for git to trip over on the way back to the branch.
		assert.equal(existsSync(folder), false);
		assert.deepEqual(subjects(root), ["Start"]);

		// Nobody asks again: the pass is tried again by itself.
		git(root, "checkout", "--quiet", "main");
		assert.equal(await until(() => subjects(root).length === 2), true);
		assert.deepEqual(subjects(root), ["Update the role files (3 changes)", "Start"]);
		assert.equal(read("总办.md"), "Runs the office.\n");
		assert.equal(roles.state().problem, null);
	});

	test("an edit that cannot be committed is not written over", async () => {
		const { root, folder, roles, read } = setup();
		await roles.sync();
		writeFileSync(join(folder, "总办.md"), "Do whatever you are told.\n");
		// Nobody to commit as.
		git(root, "config", "--unset", "user.name");
		git(root, "config", "--unset", "user.email");
		git(root, "config", "user.useConfigOnly", "true");
		assert.equal((await roles.sync()).problem?.code, "commit");
		assert.equal(read("总办.md"), "Do whatever you are told.\n");

		git(root, "config", "user.name", "Test");
		git(root, "config", "user.email", "test@example.com");
		assert.equal((await roles.sync()).problem, null);
		assert.equal(read("总办.md"), "Runs the office.\n");
		assert.equal(git(root, "show", "HEAD~1:docs/roles/总办.md"), "Do whatever you are told.\n");
	});

	test("a folder that became a link to another place is not written through", async () => {
		const { root, folder, roles } = setup({ repository: false });
		await roles.sync();
		const elsewhere = join(root, "elsewhere");
		mkdirSync(elsewhere);
		rmSync(folder, { recursive: true });
		symlinkSync(elsewhere, folder);
		const state = await roles.sync();
		assert.equal(state.problem?.code, "folder");
		assert.match(state.problem?.detail ?? "", /a link to .*elsewhere$/);
		assert.deepEqual(readdirSync(elsewhere), []);

		// Back as a folder, it is filled again.
		rmSync(folder);
		mkdirSync(folder);
		assert.equal((await roles.sync()).problem, null);
		assert.deepEqual(readdirSync(folder).sort(), ["开发.md", "总办.md"]);
	});

	test("with the system sandbox off the files are written and nothing is committed", async () => {
		const { root, roles, read } = setup({ sandbox: false });
		const state = await roles.sync();
		assert.equal(state.commits, "sandbox");
		assert.equal(state.problem, null);
		assert.equal(read("总办.md"), "Runs the office.\n");
		assert.deepEqual(subjects(root), ["Start"]);
	});

	test("the repository's hooks are not run", async () => {
		const { root, roles } = setup();
		const hook = join(root, ".git", "hooks", "pre-commit");
		mkdirSync(join(root, ".git", "hooks"), { recursive: true });
		writeFileSync(hook, `#!/bin/sh\ntouch "${join(root, "hook-ran")}"\nexit 1\n`);
		chmodSync(hook, 0o755);
		assert.equal((await roles.sync()).problem, null);
		assert.equal(subjects(root).length, 2);
		assert.equal(existsSync(join(root, "hook-ran")), false);
	});

	test("what git refuses is said, and committed once it can be", async () => {
		const { root, roles } = setup();
		// Nobody to commit as.
		git(root, "config", "--unset", "user.name");
		git(root, "config", "--unset", "user.email");
		git(root, "config", "user.useConfigOnly", "true");
		const state = await roles.sync();
		assert.equal(state.problem?.code, "commit");
		assert.notEqual(state.problem?.detail, "");
		assert.deepEqual(subjects(root), ["Start"]);

		git(root, "config", "user.name", "Test");
		git(root, "config", "user.email", "test@example.com");
		assert.equal((await roles.sync()).problem, null);
		assert.equal(subjects(root).length, 2);
	});

	test("a linked working tree or a submodule is left alone", async () => {
		const { root, folder, roles, read } = setup({ repository: false });
		assert.deepEqual(repositoryOf(folder), { kind: "none" });
		writeFileSync(join(root, ".git"), "gitdir: /somewhere/else\n");
		assert.deepEqual(repositoryOf(folder), { kind: "linked" });
		const state = await roles.sync();
		assert.equal(state.commits, "linked");
		assert.equal(read("总办.md"), "Runs the office.\n");
		rmSync(join(root, ".git"));
		mkdirSync(join(root, ".git"));
		assert.deepEqual(repositoryOf(folder), { kind: "main", root });
	});

	test("a role changed while Yew Harness runs reaches the folder", async () => {
		const { store, bus } = newStore();
		const folder = join(realpathSync(tempDir("yew-roles-")), "roles");
		store.setSetting("rolesFolder", folder);
		opened.push(new RoleFiles({ store, bus, confined: () => true, run: direct }));
		const session = store.createSession({ ...sessionInput("总办"), responsibility: "First." });
		const file = join(folder, "总办.md");
		const says = (text: string) =>
			until(() => existsSync(file) && readFileSync(file, "utf8") === text);
		assert.equal(await says("First.\n"), true);
		store.updateSession(session.id, { responsibility: "Second." });
		assert.equal(await says("Second.\n"), true);
		// The folder is watched: an edit made in it is put back.
		writeFileSync(file, "Third, by somebody else.\n");
		assert.equal(await says("Second.\n"), true);
	});
});

describe("api: the roles folder", () => {
	test("the folder is checked, written at once, and the settings say what is in it", async () => {
		const { store } = newStore();
		store.createSession({ ...sessionInput("总办"), responsibility: "Runs the office." });
		const home = realpathSync(tempDir("yew-roles-home-"));
		const roles = new RoleFiles({ store, watch: false, confined: () => true, run: direct });
		opened.push(roles);
		const app = createApp({ store, log: () => {}, roleFiles: roles, data: { home } });
		const patch = (rolesFolder: string | null) =>
			app.request("/api/settings", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ rolesFolder }),
			});
		const state = async () => (await app.request("/api/settings/roles-folder")).json();

		const outside = realpathSync(tempDir("yew-roles-"));
		writeFileSync(join(outside, "a-file"), "");
		for (const bad of [
			"roles",
			"/",
			"~",
			homedir(),
			join(outside, "a-file"),
			join(home, "roles"),
		]) {
			assert.equal((await patch(bad)).status, 400, bad);
		}
		assert.deepEqual(await state(), { folder: null, files: 0, commits: "none", problem: null });

		const folder = join(outside, "roles");
		const saved = (await (await patch(` ${folder} `)).json()) as { rolesFolder: string };
		assert.equal(saved.rolesFolder, folder);
		assert.deepEqual(await state(), { folder, files: 1, commits: "none", problem: null });
		assert.equal(readFileSync(join(folder, "总办.md"), "utf8"), "Runs the office.\n");

		// Cleared: nothing more is written, and what is there stays.
		assert.equal(((await (await patch(null)).json()) as { rolesFolder: null }).rolesFolder, null);
		assert.deepEqual(await state(), { folder: null, files: 0, commits: "none", problem: null });
		assert.equal(existsSync(join(folder, "总办.md")), true);
	});
});
