// Versions and updates: no real npm, registry or restart.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, mock, test } from "node:test";
import { startedByService } from "../src/cli/service.ts";
import { createApp } from "../src/server/http/app.ts";
import {
	buildAt,
	buildIn,
	COMMIT_FILE,
	globalPrefix,
	installKind,
	newer,
	npmNextTo,
	type Run,
	type UpdateOptions,
	Updates,
} from "../src/server/updates.ts";
import { newStore, tempDir } from "./helpers/store.ts";

/** A package folder shaped like a global npm install: <prefix>/lib/node_modules/@tenonai/yew. */
function npmInstall(version = "1.7.0") {
	const prefix = realpathSync(tempDir("yew-prefix-"));
	const root = join(prefix, "lib", "node_modules", "@tenonai", "yew");
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@tenonai/yew", version }));
	// The Node.js running Yew Harness, with its npm beside it.
	const node = join(prefix, "node", "bin", "node");
	mkdirSync(join(prefix, "node", "lib", "node_modules", "npm", "bin"), { recursive: true });
	writeFileSync(npmNextTo(node), "");
	return { prefix, root, node };
}

function setup(options: Partial<UpdateOptions> = {}, version = "1.7.0") {
	const made = npmInstall(version);
	const { store } = newStore();
	const runs: { file: string; args: string[] }[] = [];
	const requests: { url: string; agent: string | null }[] = [];
	let latest = "1.8.0";
	/** The integrity each registry gives for a version; null for one that cannot be reached. */
	const integrity: Record<string, string | null> = {
		"registry.npmmirror.com": "sha512-same",
		"registry.npmjs.org": "sha512-same",
	};
	/** What npm records in the global folder's lock file for the package it installs. */
	const installs = { integrity: "sha512-same" };
	let busy = 0;
	let restarts = 0;
	let refreshed = 0;
	const updates = new Updates({
		version: "1.7.0",
		build: null,
		root: made.root,
		node: made.node,
		store,
		busy: () => busy,
		restart: () => {
			restarts += 1;
		},
		refreshApp: async () => {
			refreshed += 1;
		},
		log: () => {},
		fetch: (async (url: URL, init?: RequestInit) => {
			requests.push({
				url: String(url),
				agent: new Headers(init?.headers).get("User-Agent"),
			});
			if (url.pathname.endsWith("/latest")) {
				return Response.json({ name: "@tenonai/yew", version: latest });
			}
			const known = integrity[url.hostname];
			if (known === null) throw new TypeError("fetch failed");
			const version = url.pathname.split("/").at(-1);
			return Response.json({ name: "@tenonai/yew", version, dist: { integrity: known } });
		}) as typeof fetch,
		run: async (file, args): Promise<Run> => {
			runs.push({ file, args });
			if (args.includes("config")) return { code: 0, output: "https://registry.npmmirror.com\n" };
			// npm puts the version asked for in place.
			const asked = args.find((arg) => arg.startsWith("@tenonai/yew@"));
			if (asked) {
				writeFileSync(
					join(made.root, "package.json"),
					JSON.stringify({ name: "@tenonai/yew", version: asked.slice("@tenonai/yew@".length) }),
				);
				writeFileSync(
					join(made.prefix, "lib", "node_modules", ".package-lock.json"),
					JSON.stringify({
						packages: { "node_modules/@tenonai/yew": { integrity: installs.integrity } },
					}),
				);
			}
			return { code: 0, output: "added 1 package" };
		},
		writable: () => true,
		platform: "darwin",
		...options,
	});
	return {
		...made,
		store,
		updates,
		runs,
		requests,
		setLatest: (value: string) => {
			latest = value;
		},
		setBusy: (value: number) => {
			busy = value;
		},
		restarts: () => restarts,
		refreshed: () => refreshed,
		integrity,
		installs,
	};
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("versions", () => {
	test("newer compares x.y.z by number", () => {
		assert.equal(newer("1.8.0", "1.7.0"), true);
		assert.equal(newer("1.10.0", "1.9.9"), true);
		assert.equal(newer("2.0.0", "1.99.99"), true);
		assert.equal(newer("1.7.0", "1.7.0"), false);
		assert.equal(newer("1.6.1", "1.7.0"), false);
		assert.equal(newer("1.8.0-beta.1", "1.7.0"), true);
	});

	test("how it was installed: a checkout, a global npm install, anything else", () => {
		const checkout = realpathSync(tempDir("yew-src-"));
		mkdirSync(join(checkout, ".git"));
		assert.equal(installKind(checkout), "source");
		const { prefix, root } = npmInstall();
		assert.equal(installKind(root), "npm");
		// As serve.ts gives it: a folder URL turned into a path, with a slash at the end.
		assert.equal(installKind(`${root}/`), "npm");
		assert.equal(globalPrefix(root), prefix);
		assert.equal(globalPrefix(`${root}/`), prefix);
		assert.equal(installKind(realpathSync(tempDir("yew-other-"))), "other");
	});

	test("the build is the commit of Yew's own checkout, not of a repository around an install", () => {
		const outer = realpathSync(tempDir("yew-brew-"));
		const git = (...args: string[]) =>
			execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
				cwd: outer,
				stdio: "ignore",
			});
		git("init", "-q");
		git("commit", "-q", "--allow-empty", "-m", "brew");
		const installed = join(outer, "lib", "node_modules", "@tenonai", "yew");
		mkdirSync(installed, { recursive: true });
		assert.equal(buildIn(installed), null);
		assert.match(buildIn(outer)?.build ?? "", /^[0-9a-f]{7,}$/);
	});

	test("the id of the code changes with what the service loads, not with the interface or the documents", () => {
		const checkout = realpathSync(tempDir("yew-src-"));
		const git = (...args: string[]) =>
			execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
				cwd: checkout,
				stdio: "ignore",
			});
		const write = (path: string, text: string) => {
			mkdirSync(join(checkout, path, ".."), { recursive: true });
			writeFileSync(join(checkout, path), text);
			git("add", "-A");
			git("commit", "-q", "-m", path);
		};
		git("init", "-q");
		for (const path of [
			"src/a.ts",
			"bin/yew.js",
			"mcp-builtin/package.json",
			"skills-builtin/a.md",
		])
			write(path, "1");
		write("package.json", "{}");
		// Not everything the service loads is there yet: the commit is known, the code's id is not.
		assert.equal(buildIn(checkout)?.code, null);
		write("package-lock.json", "{}");
		const first = buildIn(checkout);
		assert.match(first?.code ?? "", /^[0-9a-f]{16}$/);
		write("web/src/app.tsx", "1");
		write("README.md", "1");
		const second = buildIn(checkout);
		assert.notEqual(second?.build, first?.build);
		assert.equal(second?.code, first?.code);
		write("src/a.ts", "2");
		assert.notEqual(buildIn(checkout)?.code, first?.code);
		// An earlier commit can be asked about, as the install script does.
		assert.deepEqual(buildAt(checkout, first?.build), first);
		assert.equal(buildAt(checkout, "no-such-commit"), null);
	});

	test("a copy installed from a checkout says its build in a file", () => {
		const copy = realpathSync(tempDir("yew-copy-"));
		assert.equal(installKind(copy), "other");
		writeFileSync(join(copy, COMMIT_FILE), "66f5352\n0123456789abcdef\n");
		assert.deepEqual(buildIn(copy), { build: "66f5352", code: "0123456789abcdef" });
		assert.equal(installKind(copy), "source");
		writeFileSync(join(copy, COMMIT_FILE), "66f5352\n");
		assert.deepEqual(buildIn(copy), { build: "66f5352", code: null });
		writeFileSync(join(copy, COMMIT_FILE), "$Format:%h$\n");
		assert.equal(buildIn(copy), null);
		assert.equal(installKind(copy), "other");
	});

	test("a service older than what is installed asks for a restart", () => {
		const { root, updates } = setup();
		assert.equal(updates.state().restart, false);
		writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.8.0" }));
		const state = updates.state();
		assert.equal(state.restart, true);
		assert.deepEqual(state.installed, { version: "1.8.0", build: null });
	});

	test("a newer commit asks for a restart only when the service's code changed", async () => {
		const copy = realpathSync(tempDir("yew-copy-"));
		writeFileSync(join(copy, "package.json"), JSON.stringify({ version: "1.7.0" }));
		writeFileSync(join(copy, COMMIT_FILE), "aaaaaaa 1111111111111111\n");
		const { updates, requests } = setup({ root: copy, build: "aaaaaaa", code: "1111111111111111" });
		assert.equal(updates.state().restart, false);
		// Only the interface changed: the new commit is in use as it is.
		writeFileSync(join(copy, COMMIT_FILE), "bbbbbbb 1111111111111111\n");
		let state = updates.state();
		assert.equal(state.restart, false);
		assert.deepEqual(state.installed, { version: "1.7.0", build: "bbbbbbb" });
		writeFileSync(join(copy, COMMIT_FILE), "ccccccc 2222222222222222\n");
		state = updates.state();
		assert.equal(state.restart, true);
		assert.equal(state.kind, "source");
		// A copy of a checkout is not checked against npm either.
		assert.equal((await updates.check()).latest, null);
		assert.equal(requests.length, 0);
	});

	test("without an id for the code, any other commit asks for a restart", () => {
		const copy = realpathSync(tempDir("yew-copy-"));
		writeFileSync(join(copy, "package.json"), JSON.stringify({ version: "1.7.0" }));
		writeFileSync(join(copy, COMMIT_FILE), "aaaaaaa\n");
		const { updates } = setup({ root: copy, build: "aaaaaaa", code: null });
		assert.equal(updates.state().restart, false);
		writeFileSync(join(copy, COMMIT_FILE), "bbbbbbb 1111111111111111\n");
		assert.equal(updates.state().restart, true);
	});
});

describe("checking for a new version", () => {
	test("asks the registry the person's npm uses, with only Yew's version as the user agent", async () => {
		const { updates, requests, store } = setup();
		const state = await updates.check();
		assert.deepEqual(requests, [
			{ url: "https://registry.npmmirror.com/@tenonai/yew/latest", agent: "yew/1.7.0" },
		]);
		assert.equal(state.available, true);
		assert.equal(state.latest?.version, "1.8.0");
		assert.equal(state.manual, null);
		assert.equal(
			store.getSetting<{ version: string } | null>("updateLatest", null)?.version,
			"1.8.0",
		);
	});

	test("the same version or an older one is not offered", async () => {
		const { updates, setLatest } = setup();
		setLatest("1.7.0");
		assert.equal((await updates.check()).available, false);
		setLatest("1.6.1");
		assert.equal((await updates.check()).available, false);
	});

	test("a source checkout is not checked", async () => {
		const checkout = realpathSync(tempDir("yew-src-"));
		mkdirSync(join(checkout, ".git"));
		writeFileSync(join(checkout, "package.json"), JSON.stringify({ version: "1.7.0" }));
		const { updates, requests } = setup({ root: checkout });
		const state = await updates.check();
		assert.equal(requests.length, 0);
		assert.equal(state.kind, "source");
		assert.equal(state.latest, null);
	});

	test("an answer without a version is refused and nothing is kept", async () => {
		const { updates, store } = setup({
			fetch: (async () => Response.json({ name: "@tenonai/yew" })) as unknown as typeof fetch,
		});
		await assert.rejects(updates.check(), /did not say which version/);
		assert.equal(store.getSetting("updateLatest", null), null);
	});
});

describe("installing an update", () => {
	test("installs that version with the npm next to Node.js, into the same folder, without scripts", async () => {
		const { updates, runs, node, prefix, refreshed } = setup();
		await updates.check();
		const started = updates.install("1.8.0");
		assert.equal(started.job?.state, "installing");
		await settle();
		const install = runs.find((run) => run.args.includes("install"));
		assert.deepEqual(install, {
			file: node,
			args: [
				npmNextTo(node),
				"install",
				"--global",
				"--prefix",
				prefix,
				"@tenonai/yew@1.8.0",
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
			],
		});
		assert.equal(updates.state().job?.state, "installed");
		assert.equal(refreshed(), 1);
		// On a Mac, the mark macOS puts on downloads comes off what npm put there.
		assert.deepEqual(runs.find((run) => run.file === "xattr")?.args, [
			"-r",
			"-d",
			"com.apple.quarantine",
			join(prefix, "lib", "node_modules", "@tenonai", "yew"),
		]);
	});

	test("the mark is not taken off a package reached through a link", async () => {
		const real = npmInstall();
		const prefix = realpathSync(tempDir("yew-linked-"));
		mkdirSync(join(prefix, "lib", "node_modules", "@tenonai"), { recursive: true });
		const linked = join(prefix, "lib", "node_modules", "@tenonai", "yew");
		symlinkSync(real.root, linked);
		const runs: { file: string; args: string[] }[] = [];
		const { updates } = setup({
			root: linked,
			node: real.node,
			run: async (file, args) => {
				runs.push({ file, args });
				if (args.includes("config")) return { code: 0, output: "https://registry.npmjs.org/" };
				if (args.includes("install")) {
					writeFileSync(
						join(linked, "package.json"),
						JSON.stringify({ name: "@tenonai/yew", version: "1.8.0" }),
					);
				}
				return { code: 0, output: "" };
			},
		});
		await updates.check();
		updates.install("1.8.0");
		for (let i = 0; i < 5; i++) await settle();
		assert.equal(updates.state().job?.state, "installed");
		assert.equal(
			runs.some((run) => run.file === "xattr"),
			false,
		);
	});

	test("only the new version found on npm", async () => {
		const { updates } = setup();
		assert.throws(() => updates.install("1.8.0"), /not the new version found/);
		await updates.check();
		assert.throws(() => updates.install("1.9.0"), /not the new version found/);
		assert.throws(() => updates.install("1.8.0; rm -rf ~"), /must look like/);
	});

	test("where it may not write, it gives the command and does not run npm", async () => {
		const { updates, runs } = setup({ writable: () => false });
		const state = await updates.check();
		assert.equal(state.manual, "npm install --global @tenonai/yew@1.8.0");
		assert.throws(() => updates.install("1.8.0"), /cannot install it here/);
		assert.equal(runs.filter((run) => run.args.includes("install")).length, 0);
	});

	test("from a mirror, a package that differs from npm's own is not installed", async () => {
		const { updates, runs, integrity } = setup();
		await updates.check();
		integrity["registry.npmmirror.com"] = "sha512-changed";
		updates.install("1.8.0");
		await settle();
		await settle();
		const job = updates.state().job;
		assert.equal(job?.state, "failed");
		assert.match(job?.output ?? "", /gives a different package/);
		assert.equal(runs.filter((run) => run.args.includes("install")).length, 0);
	});

	test("what npm installed from a mirror is checked again: one unlike npm's blocks the restart", async () => {
		const { updates, installs, refreshed, prefix } = setup();
		await updates.check();
		installs.integrity = "sha512-swapped";
		updates.install("1.8.0");
		for (let i = 0; i < 5; i++) await settle();
		const state = updates.state();
		assert.equal(state.job?.state, "failed");
		assert.match(state.job?.output ?? "", /is not the package/);
		assert.equal(state.restart, false);
		assert.equal(
			state.manual,
			"npm install --global @tenonai/yew@1.8.0 --registry=https://registry.npmjs.org/",
		);
		assert.equal(refreshed(), 0);
		assert.throws(() => updates.restart(true), /Install it again first/);
		// Installed again from npm's registry: the restart is offered.
		writeFileSync(
			join(prefix, "lib", "node_modules", ".package-lock.json"),
			JSON.stringify({ packages: { "node_modules/@tenonai/yew": { integrity: "sha512-same" } } }),
		);
		assert.equal(updates.state().restart, true);
		assert.equal(updates.state().manual, null);
	});

	test("when npm's own registry cannot be reached, the mirror's package is installed", async () => {
		const { updates, integrity } = setup();
		await updates.check();
		integrity["registry.npmjs.org"] = null;
		updates.install("1.8.0");
		for (let i = 0; i < 5; i++) await settle();
		assert.equal(updates.state().job?.state, "installed");
	});

	test("after npm, a package that is not the one asked for leaves the Mac app alone", async () => {
		const { updates, refreshed } = setup({
			run: async (_file, args) =>
				args.includes("config")
					? { code: 0, output: "https://registry.npmjs.org/" }
					: { code: 0, output: "added 1 package" },
		});
		await updates.check();
		updates.install("1.8.0");
		for (let i = 0; i < 5; i++) await settle();
		const job = updates.state().job;
		assert.equal(job?.state, "failed");
		assert.match(job?.output ?? "", /does not hold @tenonai\/yew@1\.8\.0/);
		assert.equal(refreshed(), 0);
		// Nothing that is not the package asked for gets started.
		assert.throws(() => updates.restart(true), /Install it again first/);
	});

	test("an install that fails says so, with npm's output", async () => {
		const { updates } = setup({
			run: async (_file, args) =>
				args.includes("config")
					? { code: 0, output: "https://registry.npmjs.org/" }
					: { code: 1, output: "npm error code EACCES" },
		});
		await updates.check();
		updates.install("1.8.0");
		await settle();
		const job = updates.state().job;
		assert.equal(job?.state, "failed");
		assert.match(job?.output ?? "", /EACCES/);
	});
});

describe("restarting", () => {
	test("waits for the sessions at work, or goes at once when asked", () => {
		mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
		try {
			const { updates, setBusy, restarts } = setup();
			setBusy(2);
			const waiting = updates.restart(false);
			assert.equal(waiting.restarting, false);
			assert.equal(waiting.restartPending, true);
			mock.timers.tick(5000);
			assert.equal(restarts(), 0);
			setBusy(0);
			mock.timers.tick(5000);
			assert.equal(restarts(), 1);

			setBusy(1);
			const now = updates.restart(true);
			assert.equal(now.restarting, true);
			mock.timers.tick(300);
			assert.equal(restarts(), 2);
		} finally {
			mock.timers.reset();
		}
	});

	test("the login service restarts it when it exits with an error; otherwise it starts itself", () => {
		assert.equal(startedByService({ XPC_SERVICE_NAME: "cn.tenonai.apps.yew" }, "darwin"), true);
		assert.equal(
			startedByService({ XPC_SERVICE_NAME: "application.cn.tenonai.apps.yew.desktop.1" }, "darwin"),
			false,
		);
		const unit = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/yew.service\n";
		assert.equal(
			startedByService({}, "linux", () => unit),
			true,
		);
		assert.equal(
			startedByService({}, "linux", () => "0::/user.slice/user-1000.slice/session-2.scope\n"),
			false,
		);
	});
});

describe("the routes", () => {
	test("a phone cannot reach them, and nothing runs", async () => {
		const { updates, runs, store } = setup();
		const app = createApp({ store, log: () => {}, updates });
		for (const [method, path] of [
			["GET", "/api/updates"],
			["POST", "/api/updates/check"],
			["POST", "/api/updates/install"],
			["POST", "/api/updates/restart"],
		] as const) {
			const response = await app.fetch(
				new Request(`http://localhost${path}`, {
					method,
					headers: { "Content-Type": "application/json" },
					...(method === "POST" ? { body: JSON.stringify({ version: "1.8.0", now: true }) } : {}),
				}),
				{ device: "phone-1" },
			);
			assert.equal(response.status, 403, `${method} ${path}`);
			assert.match(((await response.json()) as { type: string }).type, /mac-only$/);
		}
		assert.equal(runs.length, 0);
	});

	test("on the Mac: the state, a check and turning the daily check off", async () => {
		const { updates, store } = setup();
		const app = createApp({ store, log: () => {}, updates });
		const send = async (method: string, path: string, body?: unknown) => {
			const response = await app.fetch(
				new Request(`http://localhost${path}`, {
					method,
					headers: { "Content-Type": "application/json" },
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				}),
			);
			return { status: response.status, body: (await response.json()) as Record<string, unknown> };
		};
		const first = await send("GET", "/api/updates");
		assert.equal(first.status, 200);
		assert.equal(first.body.version, "1.7.0");
		assert.equal(first.body.checks, true);
		const checked = await send("POST", "/api/updates/check");
		assert.equal(checked.body.available, true);
		await send("PATCH", "/api/settings", { updateCheck: false });
		assert.equal((await send("GET", "/api/updates")).body.checks, false);
	});
});
