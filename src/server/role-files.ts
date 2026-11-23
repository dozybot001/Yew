import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	type FSWatcher,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
	watch,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Session } from "../shared/types.ts";
import type { EventBus } from "./events.ts";
import { canonical } from "./permissions/paths.ts";
import { activeSandbox, OUTSIDE_GIT, quote, sandboxed } from "./sandbox.ts";
import type { Store } from "./store.ts";

/**
 * The roles folder (a setting): Yew writes each standing session's role into a Markdown file there
 * and keeps the files as the roles are, so the roles can be read as documents. In a git repository
 * every change is committed, and the repository's history is the history of the roles.
 *
 * The folder is written, never read back: a role is changed in Yew, by the person or by a session
 * that may manage others, with the confirmation that takes. A file changed by anyone else is put
 * back; in a repository the edit is committed first, so what was written there stays in the history,
 * and while it cannot be committed the file is left as it is. While the repository is off a branch
 * or in the middle of a merge or a rebase, the folder is left alone: the working tree is git's then.
 * A pass that did not go through is tried again, at growing intervals.
 *
 * Sessions' commands may work in the same folder and repository, so Yew trusts nothing it finds
 * there. This process only looks: it reads plain files and compares them. Whatever changes the
 * folder (writing and removing files, git) is done by a small script in the system sandbox, which
 * can write in that repository or folder and nowhere else: a link put in a file's place, or a
 * program a repository's settings name, reaches no further than the command that left it could.
 * While the sandbox is off the script still writes the files, as the person's commands would, but
 * runs no git.
 */

/** What the settings show under the folder. */
export interface RoleFilesState {
	folder: string | null;
	/** How many sessions' roles are in the folder. */
	files: number;
	/**
	 * Whether changes are committed: "on" in a repository's main working tree; "none" outside any
	 * repository; "linked" in a linked working tree or a submodule, which is left alone; "sandbox"
	 * while the system sandbox is off, because git runs only in it.
	 */
	commits: "on" | "none" | "linked" | "sandbox";
	/**
	 * Why the last pass did not go through: the folder cannot be written ("folder"), files Yew did
	 * not write have the names it needs ("taken"), the repository is in the middle of a merge or a
	 * rebase, or not on a branch, and the folder waits for it ("busy"), or git refused ("commit").
	 */
	problem: { code: "folder" | "taken" | "busy" | "commit"; detail: string } | null;
}

/** What Yew last wrote for a session. */
interface Kept {
	file: string;
	sha: string;
	name: string;
}

/** The setting `roleFiles`: what Yew wrote into which folder. */
interface Saved {
	folder: string;
	files: Record<string, Kept>;
	readme?: boolean;
}

const README = "README.md";
/** Names a role file never takes: the folder's own description, and files read as instructions. */
const RESERVED = [README, "AGENTS.md", "CLAUDE.md"];
/** A role is 20 000 characters at most; a file far larger than that is not one Yew wrote. */
const MAX_FILE_BYTES = 1024 * 1024;
const SCRIPT_MS = 60_000;
const SETTLE_MS = 200;
/** How long until a pass that did not go through is tried again: doubled each time, up to the cap. */
const RETRY_FIRST_MS = 5_000;
const RETRY_MAX_MS = 10 * 60_000;

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** A role as its file holds it. */
const fileText = (role: string) => `${role.trim()}\n`;

/** A file name's stem from a session's name: readable, and safe on every file system. */
function stemOf(name: string): string {
	const clean = name
		.replace(/[\\/:*?"<>|\p{Cc}]/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^\.+/, "");
	return [...clean].slice(0, 80).join("").trim() || "session";
}

/** Whether `file` is the name `stem` gives, with or without a number after it. */
function namedFor(file: string, stem: string): boolean {
	if (file === `${stem}.md`) return true;
	return file.startsWith(`${stem} `) && /^\d+\.md$/.test(file.slice(stem.length + 1));
}

/** What a session's file depends on. */
function signature(session: Session): string {
	return `${session.kind}\n${session.archivedAt === null}\n${session.name}\n${session.responsibility}`;
}

/**
 * What is at a path: a plain file's text, nothing, or something else (a link, a folder, a pipe, a
 * file too large to be a role). Never follows a link and never waits on a pipe.
 */
function look(path: string): { text: string } | "none" | "other" {
	let fd: number;
	try {
		fd = openSync(
			path,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
		);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "none" : "other";
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return "other";
		return { text: readFileSync(fd, "utf8") };
	} catch {
		return "other";
	} finally {
		closeSync(fd);
	}
}

const WORDS = {
	en: {
		add: (name: string) => `Add the role of "${name}"`,
		update: (name: string) => `Update the role of "${name}"`,
		remove: (name: string) => `Remove the role of "${name}"`,
		rename: (from: string, to: string) => `Rename the role of "${from}" to "${to}"`,
		keep: (name: string) => `Keep an edit made to the role file of "${name}" outside Yew Harness`,
		restore: (name: string) =>
			`Restore the role file of "${name}": roles are changed in Yew Harness`,
		readme: "Describe the roles folder",
		several: (count: number) => `Update the role files (${count} changes)`,
		pending: "Update the role files",
		text: [
			"# Roles",
			"",
			"Yew Harness writes this folder: one file for each standing session, holding its role.",
			"",
			"- A role is changed in Yew Harness: in the session's settings, or by a session that manages others. The file follows, and when this folder is in a git repository, each change is committed.",
			"- Changing a file here does not change the role. Yew Harness puts the file back; in a repository the edit stays in the history.",
			"",
		].join("\n"),
	},
	zh: {
		add: (name: string) => `记下「${name}」的职责`,
		update: (name: string) => `更新「${name}」的职责`,
		remove: (name: string) => `移除「${name}」的职责`,
		rename: (from: string, to: string) => `「${from}」的职责改名为「${to}」`,
		keep: (name: string) => `保留「${name}」的职责文件在 Yew Harness 之外被改的内容`,
		restore: (name: string) => `恢复「${name}」的职责文件：职责在 Yew Harness 里改`,
		readme: "说明职责文件夹",
		several: (count: number) => `更新职责文件（${count} 处）`,
		pending: "更新职责文件",
		text: [
			"# 职责",
			"",
			"这个文件夹由 Yew Harness 写：每个常设会话一个文件，内容是它的职责。",
			"",
			"- 职责在 Yew Harness 里改：在会话设置里改，或由管理其他会话的会话改。文件跟着更新；文件夹在 git 仓库里时，每次改动提交一次。",
			"- 在这里改文件不会改职责。Yew Harness 会把文件改回去；有仓库时，改过的内容留在历史里。",
			"",
		].join("\n"),
	},
};

/** The repository a folder is in, as far as committing there goes. */
export type RoleRepository = { kind: "main"; root: string } | { kind: "linked" } | { kind: "none" };

/**
 * Looks for the repository above `folder` itself instead of asking git: the nearest folder with a
 * `.git`. Only a `.git` folder counts, a repository's main working tree. A `.git` file (a linked
 * working tree, a submodule) points to settings kept somewhere else, and is left alone.
 */
export function repositoryOf(folder: string): RoleRepository {
	for (let at = folder; ; at = dirname(at)) {
		const git = lstatSync(join(at, ".git"), { throwIfNoEntry: false });
		if (git?.isDirectory()) return { kind: "main", root: at };
		if (git) return { kind: "linked" };
		if (dirname(at) === at) return { kind: "none" };
	}
}

/**
 * One thing the script does in the folder. `keep` is on a file that holds what somebody else wrote:
 * that is committed first, under this subject, and when it cannot be, the file is left as it is.
 */
type Step =
	| { do: "write"; file: string; text: string; keep?: string }
	| { do: "remove"; file: string; keep?: string }
	/** Commits what differs in `files`; other changes in the repository stay as they are. */
	| { do: "commit"; files: string[]; subject: string; body?: string };

/** What the script is given on standard input. */
export interface RolePlan {
	folder: string;
	/** The repository commits go to; null when none are made. */
	root: string | null;
	steps: Step[];
}

/** What the script says of each step, in order. */
interface StepResult {
	ok: boolean;
	detail?: string;
	/** Not done because the repository is off a branch or in a merge or a rebase. */
	busy?: boolean;
	/** Not done because git refused. */
	git?: boolean;
}

/**
 * The script: carries out a plan read from standard input and prints what became of each step. It
 * runs on its own (run as `node -e`), so everything it uses is inside it.
 */
async function applyRolePlan(): Promise<void> {
	const { execFileSync } = await import("node:child_process");
	const fs = await import("node:fs");
	const path = await import("node:path");
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	const plan = JSON.parse(input) as RolePlan;
	const root = plan.root ?? "";
	const gitDir = path.join(root, ".git");
	// The repository is named outright, so nothing left in the folder can pass for one.
	const git = (args: string[]): string =>
		execFileSync("git", [`--git-dir=${gitDir}`, `--work-tree=${root}`, ...args], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 20_000,
			maxBuffer: 16 * 1024 * 1024,
		});
	/** Commits what differs in `files`, and nothing else that waits in the repository. */
	const commit = (files: string[], subject: string, body?: string): void => {
		const paths = files.map((file) => path.relative(root, path.join(plan.folder, file)));
		const dirty = git([
			"status",
			"--porcelain",
			"-z",
			"--no-renames",
			"--untracked-files=all",
			"--",
			...paths,
		])
			.split("\0")
			.filter((entry) => entry.length > 3)
			.map((entry) => entry.slice(3));
		if (dirty.length === 0) return;
		git(["add", "-A", "--", ...dirty]);
		git([
			"commit",
			"--only",
			"--quiet",
			"-m",
			subject,
			...(body ? ["-m", body] : []),
			"--",
			...dirty,
		]);
	};
	const said = (error: unknown): string => {
		const failure = error as Error & { stderr?: string };
		return (
			String(failure.stderr || failure.message)
				.trim()
				.split("\n")[0] ?? ""
		);
	};
	// Off a branch, or in the middle of a merge or a rebase, the working tree is git's: nothing is
	// written into it and nothing committed until that is over.
	let busy = false;
	if (plan.root !== null) {
		try {
			busy =
				!fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").startsWith("ref: ") ||
				[
					"MERGE_HEAD",
					"CHERRY_PICK_HEAD",
					"REVERT_HEAD",
					"BISECT_LOG",
					"rebase-merge",
					"rebase-apply",
				].some((name) => fs.existsSync(path.join(gitDir, name)));
		} catch {
			// Not a repository git can use: git says so in its own words at the first commit.
		}
	}
	const results: StepResult[] = [];
	let count = 0;
	for (const step of plan.steps) {
		if (busy) {
			results.push({ ok: false, busy: true });
			continue;
		}
		if (step.do !== "commit" && step.keep !== undefined && plan.root !== null) {
			try {
				commit([step.file], step.keep);
			} catch (error) {
				results.push({ ok: false, git: true, detail: said(error) });
				continue;
			}
		}
		try {
			if (step.do === "write") {
				fs.mkdirSync(plan.folder, { recursive: true });
				// Written beside the file and moved over it: a link in the file's place is replaced, not
				// followed, and a reader never sees half a file.
				const temporary = path.join(plan.folder, `.${process.pid}-${count++}.tmp`);
				fs.rmSync(temporary, { force: true });
				const fd = fs.openSync(
					temporary,
					fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
					0o644,
				);
				try {
					fs.writeSync(fd, step.text);
				} finally {
					fs.closeSync(fd);
				}
				try {
					fs.renameSync(temporary, path.join(plan.folder, step.file));
				} catch (error) {
					fs.rmSync(temporary, { force: true });
					throw error;
				}
			} else if (step.do === "remove") {
				fs.rmSync(path.join(plan.folder, step.file), { force: true });
			} else {
				commit(step.files, step.subject, step.body);
			}
			results.push({ ok: true });
		} catch (error) {
			results.push({
				ok: false,
				detail: said(error),
				...(step.do === "commit" ? { git: true } : {}),
			});
		}
	}
	process.stdout.write(JSON.stringify(results));
}

const SCRIPT = `(${applyRolePlan.toString()})().catch((error) => { console.error(error.message); process.exit(1); });`;

/**
 * The script's whole environment: where programs and the person's git settings are, and git told
 * to run no hooks, file system monitor, signing program or housekeeping in the background, to take
 * names as names and not patterns, and to ask nothing. Nothing else of Yew's own environment.
 */
function scriptEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const name of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "XDG_CONFIG_HOME"]) {
		if (process.env[name] !== undefined) env[name] = process.env[name];
	}
	const settings = [
		["commit.gpgsign", "false"],
		["gc.auto", "0"],
		["maintenance.auto", "false"],
	];
	const first = Number(OUTSIDE_GIT.GIT_CONFIG_COUNT);
	Object.assign(env, OUTSIDE_GIT, {
		GIT_CONFIG_COUNT: String(first + settings.length),
		GIT_TERMINAL_PROMPT: "0",
		GIT_LITERAL_PATHSPECS: "1",
		GIT_PAGER: "cat",
	});
	settings.forEach(([key, value], index) => {
		env[`GIT_CONFIG_KEY_${first + index}`] = key;
		env[`GIT_CONFIG_VALUE_${first + index}`] = value;
	});
	return env;
}

export interface ScriptRun {
	ok: boolean;
	out: string;
	err: string;
}

/** Runs the script on a plan: `sandboxedRun` where sessions' commands may write, too. */
export type RunScript = (plan: RolePlan, env: NodeJS.ProcessEnv) => Promise<ScriptRun>;

/** Starts a command line or a program, hands it the plan, and collects what it prints. */
function runWith(
	start: { line: string } | { file: string; args: string[] },
	plan: RolePlan,
	env: NodeJS.ProcessEnv,
): Promise<ScriptRun> {
	return new Promise((done) => {
		const options = {
			// The script names every path in full; the folder itself may not be there yet.
			cwd: plan.root ?? "/",
			env,
			detached: true,
			stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
		};
		const child =
			"line" in start
				? spawn(start.line, { ...options, shell: true })
				: spawn(start.file, start.args, options);
		let out = "";
		let err = "";
		child.stdout.on("data", (data: Buffer) => {
			out += data.toString("utf8");
		});
		child.stderr.on("data", (data: Buffer) => {
			err += data.toString("utf8");
		});
		const timer = setTimeout(() => {
			err += "\nit took too long and was stopped";
			try {
				if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}, SCRIPT_MS);
		let ended = false;
		const end = (ok: boolean) => {
			if (ended) return;
			ended = true;
			clearTimeout(timer);
			done({ ok, out, err: err.trim() });
		};
		child.on("error", (error) => {
			err += error.message;
			end(false);
		});
		child.on("close", (code) => end(code === 0));
		// A script that ended early leaves nobody to read the plan.
		child.stdin.on("error", () => {});
		child.stdin.end(JSON.stringify(plan));
	});
}

const SCRIPT_ARGS = ["--input-type=module", "-e", SCRIPT];

/** Runs the script as it is: while the sandbox is off, and in tests. */
export const directRun: RunScript = (plan, env) =>
	runWith({ file: process.execPath, args: SCRIPT_ARGS }, plan, env);

/** Runs the script in the system sandbox, able to write in the plan's repository or folder only. */
export const sandboxedRun: RunScript = async (plan, env) => {
	const box = await sandboxed(`exec ${[process.execPath, ...SCRIPT_ARGS].map(quote).join(" ")}`, {
		grant: { writable: [plan.root ?? plan.folder] },
		text: "writing the roles folder",
	});
	if (!box) return { ok: false, out: "", err: "the system sandbox went off" };
	const environment = { ...env };
	for (const name of box.unset) delete environment[name];
	Object.assign(environment, box.env);
	const result = await runWith({ line: box.line }, plan, environment);
	const { blocked } = await box.finish();
	return result.ok
		? result
		: { ...result, err: [result.err, ...blocked.slice(0, 3)].join("\n").trim() };
};

export interface RoleFilesOptions {
	store: Store;
	/** Session changes are heard here; without it, `sync` is called by hand. */
	bus?: EventBus;
	log?: (line: string) => void;
	/** False to leave the folder unwatched: a file changed there is put back at the next sync. */
	watch?: boolean;
	/** Whether the system sandbox is on; asked before each pass. Tests answer for it. */
	confined?: () => boolean;
	/** How the script is run while the sandbox is on: in it, unless a test says otherwise. */
	run?: RunScript;
	/** The first wait before a pass that did not go through is tried again; tests shorten it. */
	retryAfter?: number;
}

export class RoleFiles {
	readonly #store: Store;
	readonly #log: (line: string) => void;
	readonly #watching: boolean;
	readonly #confined: () => boolean;
	readonly #run: RunScript;
	readonly #unsubscribe: (() => void) | null;
	/** What each session's file depends on, as last seen: a change of status is not one. */
	readonly #seen = new Map<string, string>();
	#state: RoleFilesState = { folder: null, files: 0, commits: "none", problem: null };
	#queue: Promise<RoleFilesState> = Promise.resolve(this.#state);
	#timer: NodeJS.Timeout | null = null;
	#watcher: { folder: string; watcher: FSWatcher } | null = null;
	/** The folder whose files are all committed, as far as Yew knows: nothing to ask git then. */
	#committed: string | null = null;
	readonly #retryFirst: number;
	#retryIn: number;
	#retry: NodeJS.Timeout | null = null;
	/** The last problem written to the log: one that stays is said once. */
	#logged: string | null = null;
	#closed = false;

	constructor(options: RoleFilesOptions) {
		this.#store = options.store;
		this.#log = options.log ?? (() => {});
		this.#watching = options.watch ?? true;
		this.#confined = options.confined ?? (() => activeSandbox() !== "none");
		this.#run = options.run ?? sandboxedRun;
		this.#retryFirst = options.retryAfter ?? RETRY_FIRST_MS;
		this.#retryIn = this.#retryFirst;
		this.#unsubscribe =
			options.bus?.subscribe((event) => {
				if (event.scope !== "global") return;
				if (event.event.type === "sessionsDeleted") this.#soon();
				if (event.event.type !== "sessionSummary") return;
				const { session } = event.event;
				if (this.#seen.get(session.id) === signature(session)) return;
				this.#seen.set(session.id, signature(session));
				this.#soon();
			}) ?? null;
	}

	state(): RoleFilesState {
		return this.#state;
	}

	close(): void {
		this.#closed = true;
		this.#unsubscribe?.();
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
		if (this.#retry) clearTimeout(this.#retry);
		this.#retry = null;
		this.#unwatch();
	}

	/** Makes the folder say what the roles are now, after any pass already under way. */
	sync(): Promise<RoleFilesState> {
		this.#queue = this.#queue.then(() =>
			this.#once().catch((error: unknown) => {
				const problem = { code: "folder" as const, detail: (error as Error).message };
				this.#settle(this.#state.folder ?? "", problem);
				this.#state = { ...this.#state, problem };
				return this.#state;
			}),
		);
		return this.#queue;
	}

	#soon(): void {
		if (this.#closed) return;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#timer = null;
			void this.sync();
		}, SETTLE_MS);
		this.#timer.unref();
	}

	/**
	 * After a pass: a problem is written to the log when it is new, and a pass that did not go
	 * through is tried again, each time after twice as long. Names taken by other files wait for
	 * the person instead.
	 */
	#settle(folder: string, problem: RoleFilesState["problem"]): void {
		const line = !problem
			? null
			: problem.code === "taken"
				? `roles folder ${folder}: other files have the names some roles need`
				: `roles folder ${folder}: ${
						{ folder: "not written", busy: "waiting for the repository", commit: "not committed" }[
							problem.code
						]
					}${problem.detail ? `: ${problem.detail}` : ""}`;
		if (line !== null && line !== this.#logged) this.#log(line);
		this.#logged = line;
		if (this.#retry) clearTimeout(this.#retry);
		this.#retry = null;
		if (!problem || problem.code === "taken") {
			this.#retryIn = this.#retryFirst;
			return;
		}
		if (this.#closed) return;
		this.#retry = setTimeout(() => {
			this.#retry = null;
			void this.sync();
		}, this.#retryIn);
		this.#retry.unref();
		this.#retryIn = Math.min(this.#retryIn * 2, RETRY_MAX_MS);
	}

	#unwatch(): void {
		this.#watcher?.watcher.close();
		this.#watcher = null;
	}

	#watch(folder: string): void {
		if (!this.#watching || this.#watcher?.folder === folder) return;
		this.#unwatch();
		try {
			// While a pass waits to be tried again, what happens in the folder waits with it: a write
			// that keeps failing would otherwise start the next pass itself.
			const watcher = watch(folder, { persistent: false }, () => {
				if (!this.#retry) this.#soon();
			});
			// A folder that went away is watched again once it is written again.
			watcher.on("error", () => this.#unwatch());
			this.#watcher = { folder, watcher };
		} catch {
			// Not there yet: it is watched once a pass has written it.
		}
	}

	/** The standing sessions that have a role; every session's signature is noted on the way. */
	#sessions(): Session[] {
		const sessions: Session[] = [];
		let cursor: string | null = null;
		do {
			const page = this.#store.listSessions({ cursor, limit: 200 });
			sessions.push(...page.items);
			cursor = page.nextCursor;
		} while (cursor !== null);
		for (const session of sessions) this.#seen.set(session.id, signature(session));
		return sessions.filter(
			(session) => session.kind === "standing" && session.responsibility.trim() !== "",
		);
	}

	async #once(): Promise<RoleFilesState> {
		const folder = this.#store.getSetting<string | null>("rolesFolder", null);
		if (!folder) {
			this.#unwatch();
			this.#committed = null;
			this.#settle("", null);
			this.#state = { folder: null, files: 0, commits: "none", problem: null };
			return this.#state;
		}
		const words =
			WORDS[this.#store.getSetting<string>("language", "system") === "en" ? "en" : "zh"];
		const before = this.#store.getSetting<Saved | null>("roleFiles", null);
		// Another folder starts empty-handed: what was written into the earlier one stays there.
		const saved: Saved =
			before?.folder === folder
				? { folder, files: { ...before.files }, ...(before.readme ? { readme: true } : {}) }
				: { folder, files: {} };
		const repository = repositoryOf(folder);
		const confined = this.#confined();
		// Git runs only in the sandbox.
		const root = repository.kind === "main" && confined ? repository.root : null;
		const commits: RoleFilesState["commits"] =
			repository.kind === "none"
				? "none"
				: repository.kind === "linked"
					? "linked"
					: confined
						? "on"
						: "sandbox";
		// The setting names a real folder. A path that now leads somewhere else was changed since, and
		// nothing is written through it.
		const real = canonical(folder);
		if (real !== folder) {
			const problem = { code: "folder" as const, detail: `it is now a link to ${real}` };
			this.#committed = null;
			this.#settle(folder, problem);
			this.#state = { folder, files: Object.keys(saved.files).length, commits, problem };
			return this.#state;
		}
		const at = (file: string) => look(join(folder, file));
		const steps: Step[] = [];
		/**
		 * For a file Yew wrote that now holds something else, in a repository: the subject of the
		 * commit that takes what is in it, before the file is replaced or removed.
		 */
		const edited = (kept: Kept): { keep?: string } => {
			const now = at(kept.file);
			if (!root || now === "none") return {};
			if (typeof now === "object" && sha(now.text) === kept.sha) return {};
			return { keep: words.keep(kept.name) };
		};

		const wanted = this.#sessions();
		const wantedIds = new Set(wanted.map((session) => session.id));
		const changes: { subject: string; files: string[] }[] = [];

		// Files of sessions that are gone, archived, no longer standing, or without a role.
		const leaving = Object.entries(saved.files).filter(([id]) => !wantedIds.has(id));
		for (const [, kept] of leaving) {
			steps.push({ do: "remove", file: kept.file, ...edited(kept) });
			changes.push({ subject: words.remove(kept.name), files: [kept.file] });
		}

		// Names in use: a session keeps its file while its name still gives that file's name.
		const taken = new Set(RESERVED.map((name) => name.toLowerCase()));
		for (const session of wanted) {
			const kept = saved.files[session.id];
			if (kept && namedFor(kept.file, stemOf(session.name))) taken.add(kept.file.toLowerCase());
		}
		const inTheWay: string[] = [];
		const writing: { id: string; file: string; text: string; name: string; old?: string }[] = [];
		for (const session of wanted) {
			const kept = saved.files[session.id];
			const text = fileText(session.responsibility);
			const stem = stemOf(session.name);
			let file: string;
			if (kept && namedFor(kept.file, stem)) file = kept.file;
			else {
				file = `${stem}.md`;
				for (let n = 2; taken.has(file.toLowerCase()); n++) file = `${stem} ${n}.md`;
				// What Yew did not write is left alone, unless it is a file that already says the same.
				const there = at(file);
				if (there !== "none" && !(typeof there === "object" && there.text === text)) {
					inTheWay.push(file);
					continue;
				}
				taken.add(file.toLowerCase());
			}
			const now = at(file);
			const same = typeof now === "object" && now.text === text;
			const renamed = kept !== undefined && kept.file !== file;
			if (renamed) steps.push({ do: "remove", file: kept.file, ...edited(kept) });
			if (!same) steps.push({ do: "write", file, text, ...(kept && !renamed ? edited(kept) : {}) });
			const subject = renamed
				? words.rename(kept.name, session.name)
				: !kept
					? words.add(session.name)
					: same
						? null
						: sha(text) === kept.sha
							? words.restore(session.name)
							: words.update(session.name);
			if (subject) changes.push({ subject, files: renamed ? [kept.file, file] : [file] });
			writing.push({
				id: session.id,
				file,
				text,
				name: session.name,
				...(renamed ? { old: kept.file } : {}),
			});
		}
		if (!saved.readme && at(README) === "none") {
			steps.push({ do: "write", file: README, text: words.text });
			changes.push({ subject: words.readme, files: [README] });
		}

		// One commit for what this pass changes, and for what an earlier pass could not commit.
		if (root && (changes.length > 0 || this.#committed !== folder)) {
			const [only] = changes;
			steps.push({
				do: "commit",
				files: [
					...new Set([
						...changes.flatMap((change) => change.files),
						...Object.values(saved.files).map((kept) => kept.file),
						...writing.map((item) => item.file),
					]),
				],
				subject:
					changes.length === 0
						? words.pending
						: changes.length === 1 && only
							? only.subject
							: words.several(changes.length),
				...(changes.length > 1
					? { body: changes.map((change) => `- ${change.subject}`).join("\n") }
					: {}),
			});
		}

		let problem: RoleFilesState["problem"] = null;
		if (steps.length > 0) {
			const plan: RolePlan = { folder, root, steps };
			const ran = await (confined ? this.#run : directRun)(plan, scriptEnvironment());
			let results: StepResult[] = [];
			try {
				results = ran.ok ? (JSON.parse(ran.out) as StepResult[]) : [];
			} catch {
				// Counted as a script that did not finish.
			}
			const failed = results.filter((result) => !result.ok);
			const files = failed.find((result) => !result.busy && !result.git);
			const refused = failed.find((result) => result.git);
			if (results.length !== steps.length || files) {
				problem = { code: "folder", detail: files?.detail ?? ran.err.split("\n")[0] ?? "" };
			} else if (failed.some((result) => result.busy)) {
				problem = { code: "busy", detail: "" };
			} else if (refused) {
				problem = { code: "commit", detail: refused.detail ?? "" };
			}
		}

		// What is recorded as written is what is there now.
		for (const [id, kept] of leaving) {
			if (at(kept.file) === "none") delete saved.files[id];
		}
		for (const item of writing) {
			// A file under an earlier name that could not be removed yet is still the one on record.
			if (item.old !== undefined && at(item.old) !== "none") continue;
			const now = at(item.file);
			if (typeof now === "object" && now.text === item.text) {
				saved.files[item.id] = { file: item.file, sha: sha(item.text), name: item.name };
			}
		}
		if (at(README) !== "none") saved.readme = true;
		if (JSON.stringify(saved) !== JSON.stringify(before)) {
			this.#store.setSetting("roleFiles", saved);
		}
		// Everything Yew wrote is in the repository, as far as this pass saw; never while git is not run.
		this.#committed = problem === null && commits !== "sandbox" ? folder : null;
		if (inTheWay.length > 0 && problem === null) {
			problem = { code: "taken", detail: inTheWay.join(", ") };
		}
		this.#settle(folder, problem);
		this.#watch(folder);
		this.#state = { folder, files: Object.keys(saved.files).length, commits, problem };
		return this.#state;
	}
}
