import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Lang, type Picture, type Theme, WEB_ORDER } from "./shared.ts";
import type { Story } from "./story.ts";
import type { Yew } from "./yew.ts";

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

export interface Browser {
	newContext(options: Record<string, unknown>): Promise<{
		newPage(): Promise<Page>;
		close(): Promise<void>;
	}>;
	close(): Promise<void>;
}

export async function launchBrowser(): Promise<Browser> {
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
export async function webPictures(
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
			observer: async () => {
				await tab.locator(".nav-row").first().click();
				await tab.locator(".transcript .remark").waitFor();
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
