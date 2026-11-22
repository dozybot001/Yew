import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolContext } from "../../src/server/tools/types.ts";
import { tempDir } from "./store.ts";

export const server = fileURLToPath(new URL("./mcp-server.mjs", import.meta.url));
export const ctx = { signal: new AbortController().signal, acceptsImages: false } as ToolContext;

export function home(servers: unknown) {
	const yewHome = tempDir("yew-home-");
	writeFileSync(join(yewHome, "mcp.json"), JSON.stringify({ mcpServers: servers }));
	return yewHome;
}

export const textOf = (result: { content: { type: string; text?: string }[] }) =>
	result.content.map((block) => block.text ?? "").join("");
