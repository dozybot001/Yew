/**
 * The screenshots of Yew Harness for the website and the README: six pictures, each in Chinese and
 * English, light and dark, saved as docs/assets/yew-<picture>-<zh|en>-<light|dark>.png.
 *
 * Every picture is Yew's real interface over local demo data. For each language the script sets up a
 * throwaway Yew in a temporary folder (YEW_HOME there, YEW_KEYCHAIN=off, YEW_MCP_BUILTIN=off): a
 * coordinator as the main conversation, Website and Backend in a Product team, Content in a Marketing
 * team, a small shop project in git, a few letters from earlier in the day (one from `yew send`), and
 * the scripted stand-in model (scripts/demo-model.ts) in place of a real one. Then, as the person, it
 * asks the coordinator to ship the home page redesign and fix being signed out on reload. Yew and the
 * stand-in do the rest: the coordinator writes to Website and Backend, Website edits the page, runs the
 * tests and stops to ask before pushing, Backend fixes the sign-in and reports back, and the
 * coordinator puts the question Backend raised in the approval center and sums up.
 *
 * Once that is done nothing runs again. For the pictures the sessions are switched to DeepSeek V4 Pro,
 * the default model (the stand-in counted tokens at its prices), and four Chinese providers get a
 * placeholder key, so the provider list shows some with keys; the service is also kept from reaching
 * any other computer. The browser's clock is held at 25 seconds after the story ended, so "just now"
 * and how long Website has waited read the same in every picture.
 *
 * - Web pictures: a 1280×720 window at device scale 2 (2560×1440), in Google Chrome driven by
 *   playwright-core. The script uses the copy in ~/.yew/mcp-builtin/node_modules, only reading it;
 *   PLAYWRIGHT_CORE=<folder> points to another.
 * - Phone: the Debug build of the iPhone app (built here with xcodebuild, or --app) in an iPhone 17
 *   Pro simulator, portrait, connected straight to the same demo Yew with -YewDirectLink and opened on
 *   its approvals tab with -YewTab approvals (1206×2622). The simulator is one the script creates and
 *   deletes, so the person's own simulators and apps stay as they are; its status bar shows 9:41 with
 *   full signal and battery. The phone pictures are taken while the requests read "2 min. ago".
 *
 * Run it from the repository after `npm run build:web`, with Google Chrome and Xcode installed:
 *
 *   node scripts/screenshots.ts [picture…] [--lang zh|en] [--out <folder>] [--app <Yew.app>] [--keep]
 *
 * Pictures are approval, main, letters, permission, models and phone; without any it makes all six.
 * --keep leaves the temporary folder (printed at the start) in place.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { openDatabase } from "../src/server/db/database.ts";
import { EventBus } from "../src/server/events.ts";
import { MemoryKeyStore } from "../src/server/keys.ts";
import { PostOffice } from "../src/server/mail/post.ts";
import { ModelGateway } from "../src/server/model/gateway.ts";
import { dbPath } from "../src/server/paths.ts";
import { Store } from "../src/server/store.ts";
import type { Approval, Card, Session } from "../src/shared/types.ts";
import { type Call, type Reply, type Script, startDemoModel, textOf } from "./demo-model.ts";

type Lang = "zh" | "en";
type Theme = "light" | "dark";
const PICTURES = ["approval", "main", "letters", "permission", "models", "phone"] as const;
type Picture = (typeof PICTURES)[number];
const WEB_ORDER: Picture[] = ["main", "permission", "approval", "letters"];

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(ROOT, "bin/yew.js");
const BUNDLE_ID = "cn.tenonai.apps.yew";
const SHOWN_MODEL = { provider: "deepseek", model: "deepseek-v4-pro", thinking: "high" } as const;
/** Providers that get a placeholder key, so the provider list has some with keys and some without. */
const WITH_KEYS = ["deepseek", "moonshotai-cn", "qwen-token-plan-cn", "zai-coding-cn"];
const HOUR = 60 * 60 * 1000;
const log = (line: string) => process.stderr.write(`${line}\n`);
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

// --- the story, in both languages ---

interface LetterText {
	summary: string;
	body: string;
}

interface Story {
	names: { main: string; website: string; backend: string; content: string };
	teams: { product: string; marketing: string };
	roles: { main: string; website: string; backend: string; content: string };
	/** What the person asks the coordinator. */
	kickoff: string;
	toWebsite: LetterText;
	toBackend: LetterText;
	/** What the coordinator says once it has written the letters, and once Backend has reported. */
	coordinator: { handedOff: string; summary: string };
	website: { look: string; change: string; done: string; push: string; pushed: string };
	backend: { look: string; change: string; fixed: string };
	tests: string;
	/** post_card's arguments for the question Backend raised. */
	card: Record<string, unknown>;
	/** Letters from earlier in the day. */
	earlier: { request: LetterText; report: string; notice: LetterText; ci: string };
	/** The shop's home page, the part of it the redesign replaces, and what replaces it. */
	page: { index: string; hero: string; redesign: string; design: string };
}

const page = (lang: string, title: string, hero: string) =>
	`<!doctype html>\n<html lang="${lang}">\n<head>\n  <meta charset="utf-8">\n  <title>${title}</title>\n  <link rel="stylesheet" href="styles.css">\n</head>\n<body>\n${hero}  <main id="products"></main>\n</body>\n</html>\n`;

const ZH_HERO =
	'  <header class="hero">\n    <h1>Acme 咖啡</h1>\n    <p>新鲜烘焙的咖啡豆，每周发货。</p>\n  </header>\n';
const EN_HERO =
	'  <header class="hero">\n    <h1>Acme Coffee</h1>\n    <p>Freshly roasted beans, shipped every week.</p>\n  </header>\n';

const STORIES: Record<Lang, Story> = {
	zh: {
		names: { main: "统筹", website: "网站", backend: "后端", content: "内容" },
		teams: { product: "产品", marketing: "运营" },
		roles: {
			main: "我的主对话：把我交代的事分给合适的会话，跟进进度，汇总给我。",
			website: "网站的页面、样式和前端测试。改完跑测试，通过后推送。",
			backend: "后端的接口、登录和数据。改完跑测试。",
			content: "整理顾客反馈，写页面文案和发布说明。",
		},
		kickoff: "这周把首页改版上线，刷新页面被登出的问题也一起修掉。",
		toWebsite: {
			summary: "首页改版：换成新的首屏和价格区，测试通过后推送",
			body: "设计在 docs/home.md。改完跑一遍测试再推送。",
		},
		toBackend: {
			summary: "修复刷新页面后被登出的问题",
			body: "用户反馈登录半小时左右刷新页面就被登出，哪怕一直在用。",
		},
		coordinator: {
			handedOff: "首页交给了网站，登录的问题交给了后端。它们做完会回报，我再汇总给你。",
			summary:
				"两件事的进展：\n\n- **登录**：后端修好了，测试通过。登录有效期等你定，我放进了审批中心（#1），建议 7 天。\n- **首页**：网站改完了首屏和价格区，测试通过，在等你授权推送。",
		},
		website: {
			look: "先看现在的首页和设计说明。",
			change: "按设计换首屏，加上价格区。",
			done: "首屏和价格区改好了，测试通过。现在推送。",
			push: "把首页改版推到远程仓库",
			pushed: "推好了：首页改版已经在远程仓库的 main 上。",
		},
		backend: {
			look: "先看会话是怎么续期的。",
			change:
				"问题在 touch：它按创建时间算过期，用户一直在用也会到点被登出。改成按最近一次使用算。",
			fixed:
				"修好了：会话改成从最近一次使用算起，刷新页面会续期，测试都通过了。\n\n登录有效期还是 30 分钟，要不要改长需要你定，我建议 7 天。",
		},
		tests: "跑测试",
		card: {
			title: "登录有效期定多久？",
			context:
				"后端修好了刷新页面后被登出的问题。现在登录 30 分钟没有操作就过期，常用设备上也要经常重新登录。",
			options: [
				{ label: "7 天", detail: "每次使用自动续期，7 天不用才要重新登录" },
				{ label: "30 天", detail: "和多数网站一样；设备丢了，被别人用的时间更长" },
			],
			recommended: 1,
			deadline: "本周五",
			undoable: true,
			reversible: "改回配置就行",
			after: "后端改配置，内容写进发布说明",
			requested_by: "后端",
		},
		earlier: {
			request: {
				summary: "整理上周的顾客反馈，挑出和首页有关的",
				body: "首页这周改版，先看看顾客对现在的首页说了什么。",
			},
			report:
				"上周 12 条反馈里有 4 条说首页：照片太小，找不到价格\n\n- 照片太小，看不清豆子（2 条）\n- 首页上没有价格，要点进商品才看得到（2 条）\n\n另外 8 条说的是物流和包装。",
			notice: {
				summary: "订单接口加了 plan 字段，价格区可以直接用",
				body: "plan 的取值是 once、biweekly、monthly，对应单次、每两周、每月。",
			},
			ci: "CI：main 上的测试全部通过",
		},
		page: {
			index: page("zh-CN", "Acme 咖啡", ZH_HERO),
			hero: ZH_HERO,
			redesign:
				'  <header class="hero">\n    <img src="images/origin.jpg" alt="云南保山的咖啡庄园">\n    <h1>产地直采的咖啡豆，每周现烘</h1>\n    <a class="button" href="#pricing">选择订阅</a>\n  </header>\n  <section id="pricing">\n    <h2>订阅</h2>\n    <ul class="plans">\n      <li>单次</li>\n      <li>每两周</li>\n      <li>每月</li>\n    </ul>\n  </section>\n',
			design:
				"# 首页改版\n\n- 首屏换成产地照片和一句话介绍，按钮去订阅\n- 价格区放三种订阅：单次、每两周、每月\n",
		},
	},
	en: {
		names: { main: "Coordinator", website: "Website", backend: "Backend", content: "Content" },
		teams: { product: "Product", marketing: "Marketing" },
		roles: {
			main: "My main conversation: hands what I ask for to the right sessions, follows up and sums up for me.",
			website:
				"The website's pages, styles and front-end tests. Run the tests after a change and push once they pass.",
			backend: "The back end: the API, sign-in and data. Run the tests after a change.",
			content: "Sorts customer feedback and writes page copy and release notes.",
		},
		kickoff: "Let's ship the home page redesign this week, and fix the sign-out on reload too.",
		toWebsite: {
			summary: "Redesign the home page: new hero and pricing, then push once the tests pass",
			body: "The design is in docs/home.md. Run the tests before you push.",
		},
		toBackend: {
			summary: "Fix users being signed out when they reload the page",
			body: "Users say a reload signs them out after about half an hour, even while they are using the site.",
		},
		coordinator: {
			handedOff:
				"The home page is with Website and the sign-in problem with Backend. I'll sum up when they report back.",
			summary:
				"Where the two things stand:\n\n- **Sign-in**: fixed, and the tests pass. How long a sign-in lasts is up to you (#1); I suggest 7 days.\n- **Home page**: done, and the tests pass. Website is waiting for you to approve the push.",
		},
		website: {
			look: "First, the current page and the design notes.",
			change: "Replacing the hero and adding the pricing section, as designed.",
			done: "The hero and pricing section are done, and the tests pass. Pushing now.",
			push: "Push the home page redesign to the remote repository",
			pushed: "Pushed: the redesign is on main in the remote repository.",
		},
		backend: {
			look: "First, how sessions are renewed.",
			change:
				"The bug is in touch: it counts from when the session was created, so active users are signed out anyway. It should count from the last use.",
			fixed:
				"Fixed: sessions now count from the last use, and the tests pass.\n\nA reload keeps people signed in. A sign-in still lasts 30 minutes; making it longer is your call. I suggest 7 days.",
		},
		tests: "Run the tests",
		card: {
			title: "How long should a sign-in last?",
			context:
				"Backend fixed the sign-out on reload. A sign-in still expires after 30 minutes without activity, so people sign in often even on their own devices.",
			options: [
				{ label: "7 days", detail: "Renewed on every use; sign in again after 7 days away" },
				{ label: "30 days", detail: "Like most sites; a lost device stays signed in longer" },
			],
			recommended: 1,
			deadline: "Friday",
			undoable: true,
			reversible: "Change the setting back",
			after: "Backend changes the setting; Content adds it to the release notes",
			requested_by: "Backend",
		},
		earlier: {
			request: {
				summary:
					"Go through last week's customer feedback and pick out what is about the home page",
				body: "The home page is being redesigned this week. First, what did customers say about the current one?",
			},
			report:
				"4 of last week's 12 messages were about the home page: small photos, no prices\n\n- The photos are too small to see the beans (2)\n- No prices on the home page; you have to open a product to see one (2)\n\nThe other 8 were about delivery and packaging.",
			notice: {
				summary: "The orders API now returns a plan field, ready for the pricing section",
				body: "plan is once, biweekly or monthly.",
			},
			ci: "CI: all tests pass on main",
		},
		page: {
			index: page("en", "Acme Coffee", EN_HERO),
			hero: EN_HERO,
			redesign:
				'  <header class="hero">\n    <img src="images/origin.jpg" alt="A coffee farm in Baoshan, Yunnan">\n    <h1>Beans straight from the farm, roasted every week</h1>\n    <a class="button" href="#pricing">Choose a plan</a>\n  </header>\n  <section id="pricing">\n    <h2>Plans</h2>\n    <ul class="plans">\n      <li>One-off</li>\n      <li>Every two weeks</li>\n      <li>Monthly</li>\n    </ul>\n  </section>\n',
			design:
				"# Home page redesign\n\n- Hero: a photo of the farm, one line about the beans, a button to the plans\n- Pricing: three plans: one-off, every two weeks, monthly\n",
		},
	},
};

const SESSION_JS = `export const SESSION_TTL = 30 * 60 * 1000;

export function touch(session, now = Date.now()) {
  return { ...session, lastUsedAt: now, expiresAt: session.createdAt + SESSION_TTL };
}
`;
const SESSION_BUG =
	"  return { ...session, lastUsedAt: now, expiresAt: session.createdAt + SESSION_TTL };";
const SESSION_FIX =
	"  // Count from the last use, so a reload keeps an active user signed in.\n  return { ...session, lastUsedAt: now, expiresAt: now + SESSION_TTL };";

/** The shop project both code sessions work in; its four tests pass before and after the changes. */
function projectFiles(story: Story): Record<string, string> {
	return {
		"package.json": `${JSON.stringify({ name: "acme-shop", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
		"index.html": story.page.index,
		"styles.css": ".hero {\n  padding: 64px 24px;\n}\n",
		"docs/home.md": story.page.design,
		"src/session.js": SESSION_JS,
		"test/pages.test.js": [
			'import assert from "node:assert/strict";',
			'import { readFileSync } from "node:fs";',
			'import { test } from "node:test";',
			"",
			'const home = readFileSync(new URL("../index.html", import.meta.url), "utf8");',
			'test("the home page declares a doctype", () => assert.match(home, /^<!doctype html>/));',
			'test("the home page has a title", () => assert.match(home, /<title>.+<\\/title>/));',
			"",
		].join("\n"),
		"test/session.test.js": [
			'import assert from "node:assert/strict";',
			'import { test } from "node:test";',
			'import { SESSION_TTL, touch } from "../src/session.js";',
			"",
			'test("a sign-in lasts 30 minutes", () => assert.equal(SESSION_TTL, 30 * 60 * 1000));',
			'test("touch records the last use", () => assert.equal(touch({ createdAt: 0 }, 5).lastUsedAt, 5));',
			"",
		].join("\n"),
	};
}

// --- what the stand-in says in the story ---

interface Flow {
	/** Text in the message that starts the turn: the person's words or a letter. */
	trigger: string;
	/** One reply per model request in that turn, in order. */
	steps: Reply[];
}

const say = (text: string | undefined, ...calls: Call[]): Reply => ({
	...(text ? { text } : {}),
	...(calls.length > 0 ? { calls } : {}),
});

function flows(story: Story): Flow[] {
	const { names, coordinator, website, backend } = story;
	const tests: Call = { name: "shell", args: { command: "npm test", description: story.tests } };
	return [
		{
			trigger: story.kickoff,
			steps: [
				say(
					undefined,
					{
						name: "send_letter",
						args: { to: names.website, kind: "request", ...story.toWebsite },
					},
					{
						name: "send_letter",
						args: { to: names.backend, kind: "request", ...story.toBackend },
					},
				),
				say(coordinator.handedOff),
			],
		},
		{
			trigger: story.toWebsite.summary,
			steps: [
				say(
					website.look,
					{ name: "read", args: { path: "index.html" } },
					{ name: "read", args: { path: "docs/home.md" } },
				),
				say(website.change, {
					name: "edit",
					args: { path: "index.html", old_text: story.page.hero, new_text: story.page.redesign },
				}),
				say(undefined, tests),
				say(website.done, {
					name: "shell",
					args: { command: "git push origin main", description: website.push },
				}),
				say(website.pushed),
			],
		},
		{
			trigger: story.toBackend.summary,
			steps: [
				say(backend.look, { name: "read", args: { path: "src/session.js" } }),
				say(backend.change, {
					name: "edit",
					args: { path: "src/session.js", old_text: SESSION_BUG, new_text: SESSION_FIX },
				}),
				say(undefined, tests),
				// Backend answers once Website has stopped to ask, as the coordinator's summary has it.
				{ ...say(backend.fixed), delay: 2500 },
			],
		},
		{
			trigger: backend.fixed.split("\n")[0] as string,
			steps: [
				say(
					undefined,
					{ name: "list_sessions", args: {} },
					{ name: "post_card", args: story.card },
				),
				say(coordinator.summary),
			],
		},
	];
}

/**
 * The story's turns. A turn is told apart by the message that started it, and its step by how many
 * answers the model gave since; a call the person declined is left to the stand-in's own answer.
 */
function storyScript(): Script {
	const all = Object.values(STORIES).flatMap(flows);
	return (messages) => {
		const at = messages.findLastIndex((message) => message.role === "user");
		if (at < 0) return null;
		const said = textOf(messages[at]);
		const flow = all.find((candidate) => said.includes(candidate.trigger));
		const last = messages.at(-1);
		if (!flow || (last?.role === "tool" && /declined|Not run/i.test(textOf(last)))) return null;
		const step = messages.slice(at + 1).filter((message) => message.role === "assistant").length;
		return flow.steps[step] ?? null;
	};
}

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
function seed(folder: string, lang: Lang, modelUrl: string): { env: NodeJS.ProcessEnv; ids: Ids } {
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
	// claim of her own (founder, 2026-11-18: 「配图里每一张图左下角都有提醒，这个是否要去除一下？」).
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

function freePort(): Promise<number> {
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
class Yew {
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
async function tell(app: Yew, story: Story, ids: Ids): Promise<{ first: number; last: number }> {
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
async function dress(app: Yew, home: string, ids: Ids): Promise<void> {
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

// --- the browser ---

/** The little of playwright-core's API the script uses. */
interface Locator {
	click(): Promise<void>;
	waitFor(): Promise<void>;
	first(): Locator;
	nth(index: number): Locator;
}

interface Page {
	clock: { setFixedTime(time: number): Promise<void> };
	mouse: { move(x: number, y: number): Promise<void> };
	goto(url: string): Promise<unknown>;
	emulateMedia(options: { colorScheme: Theme }): Promise<void>;
	locator(selector: string, options?: { hasText?: string }): Locator;
	evaluate(script: string): Promise<unknown>;
	screenshot(options: { path: string; animations: "disabled"; caret: "hide" }): Promise<unknown>;
	waitForTimeout(ms: number): Promise<void>;
}

interface Browser {
	newContext(options: Record<string, unknown>): Promise<{
		newPage(): Promise<Page>;
		close(): Promise<void>;
	}>;
	close(): Promise<void>;
}

async function launchBrowser(): Promise<Browser> {
	const folder =
		process.env.PLAYWRIGHT_CORE ?? join(homedir(), ".yew/mcp-builtin/node_modules/playwright-core");
	const module = (await import(pathToFileURL(join(folder, "index.mjs")).href)) as {
		chromium: { launch(options: Record<string, unknown>): Promise<Browser> };
	};
	try {
		return await module.chromium.launch({ channel: "chrome", headless: true });
	} catch {
		// No Google Chrome: Playwright's own Chromium, if it is installed.
		return await module.chromium.launch({ headless: true });
	}
}

/** Takes the web pictures of one language, in both themes. */
async function webPictures(
	browser: Browser,
	app: Yew,
	story: Story,
	lang: Lang,
	pictures: Picture[],
	frozenAt: number,
	out: (picture: Picture, theme: Theme) => string,
): Promise<void> {
	const context = await browser.newContext({
		viewport: { width: 1280, height: 720 },
		deviceScaleFactor: 2,
		locale: lang === "zh" ? "zh-CN" : "en-US",
		colorScheme: "light",
	});
	try {
		const tab = await context.newPage();
		await tab.clock.setFixedTime(frozenAt);
		await tab.goto(app.link());
		await tab.locator(".sidebar").waitFor();
		// A conversation shows whole, from its first message to its last; longer words would push the
		// start out of the picture.
		const whole = async (name: string) => {
			const over = await tab.evaluate(
				`(() => { const t = document.querySelector(".transcript"); return t ? t.scrollHeight - t.clientHeight : 0; })()`,
			);
			if (Number(over) > 1) {
				throw new Error(`${name} is ${over}px taller than the window: shorten what is said there.`);
			}
		};
		const session = async (name: string) => {
			await tab.locator(".session-row", { hasText: name }).first().click();
			await tab.locator(".transcript .msg-assistant").first().waitFor();
			// A reply must show once: a draft kept from the turn would repeat it under the same text.
			// The event stream sends such a draft right after it connects.
			await tab.waitForTimeout(600);
			const repeated = await tab.evaluate(`
				(() => {
					const texts = [...document.querySelectorAll(".transcript .msg-assistant:not(.msg-tool)")]
						.map((item) => item.textContent.trim());
					return texts.find((text, index) => text && texts.indexOf(text) !== index) ?? null;
				})()
			`);
			if (repeated) throw new Error(`${name} shows a reply twice: ${repeated}`);
			await whole(name);
		};
		const views: Partial<Record<Picture, () => Promise<void>>> = {
			main: async () => {
				await tab.locator(".nav-row").first().click();
				await tab.locator(".msg-assistant li").first().waitFor();
				await whole(story.names.main);
			},
			permission: async () => {
				await session(story.names.website);
				await tab.locator(".transcript .request-card").waitFor();
			},
			approval: async () => {
				await tab.locator(".nav-row").nth(1).click();
				await tab.locator("[role=tab]").first().click();
				await tab.locator(".decision-card").waitFor();
			},
			letters: async () => {
				await tab.locator(".nav-row").nth(1).click();
				await tab.locator("[role=tab]").nth(2).click();
				await tab.locator(".letter-lines .letter-item").nth(6).waitFor();
			},
		};
		const shoot = async (path: string) => {
			// The pointer rests where nothing reacts to it, and the row clicked last lets go of the focus
			// (a focused row shows its menu button). The sidebar's list is scrolled to its end, so it shows
			// every session with its state; at 720 pixels the teams above them scroll away.
			await tab.mouse.move(1279, 300);
			await tab.evaluate(`
				if (!document.querySelector(":popover-open")) document.activeElement?.blur();
				document.querySelectorAll(".sidebar-list").forEach((list) => {
					list.scrollTop = list.scrollHeight;
				});
			`);
			await tab.waitForTimeout(400);
			await tab.screenshot({ path, animations: "disabled", caret: "hide" });
		};
		for (const theme of ["light", "dark"] as const) {
			await tab.emulateMedia({ colorScheme: theme });
			for (const picture of WEB_ORDER) {
				const open = views[picture];
				if (!open || !pictures.includes(picture)) continue;
				await open();
				await shoot(out(picture, theme));
			}
		}
		if (pictures.includes("models")) {
			await session(story.names.backend);
			// The provider list of Backend's message box, open over the conversation in both themes.
			await tab.locator(".composer .model-picker [role=combobox]").first().click();
			await tab.locator(".listbox:popover-open [role=option]").first().waitFor();
			for (const theme of ["light", "dark"] as const) {
				await tab.emulateMedia({ colorScheme: theme });
				await shoot(out("models", theme));
			}
		}
	} finally {
		await context.close();
	}
}

// --- the phone ---

interface Simulator {
	udid: string;
}

const SIMULATOR = "Yew screenshots";
const IPHONE_17_PRO = "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro";

const simctl = (...args: string[]) =>
	execFileSync("xcrun", ["simctl", ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

/**
 * A simulator of the script's own, so none of the person's simulators or the apps on them change: an
 * iPhone 17 Pro on the iOS version of theirs (or the newest), in US English so the status bar reads
 * 9:41 (in a 24-hour region it reads 09:41), showing full signal and a full battery. It is deleted at
 * the end.
 */
function startSimulator(): Simulator {
	const list = JSON.parse(simctl("list", "--json")) as {
		devices: Record<string, { udid: string; name: string; isAvailable?: boolean }[]>;
		runtimes: {
			identifier: string;
			platform?: string;
			isAvailable: boolean;
			supportedDeviceTypes?: { identifier: string }[];
		}[];
	};
	// One left over from a run that was cut short.
	for (const device of Object.values(list.devices).flat()) {
		if (device.name === SIMULATOR) simctl("delete", device.udid);
	}
	const theirs = Object.entries(list.devices).find(([, devices]) =>
		devices.some((device) => device.name === "iPhone 17 Pro" && device.isAvailable !== false),
	)?.[0];
	const newest = list.runtimes
		.filter(
			(runtime) =>
				runtime.isAvailable &&
				runtime.platform === "iOS" &&
				runtime.supportedDeviceTypes?.some((type) => type.identifier === IPHONE_17_PRO),
		)
		.at(-1)?.identifier;
	const runtime = theirs ?? newest;
	if (!runtime)
		throw new Error("No iOS simulator runtime runs an iPhone 17 Pro. Add one in Xcode.");
	const udid = simctl("create", SIMULATOR, IPHONE_17_PRO, runtime).trim();
	const boot = () => {
		simctl("boot", udid);
		simctl("bootstatus", udid, "-b");
	};
	boot();
	simctl("spawn", udid, "defaults", "write", "-g", "AppleLocale", "-string", "en_US");
	simctl("spawn", udid, "defaults", "write", "-g", "AppleLanguages", "-array", "en");
	simctl("shutdown", udid);
	boot();
	const time = new Date();
	time.setHours(9, 41, 0, 0);
	simctl(
		"status_bar",
		udid,
		"override",
		"--time",
		time.toISOString(),
		"--dataNetwork",
		"wifi",
		"--wifiMode",
		"active",
		"--wifiBars",
		"3",
		"--cellularMode",
		"active",
		"--cellularBars",
		"4",
		"--batteryState",
		"discharging",
		"--batteryLevel",
		"100",
	);
	return { udid };
}

function stopSimulator(simulator: Simulator): void {
	try {
		simctl("shutdown", simulator.udid);
	} catch {
		// It had stopped already.
	}
	simctl("delete", simulator.udid);
}

/** The Debug build of the iPhone app for the simulator. Xcode's output is shown only if it fails. */
function buildApp(folder: string): string {
	log("Building the iPhone app (Debug, simulator)…");
	const derived = join(folder, "DerivedData");
	try {
		execFileSync(
			"xcodebuild",
			[
				"-project",
				join(ROOT, "ios/Yew.xcodeproj"),
				"-scheme",
				"Yew",
				"-configuration",
				"Debug",
				"-destination",
				"generic/platform=iOS Simulator",
				"-derivedDataPath",
				derived,
				"build",
			],
			{ stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 },
		);
	} catch (error) {
		const { stdout = "", stderr = "" } = error as {
			stdout?: Buffer | string;
			stderr?: Buffer | string;
		};
		log(`${stdout}${stderr}`.split("\n").slice(-40).join("\n"));
		throw new Error("The iPhone app did not build.");
	}
	return join(derived, "Build/Products/Debug-iphonesimulator/Yew.app");
}

/**
 * Takes the phone pictures of one language. The app shows how long ago each request came, rounded to
 * whole minutes after the first one: "2 min. ago" from 90 seconds to 150. Both pictures are taken while
 * both requests read the same, two minutes or the first number of minutes that leaves time for both.
 */
async function phonePictures(
	simulator: Simulator,
	app: Yew,
	lang: Lang,
	asked: { first: number; last: number },
	out: (theme: Theme) => string,
): Promise<void> {
	const needed = 30_000;
	for (let minutes = 2; ; minutes++) {
		const start = Math.max(Date.now(), asked.last + (minutes - 0.5) * 60_000 + 1000);
		if (start + needed - asked.first < (minutes + 0.5) * 60_000) {
			await pause(start - Date.now());
			break;
		}
	}
	for (const theme of ["light", "dark"] as const) {
		simctl("ui", simulator.udid, "appearance", theme);
		try {
			simctl("terminate", simulator.udid, BUNDLE_ID);
		} catch {
			// It was not running.
		}
		simctl(
			"launch",
			simulator.udid,
			BUNDLE_ID,
			"-YewReset",
			"YES",
			"-YewDirectLink",
			app.link(),
			"-YewTab",
			"approvals",
			"-AppleLanguages",
			lang === "zh" ? "(zh-Hans)" : "(en)",
			"-AppleLocale",
			lang === "zh" ? "zh_CN" : "en_US",
		);
		await pause(6000);
		simctl("io", simulator.udid, "screenshot", "--type", "png", out(theme));
	}
	simctl("terminate", simulator.udid, BUNDLE_ID);
}

// --- the whole run ---

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		options: {
			lang: { type: "string", multiple: true },
			out: { type: "string" },
			app: { type: "string" },
			keep: { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
		allowPositionals: true,
	});
	if (values.help) {
		process.stdout.write(
			"Usage: node scripts/screenshots.ts [picture…] [--lang zh|en] [--out <folder>] [--app <Yew.app>] [--keep]\n",
		);
		return;
	}
	const pictures = (positionals.length > 0 ? positionals : [...PICTURES]) as Picture[];
	const unknown = pictures.filter((picture) => !PICTURES.includes(picture));
	if (unknown.length > 0) throw new Error(`Unknown picture: ${unknown.join(", ")}`);
	const langs = (values.lang ?? ["zh", "en"]) as Lang[];
	if (langs.some((lang) => lang !== "zh" && lang !== "en")) throw new Error("--lang is zh or en.");
	const out = resolve(values.out ?? join(ROOT, "docs/assets"));
	if (!existsSync(join(ROOT, "web/dist/index.html"))) {
		throw new Error("web/dist is missing: run npm run build:web first.");
	}
	mkdirSync(out, { recursive: true });
	const folder = realpathSync(mkdtempSync(join(tmpdir(), "yew-screenshots-")));
	log(`Working in ${folder}`);
	const file = (picture: Picture, lang: Lang, theme: Theme) =>
		join(out, `yew-${picture}-${lang}-${theme}.png`);
	const written: string[] = [];
	const web = pictures.filter((picture) => picture !== "phone");
	const phone = pictures.includes("phone");

	// Each answer comes in one piece: nobody watches it being written, and while a turn goes on Yew
	// keeps its last streamed draft, which a session opened while it waits for approval shows again
	// under the same reply.
	const model = await startDemoModel(0, { script: storyScript(), typing: false });
	const address = model.address();
	const modelUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/v1`;
	let browser: Browser | null = null;
	let simulator: Simulator | null = null;
	const running: Yew[] = [];
	try {
		if (web.length > 0) browser = await launchBrowser();
		if (phone) {
			const app = values.app ? resolve(values.app) : buildApp(folder);
			log("Starting a simulator of its own…");
			simulator = startSimulator();
			simctl("install", simulator.udid, app);
			// A first start, so the timed ones later start as fast as usual.
			simctl("launch", simulator.udid, BUNDLE_ID);
			await pause(5000);
			simctl("terminate", simulator.udid, BUNDLE_ID);
		}
		for (const lang of langs) {
			const story = STORIES[lang];
			const place = join(folder, lang);
			log(`${lang}: setting up a throwaway Yew…`);
			const { env, ids } = seed(place, lang, modelUrl);
			const app = new Yew(env, await freePort(), join(place, "serve.log"));
			running.push(app);
			await app.start();
			log(`${lang}: telling the story…`);
			const asked = await tell(app, story, ids);
			await dress(app, join(place, "home"), ids);
			const frozenAt = Date.now() + 25_000;
			if (browser && web.length > 0) {
				log(`${lang}: web pictures…`);
				await webPictures(browser, app, story, lang, web, frozenAt, (picture, theme) => {
					written.push(file(picture, lang, theme));
					return file(picture, lang, theme);
				});
			}
			if (simulator) {
				log(`${lang}: phone pictures…`);
				await phonePictures(simulator, app, lang, asked, (theme) => {
					written.push(file("phone", lang, theme));
					return file("phone", lang, theme);
				});
			}
			await app.stop();
		}
	} finally {
		for (const app of running) await app.stop();
		await browser?.close();
		if (simulator) stopSimulator(simulator);
		model.close();
		if (values.keep) log(`Kept ${folder}`);
		else rmSync(folder, { recursive: true, force: true });
	}
	// Every picture at the size the website takes: the width and height of a PNG are in its header.
	for (const path of written) {
		const header = readFileSync(path).subarray(16, 24);
		const size = `${header.readUInt32BE(0)}×${header.readUInt32BE(4)}`;
		const wanted = basename(path).startsWith("yew-phone-") ? "1206×2622" : "2560×1440";
		if (size !== wanted) throw new Error(`${path} is ${size}, not ${wanted}.`);
	}
	process.stdout.write(`${written.join("\n")}\n`);
}

await main();
