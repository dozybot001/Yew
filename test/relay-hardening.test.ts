import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";
import { describe, test } from "node:test";
import WebSocket from "ws";
import { Relay, type RelayOptions } from "../relay/relay.ts";
import { Connector } from "../src/remote/connector.ts";
import { loadIdentity, signChallenge } from "../src/remote/identity.ts";
import { MemoryKeyStore } from "../src/server/keys.ts";
import { newStore } from "./helpers/store.ts";

// Problems found in the relay and fixed: requests that took the process down, forwarding without
// back-pressure, and places that could be held without proving anything.

async function until(check: () => boolean, ms = 5000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > ms) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function start(options: Partial<RelayOptions> = {}) {
	const relay = new Relay({ port: 0, host: "127.0.0.1", log: () => {}, ...options });
	const port = await relay.listen();
	const healthy = async () => (await fetch(`http://127.0.0.1:${port}/health`)).status === 200;
	return { relay, port, url: `ws://127.0.0.1:${port}`, healthy };
}

/** A WebSocket upgrade written by hand, for paths and frames a well-behaved client never sends. */
function rawUpgrade(port: number, path: string): Promise<{ socket: Socket; head: string }> {
	return new Promise((resolve, reject) => {
		const socket = connect(port, "127.0.0.1", () => {
			socket.write(
				`GET ${path} HTTP/1.1\r\nHost: relay\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
			);
		});
		socket.once("data", (data) => resolve({ socket, head: data.toString("latin1") }));
		socket.once("error", reject);
		socket.once("close", () => resolve({ socket, head: "" }));
	});
}

/** One masked frame, as a client must send it. */
function clientFrame(opcode: number, payload: Buffer): Buffer {
	const mask = randomBytes(4);
	const masked = Buffer.from(payload.map((byte, i) => byte ^ (mask[i % 4] as number)));
	return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, masked]);
}

const closed = (socket: WebSocket) =>
	new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));

/** A Mac that proves who it is to the relay, without Yew behind it. */
async function fakeDesktop(url: string) {
	const identity = await loadIdentity(new MemoryKeyStore());
	const socket = new WebSocket(`${url}/desktop`);
	const channels: number[] = [];
	await new Promise<void>((resolve, reject) => {
		socket.on("error", reject);
		socket.on("message", (data, binary) => {
			if (binary) return;
			const message = JSON.parse(data.toString());
			if (message.type === "challenge") {
				socket.send(
					JSON.stringify({
						type: "hello",
						key: identity.signingPublic.toString("base64url"),
						sig: signChallenge(identity, message.nonce),
					}),
				);
			} else if (message.type === "ready") resolve();
			else if (message.type === "open") channels.push(message.channel);
		});
	});
	return { socket, identity, channels };
}

describe("the relay under bad input", () => {
	test("a path that cannot be decoded or parsed closes that connection only", async () => {
		const { relay, port, healthy } = await start();
		try {
			const undecodable = await rawUpgrade(port, "/phone/%E0%A4%A");
			undecodable.socket.destroy();
			const unparsable = await rawUpgrade(port, "//[");
			unparsable.socket.destroy();
			assert.ok(await healthy());
		} finally {
			await relay.close();
		}
	});

	test("a frame over the size limit or with invalid text closes that connection only", async () => {
		const { relay, port, url, healthy } = await start();
		try {
			const big = new WebSocket(`${url}/desktop`);
			await new Promise((resolve) => big.once("open", resolve));
			big.on("error", () => {});
			big.send(Buffer.alloc(2 * 1024 * 1024));
			await closed(big);
			assert.ok(await healthy());

			const { socket, head } = await rawUpgrade(port, "/desktop");
			assert.match(head, /101/);
			const gone = new Promise((resolve) => socket.once("close", resolve));
			socket.write(clientFrame(0x1, Buffer.from([0xff, 0xfe, 0xfd])));
			await gone;
			assert.ok(await healthy());
		} finally {
			await relay.close();
		}
	});

	test("an end that does not read is closed instead of filling the relay's memory", async () => {
		const { relay, url } = await start({ maxBuffered: 64 * 1024 });
		try {
			const desktop = await fakeDesktop(url);
			const phone = new WebSocket(`${url}/phone/${desktop.identity.desktopId}`);
			phone.on("error", () => {});
			await new Promise((resolve) => phone.once("open", resolve));
			await until(() => desktop.channels.length === 1);
			// The phone stops reading; the Mac keeps sending.
			(phone as unknown as { _socket: Socket })._socket.pause();
			const frame = Buffer.alloc(4 + 512 * 1024);
			frame.writeUInt32BE(desktop.channels[0] as number, 0);
			for (let i = 0; i < 60; i++) desktop.socket.send(frame);
			await until(() => relay.counts.phones === 0);
			// The Mac's own connection is untouched.
			assert.equal(relay.counts.desktops, 1);
			desktop.socket.close();
		} finally {
			await relay.close();
		}
	});

	test("many connections that do not read stay under one total, and the relay stays up", async () => {
		const total = 8 * 1024 * 1024;
		const { relay, url, healthy } = await start({ maxBufferedTotal: total });
		try {
			const desktops = await Promise.all([1, 2, 3].map(() => fakeDesktop(url)));
			const phones: WebSocket[] = [];
			for (const desktop of desktops) {
				for (let i = 0; i < 8; i++) {
					const phone = new WebSocket(`${url}/phone/${desktop.identity.desktopId}`);
					phone.on("error", () => {});
					await new Promise((resolve) => phone.once("open", resolve));
					(phone as unknown as { _socket: Socket })._socket.pause();
					phones.push(phone);
				}
			}
			await until(() => desktops.every((desktop) => desktop.channels.length === 8));
			let most = 0;
			const watch = setInterval(() => {
				most = Math.max(most, relay.waiting);
			}, 5);
			// Each stays under its own limit of 4 MB; together they would be far over the total.
			for (let round = 0; round < 6; round++) {
				for (const desktop of desktops) {
					for (const channel of desktop.channels) {
						const frame = Buffer.alloc(4 + 512 * 1024);
						frame.writeUInt32BE(channel, 0);
						desktop.socket.send(frame);
					}
				}
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			await new Promise((resolve) => setTimeout(resolve, 300));
			clearInterval(watch);
			most = Math.max(most, relay.waiting);
			// One frame may be on its way in when the total is reached.
			assert.ok(most <= total + 1024 * 1024, `waiting reached ${most}`);
			assert.ok(relay.counts.phones < phones.length);
			assert.ok(await healthy());
			for (const desktop of desktops) desktop.socket.close();
		} finally {
			await relay.close();
		}
	});

	test("one address holds only so many connections", async () => {
		const { relay, url } = await start({ maxPerAddress: 2 });
		try {
			const first = new WebSocket(`${url}/desktop`);
			const second = new WebSocket(`${url}/desktop`);
			await Promise.all([first, second].map((s) => new Promise((r) => s.once("open", r))));
			const third = new WebSocket(`${url}/desktop`);
			assert.equal(await closed(third), 4429);
			first.close();
			await closed(first);
			// A place freed is a place another connection can take.
			const fourth = new WebSocket(`${url}/desktop`);
			await new Promise((resolve) => fourth.once("message", resolve));
			second.close();
			fourth.close();
		} finally {
			await relay.close();
		}
	});

	test("the Mac closes a phone connection that does not finish the handshake", async () => {
		const { relay, url } = await start();
		const { store } = newStore();
		const identity = await loadIdentity(new MemoryKeyStore());
		const connector = new Connector({
			store,
			identity,
			relayUrl: url,
			desktopName: "Mac",
			version: "0.0.0",
			handle: async () => new Response(null, { status: 204 }),
			log: () => {},
			WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
			handshakeMs: 50,
		});
		try {
			connector.start();
			await until(() => connector.connected);
			const idle = new WebSocket(`${url}/phone/${identity.desktopId}`);
			assert.equal(await closed(idle), 1000);
			// The relay may see the close a moment after the phone does (Linux).
			await until(() => relay.counts.phones === 0);
		} finally {
			connector.stop();
			await relay.close();
		}
	});
});
