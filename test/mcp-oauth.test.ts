/**
 * Signing in to MCP servers in the browser. A local server plays both the
 * MCP server that wants a token and its authorization server; the browser's part is played by the
 * test, which takes the address Yew would open and hands back a code.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, test } from "node:test";
import { oauthCallbackRoute } from "../src/server/http/mcp.ts";
import { MemoryKeyStore } from "../src/server/keys.ts";
import { McpHub } from "../src/server/mcp.ts";
import { McpAuth } from "../src/server/mcp-oauth.ts";
import type { ToolContext } from "../src/server/tools/types.ts";
import { tempDir } from "./helpers/store.ts";

const REDIRECT = "http://127.0.0.1:4777/oauth/callback";

/** An MCP server that wants a bearer token, and the authorization server that hands them out. */
async function provider(options: { register?: boolean; iss?: boolean; moveToken?: boolean } = {}) {
	const seen = {
		registrations: [] as unknown[],
		tokens: [] as URLSearchParams[],
		bearers: [] as string[],
		revoked: [] as URLSearchParams[],
		/** What reached the address the token endpoint redirected to. */
		moved: [] as string[],
	};
	let challenge = "";
	let valid = new Set<string>();
	const http = createServer((req: IncomingMessage, res: ServerResponse) => {
		let body = "";
		req.on("data", (piece: Buffer) => {
			body += piece.toString("utf8");
		});
		req.on("end", () => {
			const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
			const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
				res.writeHead(status, { "Content-Type": "application/json", ...headers });
				res.end(JSON.stringify(value));
			};
			const path = req.url ?? "";
			if (path === "/mcp" && req.method === "POST") {
				const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
				seen.bearers.push(bearer);
				if (!valid.has(bearer)) {
					return json(
						401,
						{ error: "unauthorized" },
						{
							"WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="read"`,
						},
					);
				}
				const message = JSON.parse(body) as { id?: number; method: string };
				if (message.id === undefined) return json(202, {});
				const result =
					message.method === "initialize"
						? {
								protocolVersion: "2025-06-18",
								capabilities: { tools: {} },
								serverInfo: { name: "demo", version: "1" },
							}
						: message.method === "tools/list"
							? { tools: [{ name: "hello", inputSchema: { type: "object", properties: {} } }] }
							: { content: [{ type: "text", text: `hi with ${bearer}` }] };
				return json(200, { jsonrpc: "2.0", id: message.id, result });
			}
			if (path === "/.well-known/oauth-protected-resource/mcp") {
				return json(200, { resource: `${base}/mcp`, authorization_servers: [`${base}/as`] });
			}
			if (path === "/.well-known/oauth-authorization-server/as") {
				return json(200, {
					issuer: `${base}/as`,
					authorization_endpoint: `${base}/as/authorize`,
					token_endpoint: `${base}/as/token`,
					...(options.register === false ? {} : { registration_endpoint: `${base}/as/register` }),
					revocation_endpoint: `${base}/as/revoke`,
					...(options.iss ? { authorization_response_iss_parameter_supported: true } : {}),
					code_challenge_methods_supported: ["S256"],
				});
			}
			if (path === "/as/revoke") {
				seen.revoked.push(new URLSearchParams(body));
				res.writeHead(200);
				res.end();
				return;
			}
			if (path === "/as/token" && options.moveToken) {
				res.writeHead(307, { Location: `${base}/as/elsewhere` });
				res.end();
				return;
			}
			if (path === "/as/elsewhere") {
				seen.moved.push(body);
				return json(200, { access_token: "taken" });
			}
			if (path === "/as/register") {
				seen.registrations.push(JSON.parse(body));
				return json(201, { client_id: "c-1" });
			}
			if (path === "/as/token") {
				const form = new URLSearchParams(body);
				seen.tokens.push(form);
				if (form.get("grant_type") === "authorization_code") {
					const verifier = form.get("code_verifier") ?? "";
					const derived = createHash("sha256").update(verifier).digest("base64url");
					if (form.get("code") !== "code-1" || derived !== challenge) {
						return json(400, { error: "invalid_grant" });
					}
					valid = new Set(["at-1"]);
					return json(200, { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 });
				}
				if (form.get("grant_type") === "refresh_token" && form.get("refresh_token") === "rt-1") {
					valid = new Set(["at-2"]);
					return json(200, { access_token: "at-2", expires_in: 3600 });
				}
				return json(400, { error: "invalid_grant" });
			}
			res.writeHead(404);
			res.end();
		});
	});
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
	return {
		base,
		seen,
		/** What the authorization server remembers from the address the browser opened. */
		expect: (url: URL) => {
			challenge = url.searchParams.get("code_challenge") ?? "";
		},
		close: () => {
			http.closeAllConnections();
			http.close();
		},
	};
}

function setup(entry: Record<string, unknown>, now = () => Date.now()) {
	const yewHome = tempDir("yew-home-");
	writeFileSync(join(yewHome, "mcp.json"), JSON.stringify({ mcpServers: { demo: entry } }));
	const keys = new MemoryKeyStore();
	const auth = new McpAuth({ keys, redirectUri: REDIRECT, version: "0.0.0", now });
	const hub = new McpHub({ yewHome, version: "0.0.0", log: () => {}, auth });
	const status = () => hub.status().find((server) => server.name === "demo");
	return { yewHome, keys, auth, hub, status };
}

const ctx = { signal: new AbortController().signal, acceptsImages: false } as ToolContext;

describe("signing in to an MCP server", () => {
	test("Yew finds where to sign in, registers itself, and keeps the tokens in the keychain", async () => {
		const server = await provider();
		const { yewHome, keys, hub, status } = setup({ url: `${server.base}/mcp` });
		try {
			await hub.refresh();
			assert.equal(status()?.state, "sign-in");
			assert.equal(status()?.signInAt, new URL(server.base).host, "the settings name the site");
			const url = new URL(await hub.signInUrl("demo"));
			assert.equal(url.origin + url.pathname, `${server.base}/as/authorize`);
			const params = Object.fromEntries(url.searchParams);
			assert.equal(params.client_id, "c-1");
			assert.equal(params.redirect_uri, REDIRECT);
			assert.equal(params.code_challenge_method, "S256");
			assert.equal(params.resource, `${server.base}/mcp`);
			assert.equal(params.scope, "read", "the scope the server named");
			assert.deepEqual(server.seen.registrations[0], {
				client_name: "Yew Harness",
				redirect_uris: [REDIRECT],
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
				software_version: "0.0.0",
			});

			server.expect(url);
			assert.equal(await hub.completeSignIn(params.state as string, "code-1", null), "demo");
			assert.equal(status()?.state, "ready");
			assert.equal(status()?.signedIn, true);
			const tool = hub.tools().find((item) => item.name === "mcp__demo__hello");
			const result = await tool?.run({}, ctx);
			assert.match(JSON.stringify(result), /hi with at-1/);
			// The token went with the request; nothing of it is in mcp.json.
			assert.ok(server.seen.bearers.includes("at-1"));
			assert.doesNotMatch(readFileSync(join(yewHome, "mcp.json"), "utf8"), /at-1|rt-1|c-1/);
			assert.match((await keys.get("demo")) ?? "", /"access":"at-1"/);

			// A state works once.
			await assert.rejects(
				hub.completeSignIn(params.state as string, "code-1", null),
				/not valid any more/,
			);

			await hub.signOut("demo");
			assert.equal(status()?.state, "sign-in");
			assert.equal(await keys.get("demo"), null);
			// The server was asked to void both tokens first (RFC 7009).
			assert.deepEqual(
				server.seen.revoked.map((form) => [
					form.get("token"),
					form.get("token_type_hint"),
					form.get("client_id"),
				]),
				[
					["rt-1", "refresh_token", "c-1"],
					["at-1", "access_token", "c-1"],
				],
			);
		} finally {
			hub.stop();
			server.close();
		}
	});

	test("a token about to run out is refreshed", async () => {
		const server = await provider();
		let now = Date.now();
		const { auth, hub } = setup({ url: `${server.base}/mcp` }, () => now);
		try {
			await hub.refresh();
			const url = new URL(await hub.signInUrl("demo"));
			server.expect(url);
			await hub.completeSignIn(url.searchParams.get("state") as string, "code-1", null);
			assert.equal(await auth.bearer("demo", `${server.base}/mcp`), "at-1");
			now += 3600 * 1000;
			assert.equal(await auth.bearer("demo", `${server.base}/mcp`), "at-2");
			const refresh = server.seen.tokens.find((form) => form.get("grant_type") === "refresh_token");
			assert.equal(refresh?.get("resource"), `${server.base}/mcp`);
		} finally {
			hub.stop();
			server.close();
		}
	});

	test("with a client the person made, Yew registers nothing and asks for the scopes given", async () => {
		const server = await provider({ register: false });
		const { hub } = setup({
			url: `${server.base}/mcp`,
			oauth: { clientId: "mine", clientSecret: "shh", scopes: ["a", "b"] },
		});
		try {
			await hub.refresh();
			const url = new URL(await hub.signInUrl("demo"));
			assert.equal(url.searchParams.get("client_id"), "mine");
			assert.equal(url.searchParams.get("scope"), "a b");
			assert.equal(server.seen.registrations.length, 0);
			server.expect(url);
			await hub.completeSignIn(url.searchParams.get("state") as string, "code-1", null);
			const exchange = server.seen.tokens.at(-1);
			assert.equal(exchange?.get("client_secret"), "shh");
			assert.equal(exchange?.get("client_id"), "mine");
		} finally {
			hub.stop();
			server.close();
		}
	});

	test("a server that only takes clients registered in advance says so", async () => {
		const server = await provider({ register: false });
		const { hub } = setup({ url: `${server.base}/mcp` });
		try {
			await hub.refresh();
			await assert.rejects(hub.signInUrl("demo"), /only accepts clients registered in advance/);
		} finally {
			hub.stop();
			server.close();
		}
	});

	test("the page the browser comes back to finishes the sign-in, and only with a state Yew made", async () => {
		const server = await provider();
		const { hub, status } = setup({ url: `${server.base}/mcp` });
		const page = oauthCallbackRoute(hub);
		try {
			await hub.refresh();
			const bad = await page.request("/oauth/callback?state=forged&code=code-1");
			assert.equal(bad.status, 400);
			assert.equal(bad.headers.get("cache-control"), "no-store");
			assert.match(await bad.text(), /not valid any more/);
			const url = new URL(await hub.signInUrl("demo"));
			server.expect(url);
			const good = await page.request(
				`/oauth/callback?state=${url.searchParams.get("state")}&code=code-1`,
			);
			assert.equal(good.status, 200);
			assert.equal(good.headers.get("cache-control"), "no-store");
			assert.match(await good.text(), /已登录 demo/);
			assert.equal(status()?.state, "ready");
		} finally {
			hub.stop();
			server.close();
		}
	});
	test("a return that names another sign-in server, or leaves out the name it should give, is not used", async () => {
		const server = await provider({ iss: true });
		const { hub, status } = setup({ url: `${server.base}/mcp` });
		try {
			await hub.refresh();
			const start = async () => {
				const url = new URL(await hub.signInUrl("demo"));
				server.expect(url);
				return url.searchParams.get("state") as string;
			};
			await assert.rejects(
				hub.completeSignIn(await start(), "code-1", null, "https://elsewhere.example"),
				/another server/,
			);
			await assert.rejects(
				hub.completeSignIn(await start(), "code-1", null, null),
				/another server/,
			);
			assert.equal(server.seen.tokens.length, 0, "no code was traded");
			await hub.completeSignIn(await start(), "code-1", null, `${server.base}/as`);
			assert.equal(status()?.state, "ready");
		} finally {
			hub.stop();
			server.close();
		}
	});

	test("a code is not sent on when the token address redirects", async () => {
		const server = await provider({ moveToken: true });
		const { hub, status } = setup({ url: `${server.base}/mcp` });
		try {
			await hub.refresh();
			const url = new URL(await hub.signInUrl("demo"));
			server.expect(url);
			await assert.rejects(
				hub.completeSignIn(url.searchParams.get("state") as string, "code-1", null),
				/did not give Yew Harness a token/,
			);
			assert.deepEqual(server.seen.moved, []);
			assert.equal(status()?.state, "sign-in");
		} finally {
			hub.stop();
			server.close();
		}
	});
});

describe("what a server says about signing in is checked before it is used", () => {
	const resource = "https://mcp.example.com/mcp";
	const prm = "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
	const meta = "https://auth.example.com/.well-known/oauth-authorization-server";
	const good: Record<string, Record<string, unknown>> = {
		[prm]: { resource, authorization_servers: ["https://auth.example.com/"] },
		[meta]: {
			issuer: "https://auth.example.com",
			authorization_endpoint: "https://auth.example.com/authorize",
			token_endpoint: "https://auth.example.com/token",
			code_challenge_methods_supported: ["S256"],
		},
	};
	/** Starts a sign-in against a table of addresses and their answers, noting each address asked. */
	const begin = (
		table: Record<string, Record<string, unknown>>,
		at = resource,
		challenge: string | null = null,
	) => {
		const asked: string[] = [];
		const fetch = (async (input: string | URL | Request) => {
			const url = String(input);
			asked.push(url);
			const body = table[url];
			return body
				? new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } })
				: new Response("", { status: 404 });
		}) as typeof globalThis.fetch;
		const keys = new MemoryKeyStore();
		const auth = new McpAuth({ keys, redirectUri: REDIRECT, version: "0", fetch });
		return { asked, result: auth.begin("demo", at, { clientId: "mine" }, challenge) };
	};

	test("details that hold together are used, a trailing slash aside", async () => {
		const url = new URL(await begin(good).result);
		assert.equal(url.origin + url.pathname, "https://auth.example.com/authorize");
	});

	test("an address that is not https is not used, nor asked", async () => {
		await assert.rejects(begin(good, "http://mcp.example.com/mcp").result, /https addresses/);
		const lan = begin(good, resource, 'Bearer resource_metadata="http://192.168.1.2/prm"');
		await assert.rejects(lan.result, /not https/);
		assert.deepEqual(lan.asked, []);
		const plain = begin({
			...good,
			[prm]: { resource, authorization_servers: ["http://auth.example.com"] },
		});
		await assert.rejects(plain.result, /not at an https address/);
		assert.ok(!plain.asked.some((url) => url.startsWith("http:")));
		const token = begin({
			...good,
			[meta]: { ...good[meta], token_endpoint: "http://auth.example.com/token" },
		});
		await assert.rejects(token.result, /not https/);
	});

	test("details about another address, from another server, or without S256 are not used", async () => {
		const other = { ...good, [prm]: { ...good[prm], resource: "https://other.example.com/mcp" } };
		await assert.rejects(begin(other).result, /another address/);
		const issuer = { ...good, [meta]: { ...good[meta], issuer: "https://elsewhere.example.com" } };
		await assert.rejects(begin(issuer).result, /another server/);
		const { code_challenge_methods_supported: _s256, ...noPkce } = good[meta] as Record<
			string,
			unknown
		>;
		await assert.rejects(begin({ ...good, [meta]: noPkce }).result, /S256/);
		const plainOnly = {
			...good,
			[meta]: { ...good[meta], code_challenge_methods_supported: ["plain"] },
		};
		await assert.rejects(begin(plainOnly).result, /S256/);
	});
});
