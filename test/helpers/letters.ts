import { realpathSync } from "node:fs";
import { Agents } from "../../src/server/agent/runner.ts";
import { MemoryKeyStore } from "../../src/server/keys.ts";
import { ModelGateway } from "../../src/server/model/gateway.ts";
import {
	fauxAssistantMessage,
	fauxProvider,
	type fauxToolCall,
} from "../../src/server/model/testing.ts";
import { PermissionEngine } from "../../src/server/permissions/engine.ts";
import type { NewSession } from "../../src/server/store.ts";
import type { Entry, Session } from "../../src/shared/types.ts";
import { newStore, tempDir } from "./store.ts";

type Reply = ReturnType<typeof fauxAssistantMessage>;
export type Context = {
	messages: { role: string; content: unknown; toolsAdded?: { name: string }[] }[];
};
type Step = Reply | ((context: Context) => Reply | Promise<Reply>);

export const textOf = (value: unknown) => JSON.stringify(value);
export const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) =>
	fauxAssistantMessage(calls, { stopReason: "toolUse" });

/**
 * Several sessions share one scripted model. Each request is answered from the script of the session
 * that asks, found by the name its system prompt starts with, so turns can interleave freely.
 */
export function harness(options: { waitMs?: number; dbPath?: string } = {}) {
	const faux = fauxProvider();
	const { store } = newStore(options.dbPath);
	const keys = new MemoryKeyStore({ [faux.provider.id]: "test-key" });
	const gateway = new ModelGateway({ keys, version: "0.0.0", providers: [faux.provider] });
	const home = realpathSync(tempDir("yew-home-"));
	const folder = realpathSync(tempDir("yew-cwd-"));
	const agents = new Agents({
		store,
		gateway,
		permissions: new PermissionEngine(home),
		home,
		version: "0.0.0",
		draftIntervalMs: 0,
		log: () => {},
		waitMs: options.waitMs ?? 3000,
	});
	const scripts = new Map<string, Step[]>();
	const seen = new Map<string, Context[]>();
	const router = (context: unknown): Reply | Promise<Reply> => {
		const copy = structuredClone(context) as Context;
		const system = String(copy.messages.find((m) => m.role === "system")?.content ?? "");
		const name = /^You are "([^"]+)"/.exec(system)?.[1] ?? "";
		seen.set(name, [...(seen.get(name) ?? []), copy]);
		const step = scripts.get(name)?.shift();
		if (!step) return fauxAssistantMessage(`(${name} has no more replies)`);
		return typeof step === "function" ? step(copy) : step;
	};
	faux.setResponses(Array.from({ length: 300 }, () => router) as never);
	const make = (name: string, extra: Partial<NewSession> = {}): Session =>
		store.createSession({
			name,
			kind: "standing",
			provider: faux.provider.id,
			model: faux.getModel().id,
			cwd: folder,
			thinking: "off",
			options: { permissionMode: "default" },
			...extra,
		});
	const script = (session: Session, steps: Step[]) => scripts.set(session.name, steps);
	const entries = (session: Session): Entry[] =>
		store.listEntries(session.id, { limit: 200 }).entries;
	const said = (session: Session) =>
		entries(session)
			.filter((entry) => entry.role === "assistant")
			.map((entry) => textOf(entry));
	return { faux, store, agents, make, script, seen, entries, said, folder, home };
}

export async function until(check: () => boolean, ms = 4000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > ms) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

export const lastTool = (context: Context | undefined) => textOf(context?.messages.at(-1));
