import assert from "node:assert/strict";
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { loadInstructions } from "../src/server/agent/prompt.ts";
import { createApp } from "../src/server/http/app.ts";
import { findSkills, listSkills, skillTool } from "../src/server/skills.ts";
import type { ToolContext } from "../src/server/tools/types.ts";
import type { Session } from "../src/shared/types.ts";
import { newStore, tempDir } from "./helpers/store.ts";

/** Skills in the settings: the list, the switch and showing the folder. */

// biome-ignore lint/suspicious/noExplicitAny: test assertions read arbitrary JSON
type Json = any;

const real = (prefix: string) => realpathSync(tempDir(prefix));

function skill(folder: string, dir: string, source: string | null): string {
	mkdirSync(join(folder, dir), { recursive: true });
	if (source !== null) writeFileSync(join(folder, dir, "SKILL.md"), source);
	return join(folder, dir);
}

const body = (name: string, description: string) =>
	`---\nname: ${name}\ndescription: ${description}\n---\nSteps`;

/** A global folder and one workspace, each with skills that read and folders that do not. */
function folders() {
	const yewHome = real("yew-home-");
	const userHome = real("yew-user-");
	const cwd = real("yew-cwd-");
	const global = join(userHome, ".claude", "skills");
	const project = join(cwd, ".claude", "skills");
	const ids = {
		pdf: skill(global, "pdf", body("pdf", "PDF work")),
		globalRelease: skill(global, "release", body("release", "The person's")),
		projectRelease: skill(project, "release", body("release", "The project's")),
		deploy: skill(join(cwd, ".yew", "skills"), "deploy", body("deploy", "Ship it")),
		empty: skill(global, "empty", null),
		badName: skill(project, "bad name", "---\nname: not a name!\n---\nE"),
	};
	// Loose files and hidden folders are not skills that went wrong.
	writeFileSync(join(global, "README.md"), "notes");
	mkdirSync(join(global, ".git"));
	const workspaces = [{ id: "w1", name: "App", path: cwd }];
	return { yewHome, userHome, cwd, ids, workspaces };
}

describe("skills: what the settings list", () => {
	test("skills are listed by source, and folders that cannot be read carry the reason", () => {
		const { yewHome, userHome, cwd, ids, workspaces } = folders();
		const listing = listSkills(workspaces, yewHome, userHome, [ids.pdf], null);
		const workspace = { kind: "workspace", name: "App", path: cwd };
		assert.deepEqual(
			listing.items.map((item) => [item.name, item.source, item.problem, item.disabled, item.id]),
			[
				["pdf", { kind: "global" }, null, true, ids.pdf],
				["release", { kind: "global" }, null, false, ids.globalRelease],
				["empty", { kind: "global" }, "no-file", false, ids.empty],
				["deploy", workspace, null, false, ids.deploy],
				["release", workspace, null, false, ids.projectRelease],
				["bad name", workspace, "bad-name", false, ids.badName],
			],
		);
		assert.equal(listing.items[0]?.description, "PDF work");
		assert.equal(listing.items[0]?.dir, ids.pdf);
		assert.deepEqual(listing.folders, [
			{
				source: { kind: "global" },
				paths: [join(yewHome, "skills"), join(userHome, ".claude", "skills")],
			},
			{
				source: workspace,
				paths: [".agents", ".claude", ".yew"].map((local) => join(cwd, local, "skills")),
			},
		]);
	});

	test("a SKILL.md that cannot be opened is reported as unreadable", (t) => {
		if (process.getuid?.() === 0) return t.skip("root reads every file");
		const { yewHome, userHome, ids } = folders();
		chmodSync(join(ids.pdf, "SKILL.md"), 0o000);
		t.after(() => chmodSync(join(ids.pdf, "SKILL.md"), 0o600));
		const pdf = listSkills([], yewHome, userHome, [], null).items.find(
			(item) => item.id === ids.pdf,
		);
		assert.equal(pdf?.problem, "unreadable");
		assert.deepEqual(
			findSkills(null, yewHome, userHome, [], null).map((s) => s.name),
			["release"],
		);
	});

	test("without the person's home folder only Yew's own folder is listed", () => {
		const { yewHome, workspaces } = folders();
		skill(join(yewHome, "skills"), "own", body("own", "Yew's"));
		assert.deepEqual(
			listSkills([], yewHome, null, [], null).items.map((item) => item.name),
			["own"],
		);
		assert.equal(listSkills(workspaces, yewHome, null, [], null).items.length, 4);
	});

	test("built-in skills are listed under the builtin group and toggled by stable ID", async () => {
		const { yewHome, userHome } = folders();
		const listing = listSkills([], yewHome, userHome);
		const builtin = listing.items.find((item) => item.id === "builtin:markdown-writing");
		assert.ok(builtin);
		assert.deepEqual(builtin.source, { kind: "builtin" });
		assert.equal(builtin.disabled, false);

		const { store } = newStore();
		const ran: { command: string; args: string[] }[] = [];
		const app = createApp({
			store,
			skills: {
				home: yewHome,
				userHome,
				platform: "darwin",
				run: async (command, args) => {
					ran.push({ command, args });
				},
			},
		});
		const toggle = await app.request("/api/skills", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "builtin:markdown-writing", disabled: true }),
		});
		assert.equal(toggle.status, 200);
		assert.deepEqual(store.getSetting("disabledSkills", []), ["builtin:markdown-writing"]);

		const reveal = await app.request("/api/skills/reveal", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "builtin:markdown-writing" }),
		});
		assert.equal(reveal.status, 204);
		assert.equal(ran[0]?.command, "open");
		assert.deepEqual(ran[0]?.args, ["-R", builtin.dir]);
	});
});

describe("skills: the switch", () => {
	const names = (skills: { name: string; description: string }[]) =>
		skills.map((s) => `${s.name}: ${s.description}`);

	test("a skill that is off is left out of what a session gets; the others stay", async () => {
		const { yewHome, userHome, cwd, ids } = folders();
		assert.deepEqual(names(findSkills(cwd, yewHome, userHome, [ids.pdf], null)), [
			"deploy: Ship it",
			"release: The project's",
		]);
		// The prompt no longer lists it and the tool no longer reads it.
		const note = loadInstructions(cwd, yewHome, {
			userHome,
			disabledSkills: [ids.pdf],
			builtinSkillsDir: null,
		}).find((file) => file.path === "skills");
		assert.equal(note?.content.includes("- pdf"), false);
		assert.ok(note?.content.includes("- deploy: Ship it"));
		let off = [ids.pdf];
		const tool = skillTool(yewHome, userHome, () => off, null);
		const session = { cwd } as Session;
		const run = (name: string) => tool.run({ name }, { session } as ToolContext);
		assert.equal((await run("pdf")).isError, true);
		assert.equal((await run("deploy")).isError, undefined);
		// Switched on again, the next call reads it; with every skill off the tool is not offered.
		off = [];
		assert.equal((await run("pdf")).isError, undefined);
		off = Object.values(ids);
		assert.equal(tool.offered?.(session, { canPostCards: false, canOrganize: false }), false);
	});

	test("with the same name in both places the project's wins, and each has its own switch", () => {
		const { yewHome, userHome, cwd, ids } = folders();
		const release = (disabled: string[], dir: string | null = cwd) =>
			findSkills(dir, yewHome, userHome, disabled).find((s) => s.name === "release")?.description;
		assert.equal(release([]), "The project's");
		// The global one off: the project's is still used there, and other folders have none.
		assert.equal(release([ids.globalRelease]), "The project's");
		assert.equal(release([ids.globalRelease], null), undefined);
		// The project's off: sessions there get the global one.
		assert.equal(release([ids.projectRelease]), "The person's");
		assert.equal(release([ids.projectRelease, ids.globalRelease]), undefined);
	});
});

describe("skills: the routes", () => {
	function setup(platform = "darwin") {
		const made = folders();
		const { store } = newStore();
		store.setSetting("workspaces", made.workspaces);
		const ran: string[][] = [];
		const app = createApp({
			store,
			log: () => {},
			skills: {
				home: made.yewHome,
				userHome: made.userHome,
				platform,
				run: async (command, args) => {
					ran.push([command, ...args]);
				},
			},
		});
		const send = async (method: string, path: string, json?: unknown, device?: string) => {
			const response = await app.fetch(
				new Request(`http://localhost${path}`, {
					method,
					...(json === undefined
						? {}
						: { headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) }),
				}),
				device ? { device } : {},
			);
			const text = await response.text();
			return { status: response.status, body: (text ? JSON.parse(text) : null) as Json };
		};
		return { ...made, store, ran, send };
	}

	test("the list has the skills, the unreadable folders and where they were looked for", async () => {
		const { send, ids, cwd } = setup();
		const { status, body: list } = await send("GET", "/api/skills");
		assert.equal(status, 200);
		assert.equal(list.items.length, 7);
		assert.equal(list.reveal, "finder");
		assert.equal(list.nextCursor, null);
		assert.deepEqual(
			list.items.find((item: Json) => item.id === ids.empty),
			{
				id: ids.empty,
				name: "empty",
				description: "",
				dir: ids.empty,
				source: { kind: "global" },
				disabled: false,
				problem: "no-file",
			},
		);
		assert.deepEqual(list.folders[0].source, { kind: "builtin" });
		assert.deepEqual(list.folders[1].source, { kind: "global" });
		assert.deepEqual(list.folders[2].source, { kind: "workspace", name: "App", path: cwd });
	});

	test("the switch is saved per skill; wrong input is refused and an unknown skill is 404", async () => {
		const { send, ids, store, yewHome, userHome, cwd } = setup();
		const off = await send("PATCH", "/api/skills", { id: ids.projectRelease, disabled: true });
		assert.equal(off.status, 200);
		assert.equal(off.body.disabled, true);
		assert.deepEqual(store.getSetting("disabledSkills", []), [ids.projectRelease]);
		// Twice is the same as once.
		await send("PATCH", "/api/skills", { id: ids.projectRelease, disabled: true });
		assert.deepEqual(store.getSetting("disabledSkills", []), [ids.projectRelease]);
		const list = (await send("GET", "/api/skills")).body;
		assert.deepEqual(
			list.items.filter((item: Json) => item.disabled).map((item: Json) => item.id),
			[ids.projectRelease],
		);
		const disabled = store.getSetting<string[]>("disabledSkills", []);
		assert.equal(
			findSkills(cwd, yewHome, userHome, disabled).find((s) => s.name === "release")?.description,
			"The person's",
		);
		const on = await send("PATCH", "/api/skills", { id: ids.projectRelease, disabled: false });
		assert.equal(on.body.disabled, false);
		assert.deepEqual(store.getSetting("disabledSkills", []), []);

		const noFlag = await send("PATCH", "/api/skills", { id: ids.pdf });
		assert.equal(noFlag.status, 400);
		assert.equal(noFlag.body.field, "disabled");
		assert.equal(
			(await send("PATCH", "/api/skills", { id: ids.pdf, disabled: "yes" })).status,
			400,
		);
		const noId = await send("PATCH", "/api/skills", { disabled: true });
		assert.equal(noId.status, 400);
		assert.equal(noId.body.field, "id");
		const unknown = await send("PATCH", "/api/skills", { id: "/nowhere/skill", disabled: true });
		assert.equal(unknown.status, 404);
		assert.match(unknown.body.type, /not-found$/);
		// A folder that could not be read has no switch.
		assert.equal(
			(await send("PATCH", "/api/skills", { id: ids.empty, disabled: true })).status,
			404,
		);
		assert.deepEqual(store.getSetting("disabledSkills", []), []);
	});

	test("only a listed folder is shown in the file manager, with the path as one argument", async () => {
		const { send, ids, ran, cwd } = setup();
		assert.equal((await send("POST", "/api/skills/reveal", { id: ids.pdf })).status, 204);
		// A folder that could not be read can be shown too: that is where it gets fixed.
		assert.equal((await send("POST", "/api/skills/reveal", { id: ids.empty })).status, 204);
		assert.deepEqual(ran, [
			["open", "-R", ids.pdf],
			["open", "-R", ids.empty],
		]);
		for (const id of [cwd, "/", join(ids.pdf, ".."), "/etc", `${ids.pdf}/`]) {
			assert.equal((await send("POST", "/api/skills/reveal", { id })).status, 404, id);
		}
		assert.equal((await send("POST", "/api/skills/reveal", {})).status, 400);
		assert.equal(ran.length, 2);
	});

	test("Linux opens the folder; a system without a known file manager answers 409", async () => {
		const linux = setup("linux");
		assert.equal((await linux.send("GET", "/api/skills")).body.reveal, "files");
		await linux.send("POST", "/api/skills/reveal", { id: linux.ids.deploy });
		assert.deepEqual(linux.ran, [["xdg-open", linux.ids.deploy]]);

		const other = setup("win32");
		assert.equal((await other.send("GET", "/api/skills")).body.reveal, null);
		const refused = await other.send("POST", "/api/skills/reveal", { id: other.ids.deploy });
		assert.equal(refused.status, 409);
		assert.match(refused.body.type, /not-on-this-system$/);
		assert.equal(other.ran.length, 0);
	});

	test("a program that fails is reported as a problem", async () => {
		const made = folders();
		const { store } = newStore();
		const app = createApp({
			store,
			log: () => {},
			skills: {
				home: made.yewHome,
				userHome: made.userHome,
				platform: "linux",
				run: () => Promise.reject(new Error("spawn xdg-open ENOENT")),
			},
		});
		const response = await app.request("/api/skills/reveal", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: made.ids.pdf }),
		});
		assert.equal(response.status, 500);
		assert.match(((await response.json()) as Json).type, /reveal-failed$/);
	});

	test("a phone cannot list, switch or show skills", async () => {
		const { send, ids, ran, store } = setup();
		for (const [method, path, json] of [
			["GET", "/api/skills", undefined],
			["PATCH", "/api/skills", { id: ids.pdf, disabled: true }],
			["POST", "/api/skills/reveal", { id: ids.pdf }],
		] as const) {
			const refused = await send(method, path, json, "phone-1");
			assert.equal(refused.status, 403, `${method} ${path}`);
			assert.match(refused.body.type, /mac-only$/);
		}
		assert.equal(ran.length, 0);
		assert.deepEqual(store.getSetting("disabledSkills", []), []);
	});
});
