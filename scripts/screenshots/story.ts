import { type Call, type Reply, type Script, textOf } from "../demo-model.ts";
import type { Lang } from "./shared.ts";

// --- the story, in both languages ---

interface LetterText {
	summary: string;
	body: string;
}

export interface Story {
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

export const STORIES: Record<Lang, Story> = {
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
export function projectFiles(story: Story): Record<string, string> {
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
export function storyScript(): Script {
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
