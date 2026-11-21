import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { dh, type KeyPair } from "./noise.ts";

/**
 * Notifications to a paired phone. The Mac encrypts what a notification says with
 * a key only it and that phone can derive, from the Noise static keys they exchanged when pairing; the
 * relay and Apple's push service carry the ciphertext and the phone's token, never the text. The
 * phone's notification service extension decrypts it before it is shown.
 *
 * key    = HKDF-SHA256(X25519(Mac static, phone static), salt = empty, info = "yew-push/1"), 32 bytes
 * sealed = nonce (12 random bytes) | ChaCha20-Poly1305 ciphertext | tag (16 bytes)
 */

const INFO = "yew-push/1";
const NONCE = 12;
const TAG = 16;

export function pushKey(own: KeyPair, phonePublic: Buffer): Buffer {
	return Buffer.from(hkdfSync("sha256", dh(own, phonePublic), Buffer.alloc(0), INFO, 32));
}

export function sealPush(key: Buffer, plaintext: Buffer, nonce = randomBytes(NONCE)): Buffer {
	const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: TAG });
	return Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

export function openPush(key: Buffer, sealed: Buffer): Buffer {
	if (sealed.length < NONCE + TAG) throw new Error("The notification is too short.");
	const decipher = createDecipheriv("chacha20-poly1305", key, sealed.subarray(0, NONCE), {
		authTagLength: TAG,
	});
	decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
	return Buffer.concat([
		decipher.update(sealed.subarray(NONCE, sealed.length - TAG)),
		decipher.final(),
	]);
}

/** A phone's token as the Mac keeps it: Apple's environment, then the token in hex. */
export const PUSH_TOKEN = /^(sandbox|production):[0-9a-f]{64,200}$/;

/** What the Mac asks the relay to hand to Apple's push service for one phone. */
export interface PushJob {
	/** `sandbox:<hex>` or `production:<hex>`. */
	token: string;
	/** The sealed notification, base64. */
	data: string;
	/** alert: shown, after the phone decrypts it. background: only tells the app to tidy up. */
	mode: "alert" | "background";
	/** A later notification with the same id replaces this one on the phone. */
	id?: string;
}

/** What the relay answers: `gone` when Apple says the token is no longer valid. */
export interface PushResult {
	token: string;
	ok: boolean;
	gone: boolean;
	reason?: string;
}

/** The largest sealed notification the relay takes, in base64 characters (Apple's limit is 4 KB in all). */
export const MAX_PUSH_DATA = 3400;
