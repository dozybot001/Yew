import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { RemoteAccess } from "../../remote/access.ts";
import { PROTOCOL_VERSION, VERSION } from "../../shared/version.ts";
import type { Agents } from "../agent/runner.ts";
import type { ArtifactStore } from "../artifacts.ts";
import type { AttachmentStore } from "../attachments.ts";
import type { EventBus } from "../events.ts";
import { PostOffice } from "../mail/post.ts";
import type { ModelGateway } from "../model/gateway.ts";
import { activeSandbox } from "../sandbox.ts";
import type { Scheduler } from "../schedules.ts";
import type { Store } from "../store.ts";
import type { SearchAccess } from "../tools/web-search.ts";
import type { Updates } from "../updates.ts";
import { agentRoutes } from "./agents.ts";
import { api } from "./api.ts";
import { artifactRoutes } from "./artifacts.ts";
import { attachmentRoutes } from "./attachments.ts";
import { type DataRoutesOptions, dataRoutes } from "./data.ts";
import { deviceRoutes } from "./devices.ts";
import { DraftCache, eventRoutes } from "./events.ts";
import { mailRoutes } from "./mail.ts";
import { type McpRoutesOptions, mcpRoutes, oauthCallbackRoute } from "./mcp.ts";
import { type NoteStreams, noteRoutes } from "./notes.ts";
import { type AppEnv, errorHandler, problemResponse, requestId, titleFor } from "./problem.ts";
import { providerRoutes } from "./providers.ts";
import { scheduleRoutes } from "./schedules.ts";
import { searchRoutes } from "./search.ts";
import {
	authRoutes,
	deviceLimits,
	localOnly,
	requireBrowser,
	securityHeaders,
} from "./security.ts";
import { type SkillRoutesOptions, skillRoutes } from "./skills.ts";
import { type SystemControl, systemRoutes } from "./system.ts";
import { updateRoutes } from "./updates.ts";

export interface AppOptions {
	store: Store;
	gateway?: ModelGateway;
	agents?: Agents;
	bus?: EventBus;
	log?: (line: string) => void;
	/** Turns on the Host, Origin and sign-in checks for this port. Tests of the API alone leave it out. */
	security?: { port: number };
	/** The built web interface (`web/dist`). */
	webRoot?: string;
	/** Short commit of the running code, shown as the build number. */
	build?: string | null;
	/** Replaces the system folder picker; tests use it so they never open a window. */
	pickFolder?: () => Promise<string | null>;
	/** Phone access through the relay. */
	remote?: RemoteAccess;
	/** Scheduled tasks. */
	scheduler?: Scheduler;
	/** Told when Yew's page on the Mac is in front and in use, so notifications wait. */
	onPresence?: () => void;
	/** Notifications for phones that keep their own connection (the Android app). */
	notes?: NoteStreams;
	/** What sessions saved for the person to look at. */
	artifacts?: ArtifactStore;
	/** File attachments sent with messages. */
	attachments?: AttachmentStore;
	/** The MCP servers in mcp.json, managed from the settings. */
	mcp?: McpRoutesOptions;
	/** The skills in the global and workspace folders, listed in the settings. */
	skills?: SkillRoutesOptions;
	/** The data folder's size, export and cleanup, in the settings. */
	data?: DataRoutesOptions;
	/** The search services' keys. */
	search?: SearchAccess;
	/** Starting at login and the launcher icon. */
	system?: SystemControl;
	/** Versions and updates (updates.ts). */
	updates?: Updates;
}

const NOT_BUILT = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Yew Harness</title>
<meta name="color-scheme" content="light dark"></head><body>
<p>网页界面还没有构建。在 Yew Harness 的目录运行 npm run build:web，然后刷新这个页面。</p>
<p lang="en">The web interface has not been built yet. In the Yew Harness folder, run npm run build:web, then reload this page.</p>
</body></html>`;

export function createApp(options: AppOptions): Hono<AppEnv> {
	const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
	const { store, gateway, agents, bus } = options;
	const app = new Hono<AppEnv>();
	app.use("*", requestId());
	app.use("*", securityHeaders());
	app.onError(errorHandler(log));
	app.notFound((c) => problemResponse(c, 404, "not-found", titleFor(404), "No such endpoint."));

	if (options.security) {
		app.use("*", localOnly(options.security.port));
		app.use("*", requireBrowser(store, options.security.port));
		app.route("/api", authRoutes(store, options.security.port));
	}
	app.use("*", deviceLimits());
	app.get("/api/health", (c) =>
		c.json({
			ok: true,
			version: VERSION,
			build: options.build ?? null,
			protocol: PROTOCOL_VERSION,
			// Which system sandbox sessions' commands run in, for the settings.
			sandbox: activeSandbox(),
		}),
	);
	app.route(
		"/api",
		api({
			store,
			...(options.data?.home || agents?.home
				? { yewHome: options.data?.home ?? agents?.home }
				: {}),
			...(options.skills?.userHome !== undefined ? { userHome: options.skills.userHome } : {}),
			...(gateway ? { checkModel: (p: string, m: string) => gateway.check(p, m) } : {}),
			...(options.pickFolder ? { pickFolder: options.pickFolder } : {}),
			...(agents ? { onArchived: (id: string) => agents.archived(id) } : {}),
			...(options.remote
				? { onRemoteChanged: () => void options.remote?.sync().catch((e: Error) => log(e.message)) }
				: {}),
			...(options.mcp
				? {
						onBrowserChanged: () =>
							void options.mcp?.hub.refresh().catch((e: Error) => log(`mcp: ${e.message}`)),
					}
				: {}),
		}),
	);
	app.route("/api", deviceRoutes(store, options.remote));
	// The page on the Mac says it is in front and in use; a phone's use does not count.
	app.post("/api/presence", (c) => {
		if (!c.env?.device) options.onPresence?.();
		return c.body(null, 204);
	});
	if (gateway) app.route("/api", providerRoutes(store, gateway));
	if (agents) app.route("/api", agentRoutes(store, agents, log));
	const attachments = options.attachments ?? agents?.attachments;
	if (attachments) app.route("/api", attachmentRoutes(attachments));
	// The runner's post office, so a released letter or a decision wakes its recipient.
	app.route("/api", mailRoutes(agents?.post ?? new PostOffice(store, log)));
	if (bus) app.route("/api", eventRoutes(store, bus, new DraftCache(bus)));
	if (options.scheduler) app.route("/api", scheduleRoutes(store, options.scheduler));
	if (options.notes) app.route("/api", noteRoutes(options.notes));
	if (options.mcp) {
		app.route("/api", mcpRoutes(store, { log, ...options.mcp }));
		app.route("/", oauthCallbackRoute(options.mcp.hub, log));
	}
	if (options.skills) app.route("/api", skillRoutes(store, options.skills));
	if (options.data) {
		// A session's output files are left alone while one of its commands may still write to them.
		const inUse = agents ? (id: string) => agents.hasLiveCommands(id) : undefined;
		app.route("/api", dataRoutes(store, { ...(inUse ? { inUse } : {}), ...options.data }));
	}
	if (options.search) app.route("/api", searchRoutes(options.search));
	if (options.system) app.route("/api", systemRoutes(options.system));
	if (options.updates) app.route("/api", updateRoutes(options.updates));
	if (options.artifacts) app.route("/", artifactRoutes(options.artifacts));

	const root = options.webRoot;
	if (root && existsSync(join(root, "index.html"))) {
		// Read per request, so a rebuilt interface (npm run watch:web) is served without a restart.
		const index = () => readFileSync(join(root, "index.html"), "utf8");
		app.use("/assets/*", async (c, next) => {
			await next();
			// Built assets have content hashes in their names, so they can be cached for good.
			if (c.res.status === 200) {
				c.res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
			}
		});
		app.use("*", async (c, next) => {
			await next();
			// The page itself (served for "/" by serveStatic too) is checked every time: a page kept from
			// before an update would load the old interface's assets, which stay cached for good.
			if (
				!c.req.path.startsWith("/assets/") &&
				c.res.headers.get("Content-Type")?.startsWith("text/html")
			) {
				c.res.headers.set("Cache-Control", "no-cache");
			}
		});
		app.use("*", serveStatic({ root }));
		app.get("*", (c) => {
			if (c.req.path.startsWith("/api/")) return c.notFound();
			c.header("Cache-Control", "no-cache");
			return c.html(index());
		});
	} else {
		app.get("/", (c) => c.html(NOT_BUILT));
	}
	return app;
}
