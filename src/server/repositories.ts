import {
	chmodSync,
	type Dirent,
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * The git repositories in the folders a command may write: where they are, the hooks and settings
 * that would run programs outside the sandbox the next time the person uses git there, and the check
 * after a command that moves a new hook aside and names changed settings.
 */

/** Folders a walk for repositories skips: dependencies and build output, which hold none of the person's. */
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
 * The hooks and settings of the repositories under a writable folder: changed, they would run
 * commands outside the sandbox the next time the person uses git there. macOS takes patterns, which
 * also cover what is made while a command runs. bubblewrap takes only paths, so on Linux each
 * repository there now is listed, nested ones and submodules too; what a command makes is checked
 * when it ends (checkRepositories).
 */
export function gitInternals(
	folder: string,
	platform: NodeJS.Platform = process.platform,
): string[] {
	if (platform === "darwin") {
		return ["", "/**"].flatMap((under) => [
			`${folder}${under}/.git/**/hooks`,
			`${folder}${under}/.git/**/hooks/**`,
			`${folder}${under}/.git/**/config`,
			`${folder}${under}/.git/**/config.worktree`,
		]);
	}
	return findRepositories(folder).flatMap((repository) => {
		if (!repository.folder) return [repository.git];
		const { hooks, configs } = repositoryParts(repository.git);
		// Only what is there: a path bubblewrap does not find would need a placeholder made for it.
		return [...hooks, ...configs].filter((path) => existsSync(path));
	});
}

/** What the repositories in some folders held before a command: hooks and settings. */
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
const hookNames = (dir: string) =>
	entries(dir)
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
 * After a command (Linux): a hook it added or changed in a repository of its working folder is
 * moved aside, so git will not run it, and said; changed settings and repositories it made, which
 * were not protected while it ran, are said too.
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
