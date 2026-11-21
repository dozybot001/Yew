import { AsyncEntry } from "@napi-rs/keyring";

/** Where API keys live. They never go into SQLite, logs, URLs or command arguments. */
export interface KeyStore {
	get(provider: string): Promise<string | null>;
	set(provider: string, key: string): Promise<void>;
	/** Resolves true when a key was there to delete. */
	delete(provider: string): Promise<boolean>;
}

export const KEYCHAIN_SERVICE = "cn.tenonai.yew";

/** The operating system keychain (macOS Keychain, Windows Credential Manager, Secret Service). */
export class KeychainStore implements KeyStore {
	readonly #prefix: string;

	/** `prefix` keeps different kinds apart: "provider" for API keys, "remote" for the relay keys. */
	constructor(prefix = "provider") {
		this.#prefix = prefix;
	}

	#entry(name: string): AsyncEntry {
		return new AsyncEntry(KEYCHAIN_SERVICE, `${this.#prefix}:${name}`);
	}

	async get(provider: string): Promise<string | null> {
		return (await this.#entry(provider).getPassword()) ?? null;
	}

	async set(provider: string, key: string): Promise<void> {
		await this.#entry(provider).setPassword(key);
	}

	async delete(provider: string): Promise<boolean> {
		return await this.#entry(provider)
			.deleteCredential()
			.catch(() => false);
	}
}

/**
 * The key store Yew runs with: the system keychain, or one in memory when `YEW_KEYCHAIN=off`.
 * The keychain is shared by every data folder on this computer, so a Yew started on a scratch
 * `YEW_HOME` to try something out would otherwise hold the real API keys and could call a model
 * with them. With the switch off it starts with no keys and forgets what is saved when it stops.
 */
export function systemKeys(prefix = "provider", env: NodeJS.ProcessEnv = process.env): KeyStore {
	const off = env.YEW_KEYCHAIN === "off";
	return off ? new MemoryKeyStore() : new KeychainStore(prefix);
}

/** For tests: keeps keys in memory. */
export class MemoryKeyStore implements KeyStore {
	readonly #keys = new Map<string, string>();

	constructor(initial: Record<string, string> = {}) {
		for (const [provider, key] of Object.entries(initial)) this.#keys.set(provider, key);
	}

	async get(provider: string): Promise<string | null> {
		return this.#keys.get(provider) ?? null;
	}

	async set(provider: string, key: string): Promise<void> {
		this.#keys.set(provider, key);
	}

	async delete(provider: string): Promise<boolean> {
		return this.#keys.delete(provider);
	}
}
