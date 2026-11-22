import { readFileSync } from "node:fs";

// Read at run time rather than imported, so the compiled package finds it the same way the sources
// do: two folders up from this file, in both layouts.
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
	version: string;
};

export const NAME = "yew";
/** The product's name where people read it; `NAME` is the command's. */
export const PRODUCT = "Yew Harness";
export const VERSION: string = pkg.version;
/**
 * The version of the protocol sessions speak: the fields of letters, decision cards, permission
 * requests and finish_task. It goes up whenever one of them changes, so an evaluation can tell which
 * protocol a run used.
 */
export const PROTOCOL_VERSION = 2;
export const PUBLISHER = "Tenon AI";
export const WEBSITE = "https://tenonai.cn/";
