/**
 * Signing in to MCP servers in the browser, as the MCP authorization spec
 * describes it with OAuth 2.1. Yew finds the server's authorization server (RFC 9728 and RFC 8414),
 * registers itself as a client where the server allows that (RFC 7591), or uses the client the person
 * made for it (Google's servers), and sends the person's browser to sign in with PKCE and a state.
 * The browser comes back to http://127.0.0.1:<port>/oauth/callback with a code, which Yew trades for
 * tokens. Tokens and registered clients are secrets: they are kept in the system keychain, never in
 * mcp.json, the database or logs.
 *
 * What a server says about where to sign in is checked before it is used: every address is https;
 * the details are for this server and from the sign-in server Yew asked; PKCE with S256 is
 * supported; a sign-in server that names itself in the browser's return is the one the browser went
 * to (RFC 9207). Requests that carry a code, a secret or a token do not follow redirects. Signing
 * out asks the server to void the tokens where it says how (RFC 7009).
 */
import { createHash, randomBytes } from "node:crypto";
import type { KeyStore } from "./keys.ts";

/** What mcp.json may say about signing in to an HTTP server. */
export interface OAuthSettings {
	/** A client the person made, for servers that do not let Yew register one (Google's). */
	clientId?: string;
	clientSecret?: string;
	/** Scopes to ask for; otherwise the server's own default. */
	scopes?: string[];
}

interface Endpoints {
	/** The sign-in server, as its own details name it. */
	issuer: string;
	authorization: string;
	token: string;
	registration?: string;
	/** Where to void tokens when the person signs out (RFC 7009). */
	revocation?: string;
	/** It names itself in the browser's return to Yew (RFC 9207). */
	namesItself?: boolean;
}

interface Discovered {
	endpoints: Endpoints;
	/** The scope the server's refusal named, if it did. */
	scope: string | null;
}

/** What is kept for one server, in the keychain. */
interface Saved {
	/** The server's address the sign-in is for. */
	resource: string;
	endpoints: Endpoints;
	client: { id: string; secret?: string; redirectUri: string; registered: boolean };
	tokens?: { access: string; refresh?: string; expiresAt?: number };
}

interface Pending {
	server: string;
	verifier: string;
	saved: Saved;
	createdAt: number;
}

/** The server answered that it wants a signed-in request. */
export class SignInRequired extends Error {
	readonly challenge: string | null;
	constructor(challenge: string | null) {
		super("the server asks you to sign in");
		this.challenge = challenge;
	}
}

export interface McpAuthOptions {
	keys: KeyStore;
	/** Where the browser comes back to: http://127.0.0.1:<port>/oauth/callback. */
	redirectUri: string;
	version: string;
	fetch?: typeof fetch;
	now?: () => number;
}

/** How long a started sign-in waits for the browser to come back. */
const PENDING_MS = 10 * 60 * 1000;
/** How long what Yew found out about where to sign in is used again. */
const FOUND_MS = 10 * 60 * 1000;
const REQUEST_MS = 20_000;
/** Voiding tokens on sign-out is a courtesy to the server: it does not hold up signing out for long. */
const REVOKE_MS = 5_000;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Whether Yew uses an address it was told about while signing in: https only, so a sign-in page, a
 * code or a token never goes in the clear and a server cannot point Yew at other machines on the
 * network. A server on this computer may use http on this computer.
 */
function usable(url: unknown, local: boolean): url is string {
	if (typeof url !== "string") return false;
	try {
		const at = new URL(url);
		return (
			at.protocol === "https:" || (local && at.protocol === "http:" && LOOPBACK.has(at.hostname))
		);
	} catch {
		return false;
	}
}

/** The same address, a trailing slash aside. */
function same(a: string, b: string): boolean {
	try {
		return new URL(a).href.replace(/\/+$/, "") === new URL(b).href.replace(/\/+$/, "");
	} catch {
		return false;
	}
}

const b64url = (bytes: Buffer) => bytes.toString("base64url");

/** A parameter of a WWW-Authenticate challenge, such as resource_metadata or scope. */
function param(challenge: string | null, name: string): string | null {
	if (!challenge) return null;
	return new RegExp(`${name}="([^"]*)"`).exec(challenge)?.[1] ?? null;
}

function tokensFrom(answer: Record<string, unknown>, now: number, previousRefresh?: string) {
	const expires = Number(answer.expires_in);
	const refresh = typeof answer.refresh_token === "string" ? answer.refresh_token : previousRefresh;
	return {
		access: String(answer.access_token),
		...(refresh ? { refresh } : {}),
		...(Number.isFinite(expires) && expires > 0 ? { expiresAt: now + expires * 1000 } : {}),
	};
}

export class McpAuth {
	readonly #keys: KeyStore;
	readonly #redirect: string;
	readonly #version: string;
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	readonly #pending = new Map<string, Pending>();
	readonly #refreshing = new Map<string, Promise<string | null>>();
	readonly #found = new Map<string, { at: number; value: Promise<Discovered> }>();

	constructor(options: McpAuthOptions) {
		this.#keys = options.keys;
		this.#redirect = options.redirectUri;
		this.#version = options.version;
		this.#fetch = options.fetch ?? fetch;
		this.#now = options.now ?? Date.now;
	}

	async #load(server: string): Promise<Saved | null> {
		const raw = await this.#keys.get(server);
		if (!raw) return null;
		try {
			return JSON.parse(raw) as Saved;
		} catch {
			return null;
		}
	}

	async #save(server: string, saved: Saved): Promise<void> {
		await this.#keys.set(server, JSON.stringify(saved));
	}

	/** Whether Yew holds a sign-in for this server at this address. */
	async signedIn(server: string, resource: string): Promise<boolean> {
		const saved = await this.#load(server);
		return Boolean(saved?.tokens && saved.resource === resource);
	}

	/** A current access token for the server, refreshed shortly before it runs out; null without one. */
	async bearer(server: string, resource: string): Promise<string | null> {
		const saved = await this.#load(server);
		if (!saved?.tokens || saved.resource !== resource) return null;
		const { tokens } = saved;
		if (!tokens.expiresAt || tokens.expiresAt - 60_000 > this.#now()) return tokens.access;
		if (!tokens.refresh) return null;
		let running = this.#refreshing.get(server);
		if (!running) {
			running = this.#refresh(server, saved, tokens.refresh).finally(() =>
				this.#refreshing.delete(server),
			);
			this.#refreshing.set(server, running);
		}
		return running;
	}

	async #refresh(server: string, saved: Saved, refresh: string): Promise<string | null> {
		const body = new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refresh,
			client_id: saved.client.id,
			resource: saved.resource,
		});
		if (saved.client.secret) body.set("client_secret", saved.client.secret);
		const answer = await this.#post(saved.endpoints.token, body);
		if (!answer || typeof answer.access_token !== "string") {
			// The sign-in no longer works: the person signs in again.
			const { tokens: _gone, ...rest } = saved;
			await this.#save(server, rest);
			return null;
		}
		const tokens = tokensFrom(answer, this.#now(), refresh);
		await this.#save(server, { ...saved, tokens });
		return tokens.access;
	}

	/** The site the person's browser goes to to sign in to a server, for the settings to name. */
	async where(resource: string, challenge: string | null = null): Promise<string> {
		const found = await this.#discovered(resource, challenge);
		return new URL(found.endpoints.authorization).host;
	}

	/**
	 * Starts signing in to a server and returns the address the person's browser opens. `challenge` is
	 * the server's WWW-Authenticate header from its refusal, when there was one.
	 */
	async begin(
		server: string,
		resource: string,
		settings: OAuthSettings = {},
		challenge: string | null = null,
	): Promise<string> {
		const found = await this.#discovered(resource, challenge);
		const saved = await this.#load(server);
		let client: Saved["client"];
		if (settings.clientId) {
			client = {
				id: settings.clientId,
				...(settings.clientSecret ? { secret: settings.clientSecret } : {}),
				redirectUri: this.#redirect,
				registered: false,
			};
		} else if (
			saved?.client.registered &&
			saved.resource === resource &&
			saved.client.redirectUri === this.#redirect &&
			same(saved.endpoints.issuer, found.endpoints.issuer)
		) {
			client = saved.client;
		} else {
			client = await this.#register(found.endpoints);
		}
		const verifier = b64url(randomBytes(32));
		const state = b64url(randomBytes(24));
		const url = new URL(found.endpoints.authorization);
		const scopes = settings.scopes?.length ? settings.scopes.join(" ") : found.scope;
		const params: Record<string, string> = {
			response_type: "code",
			client_id: client.id,
			redirect_uri: client.redirectUri,
			code_challenge: b64url(createHash("sha256").update(verifier).digest()),
			code_challenge_method: "S256",
			state,
			resource,
			...(scopes ? { scope: scopes } : {}),
		};
		// Google gives a refresh token only when asked for offline access with consent.
		if (new URL(found.endpoints.issuer).host === "accounts.google.com") {
			params.access_type = "offline";
			params.prompt = "consent";
		}
		for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
		const now = this.#now();
		for (const [key, pending] of this.#pending) {
			if (now - pending.createdAt > PENDING_MS) this.#pending.delete(key);
		}
		this.#pending.set(state, {
			server,
			verifier,
			saved: {
				resource,
				endpoints: found.endpoints,
				client,
				...(saved?.tokens && saved.resource === resource ? { tokens: saved.tokens } : {}),
			},
			createdAt: now,
		});
		return url.toString();
	}

	/**
	 * The browser came back with a code: trade it for tokens. `iss` is the sign-in server's name in the
	 * return, when it gave one. Resolves with the server's name.
	 */
	async complete(
		state: string,
		code: string | null,
		error: string | null,
		iss: string | null = null,
	): Promise<string> {
		const pending = this.#pending.get(state);
		this.#pending.delete(state);
		if (!pending || this.#now() - pending.createdAt > PENDING_MS) {
			throw new Error("This sign-in is not valid any more. Start it again from Yew Harness.");
		}
		const { saved } = pending;
		// RFC 9207: a return that names a sign-in server, or that should and does not, comes from the
		// one the browser was sent to, or it is not used.
		if (iss !== null ? !same(iss, saved.endpoints.issuer) : saved.endpoints.namesItself) {
			throw new Error(
				"The sign-in came back from another server than the one Yew Harness sent you to.",
			);
		}
		if (error || !code) throw new Error(`The sign-in was not completed (${error ?? "no code"}).`);
		const body = new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: saved.client.redirectUri,
			client_id: saved.client.id,
			code_verifier: pending.verifier,
			resource: saved.resource,
		});
		if (saved.client.secret) body.set("client_secret", saved.client.secret);
		const answer = await this.#post(saved.endpoints.token, body);
		if (!answer || typeof answer.access_token !== "string") {
			throw new Error("The server did not give Yew Harness a token.");
		}
		await this.#save(pending.server, { ...saved, tokens: tokensFrom(answer, this.#now()) });
		return pending.server;
	}

	/**
	 * Signs out: asks the server to void the tokens where it says how (RFC 7009), then forgets them and
	 * the registered client. Whether the server voids them or not, Yew keeps nothing.
	 */
	async forget(server: string): Promise<void> {
		const saved = await this.#load(server);
		const revocation = saved?.endpoints.revocation;
		if (saved?.tokens && revocation) {
			const tokens: [string | undefined, string][] = [
				[saved.tokens.refresh, "refresh_token"],
				[saved.tokens.access, "access_token"],
			];
			for (const [token, hint] of tokens) {
				if (!token) continue;
				const body = new URLSearchParams({
					token,
					token_type_hint: hint,
					client_id: saved.client.id,
				});
				if (saved.client.secret) body.set("client_secret", saved.client.secret);
				await this.#post(revocation, body, REVOKE_MS);
			}
		}
		await this.#keys.delete(server);
	}

	/** A GET for details; it may follow a redirect, but only to an address Yew would use. */
	async #json(url: string, local: boolean): Promise<Record<string, unknown> | null> {
		try {
			const response = await this.#fetch(url, {
				headers: { Accept: "application/json", "User-Agent": `yew/${this.#version}` },
				signal: AbortSignal.timeout(REQUEST_MS),
			});
			if (!response.ok || !usable(response.url || url, local)) return null;
			return (await response.json()) as Record<string, unknown>;
		} catch {
			return null;
		}
	}

	/**
	 * A POST that carries a code, a verifier, a secret or a token. A redirect is not followed: fetch
	 * would send the whole body on to the new address, whichever site that is.
	 */
	async #post(
		url: string,
		body: URLSearchParams | string,
		ms = REQUEST_MS,
	): Promise<Record<string, unknown> | null> {
		try {
			const response = await this.#fetch(url, {
				method: "POST",
				redirect: "error",
				headers: {
					"Content-Type":
						typeof body === "string" ? "application/json" : "application/x-www-form-urlencoded",
					Accept: "application/json",
					"User-Agent": `yew/${this.#version}`,
				},
				body,
				signal: AbortSignal.timeout(ms),
			});
			if (!response.ok) return null;
			return (await response.json()) as Record<string, unknown>;
		} catch {
			return null;
		}
	}

	/**
	 * Where to sign in, found out once and used again for a while: the site the settings name is the
	 * one the browser then goes to.
	 */
	#discovered(resource: string, challenge: string | null): Promise<Discovered> {
		const key = `${resource}\n${challenge ?? ""}`;
		const now = this.#now();
		const kept = this.#found.get(key);
		if (kept && now - kept.at < FOUND_MS) return kept.value;
		const value = this.#discover(resource, challenge);
		this.#found.set(key, { at: now, value });
		value.catch(() => {
			if (this.#found.get(key)?.value === value) this.#found.delete(key);
		});
		return value;
	}

	/** Where to sign in for a server, from its protected-resource metadata and its issuer's metadata. */
	async #discover(resource: string, challenge: string | null): Promise<Discovered> {
		const at = new URL(resource);
		const local = at.protocol === "http:" && LOOPBACK.has(at.hostname);
		if (!usable(resource, local)) {
			throw new Error("Yew Harness signs in only to servers at https addresses.");
		}
		const named = param(challenge, "resource_metadata");
		if (named !== null && !usable(named, local)) {
			throw new Error(`The server pointed to an address that is not https (${named}).`);
		}
		const path = at.pathname === "/" ? "" : at.pathname;
		const metadataUrls = [
			named,
			`${at.origin}/.well-known/oauth-protected-resource${path}`,
			`${at.origin}/.well-known/oauth-protected-resource`,
		].filter((url): url is string => Boolean(url));
		let metadata: Record<string, unknown> | null = null;
		for (const url of metadataUrls) {
			metadata = await this.#json(url, local);
			if (metadata) break;
		}
		// RFC 9728, 3.3: details about another address are not used.
		if (metadata && !(typeof metadata.resource === "string" && same(metadata.resource, resource))) {
			throw new Error(
				`The server's sign-in details are for another address (${String(metadata.resource)}).`,
			);
		}
		const servers = metadata?.authorization_servers;
		const issuer =
			Array.isArray(servers) && typeof servers[0] === "string" ? servers[0] : at.origin;
		if (!usable(issuer, local)) {
			throw new Error(
				`The server named a sign-in server that is not at an https address (${issuer}).`,
			);
		}
		const base = new URL(issuer);
		const issuerPath = base.pathname === "/" ? "" : base.pathname.replace(/\/$/, "");
		const candidates = [
			`${base.origin}/.well-known/oauth-authorization-server${issuerPath}`,
			`${base.origin}/.well-known/openid-configuration${issuerPath}`,
			`${base.origin}${issuerPath}/.well-known/openid-configuration`,
		];
		let problem = "The server did not say where to sign in.";
		for (const url of candidates) {
			const found = await this.#json(url, local);
			if (
				!found ||
				typeof found.authorization_endpoint !== "string" ||
				typeof found.token_endpoint !== "string"
			) {
				continue;
			}
			// RFC 8414, 3.3: the details are those of the sign-in server Yew asked about.
			if (typeof found.issuer !== "string" || !same(found.issuer, issuer)) {
				problem = `The sign-in server's details are for another server (${String(found.issuer)}).`;
				continue;
			}
			// The MCP authorization spec: no sign-in without PKCE with S256.
			const methods = found.code_challenge_methods_supported;
			if (!Array.isArray(methods) || !methods.includes("S256")) {
				problem =
					"The sign-in server does not say it supports PKCE with S256, which signing in needs.";
				continue;
			}
			const addresses = [
				found.authorization_endpoint,
				found.token_endpoint,
				found.registration_endpoint,
				found.revocation_endpoint,
			].filter((value): value is string => typeof value === "string");
			const unusable = addresses.find((address) => !usable(address, local));
			if (unusable !== undefined) {
				problem = `The sign-in server named an address that is not https (${unusable}).`;
				continue;
			}
			return {
				endpoints: {
					issuer: found.issuer,
					authorization: found.authorization_endpoint,
					token: found.token_endpoint,
					...(typeof found.registration_endpoint === "string"
						? { registration: found.registration_endpoint }
						: {}),
					...(typeof found.revocation_endpoint === "string"
						? { revocation: found.revocation_endpoint }
						: {}),
					...(found.authorization_response_iss_parameter_supported === true
						? { namesItself: true }
						: {}),
				},
				scope: param(challenge, "scope"),
			};
		}
		throw new Error(problem);
	}

	/** Registers Yew as a public client of the authorization server (RFC 7591). */
	async #register(endpoints: Endpoints): Promise<Saved["client"]> {
		if (!endpoints.registration) {
			throw new Error(
				"This server only accepts clients registered in advance. Add its client ID and secret to its entry in mcp.json.",
			);
		}
		const answer = await this.#post(
			endpoints.registration,
			JSON.stringify({
				client_name: "Yew Harness",
				redirect_uris: [this.#redirect],
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
				software_version: this.#version,
			}),
		);
		if (!answer || typeof answer.client_id !== "string") {
			throw new Error("The server did not let Yew Harness register to sign in.");
		}
		return {
			id: answer.client_id,
			...(typeof answer.client_secret === "string" ? { secret: answer.client_secret } : {}),
			redirectUri: this.#redirect,
			registered: true,
		};
	}
}
