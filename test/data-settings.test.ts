import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Agents } from "../src/server/agent/runner.ts";
import { ArtifactStore } from "../src/server/artifacts.ts";
import { exportAll } from "../src/server/data-export.ts";
import { cleanTemp, dataUsage } from "../src/server/data-usage.ts";
import { createApp } from "../src/server/http/app.ts";
import { MemoryKeyStore } from "../src/server/keys.ts";
import { ModelGateway } from "../src/server/model/gateway.ts";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "../src/server/model/testing.ts";
import { PermissionEngine } from "../src/server/permissions/engine.ts";
import { newStore, sessionInput, tempDir } from "./helpers/store.ts";

/** Data in the settings: the overview, export, cleanup and showing folders. */

// biome-ignore lint/suspicious/noExplicitAny: test assertions read arbitrary JSON
type Json = any;

const real = (prefix: string) => realpathSync(tempDir(prefix));

function file(path: string, bytes: number): string {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, "x".repeat(bytes));
	return path;
}

/** A data folder with something of every kind; the numbers are the files' lengths. */
function prepared() {
	const home = real("yew-home-");
	file(join(home, "yew.db"), 4000);
	file(join(home, "yew.db-wal"), 300);
	file(join(home, "yew.db-shm"), 20);
	file(join(home, "artifacts", "s1", "a1", "v1.md"), 700);
	file(join(home, "artifacts", "s1", "a1", "v2.md"), 800);
	file(join(home, "attachments", "s1", "att1.png"), 250);
	file(join(home, "logs", "serve.log"), 150);
	const outputs = {
		idle1: file(join(home, "tmp", "idle", "output", "one.log"), 60_000),
		idle2: file(join(home, "tmp", "idle", "output", "two.log"), 1000),
		busy: file(join(home, "tmp", "busy", "output", "live.log"), 5000),
	};
	file(join(home, "mcp.json"), 40);
	file(join(home, "skills", "pdf", "SKILL.md"), 60);
	return { home, outputs };
}

/** Every file under a folder, as sorted relative paths. */
function tree(dir: string, prefix = ""): string[] {
	return readdirSync(dir, { withFileTypes: true })
		.flatMap((entry) =>
			entry.isDirectory()
				? tree(join(dir, entry.name), `${prefix}${entry.name}/`)
				: [`${prefix}${entry.name}`],
		)
		.sort();
}

describe("data: what the folder takes", () => {
	test("each kind is added up, and the kinds add up to the total", () => {
		const { home } = prepared();
		const usage = dataUsage(home, (id) => id === "busy", 1234);
		assert.equal(usage.folder, home);
		assert.equal(usage.readAt, 1234);
		assert.deepEqual(usage.parts, [
			{ id: "database", bytes: 4320 },
			{ id: "artifacts", bytes: 1500 },
			{ id: "attachments", bytes: 250 },
			{ id: "logs", bytes: 150 },
			{ id: "temp", bytes: 66_000 },
			{ id: "other", bytes: 100 },
		]);
		assert.equal(usage.totalBytes, 72_320);
		// What a cleanup would delete leaves out the session with a running command.
		assert.deepEqual(usage.temp, {
			files: 3,
			bytes: 66_000,
			removableFiles: 2,
			removableBytes: 61_000,
		});
	});

	test("an empty or missing folder is all zeros; a link is counted as a link, not followed", () => {
		const empty = dataUsage(real("yew-home-"));
		assert.equal(empty.totalBytes, 0);
		assert.deepEqual(empty.temp, { files: 0, bytes: 0, removableFiles: 0, removableBytes: 0 });
		assert.equal(dataUsage(join(real("yew-home-"), "missing")).totalBytes, 0);

		const home = real("yew-home-");
		const elsewhere = real("yew-else-");
		file(join(elsewhere, "big.bin"), 90_000);
		symlinkSync(elsewhere, join(home, "skills"));
		assert.ok(dataUsage(home).totalBytes < 1000);
	});
});

describe("data: cleaning up temporary files", () => {
	test("files of idle sessions go and their bytes are reported; a session in use is skipped", () => {
		const { home, outputs } = prepared();
		const before = tree(home).filter((path) => !path.startsWith("tmp/"));
		const result = cleanTemp(home, (id) => id === "busy");
		assert.deepEqual(result, { deletedFiles: 2, freedBytes: 61_000, skippedFiles: 1 });
		assert.equal(existsSync(outputs.idle1), false);
		assert.equal(existsSync(outputs.idle2), false);
		assert.equal(readFileSync(outputs.busy, "utf8").length, 5000);
		// The emptied session folder goes; tmp stays, and so does everything outside it.
		assert.deepEqual(readdirSync(join(home, "tmp")), ["busy"]);
		assert.deepEqual(
			tree(home).filter((path) => !path.startsWith("tmp/")),
			before,
		);
		assert.equal(dataUsage(home).temp.removableFiles, 1);
		// Nothing to delete is not an error.
		const none = { deletedFiles: 0, freedBytes: 0, skippedFiles: 0 };
		assert.deepEqual(cleanTemp(real("yew-home-")), none);
	});

	test("links inside tmp are neither followed nor deleted", () => {
		const { home } = prepared();
		const elsewhere = real("yew-else-");
		const kept = file(join(elsewhere, "keep.txt"), 10);
		symlinkSync(elsewhere, join(home, "tmp", "idle", "output", "dir-link"));
		symlinkSync(kept, join(home, "tmp", "idle", "output", "file-link.log"));
		symlinkSync(elsewhere, join(home, "tmp", "linked-session"));
		const result = cleanTemp(home);
		assert.equal(result.deletedFiles, 3);
		assert.equal(result.skippedFiles, 3);
		assert.equal(readFileSync(kept, "utf8"), "x".repeat(10));
		assert.deepEqual(readdirSync(elsewhere), ["keep.txt"]);
	});

	test("a tmp folder that is a link out of the data folder is refused", () => {
		const home = real("yew-home-");
		const elsewhere = real("yew-else-");
		const kept = file(join(elsewhere, "s1", "output", "keep.log"), 10);
		symlinkSync(elsewhere, join(home, "tmp"));
		assert.throws(
			() => cleanTemp(home),
			(error: Json) => error.code === "temp-outside" && error.status === 409,
		);
		assert.equal(existsSync(kept), true);
		assert.equal(dataUsage(home).temp.removableFiles, 0);
	});

	test("a data folder reached through a link still cleans its own tmp", () => {
		const { home, outputs } = prepared();
		const link = join(real("yew-else-"), "home-link");
		symlinkSync(home, link);
		assert.equal(cleanTemp(link).deletedFiles, 3);
		assert.equal(existsSync(outputs.busy), false);
	});
});

describe("data: the routes", () => {
	function setup(platform = "darwin", inUse: (id: string) => boolean = (id) => id === "busy") {
		const made = prepared();
		const { store } = newStore();
		const ran: string[][] = [];
		const app = createApp({
			store,
			log: () => {},
			data: {
				home: made.home,
				inUse,
				platform,
				run: async (command, args) => {
					ran.push([command, ...args]);
				},
			},
		});
		const send = async (
			method: string,
			path: string,
			json?: unknown,
			options: { device?: string; key?: string } = {},
		) => {
			const headers: Record<string, string> = {};
			if (json !== undefined) headers["Content-Type"] = "application/json";
			if (options.key) headers["Idempotency-Key"] = options.key;
			const response = await app.fetch(
				new Request(`http://localhost${path}`, {
					method,
					headers,
					...(json === undefined ? {} : { body: JSON.stringify(json) }),
				}),
				options.device ? { device: options.device } : {},
			);
			const text = await response.text();
			return {
				status: response.status,
				body: (text ? JSON.parse(text) : null) as Json,
				replayed: response.headers.get("Idempotent-Replayed") === "true",
			};
		};
		return { ...made, store, ran, send };
	}

	test("the overview has the folder, the parts, the temporary files and the file manager", async () => {
		const { send, home } = setup();
		const { status, body } = await send("GET", "/api/data");
		assert.equal(status, 200);
		assert.equal(body.folder, home);
		assert.equal(body.totalBytes, 72_320);
		assert.deepEqual(
			body.parts.map((part: Json) => part.id),
			["database", "artifacts", "attachments", "logs", "temp", "other"],
		);
		assert.equal(body.temp.removableBytes, 61_000);
		assert.equal(body.reveal, "finder");
		assert.equal(typeof body.readAt, "number");
		assert.equal((await setup("linux").send("GET", "/api/data")).body.reveal, "files");
		assert.equal((await setup("win32").send("GET", "/api/data")).body.reveal, null);
	});

	test("export writes what yew export writes and says what it wrote", async () => {
		const { send, store, home } = setup();
		const session = store.createSession(sessionInput("写周报"));
		store.createSession(sessionInput("Yew · 开发"));
		new ArtifactStore(store, home).save(session.id, {
			name: "周报",
			kind: "markdown",
			content: "# 周报",
		});
		const byCommand = real("yew-export-");
		const counts = exportAll(store, byCommand, Date.now(), home);
		const folder = real("yew-export-");
		const { status, body } = await send("POST", "/api/data/export", { folder });
		assert.equal(status, 201);
		assert.deepEqual(body, { folder, ...counts });
		assert.equal(body.sessions, 2);
		assert.equal(body.artifacts, 1);
		assert.deepEqual(tree(folder), tree(byCommand));
		assert.equal(tree(folder).length, body.files);
		for (const name of ["sessions.json", "letters.json", "cards.json", "schedules.json"]) {
			assert.equal(
				readFileSync(join(folder, name), "utf8"),
				readFileSync(join(byCommand, name), "utf8"),
			);
		}
	});

	test("export refuses what yew export refuses, and a folder that is not there", async () => {
		const { send } = setup();
		const full = real("yew-export-");
		writeFileSync(join(full, "notes.txt"), "mine");
		const notEmpty = await send("POST", "/api/data/export", { folder: full });
		assert.equal(notEmpty.status, 400);
		assert.equal(notEmpty.body.field, "folder");
		assert.match(notEmpty.body.type, /invalid-request$/);
		assert.deepEqual(readdirSync(full), ["notes.txt"]);

		const parent = real("yew-export-");
		for (const folder of [join(parent, "missing"), "relative/folder", join(full, "notes.txt")]) {
			const refused = await send("POST", "/api/data/export", { folder });
			assert.equal(refused.status, 400, folder);
			assert.equal(refused.body.field, "folder");
		}
		assert.deepEqual(readdirSync(parent), []);
		assert.equal((await send("POST", "/api/data/export", {})).status, 400);
		assert.equal((await send("POST", "/api/data/export", { folder: 5 })).status, 400);
	});

	test("a repeated export with the same Idempotency-Key is answered once", async () => {
		const { send } = setup();
		const folder = real("yew-export-");
		const first = await send("POST", "/api/data/export", { folder }, { key: "export-1" });
		assert.equal(first.status, 201);
		// Without the key the folder is no longer empty and the repeat would be refused.
		const again = await send("POST", "/api/data/export", { folder }, { key: "export-1" });
		assert.equal(again.status, 201);
		assert.equal(again.replayed, true);
		assert.deepEqual(again.body, first.body);
	});

	test("cleanup deletes the removable files and reports them; a repeat does not delete again", async () => {
		const { send, home, outputs } = setup();
		const first = await send("POST", "/api/data/cleanup", undefined, { key: "clean-1" });
		assert.equal(first.status, 200);
		assert.deepEqual(first.body, { deletedFiles: 2, freedBytes: 61_000, skippedFiles: 1 });
		assert.equal(existsSync(outputs.busy), true);
		const later = file(join(home, "tmp", "idle", "output", "later.log"), 10);
		const again = await send("POST", "/api/data/cleanup", undefined, { key: "clean-1" });
		assert.equal(again.replayed, true);
		assert.deepEqual(again.body, first.body);
		assert.equal(existsSync(later), true);
		const overview = (await send("GET", "/api/data")).body;
		assert.deepEqual(overview.temp, {
			files: 2,
			bytes: 5010,
			removableFiles: 1,
			removableBytes: 10,
		});
	});

	test("cleanup refuses a tmp folder that is a link, as a problem", async () => {
		const home = real("yew-home-");
		const elsewhere = real("yew-else-");
		const kept = file(join(elsewhere, "s1", "output", "keep.log"), 10);
		symlinkSync(elsewhere, join(home, "tmp"));
		const { store } = newStore();
		const app = createApp({ store, log: () => {}, data: { home } });
		const response = await app.request("/api/data/cleanup", { method: "POST" });
		assert.equal(response.status, 409);
		const problem = (await response.json()) as Json;
		assert.match(problem.type, /temp-outside$/);
		assert.equal(typeof problem.requestId, "string");
		assert.equal(existsSync(kept), true);
	});

	test("only the data folder and the folder just exported are shown, never a path from the request", async () => {
		const { send, home, ran } = setup();
		assert.equal((await send("POST", "/api/data/reveal", { target: "home" })).status, 204);
		// Nothing exported yet.
		const early = await send("POST", "/api/data/reveal", { target: "export" });
		assert.equal(early.status, 409);
		assert.match(early.body.type, /no-export$/);
		const folder = real("yew-export-");
		await send("POST", "/api/data/export", { folder });
		// A refused export does not change which folder is remembered.
		await send("POST", "/api/data/export", { folder: home });
		assert.equal((await send("POST", "/api/data/reveal", { target: "export" })).status, 204);
		assert.deepEqual(ran, [
			["open", home],
			["open", folder],
		]);
		for (const body of [
			{ target: "/etc" },
			{ target: home },
			{ target: "home", path: "/etc" },
			{ target: "tmp" },
			{ path: "/etc" },
			{ target: 1 },
		]) {
			const before = ran.length;
			const response = await send("POST", "/api/data/reveal", body);
			if (response.status === 204) {
				// An extra field is ignored: the folder shown is still the data folder.
				assert.deepEqual(ran.at(-1), ["open", home]);
			} else {
				assert.equal(response.status, 400, JSON.stringify(body));
				assert.equal(ran.length, before);
			}
		}
		assert.equal(ran.filter((call) => call[1] !== home && call[1] !== folder).length, 0);
	});

	test("Linux opens the folder; a system without a known file manager answers 409", async () => {
		const linux = setup("linux");
		await linux.send("POST", "/api/data/reveal", { target: "home" });
		assert.deepEqual(linux.ran, [["xdg-open", linux.home]]);
		const other = setup("win32");
		const refused = await other.send("POST", "/api/data/reveal", { target: "home" });
		assert.equal(refused.status, 409);
		assert.match(refused.body.type, /not-on-this-system$/);
		assert.equal(other.ran.length, 0);
	});

	test("a phone gets 403 on all of them, and nothing happens", async () => {
		const { send, ran, outputs } = setup();
		const folder = real("yew-export-");
		for (const [method, path, json] of [
			["GET", "/api/data", undefined],
			["POST", "/api/data/export", { folder }],
			["POST", "/api/data/cleanup", undefined],
			["POST", "/api/data/reveal", { target: "home" }],
		] as const) {
			const refused = await send(method, path, json, { device: "phone-1" });
			assert.equal(refused.status, 403, `${method} ${path}`);
			assert.match(refused.body.type, /mac-only$/);
		}
		assert.equal(ran.length, 0);
		assert.deepEqual(readdirSync(folder), []);
		assert.equal(existsSync(outputs.idle1), true);
	});
});

describe("data: which sessions are in use", () => {
	test("a session is in use during a turn and while a background command runs", async () => {
		const faux = fauxProvider();
		const { store } = newStore();
		const keys = new MemoryKeyStore({ [faux.provider.id]: "test-key" });
		const gateway = new ModelGateway({ keys, version: "0.0.0", providers: [faux.provider] });
		const home = real("yew-home-");
		const agents = new Agents({
			store,
			gateway,
			permissions: new PermissionEngine(home),
			home,
			version: "0.0.0",
			draftIntervalMs: 0,
			log: () => {},
		});
		const session = store.createSession({
			name: "test",
			kind: "task",
			provider: faux.provider.id,
			model: faux.getModel().id,
			cwd: real("yew-cwd-"),
			thinking: "off",
		});
		store.updateSession(session.id, { options: { permissionMode: "skip" } });
		assert.equal(agents.hasLiveCommands(session.id), false);
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("shell", { command: "sleep 30", background: true }, { id: "c1" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("started"),
		]);
		agents.send(session.id, "start it");
		assert.equal(agents.hasLiveCommands(session.id), true);
		await agents.whenIdle(session.id);
		// The turn is over; the command it left running still counts.
		assert.equal(agents.isRunning(session.id), false);
		assert.equal(agents.hasLiveCommands(session.id), true);
		assert.equal(agents.hasLiveCommands("another-session"), false);

		// The routes ask the runner, so this session's output is left alone.
		const output = file(join(home, "tmp", session.id, "output", "live.log"), 100);
		const app = createApp({ store, agents, log: () => {}, data: { home } });
		const cleaned = await app.request("/api/data/cleanup", { method: "POST" });
		assert.deepEqual(await cleaned.json(), { deletedFiles: 0, freedBytes: 0, skippedFiles: 1 });
		assert.equal(existsSync(output), true);

		agents.shutdown();
		const start = Date.now();
		while (agents.hasLiveCommands(session.id)) {
			if (Date.now() - start > 5000) throw new Error("the command did not stop");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const after = await app.request("/api/data/cleanup", { method: "POST" });
		assert.deepEqual(await after.json(), { deletedFiles: 1, freedBytes: 100, skippedFiles: 0 });
	});
});
