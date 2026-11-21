import { Parser } from "htmlparser2";

const SKIP = new Set([
	"script",
	"style",
	"noscript",
	"svg",
	"template",
	"iframe",
	"canvas",
	"object",
	"head",
]);
const BLOCK = new Set([
	"p",
	"div",
	"section",
	"article",
	"main",
	"header",
	"footer",
	"aside",
	"nav",
	"figure",
	"figcaption",
	"form",
	"fieldset",
	"details",
	"summary",
	"dl",
	"dt",
	"dd",
	"address",
]);

/**
 * Converts HTML to readable Markdown with htmlparser2, without a browser engine.
 * Scripts, styles and embedded frames are dropped; links and images keep absolute URLs.
 */
export function htmlToMarkdown(html: string, baseUrl: string): { title: string; markdown: string } {
	const out: string[] = [];
	let title = "";
	let inTitle = false;
	let skipDepth = 0;
	let preDepth = 0;
	const lists: { ordered: boolean; index: number }[] = [];
	const links: { href: string; start: number }[] = [];
	let row: string[] | null = null;
	let cell: string[] | null = null;
	let headerRow = false;
	let tableRows = 0;

	const write = (value: string) => {
		if (cell) cell.push(value);
		else out.push(value);
	};
	const newline = (count = 1) => {
		if (cell) {
			cell.push(" ");
			return;
		}
		const tail = out.join("").slice(-2);
		const have = tail.endsWith("\n\n") ? 2 : tail.endsWith("\n") ? 1 : 0;
		if (out.length === 0) return;
		out.push("\n".repeat(Math.max(0, count - have)));
	};
	const absolute = (href: string) => {
		try {
			return new URL(href, baseUrl).toString();
		} catch {
			return href;
		}
	};

	const parser = new Parser(
		{
			onopentag(name, attrs) {
				if (name === "title") inTitle = true;
				if (SKIP.has(name) || skipDepth > 0) {
					if (SKIP.has(name)) skipDepth++;
					return;
				}
				if (/^h[1-6]$/.test(name)) {
					newline(2);
					write(`${"#".repeat(Number(name[1]))} `);
				} else if (BLOCK.has(name)) newline(2);
				else if (name === "br") write(preDepth > 0 ? "\n" : "  \n");
				else if (name === "hr") {
					newline(2);
					write("---");
					newline(2);
				} else if (name === "pre") {
					newline(2);
					write("```\n");
					preDepth++;
				} else if (name === "code" && preDepth === 0) write("`");
				else if (name === "strong" || name === "b") write("**");
				else if (name === "em" || name === "i") write("*");
				else if (name === "blockquote") {
					newline(2);
					write("> ");
				} else if (name === "ul" || name === "ol") {
					newline(1);
					lists.push({ ordered: name === "ol", index: 0 });
				} else if (name === "li") {
					newline(1);
					const list = lists.at(-1);
					const indent = "  ".repeat(Math.max(0, lists.length - 1));
					if (list?.ordered) {
						list.index++;
						write(`${indent}${list.index}. `);
					} else write(`${indent}- `);
				} else if (name === "a") {
					const href = attrs.href ?? "";
					if (href && !href.startsWith("javascript:")) {
						links.push({ href: absolute(href), start: out.length });
						write("[");
					}
				} else if (name === "img") {
					const src = attrs.src;
					if (src) write(`![${attrs.alt ?? ""}](${absolute(src)})`);
				} else if (name === "table") {
					newline(2);
					tableRows = 0;
				} else if (name === "tr") {
					row = [];
					headerRow = false;
				} else if (name === "td" || name === "th") {
					cell = [];
					if (name === "th") headerRow = true;
				}
			},
			ontext(data) {
				if (inTitle) {
					title += data;
					return;
				}
				if (skipDepth > 0) return;
				if (preDepth > 0) write(data);
				else write(data.replace(/\s+/g, " "));
			},
			onclosetag(name) {
				if (name === "title") inTitle = false;
				if (SKIP.has(name)) {
					skipDepth = Math.max(0, skipDepth - 1);
					return;
				}
				if (skipDepth > 0) return;
				if (/^h[1-6]$/.test(name) || BLOCK.has(name) || name === "blockquote") newline(2);
				else if (name === "pre") {
					preDepth = Math.max(0, preDepth - 1);
					write("\n```");
					newline(2);
				} else if (name === "code" && preDepth === 0) write("`");
				else if (name === "strong" || name === "b") write("**");
				else if (name === "em" || name === "i") write("*");
				else if (name === "ul" || name === "ol") {
					lists.pop();
					newline(1);
				} else if (name === "a") {
					const link = links.pop();
					if (link) write(`](${link.href})`);
				} else if ((name === "td" || name === "th") && cell && row) {
					row.push(cell.join("").trim().replace(/\|/g, "\\|"));
					cell = null;
				} else if (name === "tr" && row) {
					if (row.length > 0) {
						out.push(`| ${row.join(" | ")} |\n`);
						if (tableRows === 0 && headerRow) out.push(`|${row.map(() => " --- ").join("|")}|\n`);
						tableRows++;
					}
					row = null;
				} else if (name === "table") newline(2);
			},
		},
		{ decodeEntities: true, lowerCaseTags: true },
	);
	parser.write(html);
	parser.end();
	const markdown = out
		.join("")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { title: title.replace(/\s+/g, " ").trim(), markdown };
}
