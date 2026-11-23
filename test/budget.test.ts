import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { describe, test } from "node:test";
import { Agents } from "../src/server/agent/runner.ts";
import { budgets, crossedWarning, localDay, reached } from "../src/server/budget.ts";
import { createApp } from "../src/server/http/app.ts";
import { MemoryKeyStore } from "../src/server/keys.ts";
import { Manager } from "../src/server/manage.ts";
import { ModelGateway } from "../src/server/model/gateway.ts";
import { fauxAssistantMessage, fauxProvider } from "../src/server/model/testing.ts";
import { PermissionEngine } from "../src/server/permissions/engine.ts";
import { ScheduleBook } from "../src/server/schedules.ts";
import type { Entry } from "../src/shared/types.ts";
import { newStore, tempDir } from "./helpers/store.ts";

const spend = (cost: number) => ({ input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost });

function setup() {
	const faux = fauxProvider();
	const { store } = newStore();
	const keys = new MemoryKeyStore({ [faux.provider.id]: "test-key" });
	const gateway = new ModelGateway({ keys, version: "0.0.0", providers: [faux.provider] });
	const home = realpathSync(tempDir("yew-home-"));
	const agents = new Agents({
		store,
		gateway,
		permissions: new PermissionEngine(home),
		home,
		version: "0.0.0",
		draftIntervalMs: 0,
		log: () => {},
	});
	const make = (name: string, dailyBudget?: number) =>
		store.createSession({
			name,
			kind: "standing",
			provider: faux.provider.id,
			model: faux.getModel().id,
			cwd: null,
			thinking: "off",
			...(dailyBudget ? { options: { dailyBudget } } : {}),
		});
	const notices = (sessionId: string) =>
		store
			.listEntries(sessionId, { limit: 50 })
			.entries.filter(
				(entry): entry is Extract<Entry, { role: "notice" }> => entry.role === "notice",
			)
			.map((entry) => entry.notice);
	const replies = (sessionId: string) =>
		store.listEntries(sessionId, { limit: 50 }).entries.filter((e) => e.role === "assistant");
	return { faux, store, agents, make, notices, replies };
}

describe("daily spending limits", () => {
	test("spending counts by local calendar day, for one session and for all", () => {
		const { store, make } = setup();
		const a = make("a", 1);
		const b = make("b");
		const now = Date.now();
		const day = localDay(now);
		store.addUsage(a.id, spend(0.4), 0, now);
		store.addUsage(a.id, spend(0.2), 0, now);
		store.addUsage(b.id, spend(1), 0, now);
		store.addUsage(a.id, spend(5), 0, now - 36 * 3600 * 1000);
		assert.ok(Math.abs(store.spentOn(day, a.id) - 0.6) < 1e-9);
		assert.ok(Math.abs(store.spentOn(day) - 1.6) < 1e-9);
		assert.deepEqual(Object.keys(store.spentBySession(day)).sort(), [a.id, b.id].sort());
		assert.equal(reached(store, store.getSession(a.id), now), null);
		// The shared limit counts every session.
		store.setSetting("dailyBudget", 1.5);
		assert.equal(reached(store, store.getSession(a.id), now)?.scope, "all");
		assert.deepEqual(
			budgets(store, store.getSession(b.id), now).map((mark) => mark.scope),
			["all"],
		);
	});

	test("the request that takes spending past 80% is the one that warns", () => {
		const { store, make } = setup();
		const a = make("a", 1);
		const now = Date.now();
		store.addUsage(a.id, spend(0.7), 0, now);
		assert.deepEqual(crossedWarning(store, a, 0.7, now), []);
		store.addUsage(a.id, spend(0.15), 0, now);
		assert.equal(crossedWarning(store, a, 0.15, now)[0]?.scope, "session");
		store.addUsage(a.id, spend(0.05), 0, now);
		assert.deepEqual(crossedWarning(store, a, 0.05, now), []);
		// A request that uses the limit up stops the session instead of warning.
		store.addUsage(a.id, spend(0.2), 0, now);
		assert.deepEqual(crossedWarning(store, a, 0.2, now), []);
	});

	test("a session at its limit stops before asking the model; continuing gives as much again", async () => {
		const { faux, store, agents, make, notices, replies } = setup();
		const a = make("a", 1);
		store.addUsage(a.id, spend(1.2), 0);
		faux.setResponses([fauxAssistantMessage("接着做。")]);
		agents.send(a.id, "继续做");
		await agents.whenIdle(a.id);
		assert.equal(replies(a.id).length, 0);
		const stopped = notices(a.id).at(-1);
		assert.equal(stopped?.kind, "budget");
		assert.equal(stopped?.data?.code, "budget-reached");
		assert.equal(stopped?.data?.scope, "session");
		assert.equal(store.getSession(a.id).status, "idle");
		// The session carries the day it stopped, which is how the interface knows.
		assert.equal(store.getSession(a.id).cappedDay, localDay(Date.now()));

		agents.continue(a.id);
		await agents.whenIdle(a.id);
		assert.equal(replies(a.id).length, 1);
		assert.equal(store.getSession(a.id).cappedDay, null);
		const extra = store.getSession(a.id).options.budgetExtra;
		assert.equal(extra?.day, localDay(Date.now()));
		assert.ok(Math.abs((extra?.amount ?? 0) - 1.2) < 1e-9);
		// The new room is the limit again: $1.20 spent, $2.20 allowed.
		assert.equal(reached(store, store.getSession(a.id), Date.now()), null);
	});

	test("the shared limit stops a session without one of its own", async () => {
		const { faux, store, agents, make, notices, replies } = setup();
		const a = make("a");
		const b = make("b");
		store.setSetting("dailyBudget", 2);
		store.addUsage(b.id, spend(2), 0);
		faux.setResponses([fauxAssistantMessage("好。")]);
		agents.send(a.id, "你好");
		await agents.whenIdle(a.id);
		assert.equal(replies(a.id).length, 0);
		assert.equal(notices(a.id).at(-1)?.data?.scope, "all");
		agents.continue(a.id);
		await agents.whenIdle(a.id);
		assert.equal(replies(a.id).length, 1);
		assert.equal(store.getSetting<{ amount: number } | null>("budgetExtra", null)?.amount, 2);
	});

	test("a stopped session goes on by itself once its limit is raised", async () => {
		const { faux, store, agents, make, replies } = setup();
		const a = make("a", 1);
		store.addUsage(a.id, spend(1), 0);
		faux.setResponses([fauxAssistantMessage("做完了。")]);
		agents.send(a.id, "做这件事");
		await agents.whenIdle(a.id);
		agents.wakeQueued();
		assert.equal(agents.isRunning(a.id), false);
		store.updateSession(a.id, { options: { dailyBudget: 5 } });
		agents.wakeQueued();
		await agents.whenIdle(a.id);
		assert.equal(replies(a.id).length, 1);
	});

	test("a session may lower a limit, but raising or removing one is for the person", () => {
		const { store, make } = setup();
		const main = make("总办");
		const a = make("a", 2);
		store.setSetting("mainSessionId", main.id);
		const manager = new Manager({
			store,
			schedules: new ScheduleBook(store),
			mainId: () => main.id,
			modelExists: () => true,
			onArchived: () => {},
		});
		const lower = manager.plan(main, { sessions: [{ session: "a", daily_budget: 1 }] });
		assert.equal(lower.tier, "configure");
		const raise = manager.plan(main, { sessions: [{ session: "a", daily_budget: 3 }] });
		assert.equal(raise.tier, "widen");
		assert.deepEqual(raise.reasons, ["raise-budget"]);
		assert.throws(() => manager.plan(main, { settings: { daily_budget: 0 } }), /Nothing to change/);
		store.setSetting("dailyBudget", 10);
		assert.equal(manager.plan(main, { settings: { daily_budget: 0 } }).tier, "widen");
		manager.apply(main, { sessions: [{ session: "a", daily_budget: 1 }] });
		assert.equal(store.getSession(a.id).options.dailyBudget, 1);
	});

	test("the API checks limits and reports today's spending", async () => {
		const { store } = newStore();
		const app = createApp({ store, log: () => {} });
		// biome-ignore lint/suspicious/noExplicitAny: test assertions read arbitrary JSON
		const call = async (method: string, path: string, body?: unknown): Promise<any> => {
			const response = await app.request(path, {
				method,
				...(body === undefined
					? {}
					: { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
			});
			return response.ok ? response.json() : { status: response.status };
		};
		const session = await call("POST", "/api/sessions", { name: "a" });
		const path = `/api/sessions/${session.id}`;
		assert.equal((await call("PATCH", path, { options: { dailyBudget: -1 } })).status, 400);
		assert.equal((await call("PATCH", path, { options: { dailyBudget: "5" } })).status, 400);
		const updated = await call("PATCH", path, { options: { dailyBudget: 2.5 } });
		assert.equal(updated.options.dailyBudget, 2.5);
		assert.equal((await call("PATCH", "/api/settings", { dailyBudget: 0 })).status, 400);
		const settings = await call("PATCH", "/api/settings", { dailyBudget: 20 });
		assert.equal(settings.dailyBudget, 20);
		store.addUsage(session.id, spend(0.5), 0);
		const today = await call("GET", "/api/usage/today");
		assert.equal(today.day, localDay(Date.now()));
		assert.equal(today.total, 0.5);
		assert.equal(today.sessions[session.id], 0.5);
		const cleared = await call("PATCH", "/api/settings", { dailyBudget: null });
		assert.equal(cleared.dailyBudget, null);
	});
});
