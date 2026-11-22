import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decisionFromPhone } from "../src/server/http/agents.ts";
import { McpHub, namesHarness } from "../src/server/mcp.ts";
import { outward, ownBrowser, special as specialFor } from "../src/server/mcp-special.ts";
import { inheritableRules, PermissionEngine } from "../src/server/permissions/engine.ts";
import type { ToolDefinition } from "../src/server/tools/types.ts";
import type { JsonObject } from "../src/shared/messages.ts";
import type { Session } from "../src/shared/types.ts";
import { ctx, home, server, textOf } from "./helpers/mcp.ts";
import { tempDir } from "./helpers/store.ts";

describe("the browser and computer control", () => {
	const engine = new PermissionEngine(tempDir("yew-home-"));
	const session = (rules: Session["rules"], mode: "skip" | "default" = "default") =>
		({ id: "s1", cwd: null, rules, options: { permissionMode: mode } }) as unknown as Session;
	async function tools(name: string) {
		const hub = new McpHub({
			yewHome: home({ [name]: { command: "node", args: [server] } }),
			version: "0.0.0",
			log: () => {},
		});
		await hub.refresh();
		const echo = hub.tools().find((tool) => tool.name === `mcp__${name}__echo`);
		assert.ok(echo);
		return { hub, echo };
	}
	const lookup = {} as Parameters<ToolDefinition["subject"]>[2];

	test("an action of computer control is asked about every time and cannot be remembered", async () => {
		const { hub, echo } = await tools("computer");
		try {
			const allowed = session([{ effect: "allow", tool: "mcp__computer__echo" }]);
			for (const action of ["left_click", "type", "key", "scroll", "mouse_move", "something_new"]) {
				const decision = engine.decide(echo.subject({ action }, allowed, lookup), allowed);
				assert.equal(decision.effect, "ask", action);
				if (decision.effect !== "ask") continue;
				assert.equal(decision.request.mustConfirm, true, action);
				assert.deepEqual(decision.request.reasons, ["computer-control"]);
				assert.equal(decision.request.rememberRules, undefined);
			}
			// Skip mode lets it run and marks it.
			const skipping = session([], "skip");
			assert.deepEqual(
				engine.decide(echo.subject({ action: "left_click" }, skipping, lookup), skipping),
				{ effect: "allow", note: { risk: ["computer-control"] } },
			);
			// Looking can be remembered, and a remembered rule then covers looking only.
			const fresh = session([]);
			const look = engine.decide(echo.subject({ action: "get_screenshot" }, fresh, lookup), fresh);
			assert.ok(look.effect === "ask" && look.request.rememberRules?.length === 1);
			assert.equal(
				engine.decide(echo.subject({ action: "get_screenshot" }, allowed, lookup), allowed).effect,
				"allow",
			);
		} finally {
			hub.stop();
		}
	});

	test("an action in the browser can be remembered, with a warning about what that covers", async () => {
		const { hub, echo } = await tools("browser");
		try {
			const fresh = session([]);
			const decision = engine.decide(echo.subject({}, fresh, lookup), fresh);
			assert.ok(decision.effect === "ask");
			assert.equal(decision.request.warning, "acts-as-you");
			assert.equal(decision.request.rememberRules?.length, 1);
		} finally {
			hub.stop();
		}
		const other = await tools("files");
		try {
			const fresh = session([]);
			const decision = engine.decide(other.echo.subject({}, fresh, lookup), fresh);
			assert.ok(decision.effect === "ask" && decision.request.warning === undefined);
		} finally {
			other.hub.stop();
		}
	});

	test("opening an address counts as acting; going back does not", async () => {
		const { hub } = await tools("browser");
		try {
			const fresh = session([]);
			const warningOf = (tool: string) => {
				const subject = { kind: "act", tool: `mcp__browser__${tool}`, summary: "", always: true };
				// The hub decides by the tool's name; ask it through the definition it would build.
				const definition = hub.tools()[0];
				assert.ok(definition);
				return engine.decide({ ...subject, ...specialFor("browser", tool) } as never, fresh);
			};
			const go = warningOf("browser_navigate");
			assert.ok(go.effect === "ask" && go.request.warning === "acts-as-you");
			const back = warningOf("browser_navigate_back");
			assert.ok(back.effect === "ask" && back.request.warning === undefined);
		} finally {
			hub.stop();
		}
	});

	test("a tool that sends, publishes or deletes in its service is asked about every time", async () => {
		for (const name of [
			"send_message",
			"sendEmail",
			"gmail_send_message",
			"deploy_to_vercel",
			"trash_thread",
			"delete_issue",
			"invite_user",
			"share_file",
			"merge_pull_request",
			"push_files",
			"create_permission",
		]) {
			assert.equal(outward(name), true, name);
		}
		for (const name of [
			"create_draft",
			"search_threads",
			"get_merge_request",
			"list_deleted_files",
			"update_issue",
			"get_file_permissions",
		]) {
			assert.equal(outward(name), false, name);
		}
		const { hub, echo } = await tools("mail");
		try {
			// In the mode that asks nothing, with a rule for each tool.
			const allowed = session([
				{ effect: "allow", tool: "mcp__mail__wipe" },
				{ effect: "allow", tool: "mcp__mail__echo" },
				{ effect: "allow", tool: "mcp__mail__send_message" },
			]);
			const wipe = hub.tools().find((tool) => tool.name === "mcp__mail__wipe");
			assert.ok(wipe);
			const marked = engine.decide(wipe.subject({}, allowed, lookup), allowed);
			assert.ok(marked.effect === "ask", "its server marks it destructive");
			assert.equal(marked.request.mustConfirm, true);
			assert.deepEqual(marked.request.reasons, ["service-action"]);
			assert.equal(marked.request.rememberRules, undefined);
			const named = engine.decide(
				{
					kind: "act",
					tool: "mcp__mail__send_message",
					summary: "",
					always: true,
					...specialFor("mail", "send_message"),
				} as never,
				allowed,
			);
			assert.ok(named.effect === "ask" && named.request.mustConfirm, "its name says it sends");
			// Google's calendar server: these invite the event's attendees, which their names do not say.
			assert.deepEqual(specialFor("google-calendar", "create_event"), {
				reasons: ["service-action"],
			});
			assert.deepEqual(specialFor("google-calendar", "list_events"), {});
			assert.deepEqual(specialFor("gmail", "create_draft"), {});
			// Renamed in mcp.json, it is still known by its address.
			const renamed = { url: "https://calendarmcp.googleapis.com/mcp/v1" };
			assert.deepEqual(specialFor("my-calendar", "create_event", {}, false, renamed), {
				reasons: ["service-action"],
			});
			const plain = engine.decide(echo.subject({ text: "hi" }, allowed, lookup), allowed);
			assert.equal(plain.effect, "allow");
		} finally {
			hub.stop();
		}
	});

	test("always-allow from a phone, for a request that carries the warning, allows once", () => {
		assert.equal(decisionFromPhone("allow_always", { warning: "acts-as-you" }), "allow_once");
		assert.equal(decisionFromPhone("allow_always", { tool: "shell" }), "allow_always");
		assert.equal(decisionFromPhone("deny", { warning: "acts-as-you" }), "deny");
		assert.equal(decisionFromPhone("allow_once", { warning: "acts-as-you" }), "allow_once");
	});

	test("always-allow for these tools is not taken over by a new session", () => {
		const rules: Session["rules"] = [
			{ effect: "allow", tool: "mcp__browser__browser_click" },
			{ effect: "allow", tool: "mcp__computer__computer" },
			{ effect: "deny", tool: "mcp__browser__browser_evaluate" },
			{ effect: "allow", tool: "mcp__files__read" },
			{ effect: "allow", tool: "shell", pattern: "npm test" },
		];
		assert.deepEqual(inheritableRules(rules), rules.slice(2));
	});
});

describe("the browser in the person's own Chrome", () => {
	const engine = new PermissionEngine(tempDir("yew-home-"));
	const session = (rules: Session["rules"], mode = "default") =>
		({ id: "s1", cwd: null, rules, options: { permissionMode: mode } }) as unknown as Session;
	const lookup = {} as Parameters<ToolDefinition["subject"]>[2];
	const PORT = 4777;
	const SAFE_TABS = "- 0: (current) [Mail](https://mail.example.com/)";
	/** A server named browser with Playwright's tool names; `own` starts it with --extension. */
	async function browser(
		own: boolean,
		env: Record<string, string> = {},
		port: number | null = PORT,
	) {
		const hub = new McpHub({
			yewHome: home({
				browser: {
					command: "node",
					args: own ? [server, "--extension"] : [server],
					env: {
						EXTRA_TOOLS: [
							"browser_run_code_unsafe",
							"browser_cookie_list",
							"browser_cookie_set",
							"browser_localstorage_get",
							"browser_sessionstorage_set",
							"browser_storage_state",
							"browser_set_storage_state",
							"browser_tabs",
							"browser_click",
							"browser_evaluate",
							"browser_snapshot",
							"browser_navigate",
							"browser_navigate_back",
							"browser_close",
							"browser_resize",
							"browser_emulate_media",
							"browser_hover",
							"browser_find",
						].join(","),
						TABS: SAFE_TABS,
						...env,
					},
				},
			}),
			version: "0.0.0",
			log: () => {},
			...(port ? { port } : {}),
		});
		await hub.refresh();
		const tool = (name: string) => {
			const found = hub.tools().find((t) => t.name === `mcp__browser__${name}`);
			assert.ok(found, name);
			return found;
		};
		return { hub, tool };
	}

	test("browser_run_code_unsafe and cookie or storage tools are not offered in either mode", async () => {
		for (const own of [true, false]) {
			const { hub } = await browser(own);
			try {
				const names = hub.tools().map((t) => t.name);
				assert.ok(names.includes("mcp__browser__browser_click"));
				// Not offered, so a session that calls one anyway is told there is no such tool.
				const refused = names.filter((name) => /run_code_unsafe|cookie|storage/i.test(name));
				assert.deepEqual(refused, [], `own: ${own}`);
				const listed = hub.status()[0]?.tools ?? [];
				assert.deepEqual(
					listed.filter((name) => /run_code_unsafe|cookie|storage/i.test(name)),
					[],
				);
			} finally {
				hub.stop();
			}
		}
	});

	test("its own Chrome is told by --extension or PLAYWRIGHT_MCP_EXTENSION", () => {
		assert.equal(ownBrowser({ args: ["cli.js", "--extension"] }), true);
		assert.equal(ownBrowser({ args: ["cli.js", "--extension=chrome"] }), true);
		assert.equal(ownBrowser({ env: { PLAYWRIGHT_MCP_EXTENSION: "1" } }), true);
		assert.equal(ownBrowser({}, { PLAYWRIGHT_MCP_EXTENSION: "true" }), true);
		assert.equal(ownBrowser({}, { PLAYWRIGHT_MCP_EXTENSION: "false" }), false);
		// A server Yew runs from its data folder does not get Yew's environment.
		assert.equal(ownBrowser({ ownEnv: true }, { PLAYWRIGHT_MCP_EXTENSION: "1" }), false);
		assert.equal(ownBrowser({ args: ["cli.js", "--user-data-dir", "/x"] }), false);
	});

	test("an action on a page is asked about every time; a remembered allow does not cover it", async () => {
		const { hub, tool } = await browser(true);
		try {
			const allowed = session(
				[
					"browser_click",
					"browser_evaluate",
					"browser_tabs",
					"browser_snapshot",
					"browser_navigate_back",
					"browser_close",
					"browser_resize",
					"browser_emulate_media",
					"browser_hover",
					"browser_find",
				].map((name) => ({ effect: "allow" as const, tool: `mcp__browser__${name}` })),
			);
			const asked = (name: string, args: JsonObject = {}) => {
				const decision = engine.decide(tool(name).subject(args, allowed, lookup), allowed);
				assert.ok(decision.effect === "ask", name);
				assert.equal(decision.request.mustConfirm, true, name);
				assert.equal(decision.request.rememberRules, undefined, name);
				return decision.request.reasons;
			};
			assert.deepEqual(asked("browser_click"), ["browser-action"]);
			assert.deepEqual(asked("browser_navigate", { url: "https://example.com/" }), [
				"browser-action",
			]);
			assert.deepEqual(asked("browser_evaluate", { function: "() => 1" }), ["browser-script"]);
			// Opening a new tab at an address is opening an address.
			assert.deepEqual(asked("browser_tabs", { action: "new", url: "https://example.com/" }), [
				"browser-action",
			]);
			// So is changing the tabs and windows the person works in.
			for (const name of [
				"browser_navigate_back",
				"browser_close",
				"browser_resize",
				"browser_emulate_media",
			]) {
				assert.deepEqual(asked(name), ["browser-action"], name);
			}
			for (const action of ["select", "close", "new"]) {
				assert.deepEqual(asked("browser_tabs", { action, index: 1 }), ["browser-action"], action);
			}
			// Looking can be remembered, and the remembered rule covers it.
			assert.equal(
				engine.decide(tool("browser_snapshot").subject({}, allowed, lookup), allowed).effect,
				"allow",
			);
			assert.equal(
				engine.decide(tool("browser_tabs").subject({ action: "list" }, allowed, lookup), allowed)
					.effect,
				"allow",
			);
			for (const name of ["browser_hover", "browser_find"]) {
				assert.equal(
					engine.decide(tool(name).subject({}, allowed, lookup), allowed).effect,
					"allow",
					name,
				);
			}
			const fresh = session([]);
			const look = engine.decide(tool("browser_snapshot").subject({}, fresh, lookup), fresh);
			assert.ok(look.effect === "ask" && look.request.rememberRules?.length === 1);
		} finally {
			hub.stop();
		}
		// In a window of its own, an action can still be remembered, with the warning.
		const separate = await browser(false);
		try {
			const fresh = session([]);
			const click = engine.decide(separate.tool("browser_click").subject({}, fresh, lookup), fresh);
			assert.ok(click.effect === "ask" && click.request.warning === "acts-as-you");
			assert.equal(click.request.rememberRules?.length, 1);
			// Closing a page there is still looking-class, as before.
			const close = engine.decide(separate.tool("browser_close").subject({}, fresh, lookup), fresh);
			assert.ok(close.effect === "ask" && close.request.warning === undefined);
			assert.equal(close.request.rememberRules?.length, 1);
		} finally {
			separate.hub.stop();
		}
	});

	test("Yew Harness's address is found however it is written", () => {
		for (const text of [
			"- 1: (current) [Yew Harness](http://127.0.0.1:4777/)",
			"http://localhost:4777",
			"localhost.:4777/api",
			"view-source:http://127.0.0.1:4777/",
			"blob:http://localhost:4777/0b3e",
			"ws://127.0.0.1:4777/api/events",
			"http://127.1:4777/",
			"http://0x7f000001:4777/",
			"http:\\\\127.0.0.1:4777",
			"http://[::1]:4777/",
			"https://someone@LOCALHOST:4777/",
		]) {
			assert.equal(namesHarness(text, PORT), true, text);
		}
		for (const text of [
			"http://127.0.0.1:47770/",
			"http://127.0.0.1:4778/",
			"https://example.com/?page=4777",
			"http://192.168.1.2:4777/",
			"- 0: (current) [Mail](https://mail.example.com/)",
		]) {
			assert.equal(namesHarness(text, PORT), false, text);
		}
	});

	test("no browser tool runs while a shared tab has Yew Harness open", async () => {
		const harness = `${SAFE_TABS}\n- 1: [Yew Harness](http://127.0.0.1:${PORT}/)`;
		const open = await browser(true, { TABS: harness });
		try {
			const result = await open.tool("browser_click").run({ ref: "e1" }, ctx);
			assert.equal(result.isError, true);
			assert.match(textOf(result), /take that tab out of the shared tabs/);
		} finally {
			open.hub.stop();
		}
		// Without it, the call goes through.
		const shared = await browser(true);
		try {
			const result = await shared.tool("browser_click").run({ ref: "e1" }, ctx);
			assert.equal(result.isError, undefined);
			assert.equal(textOf(result), 'browser_click {"ref":"e1"}');
		} finally {
			shared.hub.stop();
		}
		// Tabs that cannot be listed, or a port Yew Harness does not know: the browser is not used.
		const failing = await browser(true, { TABS: "error" });
		try {
			const result = await failing.tool("browser_click").run({ ref: "e1" }, ctx);
			assert.equal(result.isError, true);
			assert.match(textOf(result), /could not be listed/);
		} finally {
			failing.hub.stop();
		}
		const unknown = await browser(true, {}, null);
		try {
			const result = await unknown.tool("browser_click").run({ ref: "e1" }, ctx);
			assert.equal(result.isError, true);
			assert.match(textOf(result), /does not know its own port/);
		} finally {
			unknown.hub.stop();
		}
		// A window of its own does not hold Yew Harness's sign-in: its tabs are not listed first.
		const separate = await browser(false, { TABS: harness });
		try {
			const result = await separate.tool("browser_click").run({ ref: "e1" }, ctx);
			assert.equal(result.isError, undefined);
		} finally {
			separate.hub.stop();
		}
	});

	test("a call whose arguments name Yew Harness's address is refused, in either mode", async () => {
		for (const own of [true, false]) {
			const { hub, tool } = await browser(own);
			try {
				for (const url of [
					`http://127.0.0.1:${PORT}/`,
					`http://localhost:${PORT}/#t=abc`,
					`http://127.1:${PORT}`,
					`view-source:http://[::1]:${PORT}/`,
				]) {
					const result = await tool("browser_navigate").run({ url }, ctx);
					assert.equal(result.isError, true, url);
					assert.match(textOf(result), /own address is not opened/);
				}
				const elsewhere = await tool("browser_navigate").run({ url: "https://example.com/" }, ctx);
				assert.equal(elsewhere.isError, undefined);
			} finally {
				hub.stop();
			}
		}
	});

	test("the extension's token does not reach the browser server", async () => {
		const { hub, tool } = await browser(false, {
			PLAYWRIGHT_MCP_EXTENSION_TOKEN: "t0",
			GREETING: "hi",
		});
		try {
			const read = async (name: string) => textOf(await tool("env").run({ name }, ctx));
			assert.equal(await read("PLAYWRIGHT_MCP_EXTENSION_TOKEN"), "(unset)");
			assert.equal(await read("GREETING"), "hi");
		} finally {
			hub.stop();
		}
	});
});
