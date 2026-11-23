import {
	chmodSync,
	closeSync,
	constants,
	type Dirent,
	existsSync,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	readSync,
	realpathSync,
	renameSync,
	statSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";

/**
 * The git repositories in the folders a command may write. git runs programs for the person outside
 * the sandbox from a repository's hooks and settings, so a command in the sandbox must leave none
 * behind:
 * - while it runs, the hooks and settings of the repositories that are there are closed to it
 *   (gitInternals, and the paths noteRepositories lists);
 * - when it ends, every `.git` in its folders has to lead to a git folder that was there before it;
 *   one that does not is moved aside (settleRepositories).
 * A repository setup the person approved outside the sandbox is looked at in its own way
 * (snapshotRepositories, checkRepositories): there a new repository is what the command is for.
 */

/**
 * Folders the walk after an approved setup skips: dependencies and build output, which hold none
 * of the person's. The walk around a sandboxed command skips none: a command can make a repository
 * in any folder it may write.
 */
const NOT_REPOSITORIES = new Set([
	"node_modules",
	".venv",
	"venv",
	".tox",
	"__pycache__",
	".gradle",
	".next",
	".nuxt",
	".cache",
	"target",
	"Pods",
	"DerivedData",
]);
/** How far and how wide a walk for repositories goes, so a huge working folder stays quick. */
const WALK_DEPTH = 8;
const WALK_FOLDERS = 20_000;

const entries = (dir: string): Dirent[] => {
	try {
		return readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
};

/**
 * The repositories in a folder, at any depth: each `.git`, a folder, or a file where a worktree or a
 * submodule points elsewhere. Symbolic links are not followed.
 */
export function findRepositories(folder: string): { git: string; folder: boolean }[] {
	const found: { git: string; folder: boolean }[] = [];
	let visited = 0;
	const walk = (dir: string, depth: number) => {
		if (visited++ >= WALK_FOLDERS) return;
		for (const entry of entries(dir)) {
			if (entry.name === ".git") {
				found.push({ git: join(dir, entry.name), folder: entry.isDirectory() });
			} else if (entry.isDirectory() && depth < WALK_DEPTH && !NOT_REPOSITORIES.has(entry.name)) {
				walk(join(dir, entry.name), depth + 1);
			}
		}
	};
	walk(folder, 0);
	return found;
}

/** The hooks folders and settings files of a `.git` folder, its submodules' and its worktrees'. */
function repositoryParts(git: string): { hooks: string[]; configs: string[] } {
	const hooks = [join(git, "hooks")];
	const configs = [join(git, "config"), join(git, "config.worktree")];
	const walk = (dir: string, depth: number) => {
		for (const entry of entries(dir)) {
			const path = join(dir, entry.name);
			if (entry.name === "hooks") hooks.push(path);
			else if (entry.name === "config" || entry.name === "config.worktree") configs.push(path);
			else if (entry.isDirectory() && depth > 0) walk(path, depth - 1);
		}
	};
	walk(join(git, "modules"), 6);
	walk(join(git, "worktrees"), 1);
	return { hooks, configs };
}

/**
 * What git reads in a git folder to find the programs it runs: its hooks, its settings, and the two
 * files that send it elsewhere for them (`commondir`) or name a worktree's place (`gitdir`).
 */
const PARTS = ["hooks", "config", "config.worktree", "commondir", "gitdir"];

/** A name as a pattern that takes it in any case: macOS volumes usually take `HOOKS` for `hooks`. */
const anyCase = (name: string) =>
	name.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`);

/**
 * macOS: patterns that close those parts in every `.git` under a writable folder, in the ones made
 * while a command runs too. bubblewrap takes only paths, so on Linux there are none. A pattern holds
 * only while the folder is called `.git`, and a command could rename one, write in it and rename it
 * back: so parts that exist are closed by path as well (closedPaths), which also keeps the folders
 * above them where they are.
 */
export function gitInternals(
	folder: string,
	platform: NodeJS.Platform = process.platform,
): string[] {
	if (platform !== "darwin") return [];
	return ["", "/**"].flatMap((under) =>
		PARTS.flatMap((part) => {
			const pattern = `${folder}${under}/.git/**/${anyCase(part)}`;
			return part === "hooks" ? [pattern, `${pattern}/**`] : [pattern];
		}),
	);
}

/** How much of a folder is looked through for repositories, so a huge one stays quick. */
export interface WalkLimits {
	/** Folders read before a command. */
	folders: number;
	/** Milliseconds spent on that. */
	ms: number;
	/** Folders a command made that are read after it. */
	fresh: number;
}
const LIMITS: WalkLimits = { folders: 50_000, ms: 500, fresh: 50_000 };
/** How many folders are read at a time. */
const WALK_WIDTH = 8;
/** What a `.git` or `commondir` file is read up to: more than a path can be long. */
const POINTER_BYTES = 8192;
/** The mark on what was moved aside. A folder with it in its name is not looked into again. */
const ASIDE = ".blocked-by-yew";

/** A git folder: known by its device and inode, wherever it is moved. */
interface GitFolder {
	id: string;
	dir: string;
}

/** What the folders a command may write held before it: see noteRepositories. */
export interface Repositories {
	folders: string[];
	/** The folders that were listed, and the ones seen and left alone because of the limits. */
	read: Set<string>;
	beyond: Set<string>;
	/** Each `.git` found, with what it led to. */
	entries: Map<string, string>;
	/** The git folders there, by device and inode, each with the parts it had. */
	known: Map<string, Set<string>>;
	/** What is closed to the command while it runs: those parts, and the `.git` files. */
	closed: string[];
}

/** A name as a volume that ignores case, or skips characters outside ASCII, may take it. */
const folded = (name: string) => name.replace(/[^ -~]/g, "").toLowerCase();

const inside = (folders: string[]) => (path: string) =>
	folders.some((folder) => path === folder || path.startsWith(folder + sep));

const isFolder = (path: string) => {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
};

/** Whether there is anything of that name, a link that leads nowhere included. */
const present = (path: string) => {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
};

const partsOf = (dir: string) => PARTS.filter((part) => present(join(dir, part)));

/** A path as the system has it: links followed, names in the case they are stored in. */
const stored = (path: string) => {
	try {
		return realpathSync.native(path);
	} catch {
		return path;
	}
};

/**
 * The folder a path leads to, as the system follows it and so as git does: `a/../b` goes through
 * what `a` links to, which reading the text would miss.
 */
function folderAt(path: string): GitFolder | null {
	try {
		const stat = statSync(path, { bigint: true });
		if (!stat.isDirectory()) return null;
		return { id: `${stat.dev}:${stat.ino}`, dir: realpathSync.native(path) };
	} catch {
		return null;
	}
}

/**
 * The path a file names for git, read the way git reads it: what follows `prefix`, without the line
 * end. Null when it is not a regular file. `path` is null when the file is longer than a path can
 * be, is not plain text or holds more than the one line: this code could not follow git there, so
 * it leads nowhere known. `stamp` tells whether such a file changed.
 */
function pointer(file: string, prefix: string): { stamp: string; path: string | null } | null {
	let fd: number | null = null;
	try {
		if (!statSync(file).isFile()) return null;
		// Without waiting, should something else have been put there meanwhile.
		fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY);
		const stat = fstatSync(fd);
		if (!stat.isFile()) return null;
		const unread = { stamp: `${stat.size}:${stat.mtimeMs}`, path: null };
		const buffer = Buffer.alloc(POINTER_BYTES + 1);
		const length = readSync(fd, buffer, 0, buffer.length, 0);
		if (length > POINTER_BYTES) return unread;
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
				buffer.subarray(0, length),
			);
		} catch {
			return unread;
		}
		const path = text.startsWith(prefix) ? text.slice(prefix.length).replace(/[\r\n]+$/, "") : "";
		const plain = path !== "" && !path.includes("\0") && !/[\r\n]/.test(path);
		return { stamp: text, path: plain ? path : null };
	} catch {
		return null;
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

/** A `.git` as git takes it. */
interface Lead {
	/** What it leads to, to tell whether that changed: a git folder, or else what it is and holds. */
	lead: string;
	/** The git folder: itself, the folder a link points to, or the one a `.git` file names. */
	git: GitFolder | null;
	/** Whether it is a file of its own, not a folder or a link. */
	file: boolean;
}

function leadOf(path: string): Lead {
	let file = false;
	let link = "";
	try {
		const own = lstatSync(path);
		file = own.isFile();
		if (own.isSymbolicLink()) link = readlinkSync(path);
	} catch {
		return { lead: "gone", git: null, file };
	}
	const folder = folderAt(path);
	if (folder) return { lead: `folder:${folder.id}`, git: folder, file };
	// A `.git` file, which git reads through a link too.
	const named = pointer(path, "gitdir: ");
	if (!named) return { lead: `other:${link}`, git: null, file };
	const to = named.path;
	const git = to === null ? null : folderAt(to.startsWith("/") ? to : `${dirname(path)}/${to}`);
	return { lead: git ? `folder:${git.id}` : `file:${named.stamp}`, git, file };
}

/** Where a git folder's `commondir` sends git for its hooks and settings, when it has one. */
function commonOf(dir: string): GitFolder | null {
	const to = pointer(join(dir, "commondir"), "")?.path ?? null;
	return to === null ? null : folderAt(to.startsWith("/") ? to : `${dir}/${to}`);
}

/** git's own test of a folder: a HEAD, and objects and refs, there or where a `commondir` sends it. */
const looksLikeGit = (names: Set<string>) =>
	names.has("head") && ((names.has("objects") && names.has("refs")) || names.has("commondir"));

interface Walked {
	read: Set<string>;
	beyond: Set<string>;
	/** Folders a command made that were not looked at: more than the limit. */
	unread: number;
	/** Every `.git` found. */
	entries: Map<string, Lead>;
	/**
	 * Every git folder found, by device and inode: what a `.git` leads to, what holds a HEAD with
	 * objects and refs, and where a `commondir` sends git.
	 */
	gits: Map<string, string>;
	/** The ones among them found by what they hold. */
	laid: Map<string, string>;
}

/**
 * Goes through `folders` level by level for every `.git` and every folder laid out as a git folder
 * (a bare repository; git takes one for a repository when run inside it), and into the `modules`
 * and `worktrees` of each git folder, where submodules' and worktrees' git folders are. Links are
 * not followed. Before a command it stops at the limits and notes what it left. After one (`before`
 * given) it reads the same folders again and the ones made since, and leaves alone what the limits
 * kept it from before: nothing is known of what was there.
 */
async function walk(folders: string[], limits: WalkLimits, before?: Repositories): Promise<Walked> {
	const within = inside(folders);
	const walked: Walked = {
		read: new Set(),
		beyond: new Set(),
		unread: 0,
		entries: new Map(),
		gits: new Map(),
		laid: new Map(),
	};
	const started = performance.now();
	const queued = new Set<string>();
	let fresh = 0;
	let next: string[] = [];
	const push = (dir: string) => {
		if (queued.has(dir) || before?.beyond.has(dir)) return;
		queued.add(dir);
		next.push(dir);
	};
	const git = (found: GitFolder) => {
		if (walked.gits.has(found.id)) return;
		walked.gits.set(found.id, found.dir);
		const common = commonOf(found.dir);
		if (common) git(common);
		if (!within(found.dir)) return;
		for (const name of ["modules", "worktrees"]) {
			const dir = join(found.dir, name);
			if (isFolder(dir)) push(dir);
		}
	};
	const visit = async (dir: string) => {
		if (before) {
			if (!before.read.has(dir) && ++fresh > limits.fresh) {
				walked.unread++;
				return;
			}
		} else if (walked.read.size >= limits.folders || performance.now() - started > limits.ms) {
			walked.beyond.add(dir);
			return;
		}
		walked.read.add(dir);
		let list: Dirent[];
		try {
			list = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		if (looksLikeGit(new Set(list.map((entry) => folded(entry.name))))) {
			const found = folderAt(dir);
			if (found) {
				git(found);
				walked.laid.set(found.id, found.dir);
			}
		}
		for (const entry of list) {
			if (entry.name.includes(ASIDE)) continue;
			const path = join(dir, entry.name);
			if (folded(entry.name) === ".git") {
				const led = leadOf(path);
				walked.entries.set(path, led);
				if (led.git) git(led.git);
			} else if (entry.isDirectory()) {
				push(path);
			}
		}
	};
	for (const folder of folders) push(folder);
	while (next.length > 0) {
		const level = next;
		next = [];
		let index = 0;
		const worker = async () => {
			while (index < level.length) await visit(level[index++] as string);
		};
		await Promise.all(Array.from({ length: WALK_WIDTH }, worker));
	}
	return walked;
}

/**
 * Notes the repositories in the folders a command may write, before it runs: every `.git` with the
 * git folder it leads to, and every git folder by device and inode with the parts it has. Those
 * parts and the `.git` files are to be closed to the command by path (`closed`, closedPaths): the
 * sandbox then also refuses to rename them and the folders above them.
 */
export async function noteRepositories(
	folders: string[],
	limits: WalkLimits = LIMITS,
): Promise<Repositories> {
	const roots = [...new Set(folders.map(stored))];
	const walked = await walk(roots, limits);
	const known = new Map<string, Set<string>>();
	const closed = new Set<string>();
	for (const [id, dir] of walked.gits) {
		const parts = partsOf(dir);
		known.set(id, new Set(parts));
		for (const part of parts) closed.add(join(dir, part));
	}
	const leads = new Map<string, string>();
	for (const [path, led] of walked.entries) {
		leads.set(path, led.lead);
		// A `.git` file stays as it is. A link is not closed: that would close what it points to.
		if (led.file) closed.add(path);
	}
	return {
		folders: roots,
		read: walked.read,
		beyond: walked.beyond,
		entries: leads,
		known,
		closed: [...closed],
	};
}

/**
 * How many git folders inside a `.git` are held in place by path on macOS. The sandbox takes longer
 * to start with every path it is given, and more so the more there are: about 0.1 s for this many.
 */
const HELD = 100;

/**
 * The paths among `closed` to give the sandbox by name. On Linux all of them. On macOS the patterns
 * of gitInternals already close the parts of a git folder inside a `.git`, as long as the folder
 * keeps that name: one path in each such git folder is enough to keep it and the folders above it
 * from being renamed, for the first `held` of them. The rest is closed by name whatever their
 * number: the `.git` files and the parts of git folders elsewhere (a bare repository, a git folder
 * a `.git` file points to), which no pattern covers.
 */
export function closedPaths(
	before: Pick<Repositories, "folders" | "closed">,
	platform: NodeJS.Platform = process.platform,
	held = HELD,
): string[] {
	if (platform !== "darwin") return before.closed;
	const kept = new Set<string>();
	return before.closed.filter((path) => {
		const root = before.folders.find((folder) => path.startsWith(folder + sep));
		if (!root || !path.slice(root.length).split(sep).slice(0, -1).includes(".git")) return true;
		const git = dirname(path);
		if (kept.has(git) || kept.size >= held) return false;
		kept.add(git);
		return true;
	});
}

/**
 * Takes the repository an approved setup made at `folder` as there before, so that a command still
 * running in the sandbox does not move it aside when it ends: the git folder its `.git` leads to,
 * and the folder itself when it is a bare repository. Nothing else in it.
 */
export function admitRepository(before: Repositories, folder: string): void {
	const found = [leadOf(join(folder, ".git")).git];
	if (looksLikeGit(new Set(entries(folder).map((entry) => folded(entry.name)))))
		found.push(folderAt(folder));
	for (const git of found) {
		if (git && !before.known.has(git.id)) before.known.set(git.id, new Set(partsOf(git.dir)));
	}
}

/** Moves `path` to a name beside it that git does not look for; the new name, or why it could not. */
function aside(path: string): { to: string } | { error: string } {
	const dir = dirname(path);
	try {
		// Only where it was found: with a link put in a folder's place, something else would be moved.
		if (realpathSync.native(dir) !== dir) return { error: "a folder above it is a link now" };
		let to = `${path}${ASIDE}`;
		if (present(to)) to = `${to}-${Date.now()}`;
		renameSync(path, to);
		return { to };
	} catch (error) {
		return { error: (error as Error).message };
	}
}

/** Moves `path` aside and says so: `what` happened, and `so` is what that does about it. */
function moved(what: string, path: string, so: string): string {
	const result = aside(path);
	return "to" in result
		? `${what} Yew Harness moved ${path} to ${basename(result.to)}${so}`
		: `${what} ${path} could not be moved aside (${result.error}): check it before using git there.`;
}

const MAKE_OUTSIDE =
	"A command in the sandbox cannot leave a repository, worktree or submodule checkout behind: make them with outside_sandbox. If the person made one of these meanwhile, renaming it back restores it.";

/**
 * After a command in the sandbox. git runs the programs a repository names, so a command must not
 * leave one of its own making where the person will use git:
 * - every `.git` in its folders has to lead to a git folder that was there before, or be as it was;
 * - every folder laid out as a git folder has to be one that was there before;
 * - a git folder that was there must not have gained hooks, settings or a `commondir` (the ones it
 *   had were closed while the command ran).
 * What does not hold is moved aside under a name git does not look for, and said in one line each.
 * Who made it cannot be told, so a repository the person made in those folders meanwhile is moved
 * too; one an approved setup made is taken out first (admitRepository).
 */
export async function settleRepositories(
	before: Repositories,
	limits: WalkLimits = LIMITS,
): Promise<string[]> {
	const notes: string[] = [];
	const walked = await walk(before.folders, limits, before);
	const within = inside(before.folders);
	for (const [id, dir] of walked.gits) {
		const had = before.known.get(id);
		if (!had || !within(dir)) continue;
		for (const part of PARTS) {
			const path = join(dir, part);
			if (had.has(part) || !present(path)) continue;
			notes.push(
				moved(
					`${path} appeared in a repository while the command ran.`,
					path,
					", so git does not use it outside the sandbox.",
				),
			);
		}
	}
	const parts = notes.length;
	for (const [id, dir] of walked.laid) {
		const head = join(dir, "HEAD");
		if (before.known.has(id) || !present(head)) continue;
		notes.push(
			moved(
				`A git folder appeared at ${dir} while the command ran.`,
				head,
				": without a HEAD git does not take the folder for a repository.",
			),
		);
	}
	for (const [path, led] of walked.entries) {
		if (led.git && before.known.has(led.git.id)) continue;
		if (led.lead === "gone" || before.entries.get(path) === led.lead) continue;
		notes.push(
			moved(
				`A repository appeared at ${dirname(path)} while the command ran.`,
				path,
				", so git does not use it outside the sandbox.",
			),
		);
	}
	if (notes.length > parts) notes.push(MAKE_OUTSIDE);
	if (before.beyond.size > 0) {
		const some = [...before.beyond].slice(0, 3).join(", ");
		notes.push(
			`The folders the command may write hold more folders than Yew Harness reads in the time it takes: ${before.beyond.size} were not looked through for repositories, such as ${some}.`,
		);
	}
	if (walked.unread > 0) {
		notes.push(
			`The command made more folders than Yew Harness looks through for repositories: ${walked.unread} were not looked at.`,
		);
	}
	return notes;
}

/** What the repositories in some folders held before a repository setup: hooks and settings. */
export interface RepositoryState {
	folders: string[];
	repositories: Set<string>;
	/** Each hook (not the samples) and settings file, with its size and time or its text. */
	files: Map<string, string>;
}

const stamp = (path: string): string | null => {
	try {
		const stat = statSync(path);
		return stat.isFile() ? `${stat.size}:${stat.mtimeMs}` : null;
	} catch {
		return null;
	}
};
const text = (path: string): string | null => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
};
// A hooks folder that is a link is left alone: what it points to is not the repository's.
const hookNames = (dir: string) =>
	(isFolder(dir) ? entries(dir) : [])
		.filter((entry) => entry.isFile() && !entry.name.endsWith(".sample"))
		.map((entry) => entry.name)
		.filter((name) => !name.includes(".blocked-by-yew"));

/** Notes what the repositories in `folders` hold now, to compare with when a command has ended. */
export function snapshotRepositories(folders: string[]): RepositoryState {
	const files = new Map<string, string>();
	const repositories = new Set<string>();
	for (const folder of folders) {
		for (const repository of findRepositories(folder)) {
			repositories.add(repository.git);
			if (!repository.folder) continue;
			const { hooks, configs } = repositoryParts(repository.git);
			for (const dir of hooks) {
				for (const name of hookNames(dir)) {
					const now = stamp(join(dir, name));
					if (now) files.set(join(dir, name), now);
				}
			}
			for (const config of configs) {
				const now = text(config);
				if (now !== null) files.set(config, now);
			}
		}
	}
	return { folders, repositories, files };
}

/** Settings that make git run a program: worth naming when a command wrote them. */
const RUNS_PROGRAMS =
	/^\s*(hookspath|fsmonitor|sshcommand|askpass|gitproxy|pager|editor|textconv|program|helper|uploadpack|receivepack)\s*=|^\s*\[(filter|diff|merge|alias|credential|include|includeif|sequence|gpg)\b/gim;

/**
 * After a repository setup outside the sandbox: a hook it added or changed in a repository of its
 * folders is moved aside, so git will not run it, and said; changed settings and the repositories it
 * made are said too.
 */
export function checkRepositories(before: RepositoryState): string[] {
	const notes: string[] = [];
	// A repository found from two of the folders, or by two spellings of one folder, is checked once.
	const seen = new Set<string>();
	for (const folder of before.folders) {
		for (const repository of findRepositories(folder)) {
			let real = repository.git;
			try {
				real = realpathSync(repository.git);
			} catch {}
			if (seen.has(real)) continue;
			seen.add(real);
			const made = !before.repositories.has(repository.git);
			const where = dirname(repository.git);
			if (!repository.folder) {
				if (made)
					notes.push(`The command made a repository at ${where}; check it before using git there.`);
				continue;
			}
			const { hooks, configs } = repositoryParts(repository.git);
			for (const dir of hooks) {
				for (const name of hookNames(dir)) {
					const path = join(dir, name);
					const was = before.files.get(path);
					if (was !== undefined && was === stamp(path)) continue;
					let aside = `${path}.blocked-by-yew`;
					if (existsSync(aside)) aside = `${aside}-${Date.now()}`;
					try {
						renameSync(path, aside);
						chmodSync(aside, 0o644);
						notes.push(
							`The command ${was === undefined ? "added" : "changed"} the git hook ${path}. Yew Harness moved it to ${aside}, so git does not run it outside the sandbox.`,
						);
					} catch (error) {
						notes.push(
							`The command ${was === undefined ? "added" : "changed"} the git hook ${path}, and it could not be moved aside (${(error as Error).message}). Check it before using git there.`,
						);
					}
				}
			}
			for (const config of configs) {
				const now = text(config);
				if (now === null || before.files.get(config) === now) continue;
				if (made && config !== join(repository.git, "config")) continue;
				const risky = [
					...new Set(
						[...now.matchAll(RUNS_PROGRAMS)].map((match) =>
							(match[1] ?? match[2] ?? "").toLowerCase(),
						),
					),
				];
				const named =
					risky.length > 0 ? ` It sets ${risky.join(", ")}, which can run programs.` : "";
				notes.push(
					made
						? `The command made a repository at ${where}; its settings were not protected while it ran. Check ${config} before using git there.${named}`
						: `The command changed ${config}. Check it before using git there.${named}`,
				);
			}
		}
	}
	return notes;
}
