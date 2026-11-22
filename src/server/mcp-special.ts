import { MCP_PRESETS } from "../shared/mcp-presets.ts";
import type { JsonObject } from "../shared/messages.ts";
import type { ConfirmReason } from "../shared/types.ts";
import type { McpServerConfig } from "./mcp.ts";

/** What the computer control tool does without changing anything. */
const COMPUTER_READS = new Set(["get_screenshot", "get_cursor_position"]);
/** What the browser's tools do without acting on a page; any other tool of it acts. */
const BROWSER_READS = new Set([
	"browser_snapshot",
	"browser_take_screenshot",
	"browser_console_messages",
	"browser_network_requests",
	"browser_network_request",
	"browser_tabs",
	"browser_find",
	"browser_wait_for",
	"browser_resize",
	"browser_emulate_media",
	"browser_hover",
	// Not browser_navigate: opening an address in a signed-in profile can act by itself, and an
	// address can carry out what a page talked the session into putting in it.
	"browser_navigate_back",
	"browser_close",
]);

/**
 * In the person's own Chrome, what only reads and can be remembered; browser_tabs counts only for
 * listing. Anything else, going back, closing a page and resizing the window included, changes the
 * tabs and windows the person works in, and is asked every time.
 */
const OWN_BROWSER_READS = new Set([
	"browser_snapshot",
	"browser_take_screenshot",
	"browser_console_messages",
	"browser_network_requests",
	"browser_network_request",
	"browser_find",
	"browser_wait_for",
	"browser_hover",
]);

/**
 * Browser tools Yew does not offer, whoever runs the server: browser_run_code_unsafe runs any
 * JavaScript in the browser server's own Node process, which is outside the system sandbox, so one
 * approval of it would be running code outside the sandbox.
 */
const BROWSER_REFUSED = new Set(["browser_run_code_unsafe"]);

/**
 * Whether Yew refuses a browser tool. Besides the one above, any tool that reads or writes cookies
 * or a site's storage (browser_cookie_list, browser_localstorage_get, browser_storage_state): Yew
 * does not start the server with them (no `--caps=storage`), and filters them by name as well.
 */
export function refusedBrowserTool(tool: string): boolean {
	return BROWSER_REFUSED.has(tool) || /cookie|storage/i.test(tool);
}

/**
 * Whether the browser server drives the person's own Chrome through Playwright's extension: started
 * with `--extension`, or told so by PLAYWRIGHT_MCP_EXTENSION in its environment.
 */
export function ownBrowser(
	config: Pick<McpServerConfig, "args" | "env" | "ownEnv"> | undefined,
	env: NodeJS.ProcessEnv = {},
): boolean {
	if (!config) return false;
	if ((config.args ?? []).some((arg) => arg === "--extension" || arg.startsWith("--extension="))) {
		return true;
	}
	const value =
		config.env?.PLAYWRIGHT_MCP_EXTENSION ??
		(config.ownEnv ? undefined : env.PLAYWRIGHT_MCP_EXTENSION);
	return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

/** A browser call that opens an address: browser_tabs opening a new tab at one counts. */
function opensAddress(tool: string, args: JsonObject): boolean {
	return tool === "browser_tabs" && args.action === "new" && typeof args.url === "string";
}

/** Words in a tool's name that say it sends, publishes or deletes something in the service. */
const OUTWARD = new Set([
	"send",
	"reply",
	"forward",
	"publish",
	"deploy",
	"share",
	"invite",
	"delete",
	"remove",
	"trash",
	"destroy",
	"purge",
	"merge",
	"push",
	"pay",
	"transfer",
	"refund",
	"permission",
	"permissions",
]);
/** First words that say a tool only looks, whatever else its name holds (get_merge_request). */
const LOOKING = new Set([
	"get",
	"list",
	"search",
	"read",
	"find",
	"fetch",
	"query",
	"describe",
	"view",
]);

/** Whether a tool's name says it sends, publishes or deletes something: send_message, sendEmail. */
export function outward(tool: string): boolean {
	const words = tool
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
	if (LOOKING.has(words[0] ?? "")) return false;
	return words.some((word) => OUTWARD.has(word));
}

/**
 * What is special about a call to an MCP tool.
 *
 * - Computer control acts on the whole screen: it can type into a terminal or click in the person's
 *   own browser, past every rule Yew has. Each action is asked about, cannot be remembered, and an
 *   earlier "always allow" does not cover it. Looking (a screenshot, the pointer's place) can be.
 * - The browser in the person's own Chrome (the default) acts with their sign-ins in the tabs it
 *   is given: each action is asked about and cannot be remembered, like computer control; looking
 *   can be. In a window of its own, its actions can be remembered, with the scope said.
 * - Any other server's tool that sends, publishes or deletes something in its service is
 *   asked about every time: one its name says does, one its server marks as destructive, and the
 *   ones a common server's preset names (a calendar event invites its attendees). A server's word
 *   that a tool only reads is not taken.
 */
/**
 * The common server a configured one is: by its `preset` in mcp.json, or by the host of its address,
 * so a person who renames the entry keeps the preset's rules. Failing those, by its name.
 */
function presetOf(server: string, config?: Pick<McpServerConfig, "url" | "preset">) {
	const host = (url: string) => {
		try {
			return new URL(url).host;
		} catch {
			return null;
		}
	};
	if (config?.preset) return MCP_PRESETS.find((preset) => preset.id === config.preset);
	if (config?.url) {
		const at = host(config.url);
		return MCP_PRESETS.find((preset) => "url" in preset.connect && host(preset.connect.url) === at);
	}
	return MCP_PRESETS.find((preset) => preset.id === server);
}

export function special(
	server: string,
	tool: string,
	args: JsonObject = {},
	destructive = false,
	config?: Pick<McpServerConfig, "url" | "preset" | "args" | "env" | "ownEnv">,
	/** The environment the server was started with, which may say it drives the person's Chrome. */
	env: NodeJS.ProcessEnv = {},
): { reasons?: ConfirmReason[]; warning?: "acts-as-you" } {
	if (server === "computer") {
		const action = typeof args.action === "string" ? args.action : "";
		return COMPUTER_READS.has(action) ? {} : { reasons: ["computer-control"] };
	}
	if (server === "browser") {
		// In the person's own Chrome, with their sign-ins: each action is asked about, cannot be
		// remembered, and an earlier "always allow" does not cover it.
		if (ownBrowser(config, env)) {
			if (OWN_BROWSER_READS.has(tool) || (tool === "browser_tabs" && args.action === "list")) {
				return {};
			}
			return { reasons: [tool === "browser_evaluate" ? "browser-script" : "browser-action"] };
		}
		if (BROWSER_READS.has(tool) && !opensAddress(tool, args)) return {};
		return { warning: "acts-as-you" };
	}
	const named = presetOf(server, config)?.asksEveryTime?.includes(tool);
	return destructive || named || outward(tool) ? { reasons: ["service-action"] } : {};
}
