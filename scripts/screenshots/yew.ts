import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { openDatabase } from "../../src/server/db/database.ts";
import { EventBus } from "../../src/server/events.ts";
import { MemoryKeyStore } from "../../src/server/keys.ts";
import { PostOffice } from "../../src/server/mail/post.ts";
import { ModelGateway } from "../../src/server/model/gateway.ts";
import { dbPath } from "../../src/server/paths.ts";
import { Store } from "../../src/server/store.ts";
import type { Approval, Card, Session } from "../../src/shared/types.ts";
import { BIN, HOUR, type Lang, pause, SHOWN_MODEL, WITH_KEYS } from "./shared.ts";
import { projectFiles, STORIES, type Story } from "./story.ts";

// --- a throwaway Yew ---

interface Ids {
	main: string;
	website: string;
	backend: string;
	content: string;
}

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=Demo", "-c", "user.email=demo@example.com", ...args], {
		cwd,
		stdio: "ignore",
	});

/** Yew's environment: the data folder, no keychain, no built-in MCP servers, no other computers. */
function yewEnv(home: string): NodeJS.ProcessEnv {
	const nowhere = "http://127.0.0.1:9";
	return {
		...process.env,
		YEW_HOME: home,
		YEW_KEYCHAIN: "off",
		YEW_MCP_BUILTIN: "off",
		NO_COLOR: "1",
		// Every request to another computer goes to a port where nothing listens, so it fails.
		NODE_USE_ENV_PROXY: "1",
		HTTP_PROXY: nowhere,
		HTTPS_PROXY: nowhere,
		http_proxy: nowhere,
		https_proxy: nowhere,
		NO_PROXY: "127.0.0.1,localhost",
		no_proxy: "127.0.0.1,localhost",
	};
}

const yew = (env: NodeJS.ProcessEnv, ...args: string[]) =>
	execFileSync(process.execPath, [BIN, ...args], {
		env,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

/**
 * The data folder and the project, before Yew starts: the sessions, teams and workspace, the stand-in
 * as the model, and the letters from earlier in the day, which their sessions have already read.
 */
export function seed(
	folder: string,
	lang: Lang,
	modelUrl: string,
): { env: NodeJS.ProcessEnv; ids: Ids } {
	const story = STORIES[lang];
	const home = join(folder, "home");
	const site = join(folder, "acme-shop");
	const remote = join(folder, "acme-shop.git");
	for (const dir of [home, join(site, "docs"), join(site, "src"), join(site, "test")]) {
		mkdirSync(dir, { recursive: true });
	}
	// Instructions of its own, so the person's global instruction file is not read.
	writeFileSync(join(home, "AGENTS.md"), "A throwaway Yew for the website screenshots.\n");
	for (const [name, content] of Object.entries(projectFiles(story))) {
		writeFileSync(join(site, name), content);
	}
	git(folder, "init", "-q", "--bare", "-b", "main", remote);
	git(site, "init", "-q", "-b", "main");
	git(site, "add", ".");
	git(site, "commit", "-q", "-m", "Acme Shop");
	git(site, "remote", "add", "origin", remote);
	git(site, "push", "-q", "-u", "origin", "main");
	const cwd = realpathSync(site);

	// The stand-in costs what DeepSeek V4 Pro does, so the pictures show what the work would cost there.
	const shown = new ModelGateway({ keys: new MemoryKeyStore(), version: "0" }).model(
		SHOWN_MODEL.provider,
		SHOWN_MODEL.model,
	);
	const db = openDatabase(dbPath(home));
	const store = new Store(db, new EventBus());
	store.saveCustomProvider({
		id: "demo",
		name: "Demo model (local)",
		baseUrl: modelUrl,
		keyRequired: false,
		models: [
			{
				id: "demo-1",
				name: "Demo model",
				contextWindow: shown?.contextWindow ?? 128_000,
				maxTokens: 32_000,
				...(shown ? { cost: shown.cost } : {}),
			},
		],
	});
	store.setSetting("defaultModel", { provider: "demo", model: "demo-1", thinking: "off" });
	store.setSetting("language", lang);
	store.setSetting("theme", "system");
	// The sidebar mascot's bubble would say the same thing in every picture; the website shows her in a
	// claim of her own.
	store.setSetting("mascot", false);
	store.setSetting("workspaces", [{ id: randomUUID(), name: "acme-shop", path: cwd }]);
	const product = store.createGroup(story.teams.product);
	const marketing = store.createGroup(story.teams.marketing);
	const session = (name: string, role: string, groupId: string | null, workspace: string | null) =>
		store.createSession({
			name,
			kind: "standing",
			groupId,
			responsibility: role,
			cwd: workspace,
			provider: "demo",
			model: "demo-1",
			thinking: "off",
			options: { permissionMode: "default" },
		});
	const { names, roles } = story;
	const content = session(names.content, roles.content, marketing.id, null);
	const website = session(names.website, roles.website, product.id, cwd);
	const backend = session(names.backend, roles.backend, product.id, cwd);
	const main = session(names.main, roles.main, null, null);
	store.setSetting("mainSessionId", main.id);

	// Earlier in the day: the coordinator asked Content about feedback and had its report; Backend told
	// Website about the orders API; CI wrote to Backend from the command line (below).
	const post = new PostOffice(store);
	const asked = post.send(
		{ kind: "session", session: main },
		{ to: content.id, kind: "request", ...story.earlier.request },
	);
	const report = post.send(
		{ kind: "session", session: content },
		{
			to: main.id,
			kind: "report",
			summary: story.earlier.report.split("\n")[0] as string,
			body: story.earlier.report,
			replyTo: asked.id,
			auto: true,
		},
	);
	const notice = post.send(
		{ kind: "session", session: backend },
		{ to: website.id, kind: "notice", ...story.earlier.notice },
	);
	db.close();

	const env = yewEnv(home);
	const ci = JSON.parse(
		yew(env, "send", "--json", "--kind", "notice", names.backend, story.earlier.ci),
	) as { id: string };

	// Read, and sent when their hours say; Content has not worked since its report.
	const again = openDatabase(dbPath(home));
	try {
		const now = Date.now();
		const stamp = again.prepare(
			"UPDATE letters SET status = 'done', created_at = ?, delivered_at = ?, updated_at = ? WHERE id = ?",
		);
		// Six, five, four and three hours ago, and a few minutes more, so each reads as whole hours.
		for (const [id, hours] of [
			[asked.id, 6],
			[report.id, 5],
			[notice.id, 4],
			[ci.id, 3],
		] as const) {
			const at = now - hours * HOUR - 10 * 60 * 1000;
			stamp.run(at, at + 60 * 1000, at + 60 * 1000, id);
		}
		again
			.prepare("UPDATE sessions SET last_activity_at = ? WHERE id = ?")
			.run(now - 5 * HOUR - 9 * 60 * 1000, content.id);
	} finally {
		again.close();
	}
	return {
		env,
		ids: { main: main.id, website: website.id, backend: backend.id, content: content.id },
	};
}

export function freePort(): Promise<number> {
	return new Promise((done, fail) => {
		const server: Server = createServer();
		server.once("error", fail);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => done(port));
		});
	});
}

/** A running `yew serve` and the person's side of its API. */
export class Yew {
	readonly base: string;
	readonly #env: NodeJS.ProcessEnv;
	readonly #process: ChildProcess;
	#cookie = "";

	constructor(env: NodeJS.ProcessEnv, port: number, logFile: string) {
		this.#env = env;
		this.base = `http://127.0.0.1:${port}`;
		const out = (piece: Buffer) => writeFileSync(logFile, piece, { flag: "a" });
		this.#process = spawn(process.execPath, [BIN, "serve", "--port", String(port)], {
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		this.#process.stdout?.on("data", out);
		this.#process.stderr?.on("data", out);
	}

	/** Waits until the service answers, then signs in as the browser does. */
	async start(): Promise<void> {
		await until("Yew to start", async () => {
			const answer = await fetch(`${this.base}/api/health`).catch(() => null);
			return answer?.ok === true;
		});
		const token = /#t=([\w-]+)/.exec(this.link())?.[1];
		const answer = await fetch(`${this.base}/api/auth/exchange`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: this.base },
			body: JSON.stringify({ token }),
		});
		if (!answer.ok) throw new Error(`sign-in failed: ${answer.status}`);
		this.#cookie = answer.headers
			.getSetCookie()
			.map((cookie) => cookie.split(";")[0])
			.join("; ");
	}

	/** A new one-time sign-in link, from `yew open --print`. */
	link(): string {
		return yew(this.#env, "open", "--print").trim();
	}

	async call<T>(method: string, path: string, body?: unknown): Promise<T> {
		const answer = await fetch(`${this.base}/api${path}`, {
			method,
			headers: {
				Cookie: this.#cookie,
				Origin: this.base,
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (!answer.ok) throw new Error(`${method} ${path}: ${answer.status} ${await answer.text()}`);
		return (answer.status === 204 ? null : await answer.json()) as T;
	}

	stop(): Promise<void> {
		return new Promise((done) => {
			if (this.#process.exitCode !== null || this.#process.signalCode !== null) return done();
			this.#process.once("exit", () => done());
			this.#process.kill("SIGTERM");
		});
	}
}

async function until(what: string, check: () => Promise<boolean>, ms = 90_000): Promise<void> {
	const end = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > end) throw new Error(`Gave up waiting for ${what}.`);
		await pause(250);
	}
}

interface Center {
	approvals: Approval[];
	cards: Card[];
}

/**
 * Tells the story and waits for its end: Website waiting to push, the card in the approval center, and
 * everyone else idle with nothing left to read. Returns the times the two requests were made.
 */
export async function tell(
	app: Yew,
	story: Story,
	ids: Ids,
): Promise<{ first: number; last: number }> {
	await app.call("POST", `/sessions/${ids.main}/messages`, { text: story.kickoff });
	let center: Center = { approvals: [], cards: [] };
	await until("the story to end", async () => {
		center = await app.call<Center>("GET", "/center");
		const sessions = (await app.call<{ items: Session[] }>("GET", "/sessions?limit=50")).items;
		const status = (id: string) => sessions.find((session) => session.id === id)?.status;
		return (
			center.cards.length === 1 &&
			center.approvals.some((approval) => approval.sessionId === ids.website) &&
			status(ids.website) === "waiting" &&
			[ids.main, ids.backend, ids.content].every((id) => status(id) === "idle")
		);
	});
	if (center.approvals.length !== 1) {
		throw new Error(`Expected one permission request, found ${center.approvals.length}.`);
	}
	const times = [center.approvals[0], center.cards[0]].map((item) => item?.createdAt ?? 0);
	return { first: Math.min(...times), last: Math.max(...times) };
}

/**
 * The sessions as the pictures show them: on DeepSeek V4 Pro, with some providers holding a key. The
 * model is set in the database: set through the API, each conversation would also get a line saying
 * the model changed. Then the stand-in is taken out of the provider list.
 */
export async function dress(app: Yew, home: string, ids: Ids): Promise<void> {
	const db = openDatabase(dbPath(home));
	try {
		const store = new Store(db, new EventBus());
		for (const id of Object.values(ids)) store.updateSession(id, SHOWN_MODEL);
		store.setSetting("defaultModel", SHOWN_MODEL);
	} finally {
		db.close();
	}
	for (const provider of WITH_KEYS) {
		await app.call("PUT", `/providers/${provider}/key`, { key: "placeholder-not-a-real-key" });
	}
	await app.call("DELETE", "/providers/demo");
}
