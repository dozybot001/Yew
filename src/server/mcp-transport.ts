import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "../shared/messages.ts";
import type { McpServerConfig } from "./mcp.ts";
import { PRESET_SITES, serverEnv } from "./mcp-builtin.ts";
import { SignInRequired } from "./mcp-oauth.ts";
import { quote, sandboxed } from "./sandbox.ts";

export const PROTOCOL = "2025-06-18";
const REQUEST_MS = 60_000;
const MAX_LINE = 8 * 1024 * 1024;

export interface Transport {
	request(method: string, params: JsonObject, signal?: AbortSignal): Promise<unknown>;
	notify(method: string, params: JsonObject): void;
	close(): void;
}

class RpcError extends Error {}

/** A server as a child process: one JSON message per line on its standard streams. */
export class StdioTransport implements Transport {
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
	#next = 1;
	#buffer = "";
	#closed: Error | null = null;

	/**
	 * Starts a server. Yew Harness's own two run as they are: the browser's Chrome brings its own
	 * sandbox, which cannot start inside another, and computer control needs the screen. Every other
	 * server runs in the system sandbox when it is on (sandbox.ts), like a session's commands: it
	 * writes only temporary files and caches, reaches the sites it is allowed, and a preset may read
	 * its own code in the data folder.
	 */
	static async start(
		config: McpServerConfig,
		env: NodeJS.ProcessEnv,
		yewHome: string,
		name: string,
	): Promise<StdioTransport> {
		const variables = { ...(config.ownEnv ? serverEnv(env) : env), ...config.env };
		// The extension's token skips the page in Chrome where the person approves each connection.
		if (name === "browser") delete variables.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
		if (config.cwd) mkdirSync(config.cwd, { recursive: true });
		const own = config.ownEnv === true && config.preset === undefined;
		const line = [config.command as string, ...(config.args ?? [])].map(quote).join(" ");
		const box = own
			? null
			: await sandboxed(`exec ${line}`, {
					grant: {
						readable: config.preset ? [join(yewHome, "mcp-presets", config.preset)] : [],
						sites: [
							...(config.preset ? (PRESET_SITES[config.preset] ?? []) : []),
							...(config.allowedDomains ?? []),
						],
					},
					text: line,
					label: { kind: "mcp", text: name },
				});
		if (box) {
			for (const variable of box.unset) delete variables[variable];
			Object.assign(variables, box.env);
		}
		const options = {
			...(config.cwd ? { cwd: config.cwd } : {}),
			env: variables,
			stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
		};
		const child = box
			? spawn(box.line, { ...options, shell: true })
			: spawn(config.command as string, config.args ?? [], options);
		if (box) child.once("exit", () => box.finish());
		return new StdioTransport(child);
	}

	constructor(child: ChildProcessWithoutNullStreams) {
		this.#child = child;
		this.#child.stdout.setEncoding("utf8");
		this.#child.stdout.on("data", (chunk: string) => this.#read(chunk));
		// What a server prints as diagnostics is not kept: it may hold what the server was given.
		this.#child.stderr.resume();
		this.#child.stdin.on("error", () => {});
		this.#child.on("error", (error) => this.#fail(new Error(`could not start: ${error.message}`)));
		this.#child.on("exit", (code) =>
			this.#fail(new Error(`the server exited (code ${code ?? "none"})`)),
		);
	}

	#read(chunk: string): void {
		this.#buffer += chunk;
		if (this.#buffer.length > MAX_LINE) {
			this.#fail(new Error("the server sent a line that is too long"));
			this.close();
			return;
		}
		for (let end = this.#buffer.indexOf("\n"); end >= 0; end = this.#buffer.indexOf("\n")) {
			const line = this.#buffer.slice(0, end).trim();
			this.#buffer = this.#buffer.slice(end + 1);
			if (!line) continue;
			let message: { id?: unknown; result?: unknown; error?: { message?: unknown } };
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			const waiting = typeof message.id === "number" ? this.#pending.get(message.id) : undefined;
			if (!waiting) continue;
			this.#pending.delete(message.id as number);
			if (message.error) waiting.reject(new RpcError(String(message.error.message ?? "error")));
			else waiting.resolve(message.result);
		}
	}

	#fail(error: Error): void {
		this.#closed ??= error;
		for (const waiting of this.#pending.values()) waiting.reject(error);
		this.#pending.clear();
	}

	request(method: string, params: JsonObject, signal?: AbortSignal): Promise<unknown> {
		if (this.#closed) return Promise.reject(this.#closed);
		const id = this.#next++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error("the server did not answer in time"));
			}, REQUEST_MS);
			const done = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", stop);
			};
			const stop = () => {
				this.#pending.delete(id);
				done();
				this.notify("notifications/cancelled", { requestId: id });
				reject(new Error("stopped"));
			};
			signal?.addEventListener("abort", stop);
			this.#pending.set(id, {
				resolve: (value) => {
					done();
					resolve(value);
				},
				reject: (error) => {
					done();
					reject(error);
				},
			});
			this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	}

	notify(method: string, params: JsonObject): void {
		if (!this.#closed)
			this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	}

	close(): void {
		this.#fail(new Error("closed"));
		this.#child.kill();
	}
}

/** A server over HTTP (Streamable HTTP): each request is a POST answered with JSON or an event stream. */
export class HttpTransport implements Transport {
	readonly #config: McpServerConfig;
	readonly #fetch: typeof fetch;
	readonly #version: string;
	#session: string | null = null;
	#next = 1;

	readonly #bearer: (() => Promise<string | null>) | null;

	constructor(
		config: McpServerConfig,
		version: string,
		fetcher: typeof fetch,
		bearer: (() => Promise<string | null>) | null = null,
	) {
		this.#config = config;
		this.#version = version;
		this.#fetch = fetcher;
		this.#bearer = bearer;
	}

	async #post(body: JsonObject, signal?: AbortSignal): Promise<Response> {
		const configured = Object.keys(this.#config.headers ?? {}).some(
			(name) => name.toLowerCase() === "authorization",
		);
		const token = configured || !this.#bearer ? null : await this.#bearer();
		const response = await this.#fetch(this.#config.url as string, {
			method: "POST",
			headers: {
				...this.#config.headers,
				...(token ? { Authorization: `Bearer ${token}` } : {}),
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				"User-Agent": `yew/${this.#version}`,
				"MCP-Protocol-Version": PROTOCOL,
				...(this.#session ? { "Mcp-Session-Id": this.#session } : {}),
			},
			body: JSON.stringify(body),
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)])
				: AbortSignal.timeout(REQUEST_MS),
		});
		this.#session = response.headers.get("Mcp-Session-Id") ?? this.#session;
		return response;
	}

	async request(method: string, params: JsonObject, signal?: AbortSignal): Promise<unknown> {
		const id = this.#next++;
		const response = await this.#post({ jsonrpc: "2.0", id, method, params }, signal);
		const challenge = response.headers.get("WWW-Authenticate");
		if (
			response.status === 401 ||
			(response.status === 403 && challenge?.includes("insufficient_scope"))
		) {
			// Wants a signed-in request: the person signs in from the settings.
			throw new SignInRequired(challenge);
		}
		if (!response.ok) throw new Error(`the server answered HTTP ${response.status}`);
		const type = response.headers.get("Content-Type") ?? "";
		const messages: { id?: unknown; result?: unknown; error?: { message?: unknown } }[] = [];
		if (type.includes("text/event-stream")) {
			for (const block of (await response.text()).split(/\r?\n\r?\n/)) {
				const data = block
					.split(/\r?\n/)
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trim())
					.join("\n");
				if (!data) continue;
				try {
					messages.push(JSON.parse(data));
				} catch {
					// Not a message: a comment or a keep-alive.
				}
			}
		} else {
			messages.push((await response.json()) as (typeof messages)[number]);
		}
		const answer = messages.find((message) => message.id === id);
		if (!answer) throw new Error("the server sent no answer");
		if (answer.error) throw new RpcError(String(answer.error.message ?? "error"));
		return answer.result;
	}

	notify(method: string, params: JsonObject): void {
		void this.#post({ jsonrpc: "2.0", method, params }).catch(() => {});
	}

	close(): void {
		if (!this.#session) return;
		void this.#fetch(this.#config.url as string, {
			method: "DELETE",
			headers: { ...this.#config.headers, "Mcp-Session-Id": this.#session },
		}).catch(() => {});
	}
}
