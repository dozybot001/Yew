import { Hono } from "hono";
import { invalid, notFound } from "../errors.ts";
import { type RunCommand, revealKind, showInFileManager } from "../reveal.ts";
import { readSettings } from "../settings.ts";
import { listSkills, type SkillEntry, type SkillListing } from "../skills.ts";
import type { Store } from "../store.ts";
import { optBoolean, readJson, reqString } from "./input.ts";
import type { AppEnv } from "./problem.ts";

export interface SkillRoutesOptions {
	/** Yew's data folder; its `skills` folder is one of the global ones. */
	home: string;
	/** The person's home folder, for `~/.claude/skills`; null reads nothing outside Yew's folder. */
	userHome: string | null;
	/** Bundled official skills folder; defaults to Yew's `skills-builtin/`, null disables it in tests. */
	builtinDir?: string | null;
	/** Replace the system and the program runner; tests use them so no window opens. */
	platform?: string;
	run?: RunCommand;
}

/**
 * Skills in the settings: list what was read and what could not be, switch one off or on, show
 * one's folder in the file manager. Computer-only: these are this computer's
 * folders. Nothing here changes a skill's files.
 */
export function skillRoutes(store: Store, options: SkillRoutesOptions): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	const platform = options.platform ?? process.platform;

	const listing = (): SkillListing => {
		const settings = readSettings(store);
		return listSkills(
			settings.workspaces,
			options.home,
			options.userHome,
			settings.disabledSkills,
			options.builtinDir,
		);
	};
	// Only a folder in the list is ever acted on: the request names one, it never supplies a path.
	const listed = (id: string): SkillEntry => {
		const entry = listing().items.find((item) => item.id === id);
		if (!entry) throw notFound("skill", id);
		return entry;
	};

	app.get("/skills", (c) =>
		c.json({
			...listing(),
			reveal: revealKind(platform),
			nextCursor: null,
		}),
	);

	app.patch("/skills", async (c) => {
		const fields = await readJson(c);
		const id = reqString(fields, "id", 4096);
		const disabled = optBoolean(fields, "disabled");
		if (disabled === undefined) throw invalid("disabled is required.", "disabled");
		const entry = listed(id);
		// A folder that could not be read has nothing to switch.
		if (entry.problem) throw notFound("skill", id);
		const others = readSettings(store).disabledSkills.filter((item) => item !== id);
		store.setSetting("disabledSkills", disabled ? [...others, id] : others);
		return c.json({ ...entry, disabled });
	});

	app.post("/skills/reveal", async (c) => {
		const fields = await readJson(c);
		const entry = listed(reqString(fields, "id", 4096));
		// Finder opens the folder that holds the skill, with the skill's folder selected.
		await showInFileManager(entry.dir, { platform, run: options.run, field: "id" });
		return c.body(null, 204);
	});

	return app;
}
