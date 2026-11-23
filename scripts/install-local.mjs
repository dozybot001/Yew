// Installs a commit of this checkout as the Yew Harness this computer runs, apart from the checkout
// that is being worked on: the service never runs code that is half written, an update is one
// command, and the copy that ran before stays to go back to.
//
//   npm run install:local               the commit at HEAD
//   npm run install:local -- <commit>   another commit
//   npm run install:local -- --back     the copy that ran before
//
// The copy is an export of the commit with its dependencies and the built interface:
//
//   ~/.yew-install/current             the copy in use
//   ~/.yew-install/current/.previous   the one before it
//   ~/.yew-install/current/.next       one being prepared
//
// The last two are inside the first because the system sandbox keeps sessions' commands from writing
// to the folder Yew Harness is installed in: what is in there, they cannot change. The folder's path
// stays the same from one copy to the next, so the app, the `yew` command and a restart all reach the
// new copy.
import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const HELP = `Usage: node scripts/install-local.mjs [commit] [options]

Install a commit of this checkout (HEAD when none is given) as the Yew Harness
this computer runs. Changes that are not committed are left out. Before a copy
whose service code changed takes over, it runs the demo story with a stand-in
model in a throwaway folder.

In the default folder, the Mac app and a linked 'yew' command are pointed at
the copy. A restart is needed when the service's code changed; when only the
interface changed, reloading the page is enough.

Options:
      --back         Return to the copy that ran before
      --dir <folder> Where the copies are kept (default ~/.yew-install); the
                     app and the 'yew' command are left alone in another folder
      --no-check     Do not run the demo story first
  -h, --help         Show this help
`;

const checkout = fileURLToPath(new URL("../", import.meta.url));
const { COMMIT_FILE, buildAt, buildIn } = await import("../src/server/updates.ts");

function fail(message) {
	process.stderr.write(`install-local: ${message}\n`);
	process.exit(1);
}

/** Runs a command to its end; what it prints goes to standard error, as progress. */
function run(command, args, cwd, what) {
	const result = spawnSync(command, args, { cwd, stdio: ["ignore", 2, 2] });
	if (result.status !== 0) fail(`${what} failed (${command} ${args.join(" ")})`);
}

const step = (text) => process.stderr.write(`install-local: ${text}\n`);

/** The result, on standard output. */
const say = (lines) => process.stdout.write(`${lines.join("\n")}\n`);

/** Copies a folder; on a file system that can, without taking more room (APFS, Btrfs, XFS). */
function clone(from, to) {
	const args =
		process.platform === "darwin" ? ["-Rc", from, to] : ["-R", "--reflink=auto", from, to];
	run("cp", args, checkout, `copying ${from}`);
}

/** The commit's files, as git has them, into `folder`. */
function exportCommit(commit, folder) {
	const tar = `${folder}.tar`;
	run("git", ["archive", "--format=tar", "-o", tar, commit], checkout, `exporting ${commit}`);
	run("tar", ["-x", "-f", tar, "-C", folder], checkout, `unpacking ${commit}`);
	rmSync(tar);
}

/** Whether nothing under `paths` differs between two commits; false when git cannot tell. */
function same(from, to, paths) {
	return (
		spawnSync("git", ["diff", "--quiet", from, to, "--", ...paths], {
			cwd: checkout,
			stdio: "ignore",
		}).status === 0
	);
}

/**
 * Puts the copy in `incoming` in use and keeps the one in use, if any, inside it. Between the two
 * renames in the middle the folder is missing, for about as long as a rename takes.
 */
function takeOver(dir, incoming) {
	const current = join(dir, "current");
	const outgoing = join(dir, ".outgoing");
	if (!existsSync(current)) {
		renameSync(incoming, current);
		return;
	}
	renameSync(current, outgoing);
	renameSync(incoming, current);
	renameSync(outgoing, join(current, ".previous"));
}

/** Finishes a change of copies that was cut short, and clears what a stopped run left. */
function recover(dir) {
	const current = join(dir, "current");
	const incoming = join(dir, ".incoming");
	const outgoing = join(dir, ".outgoing");
	if (!existsSync(current)) {
		if (existsSync(join(incoming, COMMIT_FILE))) renameSync(incoming, current);
		else if (existsSync(outgoing)) renameSync(outgoing, current);
	}
	if (existsSync(current) && existsSync(outgoing)) {
		rmSync(join(current, ".previous"), { recursive: true, force: true });
		renameSync(outgoing, join(current, ".previous"));
	}
	rmSync(incoming, { recursive: true, force: true });
}

/**
 * In the default folder: the Mac app starts this copy and has its program, and a `yew` command that
 * is a link to a checkout becomes a link to this copy. Returns what was changed or left, as lines.
 */
function pointAtCopy(current) {
	const notes = [];
	const yew = join(current, "bin", "yew.js");
	const app = join(homedir(), "Applications", "Yew.app", "Contents");
	if (process.platform === "darwin" && existsSync(app)) {
		const script = [join(app, "Resources", "yew-link"), join(app, "MacOS", "yew-launcher")].find(
			(path) => existsSync(path),
		);
		// The app's script names the copy's files by their real path.
		const starts = script
			? readFileSync(script, "utf8").includes(`'${realpathSync(current)}/`)
			: false;
		// The app holds a signed copy of the program, so the two copies' programs are compared.
		const program = (copy) => {
			const file = join(copy, "dist", "mac", "Yew");
			return existsSync(file) ? readFileSync(file) : Buffer.alloc(0);
		};
		const previous = join(current, ".previous");
		const newProgram = !existsSync(previous) || !program(current).equals(program(previous));
		if (!starts || newProgram) {
			run(process.execPath, [yew, "app", "install"], current, "installing the Mac app");
			notes.push(
				starts
					? "The Mac app has its new program: quit it and open it again."
					: "The Mac app now starts this copy.",
			);
		}
	}
	const prefix = spawnSync("npm", ["prefix", "--global"], { encoding: "utf8" }).stdout?.trim();
	const linked = prefix ? join(prefix, "lib", "node_modules", "@tenonai", "yew") : null;
	const kind = linked && lstatSync(linked, { throwIfNoEntry: false });
	if (kind?.isSymbolicLink()) {
		const target = existsSync(linked) ? realpathSync(linked) : null;
		if (target !== realpathSync(current)) {
			run("npm", ["link", "--no-audit", "--no-fund"], current, "linking the yew command");
			notes.push(`The yew command now runs this copy${target ? ` (it ran ${target})` : ""}.`);
		}
	} else if (kind) {
		notes.push("The yew command is an npm install and was left as it is.");
	} else {
		notes.push(`No yew command is linked; to have one, run npm link in ${current}.`);
	}
	return notes;
}

/** What has to be done for the copy now in `current` to be the one in use, after `before`. */
function whatNow(before, now, interfaceChanged) {
	if (!before) return "Stop the Yew Harness that is running, then start it from this copy.";
	if (!before.code || !now.code || before.code !== now.code)
		return "Restart Yew Harness to use it (Settings, About).";
	if (interfaceChanged) return "Only the interface changed: reload the page.";
	return "Nothing the service or the interface uses changed.";
}

let args;
try {
	args = parseArgs({
		allowPositionals: true,
		options: {
			back: { type: "boolean" },
			dir: { type: "string" },
			"no-check": { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
	});
} catch (error) {
	process.stderr.write(`install-local: ${error.message}\n\n${HELP}`);
	process.exit(2);
}
if (args.values.help) {
	process.stdout.write(HELP);
	process.exit(0);
}
if (args.positionals.length > 1 || (args.values.back && args.positionals.length > 0)) {
	process.stderr.write(`install-local: give one commit, or --back alone\n\n${HELP}`);
	process.exit(2);
}

const dir = resolve(args.values.dir ?? join(homedir(), ".yew-install"));
const current = join(dir, "current");
const machine = args.values.dir === undefined;
mkdirSync(dir, { recursive: true });
recover(dir);
const before = existsSync(current) ? buildIn(current) : null;

if (args.values.back) {
	const previous = join(current, ".previous");
	const back = existsSync(previous) ? buildIn(previous) : null;
	if (!back) fail(`there is no earlier copy in ${current}`);
	const incoming = join(dir, ".incoming");
	renameSync(previous, incoming);
	takeOver(dir, incoming);
	const notes = machine ? pointAtCopy(current) : [];
	const interfaceChanged = before ? !same(before.build, back.build, ["web"]) : true;
	say([
		`Back on ${back.build} in ${current}${before ? `; ${before.build} is kept to return to` : ""}.`,
		...notes,
		whatNow(before, back, interfaceChanged),
	]);
	process.exit(0);
}

const target = buildAt(checkout, args.positionals[0] ?? "HEAD");
if (!target) fail(`${args.positionals[0] ?? "HEAD"} is not a commit of this checkout`);
if (spawnSync("git", ["diff", "--quiet", "HEAD"], { cwd: checkout }).status !== 0)
	step("changes that are not committed are left out");

const staging = existsSync(current) ? join(current, ".next") : join(dir, ".incoming");
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
step(`exporting ${target.build}`);
exportCommit(target.build, staging);

// The dependencies: the lock file's, from npm; the ones in use when the lock file is the same.
const lock = (folder) => readFileSync(join(folder, "package-lock.json"));
if (existsSync(join(current, "node_modules")) && lock(current).equals(lock(staging))) {
	step("the dependencies are the same: copying them");
	clone(join(current, "node_modules"), join(staging, "node_modules"));
} else {
	step("installing the dependencies");
	run("npm", ["ci", "--no-audit", "--no-fund"], staging, "installing the dependencies");
}
step("building the interface");
run("npm", ["run", "--silent", "build:web"], staging, "building the interface");
if (process.platform === "darwin") {
	const program = join(current, "dist", "mac");
	if (
		before &&
		existsSync(program) &&
		same(before.build, target.build, ["macos", "scripts/mac-app.mjs"])
	) {
		mkdirSync(join(staging, "dist"), { recursive: true });
		clone(program, join(staging, "dist", "mac"));
	} else {
		step("building the Mac app's program");
		run("npm", ["run", "--silent", "build:mac"], staging, "building the Mac app's program");
	}
}

// A copy whose service code is new shows that it runs before it takes over.
const codeChanged = !before?.code || !target.code || before.code !== target.code;
const story = join(staging, "scripts", "package-run.ts");
if (codeChanged && !args.values["no-check"] && existsSync(story)) {
	step("running the demo story on the new copy");
	const folder = mkdtempSync(join(tmpdir(), "yew-install-"));
	try {
		const { runInstalled } = await import(pathToFileURL(story).href);
		step(await runInstalled(join(staging, "bin", "yew.js"), join(folder, "run")));
	} catch (error) {
		fail(
			`the new copy did not run the demo story, so nothing was changed: ${error.message}\nIts folder is kept: ${folder}`,
		);
	}
	rmSync(folder, { recursive: true, force: true });
}

writeFileSync(join(staging, COMMIT_FILE), `${target.build}\n${target.code ?? ""}\n`);
const incoming = join(dir, ".incoming");
if (staging !== incoming) {
	rmSync(join(current, ".previous"), { recursive: true, force: true });
	renameSync(staging, incoming);
}
takeOver(dir, incoming);
const notes = machine ? pointAtCopy(current) : [];
const interfaceChanged = before ? !same(before.build, target.build, ["web"]) : true;
say([
	`Installed ${target.build} in ${current}${before ? `; ${before.build} is kept, and --back returns to it` : ""}.`,
	...notes,
	whatNow(before, target, interfaceChanged),
]);
// The demo story's stand-in model and the service it started may still hold the event loop.
process.exit(0);
