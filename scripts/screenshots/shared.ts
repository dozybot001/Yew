import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type Lang = "zh" | "en";
export type Theme = "light" | "dark";
export const PICTURES = [
	"approval",
	"main",
	"letters",
	"permission",
	"models",
	"phone",
	"observer",
] as const;
export type Picture = (typeof PICTURES)[number];
export const WEB_ORDER: Picture[] = ["main", "permission", "approval", "letters", "observer"];
/**
 * The pictures a run without names makes. The observer's is made only when asked for: with her
 * watching, her remark is in the main conversation, which the other pictures show without it.
 */
export const USUAL: Picture[] = PICTURES.filter((picture) => picture !== "observer");

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const BIN = join(ROOT, "bin/yew.js");
export const BUNDLE_ID = "cn.tenonai.apps.yew";
export const SHOWN_MODEL = {
	provider: "deepseek",
	model: "deepseek-v4-pro",
	thinking: "high",
} as const;
/** Providers that get a placeholder key, so the provider list has some with keys and some without. */
export const WITH_KEYS = ["deepseek", "moonshotai-cn", "qwen-token-plan-cn", "zai-coding-cn"];
export const HOUR = 60 * 60 * 1000;
export const log = (line: string) => process.stderr.write(`${line}\n`);
export const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
