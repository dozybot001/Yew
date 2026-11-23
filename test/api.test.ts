import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { pickFolder } from "../src/server/folder-picker.ts";
import { createApp } from "../src/server/http/app.ts";
import { problemType } from "../src/server/http/problem.ts";
import { newStore, tempDir } from "./helpers/store.ts";

/** Response whose JSON body is loosely typed, which is what these assertions want. */
// biome-ignore lint/suspicious/noExplicitAny: test assertions read arbitrary JSON
type TestResponse = Omit<Response, "json"> & { json(): Promise<any> };

function setup() {
	const { store } = newStore();
	const app = createApp({ store, log: () => {} });
	const call = async (
		method: string,
		path: string,
		body?: unknown,
		headers: Record<string, string> = {},
	): Promise<TestResponse> =>
		app.request(path, {
			method,
			headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	return { store, app, call };
}

describe("api: sessions", () => {
	test("create, read, rename and list", async () => {
		const { call } = setup();
		const created = await call("POST", "/api/sessions", { name: "总办", kind: "standing" });
		assert.equal(created.status, 201);
		const session = await created.json();
		assert.equal(session.provider, "deepseek");
		assert.equal(session.model, "deepseek-v4-pro");
		assert.equal(session.cwd, null);

		const renamed = await call("PATCH", `/api/sessions/${session.id}`, {
			name: "总办会话",
			pinned: true,
		});
		assert.equal(renamed.status, 200);
		const updated = await renamed.json();
		assert.equal(updated.name, "总办会话");
		assert.equal(updated.pinned, true);

		const list = await (await call("GET", "/api/sessions?limit=10")).json();
		assert.deepEqual(
			list.items.map((s: { name: string }) => s.name),
			["总办会话"],
		);
		assert.equal(list.nextCursor, null);
	});

	test("new sessions start in the default mode; the mode can be changed and is checked", async () => {
		const { call } = setup();
		const session = await (await call("POST", "/api/sessions", { name: "模式" })).json();
		assert.equal(session.options.permissionMode, "default");
		const path = `/api/sessions/${session.id}`;
		const review = await (
			await call("PATCH", path, { options: { permissionMode: "review" } })
		).json();
		assert.equal(review.options.permissionMode, "review");
		// The modes before 1.7 are gone.
		const old = await call("PATCH", path, { options: { permissionMode: "manual" } });
		assert.equal(old.status, 400);
		const wrong = await call("PATCH", path, { options: { permissionMode: "never" } });
		assert.equal(wrong.status, 400);
	});

	test("a session switches between chat and code by setting or clearing its folder", async () => {
		const { call } = setup();
		const session = await (await call("POST", "/api/sessions", { name: "改代码" })).json();
		const folder = realpathSync(tempDir("yew-cwd-"));
		const code = await (await call("PATCH", `/api/sessions/${session.id}`, { cwd: folder })).json();
		assert.equal(code.cwd, folder);
		const chat = await (await call("PATCH", `/api/sessions/${session.id}`, { cwd: null })).json();
		assert.equal(chat.cwd, null);
		const missing = await call("PATCH", `/api/sessions/${session.id}`, { cwd: "/no/such/folder" });
		assert.equal(missing.status, 400);
	});

	test("errors are RFC 9457 problems with a request ID", async () => {
		const { call } = setup();
		await call("POST", "/api/sessions", { name: "A" });
		const response = await call("POST", "/api/sessions", { name: "a" });
		assert.equal(response.status, 409);
		assert.equal(response.headers.get("Content-Type"), "application/problem+json");
		const problem = await response.json();
		assert.equal(problem.type, problemType("conflict"));
		assert.equal(problem.status, 409);
		assert.equal(typeof problem.title, "string");
		assert.match(problem.detail, /already exists/);
		assert.equal(problem.requestId, response.headers.get("X-Request-Id"));

		const missing = await call("GET", "/api/sessions/nope");
		assert.equal(missing.status, 404);
		const unknown = await call("GET", "/api/nothing-here");
		assert.equal(unknown.status, 404);
		assert.equal((await unknown.json()).type, problemType("not-found"));
	});

	test("rejects bodies that are not JSON objects", async () => {
		const { app, call } = setup();
		const plain = await app.request("/api/sessions", {
			method: "POST",
			headers: { "Content-Type": "text/plain" },
			body: JSON.stringify({ name: "x" }),
		});
		assert.equal(plain.status, 415);
		assert.equal((await call("POST", "/api/sessions", ["x"])).status, 400);
		assert.equal((await call("POST", "/api/sessions", { name: 3 })).status, 400);
		assert.equal((await call("GET", "/api/sessions?limit=0")).status, 400);
		assert.equal((await call("GET", "/api/sessions?limit=999")).status, 400);
	});

	test("a working folder must exist and is stored as its real path", async () => {
		const { call } = setup();
		const dir = tempDir();
		const ok = await call("POST", "/api/sessions", { name: "s1", cwd: dir });
		assert.equal(ok.status, 201);
		assert.equal((await ok.json()).cwd, realpathSync(dir));
		const missing = await call("POST", "/api/sessions", { name: "s2", cwd: `${dir}/missing` });
		assert.equal(missing.status, 400);
		const relative = await call("POST", "/api/sessions", { name: "s3", cwd: "relative/path" });
		assert.equal(relative.status, 400);
	});

	test("the same Idempotency-Key returns the first result without creating twice", async () => {
		const { call, store } = setup();
		const headers = { "Idempotency-Key": "create-1" };
		const first = await call("POST", "/api/sessions", { name: "once" }, headers);
		const again = await call("POST", "/api/sessions", { name: "once" }, headers);
		assert.equal(first.status, 201);
		assert.equal(again.status, 201);
		assert.equal(again.headers.get("Idempotent-Replayed"), "true");
		assert.equal((await first.json()).id, (await again.json()).id);
		assert.equal(store.listSessions({ limit: 10 }).items.length, 1);
		const reused = await call("POST", "/api/sessions", { name: "other" }, headers);
		assert.equal(reused.status, 422);
	});

	test("transcript returns entries and a resumable event sequence", async () => {
		const { call, store } = setup();
		const session = await (await call("POST", "/api/sessions", { name: "t" })).json();
		store.appendEntry(session.id, {
			role: "user",
			message: { role: "user", content: "hi", timestamp: 1 },
		});
		const transcript = await (await call("GET", `/api/sessions/${session.id}/transcript`)).json();
		assert.equal(transcript.entries.length, 1);
		assert.equal(transcript.session.eventSeq, store.getSession(session.id).eventSeq);
		assert.equal(transcript.olderCursor, null);
	});
});

describe("api: groups, settings, search", () => {
	test("workspaces are saved folders: checked when added, kept when their folder goes away", async () => {
		const { call } = setup();
		const folder = realpathSync(tempDir("yew-ws-"));
		const saved = await call("PATCH", "/api/settings", {
			workspaces: [{ id: "w1", name: "Yew", path: folder }],
		});
		assert.equal(saved.status, 200);
		assert.deepEqual((await saved.json()).workspaces, [{ id: "w1", name: "Yew", path: folder }]);

		const missing = await call("PATCH", "/api/settings", {
			workspaces: [{ id: "w2", name: "Nope", path: "/no/such/folder" }],
		});
		assert.equal(missing.status, 400);
		assert.equal((await missing.json()).field, "workspaces");
		const twice = await call("PATCH", "/api/settings", {
			workspaces: [
				{ id: "w1", name: "Yew", path: folder },
				{ id: "w3", name: "Yew again", path: folder },
			],
		});
		assert.equal(twice.status, 400);

		rmSync(folder, { recursive: true });
		const renamed = await call("PATCH", "/api/settings", {
			workspaces: [{ id: "w1", name: "Yew 旧目录", path: folder }],
		});
		assert.equal(renamed.status, 200);
		assert.equal((await renamed.json()).workspaces[0].name, "Yew 旧目录");
	});

	test("the folder picker returns the chosen folder, null on cancel, and refuses off macOS", async () => {
		assert.equal(
			await pickFolder("darwin", async () => "/Users/me/Projects/demo/\n"),
			"/Users/me/Projects/demo",
		);
		const cancelled = async () => {
			throw Object.assign(new Error("Command failed"), { stderr: "User canceled. (-128)" });
		};
		assert.equal(await pickFolder("darwin", cancelled), null);
		await assert.rejects(
			pickFolder("linux", async () => "/x"),
			/cannot open a folder picker/,
		);

		const { store } = newStore();
		const app = createApp({ store, log: () => {}, pickFolder: async () => "/tmp/picked" });
		const response = await app.request("/api/folders/pick", { method: "POST" });
		assert.deepEqual(await response.json(), { path: "/tmp/picked" });
	});

	test("groups can be created, renamed and deleted", async () => {
		const { call } = setup();
		const group = await (await call("POST", "/api/groups", { name: "产品" })).json();
		const renamed = await (
			await call("PATCH", `/api/groups/${group.id}`, { name: "产品组" })
		).json();
		assert.equal(renamed.name, "产品组");
		assert.equal((await call("DELETE", `/api/groups/${group.id}`)).status, 204);
		assert.deepEqual((await (await call("GET", "/api/groups")).json()).items, []);
	});

	test("settings validate their values", async () => {
		const { call } = setup();
		const saved = await (
			await call("PATCH", "/api/settings", { theme: "dark", language: "zh" })
		).json();
		assert.equal(saved.theme, "dark");
		assert.equal(saved.language, "zh");
		assert.equal(saved.mascot, true);
		assert.equal((await call("PATCH", "/api/settings", { theme: "blue" })).status, 400);
		const hidden = await (await call("PATCH", "/api/settings", { mascot: false })).json();
		assert.equal(hidden.mascot, false);
		assert.equal((await call("PATCH", "/api/settings", { mascot: "no" })).status, 400);
		// How the opening leaves: by itself by default, or on a click.
		assert.equal(saved.opening, "auto");
		const click = await (await call("PATCH", "/api/settings", { opening: "click" })).json();
		assert.equal(click.opening, "click");
		assert.equal((await call("PATCH", "/api/settings", { opening: "tap" })).status, 400);
		// Which browser the built-in browser drives: the person's own Chrome.
		assert.equal(saved.browser, "own");
		const separate = await (await call("PATCH", "/api/settings", { browser: "separate" })).json();
		assert.equal(separate.browser, "separate");
		assert.equal((await call("PATCH", "/api/settings", { browser: "firefox" })).status, 400);
	});

	test("search caps the query length", async () => {
		const { call } = setup();
		assert.equal((await call("GET", `/api/search?q=${"x".repeat(201)}`)).status, 400);
		const result = await (await call("GET", "/api/search?q=abc")).json();
		assert.deepEqual(result, { sessions: [], hits: [] });
	});
});

describe("api: text typed and not sent", () => {
	test("is kept for each session and for the home page until the box is emptied", async () => {
		const { call } = setup();
		const session = await (await call("POST", "/api/sessions", { name: "草稿" })).json();
		const path = `/api/unsent/${session.id}`;
		assert.deepEqual(await (await call("GET", path)).json(), { text: "" });
		assert.equal((await call("PUT", path, { text: "写到一半\n第二行" })).status, 204);
		assert.equal((await call("PUT", "/api/unsent/home", { text: "首页的" })).status, 204);
		assert.deepEqual(await (await call("GET", path)).json(), { text: "写到一半\n第二行" });
		assert.deepEqual(await (await call("GET", "/api/unsent/home")).json(), { text: "首页的" });
		// The newer text replaces the older; an emptied box keeps nothing.
		await call("PUT", path, { text: "改过了" });
		assert.deepEqual(await (await call("GET", path)).json(), { text: "改过了" });
		await call("PUT", path, { text: "" });
		assert.deepEqual(await (await call("GET", path)).json(), { text: "" });
		assert.deepEqual(await (await call("GET", "/api/unsent/home")).json(), { text: "首页的" });
	});

	test("is checked: a session that exists, text, no longer than a message", async () => {
		const { call } = setup();
		assert.equal((await call("GET", "/api/unsent/no-such-session")).status, 404);
		assert.equal((await call("PUT", "/api/unsent/no-such-session", { text: "x" })).status, 404);
		assert.equal((await call("PUT", "/api/unsent/home", {})).status, 400);
		const long = await call("PUT", "/api/unsent/home", { text: "x".repeat(100_001) });
		assert.equal(long.status, 400);
	});

	test("goes with its session when the session is deleted", async () => {
		const { call, store } = setup();
		const session = await (await call("POST", "/api/sessions", { name: "要删的" })).json();
		await call("PUT", `/api/unsent/${session.id}`, { text: "没发出去的" });
		await call("PATCH", `/api/sessions/${session.id}`, { archived: true });
		assert.deepEqual(store.deleteArchivedSessions(), [session.id]);
		assert.equal(store.getUnsent(session.id), "");
	});
});

describe("api: providers and keys", () => {
	async function providerSetup() {
		const { MemoryKeyStore } = await import("../src/server/keys.ts");
		const { ModelGateway } = await import("../src/server/model/gateway.ts");
		const { store } = newStore();
		const keys = new MemoryKeyStore();
		const gateway = new ModelGateway({ keys, version: "0.0.0" });
		const app = createApp({ store, gateway, log: () => {} });
		const call = async (method: string, path: string, body?: unknown): Promise<TestResponse> =>
			app.request(path, {
				method,
				...(body === undefined
					? {}
					: { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
			});
		return { store, keys, gateway, call };
	}

	test("keys go to the key store and are never returned", async () => {
		const { keys, call } = await providerSetup();
		assert.equal(
			(await call("PUT", "/api/providers/deepseek/key", { key: " sk-abc " })).status,
			204,
		);
		assert.equal(await keys.get("deepseek"), "sk-abc");
		const list = await (await call("GET", "/api/providers")).json();
		const deepseek = list.items.find((p: { id: string }) => p.id === "deepseek");
		assert.equal(deepseek.hasKey, true);
		assert.ok(!JSON.stringify(list).includes("sk-abc"));
		assert.equal((await call("DELETE", "/api/providers/deepseek/key")).status, 204);
		assert.equal(await keys.get("deepseek"), null);
		assert.equal((await call("PUT", "/api/providers/nope/key", { key: "x" })).status, 404);
	});

	test("the model for jobs beside a conversation is saved, checked and cleared", async () => {
		const { call } = await providerSetup();
		assert.equal((await (await call("GET", "/api/settings")).json()).sideModel, null);
		const side = { provider: "deepseek", model: "deepseek-flash" };
		const saved = await call("PATCH", "/api/settings", { sideModel: side });
		assert.equal(saved.status, 200);
		assert.deepEqual((await saved.json()).sideModel, side);
		const unknown = { provider: "deepseek", model: "nope" };
		assert.equal((await call("PATCH", "/api/settings", { sideModel: unknown })).status, 400);
		assert.equal((await call("PATCH", "/api/settings", { sideModel: "deepseek" })).status, 400);
		// Another setting leaves it as it is.
		assert.deepEqual(
			(await (await call("PATCH", "/api/settings", { theme: "dark" })).json()).sideModel,
			side,
		);
		const cleared = await (await call("PATCH", "/api/settings", { sideModel: null })).json();
		assert.equal(cleared.sideModel, null);
		// The list of models says which one is the provider's small model: the picker starts from it.
		const models = await (await call("GET", "/api/providers/deepseek/models")).json();
		assert.deepEqual(
			models.items
				.filter((item: { small?: boolean }) => item.small)
				.map((item: { id: string }) => item.id),
			["deepseek-flash"],
		);
	});

	test("custom OpenAI-compatible providers can be added, used for sessions and removed", async () => {
		const { store, call } = await providerSetup();
		const body = {
			name: "Local Ollama",
			baseUrl: "http://127.0.0.1:11434/v1/",
			keyRequired: false,
			models: [{ id: "qwen3:8b", contextWindow: 32768, maxTokens: 8192 }],
		};
		const created = await call("PUT", "/api/providers/ollama", body);
		assert.equal(created.status, 201);
		assert.equal((await created.json()).region, "custom");
		assert.equal(store.listCustomProviders()[0]?.baseUrl, "http://127.0.0.1:11434/v1");
		const session = await call("POST", "/api/sessions", {
			name: "local",
			provider: "ollama",
			model: "qwen3:8b",
		});
		assert.equal(session.status, 201);
		const models = await (await call("GET", "/api/providers/ollama/models")).json();
		assert.equal(models.items[0].id, "qwen3:8b");
		assert.equal((await call("PUT", "/api/providers/deepseek", body)).status, 400);
		assert.equal((await call("PUT", "/api/providers/bad", { ...body, models: [] })).status, 400);
		assert.equal((await call("DELETE", "/api/providers/ollama")).status, 204);
		assert.deepEqual(store.listCustomProviders(), []);
		const unknownModel = await call("POST", "/api/sessions", {
			name: "x",
			provider: "ollama",
			model: "qwen3:8b",
		});
		assert.equal(unknownModel.status, 400);
	});
});

describe("api: approval center and letters", () => {
	async function twoSessions(call: ReturnType<typeof setup>["call"]) {
		const main = await (await call("POST", "/api/sessions", { name: "总办" })).json();
		const product = await (await call("POST", "/api/sessions", { name: "Yew · 开发" })).json();
		return { main, product };
	}

	test("the main conversation is a setting; an archived session cannot be it", async () => {
		const { call } = setup();
		const { main, product } = await twoSessions(call);
		const settings = await (
			await call("PATCH", "/api/settings", { mainSessionId: main.id })
		).json();
		assert.equal(settings.mainSessionId, main.id);
		await call("PATCH", `/api/sessions/${product.id}`, { archived: true });
		const refused = await call("PATCH", "/api/settings", { mainSessionId: product.id });
		assert.equal(refused.status, 400);
		const cleared = await (await call("PATCH", "/api/settings", { mainSessionId: null })).json();
		assert.equal(cleared.mainSessionId, null);
	});

	test("the decision log must be a Markdown file in an existing folder", async () => {
		const { call } = setup();
		const folder = realpathSync(tempDir());
		assert.equal((await call("PATCH", "/api/settings", { decisionLog: "notes.md" })).status, 400);
		assert.equal(
			(await call("PATCH", "/api/settings", { decisionLog: `${folder}/notes.txt` })).status,
			400,
		);
		assert.equal(
			(await call("PATCH", "/api/settings", { decisionLog: `${folder}/missing/notes.md` })).status,
			400,
		);
		const ok = await (
			await call("PATCH", "/api/settings", { decisionLog: `${folder}/decisions.md` })
		).json();
		assert.equal(ok.decisionLog, `${folder}/decisions.md`);
	});

	test("letter options on a session are checked", async () => {
		const { call } = setup();
		const { product } = await twoSessions(call);
		const updated = await (
			await call("PATCH", `/api/sessions/${product.id}`, {
				options: { receive: "hold", letterQuota: 5, canPostCards: true },
			})
		).json();
		assert.deepEqual(
			[updated.options.receive, updated.options.letterQuota, updated.options.canPostCards],
			["hold", 5, true],
		);
		for (const options of [{ receive: "maybe" }, { letterQuota: 0 }, { canPostCards: "yes" }]) {
			assert.equal((await call("PATCH", `/api/sessions/${product.id}`, { options })).status, 400);
		}
	});

	test("the person lets a session use containers in its settings", async () => {
		const { call } = setup();
		const { product } = await twoSessions(call);
		const path = `/api/sessions/${product.id}`;
		const updated = await (
			await call("PATCH", path, { options: { allowContainers: true } })
		).json();
		assert.equal(updated.options.allowContainers, true);
		const bad = await call("PATCH", path, { options: { allowContainers: "yes" } });
		assert.equal(bad.status, 400);
	});

	test("a session from the home page is named by Yew once; a name the person picks stays", async () => {
		const { call } = setup();
		const started = await (
			await call("POST", "/api/sessions", { name: "帮我看看这个仓库…", autoName: true })
		).json();
		assert.equal(started.options.autoName, true);
		const renamed = await (
			await call("PATCH", `/api/sessions/${started.id}`, { name: "仓库体检" })
		).json();
		assert.equal(renamed.options.autoName, false);
		const plain = await (await call("POST", "/api/sessions", { name: "总办" })).json();
		assert.equal(plain.options.autoName, undefined);
		const allowed = await (
			await call("PATCH", `/api/sessions/${plain.id}`, { options: { canOrganize: true } })
		).json();
		assert.equal(allowed.options.canOrganize, true);
		const bad = await call("PATCH", `/api/sessions/${plain.id}`, { options: { canOrganize: 1 } });
		assert.equal(bad.status, 400);
	});

	test("the person decides a card; held letters are released or refused", async () => {
		const { store, call } = setup();
		const { main, product } = await twoSessions(call);
		await call("PATCH", "/api/settings", { mainSessionId: main.id });
		await call("PATCH", `/api/sessions/${product.id}`, { options: { receive: "hold" } });
		const { PostOffice } = await import("../src/server/mail/post.ts");
		const post = new PostOffice(store);
		const card = post.postCard(store.getSession(main.id), {
			title: "要不要发布 0.2.0？",
			options: [{ label: "发布" }, { label: "再等等" }],
			recommended: 0,
			undoable: false,
			reversible: "标签推送后不改写",
			after: "Yew · 开发打标签并推送",
			requestedBy: product.id,
		});
		const first = post.send(
			{ kind: "session", session: store.getSession(main.id) },
			{ to: product.id, kind: "notice", summary: "第一封" },
		);
		const second = post.send(
			{ kind: "session", session: store.getSession(main.id) },
			{ to: product.id, kind: "notice", summary: "第二封" },
		);

		const center = await (await call("GET", "/api/center")).json();
		assert.equal(center.cards.length, 1);
		assert.equal(center.held.length, 2);

		const empty = await call("POST", `/api/cards/${card.id}/decide`, {});
		assert.equal(empty.status, 400);
		const decided = await (
			await call("POST", `/api/cards/${card.id}/decide`, { choice: 0, note: "今天发" })
		).json();
		assert.equal(decided.status, "decided");
		const again = await call("POST", `/api/cards/${card.id}/decide`, { choice: 1 });
		assert.equal(again.status, 409);
		assert.equal((await again.json()).type, problemType("already-answered"));

		assert.equal(
			(await (await call("POST", `/api/letters/${first.id}/release`)).json()).status,
			"queued",
		);
		assert.equal(
			(await (await call("POST", `/api/letters/${second.id}/refuse`)).json()).status,
			"refused",
		);
		assert.equal((await call("POST", `/api/letters/${second.id}/release`)).status, 409);

		const letters = await (await call("GET", `/api/letters?session=${product.id}&limit=2`)).json();
		assert.equal(letters.items.length, 2);
		assert.notEqual(letters.nextCursor, null);
		const rest = await (
			await call("GET", `/api/letters?session=${product.id}&limit=2&cursor=${letters.nextCursor}`)
		).json();
		// Three letters involve the product session: the decision, the released and the refused one.
		assert.equal(rest.items.length, 1);
		const decisions = await (await call("GET", "/api/cards?status=decided")).json();
		assert.deepEqual(
			decisions.items.map((c: { number: number }) => c.number),
			[1],
		);
	});
});

describe("api: duplicating a session", () => {
	test("the copy has the settings, task list and conversation under a free name; usage starts at zero", async () => {
		const { store, call } = setup();
		const session = await (
			await call("POST", "/api/sessions", { name: "产品会话", responsibility: "负责产品" })
		).json();
		store.setTodos(session.id, [{ text: "写测试", status: "in_progress" }]);
		const first = store.appendEntry(session.id, {
			role: "user",
			message: { role: "user", content: "加一个导出功能", timestamp: Date.now() },
		});
		const reply = store.appendEntry(session.id, {
			role: "assistant",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.txt" } }],
				api: "faux",
				provider: "faux",
				model: "faux",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		});
		const callRow = store.createToolCall({
			sessionId: session.id,
			messageId: reply.id,
			callId: "c1",
			tool: "read",
			args: { path: "a.txt" },
		});
		const result = store.appendEntry(session.id, {
			role: "toolResult",
			message: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "read",
				content: [{ type: "text", text: "alpha" }],
				isError: false,
				timestamp: Date.now(),
			},
		});
		store.updateToolCall(callRow.id, {
			status: "done",
			resultMessageId: result.id,
			finishedAt: Date.now(),
		});
		store.addUsage(
			session.id,
			{ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.5 },
			100,
		);

		const response = await call("POST", `/api/sessions/${session.id}/duplicate`);
		assert.equal(response.status, 201);
		const copy = await response.json();
		assert.equal(copy.name, "产品会话 副本");
		assert.equal(copy.responsibility, "负责产品");
		assert.deepEqual(copy.todos, [{ text: "写测试", status: "in_progress" }]);
		assert.equal(copy.usage.cost, 0);
		const transcript = await (await call("GET", `/api/sessions/${copy.id}/transcript`)).json();
		assert.deepEqual(
			transcript.entries.map((e: { seq: number; role: string }) => [e.seq, e.role]),
			[
				[first.seq, "user"],
				[reply.seq, "assistant"],
				[result.seq, "toolResult"],
			],
		);
		assert.equal(transcript.toolCalls.length, 1);
		assert.equal(transcript.toolCalls[0].status, "done");
		assert.equal(transcript.toolCalls[0].resultMessageId, transcript.entries[2].id);
		assert.notEqual(transcript.entries[0].id, first.id);
		// A second copy gets the next free name; a session at work cannot be copied.
		assert.equal(
			(await (await call("POST", `/api/sessions/${session.id}/duplicate`)).json()).name,
			"产品会话 副本 2",
		);
		store.setStatus(session.id, "working");
		const busy = await call("POST", `/api/sessions/${session.id}/duplicate`);
		assert.equal(busy.status, 409);
	});
});

describe("the person's standing instructions", () => {
	test("are read from and written to AGENTS.md in Yew's folder; an empty text removes it", async () => {
		const { store } = newStore();
		const home = realpathSync(tempDir("yew-home-"));
		const app = createApp({ store, log: () => {}, data: { home } });
		const put = (content: string) =>
			app.request("/api/settings/instructions", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content }),
			});
		const get = async () =>
			(await (await app.request("/api/settings/instructions")).json()).content;
		assert.equal(await get(), "");
		assert.equal((await put("Keep replies short.")).status, 200);
		assert.equal(readFileSync(join(home, "AGENTS.md"), "utf8"), "Keep replies short.\n");
		assert.equal(await get(), "Keep replies short.\n");
		assert.equal((await put("  ")).status, 200);
		assert.equal(existsSync(join(home, "AGENTS.md")), false);
		assert.equal((await put("x".repeat(20_001))).status, 400);
	});
});
