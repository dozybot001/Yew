import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	createPrivateKey,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	type KeyObject,
} from "node:crypto";

/**
 * Noise_IK_25519_ChaChaPoly_SHA256 (Noise Protocol Framework, revision 34), Yew's end-to-end encryption
 * between the Mac and a phone through the relay. The phone (initiator) knows the
 * Mac's static key from the pairing QR code; the Mac (responder) learns the phone's static key in the
 * first message and accepts it only if it is paired, or if the first payload carries a valid pairing
 * secret. The relay sees only ciphertext and cannot pose as either end.
 */

const PROTOCOL = "Noise_IK_25519_ChaChaPoly_SHA256";
const KEY_LENGTH = 32;
const TAG_LENGTH = 16;
/** A Noise message is at most 65535 bytes (section 3). */
export const MAX_MESSAGE = 65535;
const EMPTY = Buffer.alloc(0);

export interface KeyPair {
	publicKey: Buffer;
	privateKey: Buffer;
}

export function generateKeyPair(): KeyPair {
	const { publicKey, privateKey } = generateKeyPairSync("x25519");
	return { publicKey: rawPublic(publicKey), privateKey: rawPrivate(privateKey) };
}

/** The public half of a raw X25519 private key. */
export function publicKeyOf(privateKey: Buffer): Buffer {
	return rawPublic(createPublicKey(privateKeyObject(privateKey)));
}

// Raw X25519 keys wrapped in their fixed DER prefixes (RFC 8410), so Node can use them.
const PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI = Buffer.from("302a300506032b656e032100", "hex");

const privateKeyObject = (raw: Buffer): KeyObject =>
	createPrivateKey({ key: Buffer.concat([PKCS8, raw]), format: "der", type: "pkcs8" });

const publicKeyObject = (raw: Buffer): KeyObject =>
	createPublicKey({ key: Buffer.concat([SPKI, raw]), format: "der", type: "spki" });

function rawPublic(key: KeyObject): Buffer {
	return key.export({ format: "der", type: "spki" }).subarray(SPKI.length);
}

function rawPrivate(key: KeyObject): Buffer {
	return key.export({ format: "der", type: "pkcs8" }).subarray(PKCS8.length);
}

export function dh(pair: KeyPair, publicKey: Buffer): Buffer {
	if (publicKey.length !== KEY_LENGTH) throw new NoiseError("A public key has the wrong length.");
	const shared = diffieHellman({
		privateKey: privateKeyObject(pair.privateKey),
		publicKey: publicKeyObject(publicKey),
	});
	// A low-order point gives all zeros; refuse it rather than key a channel with it.
	if (shared.every((byte) => byte === 0)) throw new NoiseError("A public key is not usable.");
	return shared;
}

const hash = (...parts: Buffer[]) => {
	const h = createHash("sha256");
	for (const part of parts) h.update(part);
	return h.digest();
};

const hmac = (key: Buffer, ...parts: Buffer[]) => {
	const h = createHmac("sha256", key);
	for (const part of parts) h.update(part);
	return h.digest();
};

/** HKDF as Noise defines it (section 4.3), with two outputs. */
function hkdf(chainingKey: Buffer, input: Buffer): [Buffer, Buffer] {
	const temp = hmac(chainingKey, input);
	const first = hmac(temp, Buffer.from([1]));
	const second = hmac(temp, first, Buffer.from([2]));
	return [first, second];
}

/** The ChaChaPoly nonce: 32 bits of zeros, then the counter as a little-endian 64-bit number. */
function nonce(n: number): Buffer {
	const buffer = Buffer.alloc(12);
	buffer.writeBigUInt64LE(BigInt(n), 4);
	return buffer;
}

export class NoiseError extends Error {}

/** One direction of an encrypted channel (Noise CipherState). */
export class CipherState {
	#key: Buffer | null;
	#n = 0;

	constructor(key: Buffer | null = null) {
		this.#key = key;
	}

	get hasKey(): boolean {
		return this.#key !== null;
	}

	encrypt(ad: Buffer, plaintext: Buffer): Buffer {
		if (!this.#key) return plaintext;
		const cipher = createCipheriv("chacha20-poly1305", this.#key, nonce(this.#next()), {
			authTagLength: TAG_LENGTH,
		});
		cipher.setAAD(ad, { plaintextLength: plaintext.length });
		const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
		return Buffer.concat([body, cipher.getAuthTag()]);
	}

	decrypt(ad: Buffer, ciphertext: Buffer): Buffer {
		if (!this.#key) return ciphertext;
		if (ciphertext.length < TAG_LENGTH) throw new NoiseError("A message is too short.");
		const decipher = createDecipheriv("chacha20-poly1305", this.#key, nonce(this.#n), {
			authTagLength: TAG_LENGTH,
		});
		decipher.setAAD(ad, { plaintextLength: ciphertext.length - TAG_LENGTH });
		decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_LENGTH));
		let plaintext: Buffer;
		try {
			plaintext = Buffer.concat([
				decipher.update(ciphertext.subarray(0, ciphertext.length - TAG_LENGTH)),
				decipher.final(),
			]);
		} catch {
			throw new NoiseError("A message failed to decrypt.");
		}
		// The counter moves only after a message decrypts, so a forged one cannot desynchronize it.
		this.#next();
		return plaintext;
	}

	#next(): number {
		if (this.#n >= Number.MAX_SAFE_INTEGER) throw new NoiseError("The channel ran out of nonces.");
		return this.#n++;
	}
}

/** Noise SymmetricState (section 5.2). */
class SymmetricState {
	#cipher = new CipherState();
	#ck: Buffer;
	h: Buffer;

	constructor() {
		// The protocol name is exactly 32 bytes, so it is the initial hash as it is.
		this.h = Buffer.from(PROTOCOL, "ascii");
		this.#ck = this.h;
	}

	mixKey(input: Buffer): void {
		const [ck, key] = hkdf(this.#ck, input);
		this.#ck = ck;
		this.#cipher = new CipherState(key);
	}

	mixHash(data: Buffer): void {
		this.h = hash(this.h, data);
	}

	encryptAndHash(plaintext: Buffer): Buffer {
		const ciphertext = this.#cipher.encrypt(this.h, plaintext);
		this.mixHash(ciphertext);
		return ciphertext;
	}

	decryptAndHash(ciphertext: Buffer): Buffer {
		const plaintext = this.#cipher.decrypt(this.h, ciphertext);
		this.mixHash(ciphertext);
		return plaintext;
	}

	split(): [CipherState, CipherState] {
		const [first, second] = hkdf(this.#ck, EMPTY);
		return [new CipherState(first), new CipherState(second)];
	}
}

/** The two directions of a finished handshake. */
export interface Session {
	send: CipherState;
	receive: CipherState;
	/** The handshake hash: the same on both ends, and unique to this handshake. */
	handshakeHash: Buffer;
}

/**
 * The phone's side: sends `e, es, s, ss` with a payload, reads `e, ee, se`. The responder's static key
 * must be known in advance (from the pairing QR code).
 */
export class Initiator {
	#state = new SymmetricState();
	#static: KeyPair;
	#ephemeral: KeyPair;
	#remoteStatic: Buffer;

	constructor(options: {
		static: KeyPair;
		remoteStatic: Buffer;
		prologue: Buffer;
		ephemeral?: KeyPair;
	}) {
		this.#static = options.static;
		this.#remoteStatic = options.remoteStatic;
		this.#ephemeral = options.ephemeral ?? generateKeyPair();
		this.#state.mixHash(options.prologue);
		this.#state.mixHash(this.#remoteStatic);
	}

	/** Message 1: `e, es, s, ss` and the payload. */
	writeFirst(payload: Buffer): Buffer {
		const state = this.#state;
		state.mixHash(this.#ephemeral.publicKey);
		state.mixKey(dh(this.#ephemeral, this.#remoteStatic));
		const encryptedStatic = state.encryptAndHash(this.#static.publicKey);
		state.mixKey(dh(this.#static, this.#remoteStatic));
		const encryptedPayload = state.encryptAndHash(payload);
		return checked(Buffer.concat([this.#ephemeral.publicKey, encryptedStatic, encryptedPayload]));
	}

	/** Message 2: `e, ee, se`; returns the responder's payload and the channel. */
	readSecond(message: Buffer): { payload: Buffer; session: Session } {
		if (message.length < KEY_LENGTH + TAG_LENGTH) throw new NoiseError("A message is too short.");
		const state = this.#state;
		const remoteEphemeral = message.subarray(0, KEY_LENGTH);
		state.mixHash(remoteEphemeral);
		state.mixKey(dh(this.#ephemeral, remoteEphemeral));
		state.mixKey(dh(this.#static, remoteEphemeral));
		const payload = state.decryptAndHash(message.subarray(KEY_LENGTH));
		const [first, second] = state.split();
		return { payload, session: { send: first, receive: second, handshakeHash: state.h } };
	}
}

/** The Mac's side: reads `e, es, s, ss`, decides whether to accept the phone, writes `e, ee, se`. */
export class Responder {
	#state = new SymmetricState();
	#static: KeyPair;
	#ephemeral: KeyPair;
	#remoteEphemeral: Buffer | null = null;
	remoteStatic: Buffer | null = null;

	constructor(options: { static: KeyPair; prologue: Buffer; ephemeral?: KeyPair }) {
		this.#static = options.static;
		this.#ephemeral = options.ephemeral ?? generateKeyPair();
		this.#state.mixHash(options.prologue);
		this.#state.mixHash(this.#static.publicKey);
	}

	/** Message 1; afterwards `remoteStatic` is the phone's static key, authenticated. */
	readFirst(message: Buffer): Buffer {
		if (message.length < KEY_LENGTH + KEY_LENGTH + 2 * TAG_LENGTH) {
			throw new NoiseError("A message is too short.");
		}
		const state = this.#state;
		const remoteEphemeral = message.subarray(0, KEY_LENGTH);
		state.mixHash(remoteEphemeral);
		state.mixKey(dh(this.#static, remoteEphemeral));
		const remoteStatic = state.decryptAndHash(
			message.subarray(KEY_LENGTH, KEY_LENGTH + KEY_LENGTH + TAG_LENGTH),
		);
		state.mixKey(dh(this.#static, remoteStatic));
		const payload = state.decryptAndHash(message.subarray(KEY_LENGTH + KEY_LENGTH + TAG_LENGTH));
		this.#remoteEphemeral = Buffer.from(remoteEphemeral);
		this.remoteStatic = Buffer.from(remoteStatic);
		return payload;
	}

	/** Message 2 with the payload; returns it and the channel. */
	writeSecond(payload: Buffer): { message: Buffer; session: Session } {
		if (!this.#remoteEphemeral || !this.remoteStatic) {
			throw new NoiseError("Read the first message first.");
		}
		const state = this.#state;
		state.mixHash(this.#ephemeral.publicKey);
		state.mixKey(dh(this.#ephemeral, this.#remoteEphemeral));
		state.mixKey(dh(this.#ephemeral, this.remoteStatic));
		const encryptedPayload = state.encryptAndHash(payload);
		const [first, second] = state.split();
		return {
			message: checked(Buffer.concat([this.#ephemeral.publicKey, encryptedPayload])),
			session: { send: second, receive: first, handshakeHash: state.h },
		};
	}
}

function checked(message: Buffer): Buffer {
	if (message.length > MAX_MESSAGE) throw new NoiseError("A handshake message is too long.");
	return message;
}

/** The most a transport message carries: one Noise message less the tag and the chunk flag. */
const CHUNK = MAX_MESSAGE - TAG_LENGTH - 1;

/** Encrypts an application message of any length as one or more Noise messages. */
export function seal(cipher: CipherState, message: Buffer): Buffer[] {
	const parts: Buffer[] = [];
	for (let offset = 0; offset < message.length || parts.length === 0; offset += CHUNK) {
		const piece = message.subarray(offset, offset + CHUNK);
		const last = offset + CHUNK >= message.length;
		parts.push(cipher.encrypt(EMPTY, Buffer.concat([Buffer.from([last ? 1 : 0]), piece])));
	}
	return parts;
}

/** Joins decrypted chunks back into application messages. */
export class Opener {
	#cipher: CipherState;
	#pending: Buffer[] = [];
	#size = 0;
	#limit: number;

	constructor(cipher: CipherState, limit = 16 * 1024 * 1024) {
		this.#cipher = cipher;
		this.#limit = limit;
	}

	/** Returns a whole message when the last chunk of one arrives, otherwise null. */
	open(ciphertext: Buffer): Buffer | null {
		if (ciphertext.length > MAX_MESSAGE) throw new NoiseError("A message is too long.");
		const plaintext = this.#cipher.decrypt(EMPTY, ciphertext);
		if (plaintext.length === 0) throw new NoiseError("A chunk is empty.");
		this.#size += plaintext.length - 1;
		if (this.#size > this.#limit) throw new NoiseError("A message is too large.");
		this.#pending.push(plaintext.subarray(1));
		if (plaintext[0] !== 1) return null;
		const message = Buffer.concat(this.#pending);
		this.#pending = [];
		this.#size = 0;
		return message;
	}
}
