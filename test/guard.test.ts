// The outer guard (guard.ts): commands that do not run in the system sandbox are still kept out of
// Yew's data folder, the Mac app's web storage and the folders the person keeps from sessions. The
// normal flow only; whether it can be got around is tested separately.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import {
	guardedArgs,
	guardKind,
	guardProfile,
	resolved,
	startGuard,
	stopGuard,
} from "../src/server/guard.ts";
import { findProgram } from "../src/server/sandbox.ts";
import { tempDir } from "./helpers/store.ts";

afterEach(() => stopGuard());

describe("the guard", () => {
	test("the macOS profile closes the places, what runs by itself, and starting other programs", () => {
		const profile = guardProfile(["/Users/me/.yew", '/odd/"name"'], "/Users/me");
		assert.match(profile, /^\(version 1\)\n\(allow default\)\n/);
		assert.match(
			profile,
			/\(deny file-read\* file-write\* \(subpath "\/Users\/me\/\.yew"\) \(subpath "\/odd\/\\"name\\""\)\)\n/,
		);
		assert.match(profile, /\(literal "\/Users\/me\/\.zshrc"\)/);
		assert.match(profile, /\(literal "\/Users\/me\/\.ssh\/config"\)/);
		assert.match(profile, /\(subpath "\/Users\/me\/Library\/LaunchAgents"\)/);
		assert.match(profile, /\(regex #"\/\\\.git\/\(modules\/\.\+\/\)\?hooks/);
		assert.match(profile, /\(deny lsopen\)\n\(deny appleevent-send\)$/);
	});

	test("Linux lays an empty folder over each folder and binds the rest as it is", () => {
		const data = tempDir("yew-data-");
		const home = tempDir("yew-person-");
		writeFileSync(join(home, ".bashrc"), "# start-up");
		const work = tempDir("yew-work-");
		mkdirSync(join(work, ".git", "hooks"), { recursive: true });
		writeFileSync(join(work, ".git", "config"), "[core]");
		const args = guardedArgs("/bin/sh", "ls", work, {
			kind: "linux",
			program: "/usr/bin/bwrap",
			places: [data, "/nowhere/file"],
			hidden: () => [],
			home,
			runtime: null,
		});
		// Start-up files as the system sees them, links resolved.
		const bashrc = resolved(join(home, ".bashrc"));
		assert.deepEqual(args, {
			file: "/usr/bin/bwrap",
			args: [
				"--dev-bind",
				"/",
				"/",
				"--tmpfs",
				data,
				"--ro-bind",
				bashrc,
				bashrc,
				"--ro-bind",
				join(work, ".git", "hooks"),
				join(work, ".git", "hooks"),
				"--ro-bind",
				join(work, ".git", "config"),
				join(work, ".git", "config"),
				"--",
				"/bin/sh",
				"-lc",
				"ls",
			],
		});
	});

	test("without a guard there is nothing to run in", () => {
		assert.equal(guardedArgs("/bin/sh", "ls", "/tmp"), null);
		assert.equal(startGuard(["/tmp/x"], "/tmp", () => null, "win32").kind, "none");
	});

	const runs =
		process.platform === "darwin" || (process.platform === "linux" && findProgram("bwrap"));
	test("a command in it cannot read the data folder, and writes elsewhere as before", {
		skip: runs ? false : "no sandbox-exec or bubblewrap here",
	}, () => {
		const data = tempDir("yew-data-");
		writeFileSync(join(data, "yew.db"), "the decisions");
		const work = tempDir("yew-work-");
		mkdirSync(join(work, "out"));
		const started = startGuard([data], tempDir("yew-person-"), (name) => findProgram(name));
		if (started.kind === "none") {
			// A Linux machine where bubblewrap cannot make a namespace: no guard, and why.
			assert.ok(started.problem);
			return;
		}
		assert.equal(guardKind(), started.kind);
		const read = guardedArgs("/bin/sh", `cat '${join(resolved(data), "yew.db")}'`, work);
		assert.ok(read);
		const denied = spawnSync(read.file, read.args, { encoding: "utf8" });
		assert.notEqual(denied.status, 0);
		assert.doesNotMatch(denied.stdout, /the decisions/);
		const write = guardedArgs("/bin/sh", `echo done > '${join(work, "out", "a.txt")}'`, work);
		assert.ok(write);
		assert.equal(spawnSync(write.file, write.args).status, 0);
		assert.equal(readFileSync(join(work, "out", "a.txt"), "utf8"), "done\n");
	});

	test("a folder the person keeps from sessions is closed as the setting stands when a command starts", {
		skip: runs ? false : "no sandbox-exec or bubblewrap here",
	}, () => {
		const data = tempDir("yew-data-");
		writeFileSync(join(data, "yew.db"), "the decisions");
		const kept = tempDir("yew-kept-");
		writeFileSync(join(kept, "notes.txt"), "kept from sessions");
		const work = tempDir("yew-work-");
		const hidden: string[] = [];
		const started = startGuard(
			[data],
			tempDir("yew-person-"),
			(name) => findProgram(name),
			process.platform,
			() => hidden,
		);
		if (started.kind === "none") {
			assert.ok(started.problem);
			return;
		}
		const cat = `cat '${join(resolved(kept), "notes.txt")}'`;
		const open = guardedArgs("/bin/sh", cat, work);
		assert.ok(open);
		assert.equal(
			spawnSync(open.file, open.args, { encoding: "utf8" }).stdout,
			"kept from sessions",
		);
		// The person adds the folder in the settings: the next command cannot read it.
		hidden.push(kept);
		const closed = guardedArgs("/bin/sh", cat, work);
		assert.ok(closed);
		const denied = spawnSync(closed.file, closed.args, { encoding: "utf8" });
		assert.notEqual(denied.status, 0);
		assert.doesNotMatch(denied.stdout, /kept from sessions/);
	});
});
