import { Hono } from "hono";
import { PERMISSION_MODES, type PermissionMode, SCHEDULE_MODES } from "../../shared/types.ts";
import { type ScheduleFields, type Scheduler, skippedError } from "../schedules.ts";
import type { Store } from "../store.ts";
import { idempotent } from "./idempotency.ts";
import { type Fields, optBoolean, optEnum, optString, readJson } from "./input.ts";
import type { AppEnv } from "./problem.ts";

function scheduleFields(fields: Fields): ScheduleFields {
	const permissionMode: PermissionMode | null | undefined =
		fields.permissionMode === null ? null : optEnum(fields, "permissionMode", PERMISSION_MODES);
	const out: ScheduleFields = {};
	const name = optString(fields, "name", 200);
	const cron = optString(fields, "cron", 200);
	const session = optString(fields, "session", 200);
	const message = optString(fields, "message", 40_000);
	const mode = optEnum(fields, "mode", SCHEDULE_MODES);
	const autoArchive = optBoolean(fields, "autoArchive");
	const catchUp = optBoolean(fields, "catchUp");
	const enabled = optBoolean(fields, "enabled");
	if (name !== undefined) out.name = name;
	if (cron !== undefined) out.cron = cron;
	if (session !== undefined) out.session = session;
	if (message !== undefined) out.message = message;
	if (permissionMode !== undefined) out.permissionMode = permissionMode;
	if (mode !== undefined) out.mode = mode;
	if (autoArchive !== undefined) out.autoArchive = autoArchive;
	if (catchUp !== undefined) out.catchUp = catchUp;
	if (enabled !== undefined) out.enabled = enabled;
	return out;
}

/** Scheduled tasks: list, add, change, remove, and run one now. */
export function scheduleRoutes(store: Store, scheduler: Scheduler): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	const once = idempotent(store.db);
	const book = scheduler.book;

	app.get("/schedules", (c) => c.json({ items: book.list(), nextCursor: null }));

	app.post("/schedules", once, async (c) => {
		const fields = scheduleFields(await readJson(c));
		return c.json(book.create(fields), 201);
	});

	app.patch("/schedules/:id", async (c) => {
		const fields = scheduleFields(await readJson(c));
		return c.json(book.update(c.req.param("id"), fields));
	});

	app.delete("/schedules/:id", (c) => {
		book.delete(c.req.param("id"));
		return c.body(null, 204);
	});

	// Runs it now, outside its times; the next run stays as it was.
	app.post("/schedules/:id/run", (c) => {
		const id = c.req.param("id");
		const result = scheduler.run(id);
		if ("skipped" in result) throw skippedError(result.skipped, book.get(id).name);
		return c.json({ schedule: book.get(id), letter: result.letter });
	});

	return app;
}
