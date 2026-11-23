import { realpathSync } from "node:fs";
import { Agents } from "../../src/server/agent/runner.ts";
import { MemoryKeyStore } from "../../src/server/keys.ts";
import { ModelGateway } from "../../src/server/model/gateway.ts";
import { type fauxAssistantMessage, fauxProvider } from "../../src/server/model/testing.ts";
import { PermissionEngine } from "../../src/server/permissions/engine.ts";
import type { ToolDefinition } from "../../src/server/tools/types.ts";
import { newStore, tempDir } from "./store.ts";

type Context = { messages: { role: string; content: unknown; toolsAdded?: { name: string }[] }[] };

export function setup(
	options: {
		cwd?: boolean;
		key?: boolean;
		retry?: { maxRetries: number; baseDelayMs: number };
		idleMs?: number;
		maxSteps?: number;
		tools?: ToolDefinition[];
		/** Have a model read the end of each reply for a question to the person. */
		readReplies?: boolean;
		/** What the model costs, in US dollars per million tokens; nothing when not given. */
		cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	} = {},
) {
	const faux = fauxProvider(
		options.cost ? { models: [{ id: "tide-5", cost: options.cost }] } : undefined,
	);
	const { store } = newStore();
	const keys = new MemoryKeyStore(options.key === false ? {} : { [faux.provider.id]: "test-key" });
	const gateway = new ModelGateway({
		keys,
		version: "0.0.0",
		providers: [faux.provider],
		...(options.retry ? { retry: options.retry } : {}),
		...(options.idleMs ? { idleMs: options.idleMs } : {}),
	});
	const home = realpathSync(tempDir("yew-home-"));
	const cwd = options.cwd === false ? null : realpathSync(tempDir("yew-cwd-"));
	const agents = new Agents({
		store,
		gateway,
		permissions: new PermissionEngine(home),
		home,
		version: "0.0.0",
		draftIntervalMs: 0,
		log: () => {},
		...(options.maxSteps ? { maxSteps: options.maxSteps } : {}),
		...(options.tools ? { tools: options.tools } : {}),
		...(options.readReplies ? { readReplies: true } : {}),
	});
	const session = store.createSession({
		name: "test",
		kind: "task",
		provider: faux.provider.id,
		model: faux.getModel().id,
		cwd,
		thinking: "off",
	});
	const contexts: Context[] = [];
	const capture = (reply: ReturnType<typeof fauxAssistantMessage>) => (context: unknown) => {
		contexts.push(structuredClone(context) as Context);
		return reply;
	};
	return { faux, store, agents, session, cwd: cwd as string, home, contexts, capture };
}
