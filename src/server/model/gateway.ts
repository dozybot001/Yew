/**
 * The model layer: the only place that imports the model library (AGENTS.md). Everything else talks to
 * models through `ModelGateway` and the message types in `src/shared/messages.ts`.
 */
import {
	type Api,
	type AuthContext,
	type Context,
	type Credential,
	type CredentialStore,
	clampThinkingLevel,
	createModels,
	createProvider,
	getSupportedThinkingLevels,
	isContextOverflow,
	isRetryableAssistantError,
	type ThinkingLevel as LibraryThinkingLevel,
	type Message,
	type Model,
	type MutableModels,
	type Provider,
	retryDelayMs,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { AssistantMessage, JsonObject, ModelMessage } from "../../shared/messages.ts";
import type { ThinkingLevel } from "../../shared/types.ts";
import { invalid, YewError } from "../errors.ts";
import type { KeyStore } from "../keys.ts";

// Compile-time guarantees that Yew's stored message shapes and the library's stay interchangeable.
type Assert<T extends true> = T;
export type _MessagesFitLibrary = Assert<ModelMessage extends Message ? true : false>;
export type _LibraryResultFitsYew = Assert<
	import("@earendil-works/pi-ai").AssistantMessage extends AssistantMessage ? true : false
>;

export type Region = "cn" | "global" | "custom";

export interface ProviderInfo {
	id: string;
	name: string;
	region: Region;
	baseUrl: string;
	keyRequired: boolean;
	custom: boolean;
}

export interface ModelInfo {
	provider: string;
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	/** Thinking levels this model accepts, "off" included when it can answer without thinking. */
	thinkingLevels: ThinkingLevel[];
	input: ("text" | "image")[];
	/** US dollars per million tokens. */
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	/** True for active latest-generation models (shown above the divider in the model picker). */
	latest?: boolean;
	/** True for the provider's small model (SMALL_MODELS). */
	small?: boolean;
}

export interface ToolSpec {
	name: string;
	description: string;
	parameters: JsonObject;
}

export interface ModelRequest {
	provider: string;
	model: string;
	thinking: ThinkingLevel;
	systemPrompt: string;
	messages: ModelMessage[];
	tools: ToolSpec[];
	signal?: AbortSignal;
	/** Lets providers that support it route and cache by session. */
	sessionId?: string;
	/** Called before each wait when a request failed in a way that may pass and is tried again. */
	onRetry?: (retry: RetryNote) => void;
	/**
	 * False for a prompt that is not sent again, such as the one that names a session: no prompt cache
	 * is written for it.
	 */
	cache?: boolean;
	/** The most times a failure that may pass is tried again; the gateway's own number when not given. */
	retries?: number;
}

/** A failed request that will be tried again: which retry of how many, after how long, and why. */
export interface RetryNote {
	attempt: number;
	of: number;
	delayMs: number;
	error: string;
}

/**
 * How failed requests are tried again. The waits double from `baseDelayMs` up to a minute, so the
 * default covers about four minutes of a provider being overloaded or the network being away.
 */
export interface RetryOptions {
	maxRetries: number;
	baseDelayMs: number;
}

const DEFAULT_RETRY: RetryOptions = { maxRetries: 8, baseDelayMs: 2000 };
const MAX_RETRY_DELAY_MS = 60_000;
/** A response that sends nothing for this long is given up and tried again. */
const DEFAULT_IDLE_MS = 5 * 60 * 1000;

/** What a request that never answered comes back as. */
function emptyMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		timestamp: Date.now(),
	};
}

/** Resolves true after `ms`, or false as soon as the signal aborts. */
function pause(ms: number, signal?: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve(false);
		const stop = () => {
			clearTimeout(timer);
			resolve(false);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", stop);
			resolve(true);
		}, ms);
		signal?.addEventListener("abort", stop, { once: true });
	});
}

/** An OpenAI-compatible endpoint the person adds: another vendor, or a model running locally. */
export interface CustomProviderConfig {
	id: string;
	name: string;
	baseUrl: string;
	keyRequired: boolean;
	models: {
		id: string;
		name?: string;
		contextWindow: number;
		maxTokens: number;
		reasoning?: boolean;
		input?: ("text" | "image")[];
		cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
	}[];
}

/** Providers registered in mainland China; the default comes from this list. */
const CN_PROVIDERS = new Set([
	"deepseek",
	"moonshotai-cn",
	"zai-coding-cn",
	"minimax-cn",
	"qwen-token-plan-cn",
	"xiaomi",
	"xiaomi-token-plan-cn",
	"ant-ling",
]);

/**
 * Built-in providers Yew does not offer: they sign in through an account or a cloud SDK instead of an
 * API key, or need extra account configuration. Yew only uses API keys (docs/prior-art.md, section 3).
 */
const HIDDEN_PROVIDERS = new Set([
	"amazon-bedrock",
	"google-vertex",
	"azure",
	"openai-codex",
	"github-copilot",
	"radius",
	"typesafe",
	"cloudflare-workers-ai",
	"cloudflare-ai-gateway",
]);

/**
 * The small model of each provider: what the side model picker offers first when the person picks
 * that provider for the jobs beside a conversation, such as naming a session. A fixed list, not
 * "the provider's cheapest model": the cheapest may be a batch or trial variant that comes with
 * other terms. A provider that is not listed has none.
 */
export const SMALL_MODELS: Readonly<Record<string, string>> = {
	"ant-ling": "Ling-2.6-flash",
	anthropic: "claude-haiku-5-5",
	deepseek: "deepseek-flash",
	google: "gemini-flash-lite-latest",
	minimax: "MiniMax-M3.1-Flash",
	"minimax-cn": "MiniMax-M3.1-Flash",
	mistral: "mistral-small-latest",
	openai: "gpt-6-luna",
	xiaomi: "mimo-v2.6-flash",
	zai: "glm-5.3-flash",
	"zai-coding-cn": "glm-5.3-flash",
};

/** Sent to keyless local servers, which ignore it; the OpenAI client needs some value. */
const KEYLESS = "yew-no-key";

/** Keys come only from the keychain: never from environment variables or files (AGENTS.md). */
const NO_AMBIENT_AUTH: AuthContext = {
	env: async () => undefined,
	fileExists: async () => false,
};

class KeychainCredentials implements CredentialStore {
	readonly #keys: KeyStore;

	constructor(keys: KeyStore) {
		this.#keys = keys;
	}

	async read(providerId: string): Promise<Credential | undefined> {
		const key = await this.#keys.get(providerId);
		return key ? { type: "api_key", key } : undefined;
	}

	async list() {
		return [];
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		const current = await this.read(providerId);
		const next = await fn(current);
		if (next?.type === "api_key" && next.key) await this.#keys.set(providerId, next.key);
		return next ?? current;
	}

	async delete(providerId: string): Promise<void> {
		await this.#keys.delete(providerId);
	}
}

function customProvider(config: CustomProviderConfig): Provider {
	return createProvider({
		id: config.id,
		name: config.name,
		baseUrl: config.baseUrl,
		auth: {
			apiKey: {
				name: `${config.name} API key`,
				resolve: async ({ credential }) => {
					if (credential?.key) return { auth: { apiKey: credential.key }, source: "keychain" };
					return config.keyRequired ? undefined : { auth: { apiKey: KEYLESS }, source: "none" };
				},
			},
		},
		models: config.models.map(
			(model): Model<"openai-completions"> => ({
				id: model.id,
				name: model.name ?? model.id,
				api: "openai-completions",
				provider: config.id,
				baseUrl: config.baseUrl,
				reasoning: model.reasoning ?? false,
				input: model.input ?? ["text"],
				cost: {
					input: model.cost?.input ?? 0,
					output: model.cost?.output ?? 0,
					cacheRead: model.cost?.cacheRead ?? 0,
					cacheWrite: model.cost?.cacheWrite ?? 0,
				},
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
			}),
		),
		api: openAICompletionsApi(),
	});
}

function toInfo(model: Model<Api>): ModelInfo {
	const levels = model.reasoning ? (getSupportedThinkingLevels(model) as ThinkingLevel[]) : ["off"];
	return {
		provider: model.provider,
		id: model.id,
		name: model.name,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		reasoning: model.reasoning,
		thinkingLevels: levels as ThinkingLevel[],
		input: model.input.filter(
			(kind): kind is "text" | "image" => kind === "text" || kind === "image",
		),
		cost: {
			input: model.cost.input,
			output: model.cost.output,
			cacheRead: model.cost.cacheRead,
			cacheWrite: model.cost.cacheWrite,
		},
	};
}

type VersionTuple = [number, number];

interface ParsedModel {
	info: ModelInfo;
	family: string;
	root: string;
	version: VersionTuple | null;
	dated: string | null;
	isPreview: boolean;
	isLatestId: boolean;
}

function compareVersion(a: VersionTuple, b: VersionTuple): number {
	return a[0] - b[0] || a[1] - b[1];
}

function tierRank(id: string): number {
	const lower = id.toLowerCase();
	if (/\b(opus|pro|max|sol)\b|-opus-|-pro\b|-max\b|-sol\b/.test(lower)) return 0;
	if (/\b(sonnet|plus|terra)\b|-sonnet-|-plus\b|-terra\b/.test(lower)) return 1;
	if (/\b(haiku|flash|mini|lite|nano)\b|-haiku-|-flash\b|-mini\b|-lite\b/.test(lower)) return 2;
	return 3;
}

function parseModelIdentity(info: ModelInfo): ParsedModel {
	const raw = (info.id.split("/").pop() ?? info.id).toLowerCase();
	let base = raw;
	let dated: string | null = null;
	const d8 = /-(20\d{2})(\d{2})(\d{2})$/.exec(base);
	if (d8) {
		dated = `${d8[1]}-${d8[2]}-${d8[3]}`;
		base = base.slice(0, -d8[0].length);
	} else {
		const diso = /-(20\d{2}-\d{2}-\d{2})$/.exec(base);
		if (diso) {
			dated = diso[1] as string;
			base = base.slice(0, -diso[0].length);
		} else {
			const d4 = /-(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?=-|$)/.exec(base);
			const yymm = d4 ? null : /-(2[4-9])(0[1-9]|1[0-2])$/.exec(base);
			if (d4) {
				dated = `${d4[1]}-${d4[2]}`;
				base = base.replace(d4[0], "");
			} else if (yymm) {
				dated = `20${yymm[1]}-${yymm[2]}`;
				base = base.slice(0, -yymm[0].length);
			}
		}
	}
	const isPreview = /-preview\b|-spot\b/.test(base);
	const isLatestId = /-latest$/.test(base);
	const clean = base.replace(/-latest$/, "");
	let version: VersionTuple | null = null;
	let family = clean;
	const claude = /^(claude-[a-z]+)-(\d+)(?:-(\d+))?$/.exec(clean);
	if (claude) {
		family = claude[1] as string;
		version = [Number(claude[2]), Number(claude[3] ?? 0)];
	} else {
		const versioned = /^([a-z-]+?)[-_]?(\d+)(?:[.\-p](\d+))?(?![0-9bt])(.*)$/.exec(clean);
		if (versioned) {
			family = `${versioned[1]}-${versioned[4]}`.replace(/-+/g, "-").replace(/^-|-$/g, "");
			version = [Number(versioned[2]), Number(versioned[3] ?? 0)];
		} else {
			const nameVer = /\bv?(\d+)(?:\.(\d+))?(?![0-9bt])/.exec(info.name.toLowerCase());
			if (nameVer) version = [Number(nameVer[1]), Number(nameVer[2] ?? 0)];
		}
	}
	const root = family.split("-")[0] ?? family;
	return { info, family, root, version, dated, isPreview, isLatestId };
}

/**
 * Cleans up upstream display quirks (such as legacy "(latest)" tags left on older generations once
 * newer releases arrive, and duplicate names on dated snapshots), marks the current-generation
 * `latest` models, and orders latest flagship models ahead of older ones.
 */
export function enrichProviderModels(models: ModelInfo[]): ModelInfo[] {
	if (models.length === 0) return models;
	const parsed = models.map(parseModelIdentity);
	const maxByFamily = new Map<string, VersionTuple>();
	const maxMajorByRoot = new Map<string, number>();
	for (const item of parsed) {
		if (!item.version) continue;
		const existing = maxByFamily.get(item.family);
		if (!existing || compareVersion(item.version, existing) > 0) {
			maxByFamily.set(item.family, item.version);
		}
		if (!item.isPreview && !item.dated) {
			const curMajor = maxMajorByRoot.get(item.root) ?? -1;
			if (item.version[0] > curMajor) maxMajorByRoot.set(item.root, item.version[0]);
		}
	}
	const renamed = parsed.map((item) => {
		let name = item.info.name;
		const max = maxByFamily.get(item.family);
		if (
			/\s*\(latest\)\s*$/i.test(name) &&
			item.version &&
			max &&
			compareVersion(item.version, max) < 0
		) {
			name = name.replace(/\s*\(latest\)\s*$/i, "");
		}
		return { ...item, name };
	});
	const nameCounts = new Map<string, number>();
	for (const item of renamed) nameCounts.set(item.name, (nameCounts.get(item.name) ?? 0) + 1);
	const decorated = renamed.map((item) => {
		let name = item.name;
		if (item.dated && (nameCounts.get(name) ?? 0) > 1 && !name.includes(item.dated)) {
			name = `${name} (${item.dated})`;
		}
		const max = maxByFamily.get(item.family);
		const maxRoot = maxMajorByRoot.get(item.root);
		const isTopMajor = !item.version || maxRoot === undefined || item.version[0] === maxRoot;
		const isTopInFamily =
			item.version !== null &&
			max !== undefined &&
			compareVersion(item.version, max) === 0 &&
			!item.dated &&
			!item.isPreview &&
			isTopMajor;
		const latest = (item.isLatestId && isTopMajor) || isTopInFamily;
		return {
			...item,
			info: { ...item.info, name, latest },
		};
	});
	decorated.sort((a, b) => {
		if (a.info.latest !== b.info.latest) return a.info.latest ? -1 : 1;
		if (a.version && b.version) {
			const verDiff = compareVersion(b.version, a.version);
			if (verDiff !== 0) return verDiff;
		} else if (a.version !== b.version) {
			return a.version ? -1 : 1;
		}
		const rankDiff = tierRank(a.info.id) - tierRank(b.info.id);
		if (rankDiff !== 0) return rankDiff;
		return a.info.name.localeCompare(b.info.name);
	});
	return decorated.map((item) => item.info);
}

export interface GatewayOptions {
	keys: KeyStore;
	/** Yew's version, sent as `User-Agent: yew/<version>`. */
	version: string;
	custom?: CustomProviderConfig[];
	/** Replaces the built-in providers; tests pass the library's faux provider here. */
	providers?: Provider[];
	retry?: RetryOptions;
	idleMs?: number;
	/** Replaces the list of small models by provider; tests name one of the faux provider's here. */
	small?: Record<string, string>;
}

/** What one short request to a provider came to. */
export interface PingResult {
	ok: boolean;
	model: string;
	/** Until the first piece of the answer arrived, and until the answer was complete. */
	firstMs: number | null;
	totalMs: number;
	error?: string;
}

/**
 * A provider's error as one readable line: "401 {json}" becomes "401: <the message in the json>".
 * Anything that does not look like that is returned as it is, cut to a sensible length.
 */
export function plainError(text: string): string {
	const match = /^(\d{3}):?\s*(\{[\s\S]*\})\s*$/.exec(text.trim());
	if (match) {
		try {
			const body = JSON.parse(match[2] as string) as {
				message?: unknown;
				error?: { message?: unknown } | string;
			};
			const inner = typeof body.error === "string" ? body.error : body.error?.message;
			const message = typeof inner === "string" ? inner : body.message;
			if (typeof message === "string" && message.trim()) return `${match[1]}: ${message.trim()}`;
		} catch {
			// Not JSON after all.
		}
	}
	return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

/** How long a connection test may take. */
const PING_MS = 30_000;

export class ModelGateway {
	readonly #models: MutableModels;
	readonly #keys: KeyStore;
	readonly #custom = new Map<string, CustomProviderConfig>();
	readonly #retry: RetryOptions;
	readonly #idleMs: number;
	readonly #small: Readonly<Record<string, string>>;

	constructor(options: GatewayOptions) {
		this.#keys = options.keys;
		this.#small = options.small ?? SMALL_MODELS;
		this.#retry = options.retry ?? DEFAULT_RETRY;
		this.#idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
		this.#models = createModels({
			credentials: new KeychainCredentials(options.keys),
			authContext: NO_AMBIENT_AUTH,
			// No attribution headers, and our own User-Agent (AGENTS.md "数据在本机").
			identity: { userAgent: { custom: `yew/${options.version}` }, attribution: null },
		});
		const providers = options.providers ?? builtinProviders();
		for (const provider of providers) {
			if (!HIDDEN_PROVIDERS.has(provider.id)) this.#models.setProvider(provider);
		}
		this.setCustomProviders(options.custom ?? []);
	}

	setCustomProviders(configs: CustomProviderConfig[]): void {
		for (const id of this.#custom.keys()) this.#models.deleteProvider(id);
		this.#custom.clear();
		for (const config of configs) {
			if (this.#models.getProvider(config.id)) {
				throw invalid(`${config.id} is already a built-in provider.`, "id");
			}
			this.#custom.set(config.id, config);
			this.#models.setProvider(customProvider(config));
		}
	}

	providers(): ProviderInfo[] {
		return this.#models.getProviders().map((provider) => {
			const custom = this.#custom.get(provider.id);
			return {
				id: provider.id,
				name: provider.name,
				region: custom ? "custom" : CN_PROVIDERS.has(provider.id) ? "cn" : "global",
				baseUrl: provider.baseUrl ?? custom?.baseUrl ?? "",
				keyRequired: custom ? custom.keyRequired : true,
				custom: custom !== undefined,
			};
		});
	}

	provider(id: string): ProviderInfo | undefined {
		return this.providers().find((provider) => provider.id === id);
	}

	models(provider?: string): ModelInfo[] {
		const list = this.#models
			.getModels(provider)
			.map(toInfo)
			.map((item) => (this.#small[item.provider] === item.id ? { ...item, small: true } : item));
		if (provider) return enrichProviderModels(list);
		const byProvider = new Map<string, ModelInfo[]>();
		for (const item of list) {
			const group = byProvider.get(item.provider);
			if (group) group.push(item);
			else byProvider.set(item.provider, [item]);
		}
		const enriched: ModelInfo[] = [];
		for (const group of byProvider.values()) enriched.push(...enrichProviderModels(group));
		return enriched;
	}

	model(provider: string, id: string): ModelInfo | undefined {
		if (!this.#models.getModel(provider, id)) return undefined;
		return this.models(provider).find((item) => item.id === id);
	}

	/**
	 * The provider's small model for a job beside a session that runs `id`, such as naming it, when
	 * the provider has one (SMALL_MODELS) and it costs less than the session's own model. Undefined
	 * otherwise: the session's own model does the job then.
	 */
	/** Throws a 400 error when the provider or model is unknown. */
	check(provider: string, id: string): void {
		if (!this.#models.getProvider(provider)) {
			throw invalid(`Unknown provider: ${provider}.`, "provider");
		}
		if (!this.#models.getModel(provider, id)) {
			throw invalid(`${provider} has no model ${id}.`, "model");
		}
	}

	saveKey(provider: string, key: string): Promise<void> {
		return this.#keys.set(provider, key);
	}

	deleteKey(provider: string): Promise<boolean> {
		return this.#keys.delete(provider);
	}

	async hasKey(provider: string): Promise<boolean> {
		const custom = this.#custom.get(provider);
		if (custom && !custom.keyRequired) return true;
		return (await this.#keys.get(provider)) !== null;
	}

	/**
	 * Streams one model response. `onDraft` sees the response so far after each update; it is the same
	 * object every time and keeps changing, so copy it if you keep it. Resolves with the final message,
	 * whose stopReason is "error" or "aborted" when the request failed or was stopped.
	 *
	 * A failure that may pass (the provider is overloaded or limits the rate, the connection dropped,
	 * the response stalled) is tried again here, so callers only see a failure that stayed. A context
	 * that does not fit is not tried again: the caller shortens it.
	 */
	async stream(
		request: ModelRequest,
		onDraft?: (draft: AssistantMessage) => void,
	): Promise<AssistantMessage> {
		const model = this.#models.getModel(request.provider, request.model);
		if (!model) throw invalid(`${request.provider} has no model ${request.model}.`, "model");
		if (!(await this.hasKey(request.provider))) {
			throw new YewError(
				"missing-api-key",
				400,
				`There is no API key for ${request.provider}. Add one in Settings, or run: yew key set ${request.provider}`,
				{ provider: request.provider },
			);
		}
		const context: Context = {
			systemPrompt: request.systemPrompt,
			messages: request.messages,
			tools: request.tools,
		};
		// One layer of retries, the one below that the person can see: the provider SDKs' own are off.
		const options: SimpleStreamOptions = {
			cacheRetention: request.cache === false ? "none" : "short",
			maxRetries: 0,
		};
		const retries = Math.min(this.#retry.maxRetries, request.retries ?? this.#retry.maxRetries);
		if (request.sessionId) options.sessionId = request.sessionId;
		if (model.reasoning && request.thinking !== "off") {
			const level = clampThinkingLevel(model, request.thinking);
			if (level !== "off") options.reasoning = level as LibraryThinkingLevel;
		}
		for (let attempt = 1; ; attempt++) {
			const message = await this.#once(model, context, options, request.signal, onDraft);
			if (
				message.stopReason !== "error" ||
				attempt > retries ||
				isContextOverflow(message, model.contextWindow) ||
				!isRetryableAssistantError(message)
			) {
				return message;
			}
			const delayMs = retryDelayMs(
				{ baseDelayMs: this.#retry.baseDelayMs, maxAgentDelayMs: MAX_RETRY_DELAY_MS },
				attempt,
			);
			request.onRetry?.({
				attempt,
				of: retries,
				delayMs,
				error: message.errorMessage ?? "",
			});
			if (!(await pause(delayMs, request.signal))) {
				const { errorMessage: _errorMessage, ...rest } = message;
				return { ...rest, stopReason: "aborted" };
			}
		}
	}

	/** One request. A response that goes quiet for too long ends as a failure that can be tried again. */
	async #once(
		model: Model<Api>,
		context: Context,
		options: SimpleStreamOptions,
		signal: AbortSignal | undefined,
		onDraft?: (draft: AssistantMessage) => void,
	): Promise<AssistantMessage> {
		const quiet = new AbortController();
		let stalled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const watch = () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				stalled = true;
				quiet.abort();
			}, this.#idleMs);
		};
		watch();
		try {
			const stream = this.#models.streamSimple(model, context, {
				...options,
				signal: signal ? AbortSignal.any([signal, quiet.signal]) : quiet.signal,
			});
			const seen: { draft: AssistantMessage | null } = { draft: null };
			const read = async () => {
				for await (const event of stream) {
					watch();
					if ("partial" in event) seen.draft = event.partial;
					if (onDraft && "partial" in event) onDraft(event.partial);
				}
				return await stream.result();
			};
			// Not every transport ends its stream when it is aborted, so the wait ends here either way.
			const gaveUp = new Promise<null>((resolve) =>
				quiet.signal.addEventListener("abort", () => resolve(null), { once: true }),
			);
			const reading = read();
			reading.catch(() => {});
			const message = await Promise.race([reading, gaveUp]);
			if (message && (!stalled || signal?.aborted)) return message;
			if (message && message.stopReason !== "aborted" && message.stopReason !== "error")
				return message;
			return {
				...(message ?? seen.draft ?? emptyMessage(model)),
				stopReason: "error",
				errorMessage: `The provider sent nothing for ${Math.round(this.#idleMs / 1000)} seconds (timed out).`,
			};
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	/**
	 * Sends one very short request with the stored key and times it: it shows that the address, the key
	 * and the model work from this computer, and how long the provider takes to start answering. It
	 * uses a few tokens. Without `modelId`, the provider's cheapest model is asked. Not tried again on
	 * failure: the failure is the result.
	 */
	async ping(provider: string, modelId?: string): Promise<PingResult> {
		const listed = this.#models.getModels(provider);
		const model = modelId
			? this.#models.getModel(provider, modelId)
			: [...listed].sort((a, b) => a.cost.input - b.cost.input || a.id.localeCompare(b.id))[0];
		if (!model)
			throw invalid(`${provider} has no model ${modelId ?? ""}.`.replace(" .", "."), "model");
		if (!(await this.hasKey(provider))) {
			throw new YewError("missing-api-key", 400, `There is no API key for ${provider}.`, {
				provider,
			});
		}
		const started = Date.now();
		let firstMs: number | null = null;
		const limit = new AbortController();
		const timer = setTimeout(() => limit.abort(), PING_MS);
		try {
			const message = await this.#once(
				model,
				{ systemPrompt: "", messages: [{ role: "user", content: "ping", timestamp: started }] },
				{ cacheRetention: "none", maxRetries: 0, maxTokens: 16 },
				limit.signal,
				() => {
					firstMs ??= Date.now() - started;
				},
			);
			const totalMs = Date.now() - started;
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				return {
					ok: false,
					model: model.id,
					firstMs: null,
					totalMs,
					error: limit.signal.aborted
						? `No answer within ${PING_MS / 1000} seconds.`
						: plainError(message.errorMessage ?? "The request failed."),
				};
			}
			return { ok: true, model: model.id, firstMs: firstMs ?? totalMs, totalMs };
		} finally {
			clearTimeout(timer);
		}
	}

	/** True when a failed response means the conversation no longer fits the model's context window. */
	isContextOverflow(message: AssistantMessage, provider: string, model: string): boolean {
		const info = this.#models.getModel(provider, model);
		return isContextOverflow(
			message as import("@earendil-works/pi-ai").AssistantMessage,
			info?.contextWindow,
		);
	}
}
