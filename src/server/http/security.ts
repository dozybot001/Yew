import { createHash, randomBytes } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Store } from "../store.ts";
import { readJson, reqString } from "./input.ts";
import { type AppEnv, problemResponse, titleFor } from "./problem.ts";

const LOGIN_TTL_MS = 10 * 60 * 1000;
const BROWSER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const cookieName = (port: number) => `yew_${port}`;

export function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/** A one-time login token, shown by `yew serve` and `yew open` in the URL fragment. */
export function issueLoginToken(store: Store): string {
	const token = randomBytes(32).toString("base64url");
	store.pruneAuthTokens();
	store.saveAuthToken(hashToken(token), "login", Date.now() + LOGIN_TTL_MS);
	return token;
}

/**
 * Only this machine, only this origin (after pi's local checks, prior-art 5.2):
 * - Host must be 127.0.0.1 or localhost with our port, which stops DNS rebinding;
 * - requests that came through a proxy are refused;
 * - API requests must come from Yew's own pages: same-origin `Sec-Fetch-Site`, and a matching `Origin`
 *   on writes. Other pages on this machine share the cookie's site (ports do not separate sites), so the
 *   cookie alone is not enough;
 * - Yew's pages cannot be framed.
 */
export function localOnly(port: number): MiddlewareHandler<AppEnv> {
	const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
	return async (c, next) => {
		// A paired phone's request, handed over in-process by the relay connector.
		if (c.env?.device) return next();
		const host = c.req.header("Host") ?? "";
		if (!hosts.has(host)) {
			return problemResponse(
				c,
				421,
				"wrong-host",
				titleFor(421),
				"Yew Harness only answers on 127.0.0.1 and localhost.",
			);
		}
		for (const header of [
			"Forwarded",
			"X-Forwarded-For",
			"X-Forwarded-Host",
			"X-Forwarded-Proto",
		]) {
			if (c.req.header(header) !== undefined) {
				return problemResponse(
					c,
					403,
					"proxied",
					titleFor(403),
					"Requests through a proxy are not accepted.",
				);
			}
		}
		if (c.req.path.startsWith("/api/")) {
			const site = c.req.header("Sec-Fetch-Site");
			if (site !== undefined && site !== "same-origin" && site !== "none") {
				return problemResponse(
					c,
					403,
					"cross-site",
					titleFor(403),
					"Requests from other sites are refused.",
				);
			}
			const dest = c.req.header("Sec-Fetch-Dest");
			if (dest === "iframe" || dest === "frame" || dest === "embed" || dest === "object") {
				return problemResponse(
					c,
					403,
					"embedded",
					titleFor(403),
					"Yew Harness cannot be embedded.",
				);
			}
			if (c.req.method !== "GET" && c.req.method !== "HEAD") {
				const origin = c.req.header("Origin");
				if (origin !== `http://${host}`) {
					return problemResponse(
						c,
						403,
						"bad-origin",
						titleFor(403),
						"This request did not come from Yew Harness's own page.",
					);
				}
			}
		}
		await next();
	};
}

/** Security headers on every response. */
export const securityHeaders = (): MiddlewareHandler<AppEnv> => async (c, next) => {
	await next();
	const headers = c.res.headers;
	// An HTML artifact brings its own, stricter policy, and is framed by Yew's own page only.
	if (c.req.path.startsWith("/artifact-view/") && headers.has("Content-Security-Policy")) {
		headers.set("X-Content-Type-Options", "nosniff");
		headers.set("Referrer-Policy", "no-referrer");
		headers.set("X-Frame-Options", "SAMEORIGIN");
		return;
	}
	headers.set(
		"Content-Security-Policy",
		"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
	);
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("Referrer-Policy", "no-referrer");
	headers.set("X-Frame-Options", "DENY");
	headers.set("Cross-Origin-Opener-Policy", "same-origin");
	headers.set("Cross-Origin-Resource-Policy", "same-origin");
	headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
	if (c.req.path.startsWith("/api/")) headers.set("Cache-Control", "no-store");
};

/** Paths that work without signing in. */
const OPEN_PATHS = new Set(["/api/auth/exchange", "/api/health"]);

/** API requests need the browser cookie that a login token was exchanged for. */
export function requireBrowser(store: Store, port: number): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		if (!c.req.path.startsWith("/api/") || OPEN_PATHS.has(c.req.path)) return next();
		if (c.env?.device) return next();
		const token = getCookie(c, cookieName(port));
		if (!token || !store.touchBrowserToken(hashToken(token), Date.now() + BROWSER_TTL_MS)) {
			return problemResponse(
				c,
				401,
				"sign-in-required",
				titleFor(401),
				"Open Yew Harness with the link from `yew serve` or `yew open`.",
			);
		}
		await next();
	};
}

function setBrowserCookie(c: Context, port: number, token: string): void {
	setCookie(c, cookieName(port), token, {
		httpOnly: true,
		sameSite: "Strict",
		path: "/",
		maxAge: BROWSER_TTL_MS / 1000,
	});
}

export function authRoutes(store: Store, port: number): Hono<AppEnv> {
	const app = new Hono<AppEnv>();

	/** Trades a one-time login token for an HttpOnly, SameSite=Strict cookie; the token stops working. */
	app.post("/auth/exchange", async (c) => {
		const fields = await readJson(c);
		const token = reqString(fields, "token", 200);
		if (!store.consumeLoginToken(hashToken(token))) {
			return problemResponse(
				c,
				401,
				"invalid-login-token",
				titleFor(401),
				"This sign-in link was already used or has expired. Run `yew open` for a new one.",
			);
		}
		const browser = randomBytes(32).toString("base64url");
		store.saveAuthToken(hashToken(browser), "browser", Date.now() + BROWSER_TTL_MS);
		setBrowserCookie(c, port, browser);
		return c.body(null, 204);
	});

	app.post("/auth/logout", (c) => {
		const token = getCookie(c, cookieName(port));
		if (token) store.deleteAuthToken(hashToken(token));
		deleteCookie(c, cookieName(port), { path: "/" });
		return c.body(null, 204);
	});

	return app;
}

/**
 * What a paired phone may not do through the relay: manage API keys, add or revoke
 * devices, or change remote access. Those stay on the Mac. So do the settings that decide what this
 * computer starts or holds as a secret: MCP servers, search keys, starting at login and the launcher,
 * the skills in this computer's folders, and the data folder: its size, export and cleanup.
 */
const COMPUTER_ONLY = [
	"/api/mcp",
	"/api/search-services",
	"/api/system",
	"/api/skills",
	"/api/data",
	"/api/open-file",
	// Updating and restarting Yew Harness change what runs on this computer.
	"/api/updates",
];
export function deviceLimits(): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		if (!c.env?.device) return next();
		const { method, path } = c.req;
		const write = method !== "GET" && method !== "HEAD";
		const self = path === `/api/devices/${c.env.device}`;
		if (
			(path.startsWith("/api/providers") && write) ||
			// Reading them too: a server's command line is this computer's business.
			COMPUTER_ONLY.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)) ||
			path === "/api/devices/pairing" ||
			// A phone changes or removes only itself, never another phone.
			(path.startsWith("/api/devices/") && write && !self) ||
			// Artifacts are looked at on the phone and managed on the Mac.
			(path.startsWith("/api/artifacts/") && write) ||
			path.startsWith("/api/auth/")
		) {
			return problemResponse(
				c,
				403,
				"mac-only",
				titleFor(403),
				"Only Yew Harness on the Mac can do this: API keys, devices and remote access stay there.",
			);
		}
		await next();
	};
}
