import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { type ClientHttp2Session, connect } from "node:http2";
import type { PushJob, PushResult } from "../src/remote/push.ts";

/**
 * Hands notifications to Apple's push service (APNs) with a provider token. The relay holds the
 * signing key; what a notification says arrives already encrypted for the phone, so neither the
 * relay nor Apple can read it. The visible text Apple gets is a fixed fallback line.
 */

export interface ApnsConfig {
	/** The .p8 signing key, as PEM. */
	key: string;
	keyId: string;
	teamId: string;
	/** The app's bundle id. */
	topic: string;
}

/** Reads the configuration from the environment; null when push is not set up on this relay. */
export function apnsConfigFromEnv(env: Record<string, string | undefined>): ApnsConfig | null {
	const { APNS_KEY_FILE, APNS_KEY_ID, APNS_TEAM_ID } = env;
	if (!APNS_KEY_FILE || !APNS_KEY_ID || !APNS_TEAM_ID) return null;
	return {
		key: readFileSync(APNS_KEY_FILE, "utf8"),
		keyId: APNS_KEY_ID,
		teamId: APNS_TEAM_ID,
		topic: env.APNS_TOPIC ?? "cn.tenonai.apps.yew",
	};
}

const HOSTS = {
	production: "https://api.push.apple.com",
	sandbox: "https://api.sandbox.push.apple.com",
} as const;
type Environment = keyof typeof HOSTS;

/** Apple accepts a provider token for up to an hour and refuses ones renewed too often. */
const TOKEN_MS = 45 * 60 * 1000;
const REQUEST_MS = 10_000;
/** How long an undelivered notification is kept for a phone that is off or out of reach. */
const KEEP_SECONDS = 24 * 60 * 60;

const base64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");

/** One request to Apple; tests replace it. */
export type ApnsRequest = (
	host: string,
	headers: Record<string, string>,
	body: string,
) => Promise<{ status: number; body: string }>;

export class Apns {
	readonly #config: ApnsConfig;
	readonly #key: KeyObject;
	readonly #request: ApnsRequest;
	readonly #now: () => number;
	#jwt: { value: string; at: number } | null = null;
	readonly #sessions = new Map<string, ClientHttp2Session>();

	constructor(config: ApnsConfig, options: { request?: ApnsRequest; now?: () => number } = {}) {
		this.#config = config;
		this.#key = createPrivateKey(config.key);
		this.#request = options.request ?? ((host, headers, body) => this.#post(host, headers, body));
		this.#now = options.now ?? Date.now;
	}

	#token(): string {
		const now = this.#now();
		if (this.#jwt && now - this.#jwt.at < TOKEN_MS) return this.#jwt.value;
		const head = base64url(JSON.stringify({ alg: "ES256", kid: this.#config.keyId }));
		const claims = base64url(
			JSON.stringify({ iss: this.#config.teamId, iat: Math.floor(now / 1000) }),
		);
		const signature = sign("sha256", Buffer.from(`${head}.${claims}`), {
			key: this.#key,
			dsaEncoding: "ieee-p1363",
		});
		this.#jwt = { value: `${head}.${claims}.${base64url(signature)}`, at: now };
		return this.#jwt.value;
	}

	async send(job: PushJob): Promise<PushResult> {
		const split = job.token.indexOf(":");
		const environment = job.token.slice(0, split) as Environment;
		const device = job.token.slice(split + 1);
		const alert = job.mode === "alert";
		const body = JSON.stringify({
			aps: alert
				? // Shown only if the phone cannot decrypt the notification: a fixed line in its language.
					{ alert: { "loc-key": "push.fallback" }, "mutable-content": 1, sound: "default" }
				: { "content-available": 1 },
			e: job.data,
		});
		const headers: Record<string, string> = {
			":method": "POST",
			":path": `/3/device/${device}`,
			authorization: `bearer ${this.#token()}`,
			"apns-topic": this.#config.topic,
			"apns-push-type": alert ? "alert" : "background",
			"apns-priority": alert ? "10" : "5",
			"apns-expiration": String(Math.floor(this.#now() / 1000) + KEEP_SECONDS),
			...(job.id ? { "apns-collapse-id": job.id } : {}),
		};
		try {
			const response = await this.#request(HOSTS[environment], headers, body);
			if (response.status === 200) return { token: job.token, ok: true, gone: false };
			let reason = "";
			try {
				reason = String((JSON.parse(response.body) as { reason?: unknown }).reason ?? "");
			} catch {
				reason = "";
			}
			// A stale provider token is renewed for the next notification.
			if (response.status === 403) this.#jwt = null;
			const gone =
				response.status === 410 ||
				reason === "BadDeviceToken" ||
				reason === "DeviceTokenNotForTopic";
			return { token: job.token, ok: false, gone, reason: reason || String(response.status) };
		} catch (error) {
			return { token: job.token, ok: false, gone: false, reason: (error as Error).message };
		}
	}

	close(): void {
		for (const session of this.#sessions.values()) session.close();
		this.#sessions.clear();
	}

	/** One HTTP/2 connection per Apple host, reused, reopened after it closes. */
	#session(host: string): ClientHttp2Session {
		const open = this.#sessions.get(host);
		if (open && !open.closed && !open.destroyed) return open;
		const session = connect(host);
		const forget = () => {
			if (this.#sessions.get(host) === session) this.#sessions.delete(host);
		};
		session.on("error", forget);
		session.on("close", forget);
		session.on("goaway", forget);
		this.#sessions.set(host, session);
		return session;
	}

	#post(
		host: string,
		headers: Record<string, string>,
		body: string,
	): Promise<{ status: number; body: string }> {
		return new Promise((resolve, reject) => {
			const stream = this.#session(host).request(headers);
			let status = 0;
			let text = "";
			stream.setEncoding("utf8");
			stream.setTimeout(REQUEST_MS, () => stream.close());
			stream.on("response", (head) => {
				status = Number(head[":status"] ?? 0);
			});
			stream.on("data", (chunk: string) => {
				text += chunk;
			});
			stream.on("end", () => resolve({ status, body: text }));
			stream.on("error", reject);
			stream.on("close", () => {
				if (status === 0) reject(new Error("Apple's push service did not answer."));
			});
			stream.end(body);
		});
	}
}
