// Runs a Yew that was installed from the package, the way it runs on a person's computer: `yew serve`
// from the package, then the demo story of the screenshots with the stand-in model. Everything is in a
// throwaway folder, with no keychain, no built-in MCP servers and no way out to other computers.
import { join } from "node:path";
import type { Approval, Session, Transcript } from "../src/shared/types.ts";
import { startDemoModel } from "./demo-model.ts";
import { STORIES, storyScript } from "./screenshots/story.ts";
import { freePort, seed, tell, until, Yew } from "./screenshots/yew.ts";

/**
 * Tells the story to the Yew whose yew.js is `bin`, with its data in `folder`, and lets the push it
 * asks about go ahead. Returns what ran. Throws when the service does not start, the story does not
 * reach its end, a tool call ends in anything but "done", or the web interface is not served.
 */
export async function runInstalled(bin: string, folder: string): Promise<string> {
	const model = await startDemoModel(0, { script: storyScript(), typing: false });
	const address = model.address();
	const port = typeof address === "object" && address ? address.port : 0;
	const { env, ids } = seed(folder, "en", `http://127.0.0.1:${port}/v1`);
	const app = new Yew(env, await freePort(), join(folder, "serve.log"), bin);
	try {
		await app.start();
		const health = await app.call<{ version: string; sandbox: string | null }>("GET", "/health");
		await tell(app, STORIES.en, ids);
		await until("the sessions to finish after the push was allowed", async () => {
			const { approvals } = await app.call<{ approvals: Approval[] }>("GET", "/center");
			for (const approval of approvals) {
				await app.call("POST", `/approvals/${approval.id}`, { decision: "allow_once" });
			}
			const sessions = (await app.call<{ items: Session[] }>("GET", "/sessions?limit=50")).items;
			return Object.values(ids).every(
				(id) => sessions.find((session) => session.id === id)?.status === "idle",
			);
		});
		let calls = 0;
		for (const id of Object.values(ids)) {
			const path = `/sessions/${id}/transcript?limit=200`;
			const { session, toolCalls } = await app.call<Transcript>("GET", path);
			const failed = toolCalls.find((call) => call.status !== "done");
			if (failed) throw new Error(`${session.name}: ${failed.tool} ended as ${failed.status}.`);
			calls += toolCalls.length;
		}
		if (calls === 0) throw new Error("The story ran no tool call.");

		// The web interface comes with the package: the page, and the script the page names.
		const page = await fetch(app.base);
		const script = /src="(\/assets\/[^"]+\.js)"/.exec(await page.text())?.[1];
		if (!page.ok || !script) throw new Error(`The web page is not served (${page.status}).`);
		const code = await fetch(`${app.base}${script}`);
		if (!code.ok) throw new Error(`The web page's script is not served (${code.status}).`);

		return `Yew Harness ${health.version} ran the demo story from the installed package: ${calls} tool calls, commands in the ${health.sandbox ?? "absent"} sandbox, the push allowed, and the web interface served`;
	} finally {
		await app.stop();
		model.close();
	}
}
