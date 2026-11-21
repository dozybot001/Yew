import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Manager } from "../src/server/manage.ts";
import { ScheduleBook } from "../src/server/schedules.ts";
import { newStore, sessionInput } from "./helpers/store.ts";

function setup() {
	const { store } = newStore();
	const main = store.createSession({
		...sessionInput("总办"),
		options: { permissionMode: "skip", canPostCards: true, canOrganize: true },
	});
	store.setSetting("mainSessionId", main.id);
	store.setSetting("defaultPermissionMode", "default");
	const manager = new Manager({
		store,
		schedules: new ScheduleBook(store),
		mainId: () => main.id,
		modelExists: () => true,
		onArchived: () => {},
	});
	return { store, main, manager };
}

describe("manage_yew creating a session", () => {
	test("everything the entry sets applies to the new session and is listed", () => {
		const { store, main, manager } = setup();
		const entry = {
			name: "CalMD · 开发",
			permission: "skip",
			can_post_cards: true,
			receive: "hold",
			letter_quota: 5,
			daily_budget: 3,
			pinned: true,
		};
		const plan = manager.plan(main, { sessions: [entry] });
		// More room than the defaults is a widening, as for a session that already exists.
		assert.equal(plan.tier, "widen");
		assert.deepEqual([...plan.reasons].sort(), ["grant-rights", "widen-permission"]);
		const lines = manager.apply(main, { sessions: [entry] });
		assert.deepEqual(lines, [
			'Created the standing session "CalMD · 开发".',
			'Set the permission mode of "CalMD · 开发" to skip.',
			'Set how "CalMD · 开发" receives letters to hold.',
			'Set the letter quota of "CalMD · 开发" to 5.',
			'Set the daily spending limit of "CalMD · 开发" to $3.00.',
			'Gave "CalMD · 开发" the right to post cards.',
			'Pinned "CalMD · 开发".',
		]);
		const made = store.findSessionByName("CalMD · 开发");
		assert.ok(made);
		assert.equal(made.options.permissionMode, "skip");
		assert.equal(made.options.canPostCards, true);
		assert.equal(made.options.receive, "hold");
		assert.equal(made.options.letterQuota, 5);
		assert.equal(made.options.dailyBudget, 3);
		assert.equal(made.pinned, true);
	});

	test("an entry that only names the session gets the defaults; one cannot start archived", () => {
		const { store, main, manager } = setup();
		assert.equal(manager.plan(main, { sessions: [{ name: "文档" }] }).tier, "configure");
		assert.deepEqual(manager.apply(main, { sessions: [{ name: "文档" }] }), [
			'Created the standing session "文档".',
		]);
		const made = store.findSessionByName("文档");
		assert.equal(made?.options.permissionMode, "default");
		assert.equal(made?.options.canPostCards, undefined);
		assert.throws(
			() => manager.plan(main, { sessions: [{ name: "旧档", archived: true }] }),
			/cannot start archived/,
		);
	});
});
