import { Hono } from "hono";
import { conflict, invalid } from "../errors.ts";
import type { McpHub, McpStatus } from "../mcp.ts";
import {
	addMcpEntry,
	listMcpEntries,
	type McpEntryView,
	type NewMcpServer,
	patchMcpEntry,
	removeMcpEntry,
} from "../mcp-config.ts";
import type { Store } from "../store.ts";
import { idempotent } from "./idempotency.ts";
import {
	type Fields,
	optArray,
	optBoolean,
	optObject,
	optString,
	readJson,
	reqString,
} from "./input.ts";
import type { AppEnv } from "./problem.ts";

export interface McpRoutesOptions {
	/** Yew's data folder, where mcp.json is. */
	home: string;
	hub: McpHub;
	log?: (line: string) => void;
}

/** A server in the settings: what mcp.json says about it and how its connection stands. */
export interface McpServerView extends McpEntryView {
	state: McpStatus["state"];
	error: string | null;
	tools: string[];
	/** Yew holds a sign-in for it. */
	signedIn: boolean;
	/** The site the browser goes to to sign in, once Yew has found it. */
	signInAt?: string;
}

/** Names with text values (null allowed where a value can be removed); anything else is refused. */
function values<T extends string | null>(
	fields: Fields,
	key: "env" | "headers",
	nullable: boolean,
): Record<string, T> | undefined {
	const object = optObject(fields, key);
	if (!object) return undefined;
	for (const [name, value] of Object.entries(object)) {
		if (typeof value !== "string" && !(nullable && value === null)) {
			throw invalid(`The value of ${name} must be text.`, key);
		}
	}
	return object as Record<string, T>;
}

/**
 * The MCP servers in mcp.json: list them with their connection and tools,
 * add one, turn one off or on, remove one. Each change is written to the file and the running hub
 * reads it again at once. Computer-only: a server is a program this computer starts.
 */
export function mcpRoutes(store: Store, options: McpRoutesOptions): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	const once = idempotent(store.db);
	const { home, hub } = options;

	const shown = (entry: McpEntryView): McpServerView => {
		const status = hub.status().find((server) => server.name === entry.name);
		return {
			...entry,
			// In the file but not read by the hub yet: it is about to be started.
			state: entry.disabled ? "disabled" : (status?.state ?? "connecting"),
			error: entry.disabled ? null : (status?.error ?? null),
			tools: entry.disabled ? [] : (status?.tools ?? []),
			signedIn: status?.signedIn ?? false,
			...(status?.signInAt && !entry.disabled ? { signInAt: status.signInAt } : {}),
		};
	};
	const reload = () => {
		void hub.reload().catch((error: Error) => options.log?.(`mcp: ${error.message}`));
	};

	app.get("/mcp", (c) =>
		c.json({ items: listMcpEntries(home, hub.builtin).map(shown), nextCursor: null }),
	);

	app.post("/mcp", once, async (c) => {
		const fields = await readJson(c);
		const args = optArray(fields, "args");
		if (args?.some((arg) => typeof arg !== "string")) {
			throw invalid("args is a list of text values.", "args");
		}
		const command = optString(fields, "command", 4096);
		const preset = optString(fields, "preset", 100);
		const url = optString(fields, "url", 2000);
		const env = values<string>(fields, "env", false);
		const headers = values<string>(fields, "headers", false);
		const oauth = optObject(fields, "oauth") as NewMcpServer["oauth"] | undefined;
		const entry = addMcpEntry(home, {
			name: reqString(fields, "name", 100),
			...(preset !== undefined ? { preset } : {}),
			...(command !== undefined ? { command } : {}),
			...(args ? { args: args as string[] } : {}),
			...(env ? { env } : {}),
			...(url !== undefined ? { url } : {}),
			...(headers ? { headers } : {}),
			...(oauth ? { oauth } : {}),
		});
		reload();
		return c.json(shown(entry), 201);
	});

	app.patch("/mcp/:name", async (c) => {
		const fields = await readJson(c);
		const disabled = optBoolean(fields, "disabled");
		const env = values<string | null>(fields, "env", true);
		const headers = values<string | null>(fields, "headers", true);
		const entry = patchMcpEntry(
			home,
			c.req.param("name"),
			{
				...(disabled !== undefined ? { disabled } : {}),
				...(env ? { env } : {}),
				...(headers ? { headers } : {}),
			},
			hub.builtin,
		);
		reload();
		return c.json(shown(entry));
	});

	// Signing in to a server in the browser: the page opens the address.
	app.post("/mcp/:name/sign-in", async (c) => {
		try {
			return c.json({ url: await hub.signInUrl(c.req.param("name")) });
		} catch (error) {
			throw conflict((error as Error).message, undefined, "mcp-sign-in");
		}
	});

	// The same from a link on Yew's page, which opens the sign-in in a new tab: no pop-up to block.
	app.get("/mcp/:name/sign-in", async (c) => {
		try {
			return c.redirect(await hub.signInUrl(c.req.param("name")), 302);
		} catch (error) {
			const text = (error as Error).message.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
			return c.html(
				`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>没有登录 · Not signed in</title><body><h1>没有登录 · Not signed in</h1><p>${text}</p></body></html>`,
				409,
			);
		}
	});

	app.post("/mcp/:name/sign-out", async (c) => {
		await hub.signOut(c.req.param("name"));
		return c.body(null, 204);
	});

	app.delete("/mcp/:name", (c) => {
		removeMcpEntry(home, c.req.param("name"), hub.builtin);
		reload();
		return c.body(null, 204);
	});

	return app;
}

/**
 * Where the browser comes back after signing in to an MCP server. It is a plain page outside /api: the
 * provider's redirect is a navigation from another site, which carries neither Yew's cookie nor its
 * origin, so the one-time `state` Yew made when the sign-in started is what proves it.
 */
export function oauthCallbackRoute(hub: McpHub, log?: (line: string) => void): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	const page = (title: string, text: string) =>
		`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body><h1>${title}</h1><p>${text}</p></body></html>`;
	const html = (text: string) => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
	app.get("/oauth/callback", async (c) => {
		const state = c.req.query("state") ?? "";
		// The address held a one-time code: nothing keeps a copy of the page.
		c.header("Cache-Control", "no-store");
		try {
			const name = await hub.completeSignIn(
				state,
				c.req.query("code") ?? null,
				c.req.query("error") ?? null,
				c.req.query("iss") ?? null,
			);
			return c.html(
				page(
					"已登录 · Signed in",
					`已登录 ${html(name)}，可以关掉这个页面回到 Yew Harness。<br>Signed in to ${html(name)}. You can close this page and go back to Yew Harness.`,
				),
			);
		} catch (error) {
			log?.(`mcp: sign-in did not finish: ${(error as Error).message}`);
			return c.html(
				page(
					"没有登录 · Not signed in",
					`${html((error as Error).message)}<br>回到 Yew Harness 的「MCP 服务」再试一次。Go back to MCP servers in Yew Harness and try again.`,
				),
				400,
			);
		}
	});
	return app;
}
