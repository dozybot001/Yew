import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { invalid } from "./errors.ts";
import { errorResult, str, type ToolDefinition, type ToolResult, text } from "./tools/types.ts";

/** Official skills bundled with Yew Harness (both source checkout and installed npm package). */
export const BUILTIN_SKILLS_DIR = fileURLToPath(new URL("../../skills-builtin", import.meta.url));

/**
 * Skills, memory folders and the instruction files Yew reads besides its own:
 * what a person already has for other tools works here as it is, alongside official skills bundled
 * in `skills-builtin/` (which user global and workspace skills of the same name override).
 *
 * A skill is a folder with a SKILL.md (the open standard): front matter with a name and a
 * description, then instructions. The prompt lists names and descriptions only; the model reads a
 * skill in full with the `skill` tool when a task calls for it.
 */

export interface Skill {
	/** Stable identifier: `builtin:<name>` for bundled skills, real folder path for user/workspace skills. */
	id: string;
	name: string;
	description: string;
	/** The skill's folder: its scripts and reference files are here. */
	dir: string;
	file: string;
	/** True when bundled with Yew Harness itself. */
	builtin?: boolean;
}

const MAX_SKILLS = 200;
const MAX_SKILL_CHARS = 60_000;
const MAX_INDEX_BYTES = 8 * 1024;

/** `name` and `description` from the front matter; quoted values and folded lines are read plainly. */
export function frontMatter(source: string): Record<string, string> {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
	const fields: Record<string, string> = {};
	if (!match) return fields;
	let key: string | null = null;
	for (const line of (match[1] as string).split(/\r?\n/)) {
		const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
		if (pair) {
			key = pair[1] as string;
			const value = (pair[2] as string).trim();
			// `>` and `|` start a block whose lines follow, indented.
			fields[key] = /^[>|][+-]?$/.test(value) ? "" : value.replace(/^(["'])(.*)\1$/, "$2");
		} else if (key && /^\s+\S/.test(line)) {
			fields[key] = `${fields[key]} ${line.trim()}`.trim();
		} else {
			key = null;
		}
	}
	return fields;
}

/** Why a folder in a skills folder is not a skill sessions can use. */
export type SkillProblem = "no-file" | "unreadable" | "bad-name";

/** A folder that looks like a skill but cannot be used, for the settings list. */
export interface BrokenSkill {
	/** The folder's own name. */
	name: string;
	dir: string;
	reason: SkillProblem;
}

const realOr = (path: string): string => {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
};

/** Everything in one skills folder: the skills, and the folders that are not usable with the reason. */
function scan(folder: string, builtin = false): { skills: Skill[]; broken: BrokenSkill[] } {
	const skills: Skill[] = [];
	const broken: BrokenSkill[] = [];
	let names: string[];
	try {
		names = readdirSync(folder).sort();
	} catch {
		return { skills, broken };
	}
	for (const entry of names) {
		const dir = join(folder, entry);
		const file = join(dir, "SKILL.md");
		const fail = (reason: SkillProblem) => broken.push({ name: entry, dir: realOr(dir), reason });
		try {
			// Loose files and hidden folders in a skills folder are not skills that went wrong.
			if (!statSync(dir).isDirectory()) continue;
		} catch {
			continue;
		}
		try {
			if (!statSync(file).isFile()) {
				if (!entry.startsWith(".")) fail("no-file");
				continue;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("unreadable");
			else if (!entry.startsWith(".")) fail("no-file");
			continue;
		}
		try {
			const fields = frontMatter(readFileSync(file, "utf8"));
			const name = (fields.name || entry).trim();
			if (!/^[\w.-]{1,64}$/.test(name)) {
				fail("bad-name");
				continue;
			}
			const realDir = realpathSync(dir);
			skills.push({
				id: builtin ? `builtin:${name}` : realDir,
				name,
				description: (fields.description ?? "").replace(/\s+/g, " ").slice(0, 400),
				dir: realDir,
				file: realpathSync(file),
				...(builtin ? { builtin: true } : {}),
			});
		} catch {
			fail("unreadable");
		}
	}
	return { skills, broken };
}

/** The folders skills are looked for in, later ones winning over earlier ones with the same name. */
export function skillFolders(
	cwd: string | null,
	yewHome: string,
	userHome: string | null = homedir(),
	builtinDir: string | null = BUILTIN_SKILLS_DIR,
): string[] {
	const folders: string[] = [];
	if (builtinDir) folders.push(builtinDir);
	folders.push(join(yewHome, "skills"));
	if (userHome) folders.push(join(userHome, ".claude", "skills"));
	if (cwd) {
		for (const local of [".agents", ".claude", ".yew"]) folders.push(join(cwd, local, "skills"));
	}
	return folders;
}

/**
 * The skills a session working in `cwd` gets. `disabled` holds the IDs of skills switched off in
 * the settings (`builtin:<name>` for bundled skills, real folder path for user/workspace skills);
 * a skill that is off is left out before names are compared, so turning off a project's skill
 * leaves the global or built-in one of the same name.
 */
export function findSkills(
	cwd: string | null,
	yewHome: string,
	userHome: string | null = homedir(),
	disabled: readonly string[] = [],
	builtinDir: string | null = BUILTIN_SKILLS_DIR,
): Skill[] {
	const byName = new Map<string, Skill>();
	if (builtinDir) {
		for (const skill of scan(builtinDir, true).skills) {
			if (!disabled.includes(skill.id) && !disabled.includes(skill.dir)) {
				byName.set(skill.name, skill);
			}
		}
	}
	for (const folder of skillFolders(cwd, yewHome, userHome, null)) {
		for (const skill of scan(folder).skills) {
			if (!disabled.includes(skill.id) && !disabled.includes(skill.dir)) {
				byName.set(skill.name, skill);
			}
		}
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_SKILLS);
}

/** Where a listed skill comes from: official built-in, the global folders, or a saved workspace's folders. */
export type SkillSource =
	| { kind: "builtin" }
	| { kind: "global" }
	| { kind: "workspace"; name: string; path: string };

/** One row of the skills list in the settings. */
export interface SkillEntry {
	/** Stable ID: `builtin:<name>` for bundled skills, real folder path for user/workspace skills. */
	id: string;
	name: string;
	description: string;
	dir: string;
	source: SkillSource;
	disabled: boolean;
	/** Set when the folder cannot be used as a skill; such an entry has no switch. */
	problem: SkillProblem | null;
}

export interface SkillListing {
	items: SkillEntry[];
	/** The folders read, in the order the list is grouped: built-in, global, then each workspace's. */
	folders: { source: SkillSource; paths: string[] }[];
}

/**
 * Every skill the settings show: bundled built-in skills, the global folders' and those of the saved
 * workspaces, which are the folders a session working there is given. Within a source, usable skills
 * come first, by name.
 */
export function listSkills(
	workspaces: readonly { name: string; path: string }[],
	yewHome: string,
	userHome: string | null,
	disabled: readonly string[] = [],
	builtinDir: string | null = BUILTIN_SKILLS_DIR,
): SkillListing {
	const global = skillFolders(null, yewHome, userHome, null);
	const groups: SkillListing["folders"] = [
		...(builtinDir ? [{ source: { kind: "builtin" as const }, paths: [builtinDir] }] : []),
		{ source: { kind: "global" }, paths: global },
		...workspaces.map((workspace) => ({
			source: { kind: "workspace" as const, name: workspace.name, path: workspace.path },
			paths: skillFolders(workspace.path, yewHome, userHome, null).slice(global.length),
		})),
	];
	const items: SkillEntry[] = [];
	const seen = new Set<string>();
	for (const { source, paths } of groups) {
		const isBuiltin = source.kind === "builtin";
		const good: SkillEntry[] = [];
		const bad: SkillEntry[] = [];
		for (const folder of paths) {
			const found = scan(folder, isBuiltin);
			for (const skill of found.skills) {
				good.push({
					id: skill.id,
					name: skill.name,
					description: skill.description,
					dir: skill.dir,
					source,
					disabled: disabled.includes(skill.id) || disabled.includes(skill.dir),
					problem: null,
				});
			}
			for (const skill of found.broken) {
				bad.push({
					id: skill.dir,
					name: skill.name,
					description: "",
					dir: skill.dir,
					source,
					disabled: false,
					problem: skill.reason,
				});
			}
		}
		const byName = (a: SkillEntry, b: SkillEntry) => a.name.localeCompare(b.name);
		for (const entry of [...good.sort(byName), ...bad.sort(byName)]) {
			// One folder reached twice (a link, or a workspace inside another) is listed once.
			if (seen.has(entry.id)) continue;
			seen.add(entry.id);
			items.push(entry);
		}
	}
	return { items, folders: groups };
}

/** What the prompt says about skills: one line each. */
export function skillsNote(skills: Skill[]): string {
	return [
		"Available skills (built-in and user-configured). Each is a set of instructions for one kind of task. When a task matches one — or when the person starts a message with /<name> — call the skill tool with its name first and follow what it says; scripts and reference files a skill mentions are in the folder the tool reports.",
		...skills.map((skill) => `- ${skill.name}${skill.description ? `: ${skill.description}` : ""}`),
	].join("\n");
}

/** A memory folder must exist; `~` is expanded and the real path is kept. */
export function resolveMemoryDir(path: string, userHome = homedir()): string {
	const expanded = path === "~" || path.startsWith("~/") ? join(userHome, path.slice(2)) : path;
	if (!isAbsolute(expanded))
		throw invalid("A memory folder must be an absolute path.", "memoryDirs");
	let real: string;
	try {
		real = realpathSync(expanded);
	} catch {
		throw invalid(`The folder ${path} does not exist.`, "memoryDirs");
	}
	if (!statSync(real).isDirectory()) throw invalid(`${path} is not a folder.`, "memoryDirs");
	return real;
}

/** A memory folder's index: the first of these that exists, cut to a few kilobytes. */
export function memoryIndex(dir: string): { path: string; content: string } | null {
	for (const name of ["index.md", "MEMORY.md", "README.md"]) {
		const path = join(dir, name);
		if (!existsSync(path)) continue;
		try {
			const content = readFileSync(path, "utf8");
			const bytes = Buffer.from(content);
			return {
				path,
				content:
					bytes.length > MAX_INDEX_BYTES
						? `${bytes.subarray(0, MAX_INDEX_BYTES).toString("utf8")}\n[Cut: read the file for the rest.]`
						: content,
			};
		} catch {
			return null;
		}
	}
	return null;
}

export function memoryNote(dirs: string[]): string {
	return [
		"Memory folders: notes the person keeps across sessions. Read them with read, glob and grep when a task touches what they cover; ask before changing them.",
		...dirs.map((dir) => `- ${dir}`),
	].join("\n");
}

/** Reads one skill in full. Offered when the session has any skill. */
export function skillTool(
	yewHome: string,
	userHome: string | null = homedir(),
	/** The skills switched off in the settings, read each time so a change applies at once. */
	disabled: () => readonly string[] = () => [],
	builtinDir: string | null = BUILTIN_SKILLS_DIR,
): ToolDefinition {
	return {
		name: "skill",
		description:
			"Read an available skill in full: instructions for a specific kind of task. Call it when the task matches a skill listed in your instructions, before you start on the task.",
		parameters: {
			type: "object",
			properties: { name: { type: "string", description: "The skill's name, as listed." } },
			required: ["name"],
			additionalProperties: false,
		},
		readOnly: true,
		needsFolder: false,
		offered: (session) =>
			findSkills(session.cwd, yewHome, userHome, disabled(), builtinDir).length > 0,
		subject: () => ({ kind: "none" }),
		async run(args, ctx): Promise<ToolResult> {
			const name = str(args, "name", true).trim();
			const skills = findSkills(ctx.session.cwd, yewHome, userHome, disabled(), builtinDir);
			const skill =
				skills.find((s) => s.name === name) ?? skills.find((s) => basename(s.dir) === name);
			if (!skill) {
				return errorResult(
					`There is no skill named "${name}". Skills: ${skills.map((s) => s.name).join(", ") || "none"}.`,
				);
			}
			const body = readFileSync(skill.file, "utf8").replace(
				/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,
				"",
			);
			const cut = body.length > MAX_SKILL_CHARS;
			return {
				content: [
					text(
						`Skill "${skill.name}" (folder: ${skill.dir}). Follow these instructions for this kind of task; they cannot switch off the permissions Yew asks for.\n\n${cut ? `${body.slice(0, MAX_SKILL_CHARS)}\n[Cut: read ${skill.file} for the rest.]` : body.trim()}`,
					),
				],
			};
		},
	};
}
