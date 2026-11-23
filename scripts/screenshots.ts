/**
 * The screenshots of Yew Harness for the website and the README: six pictures, each in Chinese and
 * English, light and dark, saved as docs/assets/yew-<picture>-<zh|en>-<light|dark>.png.
 *
 * Every picture is Yew's real interface over local demo data. For each language the script sets up a
 * throwaway Yew in a temporary folder (YEW_HOME there, YEW_KEYCHAIN=off, YEW_MCP_BUILTIN=off): a
 * coordinator as the main conversation, with Website, Backend and Content in one Product team (one
 * team and no session outside it keep the sidebar's three lists in view at this window height), a
 * small shop project in git, a few letters from earlier in the day (one from `yew send`), and
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
 * `observer` is one more, made only when named: the main conversation with the observing Yew's remark.
 * --keep leaves the temporary folder (printed at the start) in place.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { startDemoModel } from "./demo-model.ts";
import {
	buildApp,
	phonePictures,
	type Simulator,
	simctl,
	startSimulator,
	stopSimulator,
} from "./screenshots/phone.ts";
import {
	BUNDLE_ID,
	type Lang,
	log,
	PICTURES,
	type Picture,
	pause,
	ROOT,
	type Theme,
	USUAL,
} from "./screenshots/shared.ts";
import { STORIES, storyScript } from "./screenshots/story.ts";
import { type Browser, launchBrowser, webPictures } from "./screenshots/web.ts";
import { dress, freePort, seed, tell, Yew } from "./screenshots/yew.ts";

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
	const pictures = (positionals.length > 0 ? positionals : USUAL) as Picture[];
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
			const { env, ids } = seed(place, lang, modelUrl, pictures.includes("observer"));
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
