import { deflateRawSync } from "node:zlib";
import type { Store } from "../server/store.ts";
import type { Device } from "../shared/types.ts";
import { consumePairing, type Identity, signChallenge } from "./identity.ts";
import { Opener, Responder, type Session, seal } from "./noise.ts";
import {
	type ChannelMessage,
	COMPRESS_FROM,
	type Hello,
	prologueFor,
	type Welcome,
} from "./protocol.ts";
import type { PushJob, PushResult } from "./push.ts";

/**
 * The Mac's side of remote access: keeps a connection to the relay, answers each phone's Noise
 * handshake, and runs its requests against the local API as that device. Only paired phones get
 * through; a phone that is not paired yet must bring the one-time pairing secret.
 */

export interface ConnectorOptions {
	store: Store;
	identity: Identity;
	relayUrl: string;
	desktopName: string;
	version: string;
	/** Runs a phone's request against the local API, as that device. */
	handle(request: Request, device: Device): Promise<Response>;
	log?: (line: string) => void;
	/** The WebSocket class; tests pass `ws`. */
	WebSocketImpl?: typeof WebSocket;
	/** Longest wait between reconnects. */
	maxRetryMs?: number;
	/** How long a phone has to finish the handshake. */
	handshakeMs?: number;
	/** The relay's answer to a notification it was asked to send. */
	onPushResult?: (result: PushResult) => void;
}

const FIRST_RETRY_MS = 1000;

export class Connector {
	readonly #options: ConnectorOptions;
	readonly #log: (line: string) => void;
	readonly #channels = new Map<number, Channel>();
	#socket: WebSocket | null = null;
	#stopped = true;
	#retryMs = FIRST_RETRY_MS;
	#timer: NodeJS.Timeout | null = null;
	connected = false;

	constructor(options: ConnectorOptions) {
		this.#options = options;
		this.#log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
	}

	get relayUrl(): string {
		return this.#options.relayUrl;
	}

	start(): void {
		if (!this.#stopped) return;
		this.#stopped = false;
		this.#connect();
	}

	stop(): void {
		this.#stopped = true;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
		this.#socket?.close(1000);
		this.#socket = null;
		this.#dropChannels();
		this.connected = false;
	}

	/** Closes the channels of a device that was just revoked. */
	disconnect(deviceId: string): void {
		for (const [number, channel] of this.#channels) {
			if (channel.device?.id === deviceId) this.closeChannel(number);
		}
	}

	#connect(): void {
		const Impl = this.#options.WebSocketImpl ?? WebSocket;
		const socket = new Impl(`${this.#options.relayUrl.replace(/\/$/, "")}/desktop`);
		socket.binaryType = "arraybuffer";
		this.#socket = socket;
		socket.onmessage = (event) => {
			if (typeof event.data === "string") this.#control(event.data);
			else this.#frame(Buffer.from(event.data as ArrayBuffer));
		};
		socket.onclose = () => {
			if (this.#socket !== socket) return;
			this.#socket = null;
			this.connected = false;
			this.#dropChannels();
			if (this.#stopped) return;
			// Back off up to the limit; a relay that is down is not asked again every second.
			this.#timer = setTimeout(() => this.#connect(), this.#retryMs);
			this.#retryMs = Math.min(this.#retryMs * 2, this.#options.maxRetryMs ?? 30_000);
		};
		socket.onerror = () => {};
	}

	#control(text: string): void {
		let message: { type?: string; nonce?: string; channel?: number } & Partial<PushResult>;
		try {
			message = JSON.parse(text);
		} catch {
			return;
		}
		if (message.type === "challenge" && typeof message.nonce === "string") {
			const { identity } = this.#options;
			this.#socket?.send(
				JSON.stringify({
					type: "hello",
					key: identity.signingPublic.toString("base64url"),
					sig: signChallenge(identity, message.nonce),
				}),
			);
		} else if (message.type === "ready") {
			this.connected = true;
			this.#retryMs = FIRST_RETRY_MS;
			this.#log("remote access: connected to the relay");
		} else if (message.type === "open" && typeof message.channel === "number") {
			this.#channels.set(message.channel, new Channel(this, message.channel, this.#options));
		} else if (message.type === "close" && typeof message.channel === "number") {
			this.#channels.get(message.channel)?.end();
			this.#channels.delete(message.channel);
		} else if (message.type === "pushResult" && typeof message.token === "string") {
			this.#options.onPushResult?.({
				token: message.token,
				ok: message.ok === true,
				gone: message.gone === true,
				...(typeof message.reason === "string" ? { reason: message.reason } : {}),
			});
		}
	}

	/** Asks the relay to notify a phone; false when the relay is not connected. */
	push(job: PushJob): boolean {
		if (!this.connected || !this.#socket) return false;
		this.#socket.send(JSON.stringify({ type: "push", ...job }));
		return true;
	}

	#frame(frame: Buffer): void {
		if (frame.length < 4) return;
		const channel = this.#channels.get(frame.readUInt32BE(0));
		channel?.receive(frame.subarray(4)).catch((error: Error) => {
			this.#log(`remote access: ${error.message}`);
			this.closeChannel(frame.readUInt32BE(0));
		});
	}

	send(channel: number, payload: Buffer): void {
		const header = Buffer.alloc(4);
		header.writeUInt32BE(channel, 0);
		this.#socket?.send(Buffer.concat([header, payload]));
	}

	closeChannel(channel: number): void {
		this.#channels.get(channel)?.end();
		this.#channels.delete(channel);
		this.#socket?.send(JSON.stringify({ type: "close", channel }));
	}

	#dropChannels(): void {
		for (const channel of this.#channels.values()) channel.end();
		this.#channels.clear();
	}
}

/** One phone's connection: the handshake, then its requests. */
class Channel {
	readonly #connector: Connector;
	readonly #number: number;
	readonly #options: ConnectorOptions;
	#responder: Responder;
	#session: Session | null = null;
	#opener: Opener | null = null;
	#requests = new Map<number, AbortController>();
	#ended = false;
	readonly #handshakeTimer: NodeJS.Timeout;
	device: Device | null = null;

	constructor(connector: Connector, number: number, options: ConnectorOptions) {
		this.#connector = connector;
		this.#number = number;
		this.#options = options;
		this.#responder = new Responder({
			static: options.identity.noise,
			prologue: prologueFor(options.identity.desktopId),
		});
		// A connection that does not finish the handshake soon is closed, so someone who only knows
		// this Mac's id cannot hold the places of its phones.
		this.#handshakeTimer = setTimeout(() => {
			if (!this.#session && !this.#ended) connector.closeChannel(number);
		}, options.handshakeMs ?? 10_000);
		this.#handshakeTimer.unref();
	}

	async receive(payload: Buffer): Promise<void> {
		if (this.#ended) return;
		if (!this.#session) {
			this.#handshake(payload);
			return;
		}
		const message = this.#opener?.open(payload);
		if (message) await this.#message(JSON.parse(message.toString("utf8")) as ChannelMessage);
	}

	#handshake(first: Buffer): void {
		const { store } = this.#options;
		const hello = JSON.parse(this.#responder.readFirst(first).toString("utf8")) as Hello;
		const key = this.#responder.remoteStatic?.toString("base64url") ?? "";
		let device = store.deviceByKey(key);
		if (!device) {
			// Not paired: only the secret from the QR code, used once, lets it in.
			if (typeof hello.pair !== "string" || !consumePairing(store, hello.pair)) {
				throw new Error("a phone that is not paired tried to connect");
			}
			const name =
				typeof hello.name === "string" && hello.name.trim() ? hello.name.trim() : "Phone";
			device = store.addDevice(name.slice(0, 60), key);
		}
		store.touchDevice(device.id);
		this.device = device;
		const welcome: Welcome = {
			desktop: this.#options.desktopName,
			version: this.#options.version,
			device: device.id,
		};
		const { message, session } = this.#responder.writeSecond(Buffer.from(JSON.stringify(welcome)));
		this.#session = session;
		this.#opener = new Opener(session.receive);
		this.#connector.send(this.#number, message);
	}

	async #message(message: ChannelMessage): Promise<void> {
		if (message.t === "cancel") {
			this.#requests.get(message.id)?.abort();
			return;
		}
		if (message.t !== "req") return;
		const device = this.device;
		// A device revoked since it connected gets nothing more.
		if (!device || !this.#options.store.deviceByKey(device.publicKey)) {
			this.#connector.closeChannel(this.#number);
			return;
		}
		if (!message.path.startsWith("/api/")) {
			this.#send({ t: "res", id: message.id, status: 404, type: "text/plain", body: "" });
			return;
		}
		const controller = new AbortController();
		this.#requests.set(message.id, controller);
		try {
			const request = new Request(`http://yew.internal${message.path}`, {
				method: message.method,
				headers: { "Content-Type": "application/json" },
				...(message.body !== undefined && message.method !== "GET" ? { body: message.body } : {}),
				signal: controller.signal,
			});
			const response = await this.#options.handle(request, device);
			const type = response.headers.get("Content-Type") ?? "";
			if (!type.startsWith("text/event-stream") || !response.body) {
				const body = await response.text();
				const packed = message.z === 1 && body.length >= COMPRESS_FROM;
				this.#send({
					t: "res",
					id: message.id,
					status: response.status,
					type,
					body: packed ? deflateRawSync(body).toString("base64") : body,
					...(packed ? { z: 1 as const } : {}),
				});
				return;
			}
			this.#send({ t: "head", id: message.id, status: response.status, type });
			const reader = response.body.getReader();
			controller.signal.addEventListener("abort", () => void reader.cancel());
			const decoder = new TextDecoder();
			while (!this.#ended) {
				const { done, value } = await reader.read();
				if (done) break;
				this.#send({ t: "chunk", id: message.id, data: decoder.decode(value, { stream: true }) });
			}
			this.#send({ t: "end", id: message.id });
		} catch (error) {
			if (!controller.signal.aborted) throw error;
		} finally {
			this.#requests.delete(message.id);
		}
	}

	#send(message: ChannelMessage): void {
		if (!this.#session || this.#ended) return;
		for (const part of seal(this.#session.send, Buffer.from(JSON.stringify(message)))) {
			this.#connector.send(this.#number, part);
		}
	}

	end(): void {
		this.#ended = true;
		clearTimeout(this.#handshakeTimer);
		for (const controller of this.#requests.values()) controller.abort();
		this.#requests.clear();
	}
}
