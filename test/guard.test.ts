// The outer guard (guard.ts): commands that do not run in the system sandbox are still kept out of
// Yew's data folder, the Mac app's web storage and the folders the person keeps from sessions. The
// normal flow only; whether it can be got around is tested separately.
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import {
	containerPlaces,
	containersNote,
	type GuardReach,
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
			/\(deny file-read\* file-write\* \(subpath "\/Users\/me\/\.yew"\) \(subpath "\/odd\/\\"name\\""\) /,
		);
		assert.match(profile, /\(literal "\/Users\/me\/\.zshrc"\)/);
		assert.match(profile, /\(literal "\/Users\/me\/\.ssh\/config"\)/);
		assert.match(profile, /\(subpath "\/Users\/me\/Library\/LaunchAgents"\)/);
		assert.match(profile, /\(regex #"\/\\\.git\/\(modules\/\.\+\/\)\?hooks/);
		assert.match(profile, /\(deny lsopen\)\n\(deny appleevent-send\)$/);
	});

	test("container engines and virtual machines are closed unless the session may use containers", () => {
		const home = "/Users/me";
		const line = (profile: string, start: string) =>
			profile.split("\n").find((text) => text.startsWith(start)) ?? "";
		const closed = guardProfile(["/Users/me/.yew"], home);
		const files = line(closed, "(deny file-read* file-write*");
		const network = line(closed, "(deny network-outbound");
		for (const folder of [
			".docker",
			"Library/Containers/com.docker.docker",
			".orbstack",
			".colima",
			".config/colima",
			".lima",
			".rd",
			"Library/Application Support/com.apple.container",
			".local/share/containers",
		]) {
			// Closed like Yew's data, so the keys to their machines cannot be read, and no socket in
			// them can be reached.
			assert.ok(files.includes(`(subpath "${home}/${folder}")`), folder);
			assert.ok(network.includes(`(remote unix-socket (subpath "${home}/${folder}"))`), folder);
		}
		for (const socket of ["/var/run/docker.sock", "/var/run/multipass_socket"]) {
			assert.ok(network.includes(`(remote unix-socket (path-literal "${socket}"))`), socket);
		}
		for (const port of [22, 2375, 2376, 6443]) {
			assert.ok(network.includes(`(remote ip "localhost:${port}")`), String(port));
		}
		// Apple's Virtualization framework, and the service Apple's container tool takes orders through.
		assert.equal(
			line(closed, "(deny mach-lookup"),
			'(deny mach-lookup (global-name-prefix "com.apple.Virtualization.") (xpc-service-name-prefix "com.apple.Virtualization.") (global-name-prefix "com.apple.container.") (xpc-service-name-prefix "com.apple.container."))',
		);

		// The person lets the session use containers: only ssh to this computer stays closed.
		const open = guardProfile(["/Users/me/.yew"], home, "default", [], { containers: true });
		assert.equal(
			line(open, "(deny file-read* file-write*"),
			'(deny file-read* file-write* (subpath "/Users/me/.yew"))',
		);
		assert.equal(
			line(open, "(deny network-outbound"),
			'(deny network-outbound (remote ip "localhost:22"))',
		);
		assert.doesNotMatch(open, /mach-lookup/);
	});

	test("a container engine kept from a command is said, with who can open it", () => {
		for (const output of [
			"Cannot connect to the Docker daemon at unix:///Users/me/.docker/run/docker.sock. Is the docker daemon running?",
			"permission denied while trying to connect to the docker API at unix:///var/run/docker.sock",
			"The connection to the server 127.0.0.1:6443 was refused - did you specify the right host or port?",
			"limactl: open /Users/me/.lima/default/lima.yaml: operation not permitted",
			"list failed: cannot connect to the multipass socket",
			"Ensure container system service has been started with `container system start`.",
		]) {
			assert.match(
				containersNote(output) ?? "",
				/allow containers in this session's settings/,
				output,
			);
		}
		assert.equal(containersNote("docker: 'compose' is not a docker command."), null);
		assert.equal(containersNote("ls: x: Permission denied"), null);
	});

	test("Linux lays an empty folder over each folder and binds the rest as it is", () => {
		const data = tempDir("yew-data-");
		const home = tempDir("yew-person-");
		writeFileSync(join(home, ".bashrc"), "# start-up");
		const work = tempDir("yew-work-");
		mkdirSync(join(work, ".git", "hooks"), { recursive: true });
		writeFileSync(join(work, ".git", "config"), "[core]");
		mkdirSync(join(home, ".colima", "default"), { recursive: true });
		const state = {
			kind: "linux" as const,
			program: "/usr/bin/bwrap",
			places: [data, "/nowhere/file"],
			hidden: () => [],
			home,
			runtime: null,
		};
		const args = guardedArgs("/bin/sh", "ls", work, state);
		// Start-up files as the system sees them, links resolved.
		const bashrc = resolved(join(home, ".bashrc"));
		// A container engine's folder gets an empty one laid over it; its sockets elsewhere (the
		// system's own, which this computer may or may not have) an empty file.
		const isFolder = (path: string) => existsSync(path) && statSync(path).isDirectory();
		const engines = containerPlaces(home, tmpdir());
		const others = [...new Set(engines.folders.map(resolved))]
			.filter((path) => isFolder(path) && path !== resolved(join(home, ".colima")))
			.flatMap((path) => ["--tmpfs", path]);
		const sockets = [...new Set(engines.files.map(resolved))]
			.filter((path) => existsSync(path) && !isFolder(path))
			.flatMap((path) => ["--ro-bind", "/dev/null", path]);
		assert.deepEqual(args, {
			file: "/usr/bin/bwrap",
			args: [
				"--dev-bind",
				"/",
				"/",
				"--tmpfs",
				data,
				"--tmpfs",
				resolved(join(home, ".colima")),
				...others,
				...sockets,
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
		// The person lets the session use containers: nothing laid over their places.
		const open = guardedArgs("/bin/sh", "ls", work, state, "default", [work], { containers: true });
		assert.ok(open && !open.args.includes(resolved(join(home, ".colima"))));
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

	test("a command in it cannot reach a container engine unless the session may use containers", {
		skip: runs ? false : "no sandbox-exec or bubblewrap here",
	}, async () => {
		const data = tempDir("yew-data-");
		writeFileSync(join(data, "yew.db"), "the decisions");
		// Short: a socket's path has a length limit.
		const home = tempDir("yew-h-");
		const started = startGuard([data], home, (name) => findProgram(name));
		if (started.kind === "none") {
			assert.ok(started.problem);
			return;
		}
		const work = tempDir("yew-work-");
		// Where Docker Desktop, Colima and Lima take orders.
		const sockets = [
			join(home, ".docker", "run", "docker.sock"),
			join(home, ".colima", "default", "docker.sock"),
			join(home, ".lima", "default", "sock", "docker.sock"),
		].map(resolved);
		const servers = await Promise.all(
			sockets.map((path) => {
				mkdirSync(dirname(path), { recursive: true });
				return new Promise<Server>((done) => {
					const server = createServer();
					server.listen(path, () => done(server));
				});
			}),
		);
		const connect = (path: string, reach: GuardReach) => {
			const code =
				"require('node:net').connect(process.argv[1]).on('connect', () => { console.log('connected'); process.exit(0); }).on('error', (error) => { console.log(error.code); process.exit(1); })";
			const command = `'${process.execPath}' -e "${code}" '${path}'`;
			const args = guardedArgs("/bin/sh", command, work, undefined, "default", [work], reach);
			assert.ok(args);
			return new Promise<string>((done) => {
				execFile(args.file, args.args, { encoding: "utf8", timeout: 20_000 }, (_error, stdout) =>
					done(stdout.trim()),
				);
			});
		};
		try {
			for (const [index, socket] of sockets.entries()) {
				// A link to the socket from a folder the command may write leads to the same place.
				const link = join(work, `link-${index}.sock`);
				symlinkSync(socket, link);
				for (const path of [socket, link]) {
					assert.notEqual(await connect(path, {}), "connected", path);
					assert.equal(await connect(path, { containers: true }), "connected", path);
				}
			}
		} finally {
			for (const server of servers) server.close();
		}
	});

	test("a command in it cannot have a program started outside it later", {
		skip: process.platform === "darwin" ? false : "macOS only",
	}, () => {
		const data = tempDir("yew-data-");
		writeFileSync(join(data, "yew.db"), "the decisions");
		const started = startGuard([data], tempDir("yew-person-"), (name) => findProgram(name));
		if (started.kind === "none") {
			assert.ok(started.problem);
			return;
		}
		const work = tempDir("yew-work-");
		const run = (command: string) => {
			const args = guardedArgs("/bin/sh", command, work);
			assert.ok(args);
			return spawnSync(args.file, args.args, { encoding: "utf8", timeout: 20_000 });
		};
		// launchd turns down a job sent from inside the guard.
		const label = `cn.tenonai.yew.test.${process.pid}`;
		try {
			assert.notEqual(run(`launchctl submit -l ${label} -- /usr/bin/true`).status, 0);
			assert.notEqual(spawnSync("launchctl", ["list", label]).status, 0);
		} finally {
			spawnSync("launchctl", ["remove", label]);
		}
		// cron and at would run a job later; their programs (setuid) do not start in the guard.
		for (const command of ["crontab -l", "at -l"]) {
			const ran = run(command);
			assert.notEqual(ran.status, 0, command);
			assert.match(ran.stderr, /not permitted/i, command);
		}
		// A .command file would run in Terminal: LaunchServices is closed.
		const marker = join(work, "opened");
		const script = join(work, "probe.command");
		writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
		assert.notEqual(run(`open '${script}'`).status, 0);
		assert.equal(existsSync(marker), false);
	});
});
