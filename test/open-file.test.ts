import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { openDatabase } from "../src/server/db/database.ts";
import { EventBus } from "../src/server/events.ts";
import { api } from "../src/server/http/api.ts";
import { createApp } from "../src/server/http/app.ts";
import { errorHandler } from "../src/server/http/problem.ts";
import { openFileCommand, revealOnly } from "../src/server/reveal.ts";
import { Store } from "../src/server/store.ts";
import { codeSpanPath } from "../web/src/file-links.ts";
import { continueMarkdownList, indentMarkdownList } from "../web/src/markdown-edit.ts";

describe("openFileCommand", () => {
	test("builds macOS commands for system, Finder, VS Code, Cursor and Zed with line anchors", () => {
		assert.deepEqual(
			openFileCommand("/Users/test/文档 1.md", { opener: "system", platform: "darwin" }),
			{ command: "open", args: ["/Users/test/文档 1.md"] },
		);
		assert.deepEqual(
			openFileCommand("/Users/test/文档 1.md", { opener: "finder", platform: "darwin" }),
			{ command: "open", args: ["-R", "/Users/test/文档 1.md"] },
		);
		assert.deepEqual(
			openFileCommand("/Users/test/文档 1.md", { opener: "vscode", platform: "darwin" }),
			{ command: "open", args: ["-a", "Visual Studio Code", "/Users/test/文档 1.md"] },
		);
		assert.deepEqual(
			openFileCommand("/Users/test/文档 1.md", {
				opener: "vscode",
				line: 42,
				column: 5,
				platform: "darwin",
			}),
			{ command: "open", args: ["vscode://file/Users/test/%E6%96%87%E6%A1%A3%201.md:42:5"] },
		);
		assert.deepEqual(
			openFileCommand("/Users/test/app.ts", { opener: "zed", line: 10, platform: "darwin" }),
			{ command: "open", args: ["zed://file/Users/test/app.ts:10"] },
		);
		assert.deepEqual(
			openFileCommand("/Users/test/app.ts", { opener: "cursor", platform: "darwin" }),
			{ command: "open", args: ["-a", "Cursor", "/Users/test/app.ts"] },
		);
	});

	test("builds Linux commands for editors and file manager", () => {
		assert.deepEqual(
			openFileCommand("/home/test/app.ts", { opener: "vscode", line: 7, platform: "linux" }),
			{ command: "code", args: ["--goto", "/home/test/app.ts:7"] },
		);
		assert.deepEqual(
			openFileCommand("/home/test/app.ts", {
				opener: "zed",
				line: 7,
				column: 2,
				platform: "linux",
			}),
			{ command: "zed", args: ["/home/test/app.ts:7:2"] },
		);
		assert.deepEqual(
			openFileCommand("/home/test/app.ts", { opener: "finder", platform: "linux", isDir: false }),
			{ command: "xdg-open", args: ["/home/test"] },
		);
	});
});

describe("POST /api/open-file and fileOpener setting", () => {
	test("saves fileOpener setting, resolves relative & file:// paths, and enforces boundaries", async () => {
		const root = mkdtempSync(join(tmpdir(), "yew-open-file-"));
		const yewHome = join(root, ".yew");
		const workspace = join(root, "work");
		const hidden = join(root, "secret");
		mkdirSync(yewHome, { recursive: true });
		mkdirSync(workspace, { recursive: true });
		mkdirSync(hidden, { recursive: true });
		const notePath = join(workspace, "笔记.md");
		const hiddenPath = join(hidden, "private.txt");
		writeFileSync(notePath, "# Note\n", "utf8");
		writeFileSync(hiddenPath, "secret", "utf8");

		const db = openDatabase(":memory:");
		const store = new Store(db, new EventBus());
		const launched: { command: string; args: string[] }[] = [];
		const app = api({
			store,
			yewHome,
			userHome: root,
			platform: "darwin",
			openFile: async (command, args) => {
				launched.push({ command, args });
			},
		});
		app.onError(errorHandler(() => {}));

		try {
			const session = store.createSession({
				name: "Docs",
				kind: "task",
				cwd: workspace,
				provider: "deepseek",
				model: "deepseek-v4-pro",
			});

			// Default fileOpener is system; update it to vscode and add hidden folder.
			const patch = await app.request("/settings", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ fileOpener: "vscode", hiddenFolders: [hidden] }),
			});
			assert.equal(patch.status, 200);
			const saved = (await patch.json()) as { fileOpener: string };
			assert.equal(saved.fileOpener, "vscode");

			// Relative path resolves via session cwd and opens with VS Code at line 12.
			const relRes = await app.request("/open-file", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: "笔记.md", line: 12, sessionId: session.id }),
			});
			assert.equal(relRes.status, 204);
			assert.equal(launched.length, 1);
			assert.equal(launched[0]?.command, "open");
			assert.match(launched[0]?.args[0] ?? "", /^vscode:\/\/file\/.*%E7%AC%94%E8%AE%B0\.md:12$/);

			// file:// URL opens cleanly too.
			const urlRes = await app.request("/open-file", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					path: pathToFileURL(realpathSync(notePath)).href,
					opener: "finder",
				}),
			});
			assert.equal(urlRes.status, 204);
			assert.deepEqual(launched[1], { command: "open", args: ["-R", realpathSync(notePath)] });

			// Hidden folder is rejected with 403.
			const hiddenRes = await app.request("/open-file", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: hiddenPath }),
			});
			assert.equal(hiddenRes.status, 403);

			// Missing file returns 404.
			const missingRes = await app.request("/open-file", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: "missing.md", sessionId: session.id }),
			});
			assert.equal(missingRes.status, 404);
		} finally {
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("the system default opens only documents; everything else is shown in the file manager", async () => {
		const root = mkdtempSync(join(tmpdir(), "yew-open-reveal-"));
		const yewHome = join(root, ".yew");
		mkdirSync(yewHome, { recursive: true });
		const shown = [
			"run.command",
			"tool.sh",
			"launch.py",
			"launch.pyw",
			"start.jnlp",
			"profile.mobileconfig",
			"addition.osax",
			"look.qlgenerator",
			"find.mdimporter",
			"ext.safariextz",
			"flow.alfredworkflow",
			"setup.exe",
			"setup.msi",
			"go.bat",
			"link.lnk",
			"pkg.deb",
			"pkg.rpm",
			"pkg.snap",
			"app.flatpakref",
			"repo.flatpakrepo",
			"setup.run",
			"old.doc",
			"old.xls",
			"old.ppt",
			"blob.bin",
			"mystery.foo",
			"noextension",
		];
		for (const name of shown) writeFileSync(join(root, name), "x\n", "utf8");
		const executable = join(root, "notes.txt.exe-bit.md");
		writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 });
		const bundle = join(root, "Some.app");
		mkdirSync(bundle);
		const folder = join(root, "plain");
		mkdirSync(folder);
		const note = join(root, "note.md");
		const picture = join(root, "photo.png");
		writeFileSync(note, "# Note\n", "utf8");
		writeFileSync(picture, "x", "utf8");
		const report = join(root, "report.docx");
		writeFileSync(report, "x", "utf8");
		const db = openDatabase(":memory:");
		const store = new Store(db, new EventBus());
		const launched: { command: string; args: string[] }[] = [];
		const app = api({
			store,
			yewHome,
			userHome: root,
			platform: "darwin",
			openFile: async (command, args) => {
				launched.push({ command, args });
			},
		});
		app.onError(errorHandler(() => {}));
		const open = async (path: string) => {
			const response = await app.request("/open-file", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path, opener: "system" }),
			});
			assert.equal(response.status, 204, path);
			return launched.at(-1);
		};
		try {
			for (const path of [...shown.map((name) => join(root, name)), executable, bundle]) {
				assert.deepEqual(
					await open(path),
					{ command: "open", args: ["-R", realpathSync(path)] },
					path,
				);
			}
			for (const path of [note, picture, report, folder]) {
				assert.deepEqual(await open(path), { command: "open", args: [realpathSync(path)] }, path);
			}
		} finally {
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("editors open single files; folders and workspace files are shown in the file manager", () => {
		const folder = { isDirectory: () => true, mode: 0o755 };
		const file = { isDirectory: () => false, mode: 0o644 };
		for (const opener of ["vscode", "cursor", "zed"] as const) {
			assert.equal(revealOnly("/work/project", folder, opener), true);
			assert.equal(revealOnly("/work/team.code-workspace", file, opener), true);
			assert.equal(revealOnly("/work/ext.vsix", file, opener), true);
			assert.equal(revealOnly("/work/app.ts", file, opener), false);
			assert.deepEqual(
				openFileCommand("/work/project", { opener, platform: "darwin", isDir: true, reveal: true }),
				{ command: "open", args: ["-R", "/work/project"] },
			);
			assert.deepEqual(
				openFileCommand("/work/project", { opener, platform: "linux", isDir: true, reveal: true }),
				{ command: "xdg-open", args: ["/work/project"] },
			);
		}
		for (const opener of ["system", "vscode", "cursor", "zed"] as const) {
			assert.equal(revealOnly("/work/note.md", null, opener), true);
		}
		assert.deepEqual(
			openFileCommand("/work/app.ts", { opener: "vscode", platform: "darwin", reveal: false }),
			{ command: "open", args: ["-a", "Visual Studio Code", "/work/app.ts"] },
		);
		assert.deepEqual(
			openFileCommand("/work/team.code-workspace", {
				opener: "vscode",
				platform: "darwin",
				reveal: true,
			}),
			{ command: "open", args: ["-R", "/work/team.code-workspace"] },
		);
	});

	test("blocks paired phones from calling /api/open-file", async () => {
		const db = openDatabase(":memory:");
		const store = new Store(db, new EventBus());
		const app = createApp({ store });
		try {
			const res = await app.request(
				"/api/open-file",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ path: "/tmp/anything.md" }),
				},
				{ device: "phone-1" },
			);
			assert.equal(res.status, 403);
		} finally {
			db.close();
		}
	});
});

describe("markdown composer helpers", () => {
	test("continues ordered, bullet and task lists and clears empty list markers", () => {
		assert.deepEqual(continueMarkdownList("1. 第一条", 6, 6), {
			value: "1. 第一条\n2. ",
			caret: 10,
		});
		assert.deepEqual(continueMarkdownList("1. 第一条\n2. ", 10, 10), {
			value: "1. 第一条\n",
			caret: 7,
		});
		assert.deepEqual(continueMarkdownList("  - item", 8, 8), {
			value: "  - item\n  - ",
			caret: 13,
		});
		assert.deepEqual(continueMarkdownList("- [x] done", 10, 10), {
			value: "- [x] done\n- [ ] ",
			caret: 17,
		});
		assert.equal(continueMarkdownList("plain line", 10, 10), null);
	});

	test("indents and outdents list items without affecting plain text", () => {
		assert.deepEqual(indentMarkdownList("- item", 6, 6, false), {
			value: "  - item",
			caret: 8,
		});
		assert.deepEqual(indentMarkdownList("  - item", 8, 8, true), {
			value: "- item",
			caret: 6,
		});
		assert.equal(indentMarkdownList("plain line", 5, 5, false), null);
	});
});

describe("paths written as inline code", () => {
	test("home, dot, absolute and relative paths with a line or column open as files", () => {
		assert.deepEqual(codeSpanPath("~/notes/plan.md"), { path: "~/notes/plan.md" });
		assert.deepEqual(codeSpanPath("~/Pictures/素材/Yew/poses"), {
			path: "~/Pictures/素材/Yew/poses",
		});
		assert.deepEqual(codeSpanPath("./src"), { path: "./src" });
		assert.deepEqual(codeSpanPath("../shared/types.ts"), { path: "../shared/types.ts" });
		assert.deepEqual(codeSpanPath("/Users/me/Yew"), { path: "/Users/me/Yew" });
		assert.deepEqual(codeSpanPath("/etc/hosts"), { path: "/etc/hosts" });
		assert.deepEqual(codeSpanPath("/workspace/app/main.py"), { path: "/workspace/app/main.py" });
		assert.deepEqual(codeSpanPath(".github/workflows/ci.yml"), {
			path: ".github/workflows/ci.yml",
		});
		assert.deepEqual(codeSpanPath("src/app.ts:12"), { path: "src/app.ts", line: 12 });
		assert.deepEqual(codeSpanPath("src/app.ts:12:5"), { path: "src/app.ts", line: 12, column: 5 });
		assert.deepEqual(codeSpanPath("web/src/main.tsx:30-42"), {
			path: "web/src/main.tsx",
			line: 30,
		});
	});

	test("commands, routes, web addresses, patterns and bare names stay code", () => {
		for (const text of [
			"/api/cards",
			"/help",
			"/favicon.ico",
			"npm run check",
			"build:web",
			"127.0.0.1:4317",
			"https://example.com/a.md",
			"example.com/docs/a.md",
			"src/**/*.ts",
			"web/public/mascot/<pose>.webp",
			"$HOME/notes.md",
			"--out=dist/app.js",
			"~user/notes.md",
			"~/",
			"./",
			"package.json",
			"src/server/",
			"origin/main",
			"@tenonai/yew",
			"1/2",
		]) {
			assert.equal(codeSpanPath(text), null, text);
		}
	});
});
