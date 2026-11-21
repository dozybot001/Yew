import { Hono } from "hono";
import { exportAll } from "../data-export.ts";
import { cleanTemp, dataUsage, type InUse } from "../data-usage.ts";
import { conflict, invalid, YewError } from "../errors.ts";
import { resolveWorkingFolder } from "../paths.ts";
import { type RunCommand, revealKind, showInFileManager } from "../reveal.ts";
import type { Store } from "../store.ts";
import { idempotent } from "./idempotency.ts";
import { readJson, reqString } from "./input.ts";
import type { AppEnv } from "./problem.ts";

export interface DataRoutesOptions {
	/** Yew's data folder. */
	home: string;
	/** Whether a session has a command that may still be writing its output files. */
	inUse?: InUse;
	/** Replace the system and the program runner; tests use them so no window opens. */
	platform?: string;
	run?: RunCommand;
}

/**
 * Data in the settings: what the data folder takes, exporting everything
 * as `yew export` does, and deleting the over-long command output. Computer-only: these are this
 * computer's folders. The only folders shown in the file manager are the data folder and the one
 * this process last exported to; a request never supplies a path to show.
 */
export function dataRoutes(store: Store, options: DataRoutesOptions): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	const once = idempotent(store.db);
	const platform = options.platform ?? process.platform;
	const inUse = options.inUse ?? (() => false);
	let exported: string | null = null;

	app.get("/data", (c) =>
		c.json({ ...dataUsage(options.home, inUse), reveal: revealKind(platform) }),
	);

	app.post("/data/export", once, async (c) => {
		const fields = await readJson(c);
		const requested = reqString(fields, "folder", 4096);
		let folder: string;
		try {
			folder = resolveWorkingFolder(requested);
		} catch (error) {
			if (error instanceof YewError) throw invalid(error.message, "folder");
			throw error;
		}
		// The same call as `yew export`: it refuses a folder that is not empty.
		const counts = exportAll(store, folder, Date.now(), options.home);
		exported = folder;
		return c.json({ folder, ...counts }, 201);
	});

	app.post("/data/cleanup", once, (c) => c.json(cleanTemp(options.home, inUse)));

	app.post("/data/reveal", async (c) => {
		const target = reqString(await readJson(c), "target", 20);
		if (target !== "home" && target !== "export") {
			throw invalid("target must be home or export.", "target");
		}
		const dir = target === "home" ? options.home : exported;
		if (dir === null) {
			throw conflict(
				"Nothing was exported since Yew Harness started.",
				{ field: "target" },
				"no-export",
			);
		}
		// The folder itself is opened, so its contents are what the person sees.
		await showInFileManager(dir, { platform, run: options.run, inside: true, field: "target" });
		return c.body(null, 204);
	});

	return app;
}
