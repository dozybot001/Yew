import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { MAX_BYTES } from "./tools/process.ts";

/**
 * Offline PDF text extraction and scanned-page rasterization powered by Mozilla's PDF.js
 * (`pdfjs-dist`, Apache-2.0). Uses the package's bundled CMaps and standard fonts so CJK documents
 * work without network requests, and disables `eval` for untrusted input.
 */

const require = createRequire(import.meta.url);
const PDFJS_DIR = dirname(require.resolve("pdfjs-dist/package.json"));
const CMAP_URL = `${pathToFileURL(join(PDFJS_DIR, "cmaps")).href}/`;
const STANDARD_FONT_URL = `${pathToFileURL(join(PDFJS_DIR, "standard_fonts")).href}/`;

/** A page with fewer non-whitespace characters than this is treated as likely scanned/image-only. */
const SCANNED_CHAR_THRESHOLD = 20;
const MAX_RENDER_DIMENSION = 1600;
const DEFAULT_MAX_PAGES = 20;
const DEFAULT_MAX_SCANNED_IMAGES = 5;

export interface PdfImagePage {
	page: number;
	data: Buffer;
	mimeType: "image/png";
}

export interface PdfReadResult {
	totalPages: number;
	readPages: number[];
	text: string;
	images: PdfImagePage[];
	truncatedPages: boolean;
	truncatedBytes: boolean;
	scannedUnrenderedPages: number[];
}

interface NodeCanvasAndContext {
	canvas: { toBuffer(mime: "image/png"): Buffer };
	context: unknown;
}

interface PdfCanvasFactory {
	create(width: number, height: number): NodeCanvasAndContext;
	destroy(target: NodeCanvasAndContext): void;
}

/** True when `data` starts with the `%PDF-` signature. */
export function isPdfBuffer(data: Uint8Array): boolean {
	return (
		data.length >= 5 &&
		data[0] === 0x25 &&
		data[1] === 0x50 &&
		data[2] === 0x44 &&
		data[3] === 0x46 &&
		data[4] === 0x2d
	);
}

/**
 * Parses a page range like `"1-5"`, `"3"`, or `"1,3-4"` into sorted 1-based page numbers within
 * `1..totalPages`, capped to `maxPages`. Throws an Error on malformed or out-of-range specs.
 */
export function parsePageRange(
	spec: string | undefined,
	totalPages: number,
	maxPages = DEFAULT_MAX_PAGES,
): { pages: number[]; truncated: boolean } {
	if (totalPages <= 0) return { pages: [], truncated: false };
	if (!spec?.trim()) {
		const end = Math.min(totalPages, maxPages);
		return {
			pages: Array.from({ length: end }, (_, i) => i + 1),
			truncated: totalPages > maxPages,
		};
	}
	const picked = new Set<number>();
	for (const raw of spec.split(",")) {
		const part = raw.trim();
		if (!part) continue;
		const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
		if (range) {
			const start = Number(range[1]);
			const end = Number(range[2]);
			if (start < 1 || end < start || start > totalPages) {
				throw new Error(
					`Invalid page range "${part}". This PDF has ${totalPages} page${totalPages === 1 ? "" : "s"}.`,
				);
			}
			const cappedEnd = Math.min(end, totalPages);
			for (let p = start; p <= cappedEnd; p++) picked.add(p);
			continue;
		}
		if (/^\d+$/.test(part)) {
			const page = Number(part);
			if (page < 1 || page > totalPages) {
				throw new Error(
					`Page ${page} is out of range. This PDF has ${totalPages} page${totalPages === 1 ? "" : "s"}.`,
				);
			}
			picked.add(page);
			continue;
		}
		throw new Error(`Invalid pages specification "${spec}". Use forms like "1-5" or "1,3,5-8".`);
	}
	if (picked.size === 0) {
		throw new Error(`Invalid pages specification "${spec}". Use forms like "1-5" or "1,3,5-8".`);
	}
	const sorted = [...picked].sort((a, b) => a - b);
	return {
		pages: sorted.slice(0, maxPages),
		truncated: sorted.length > maxPages,
	};
}

function openPdf(data: Uint8Array) {
	// PDF.js transfers or mutates its input view; copy once so the caller's Buffer stays intact.
	const copy = new Uint8Array(data.byteLength);
	copy.set(data);
	return pdfjs.getDocument({
		data: copy,
		cMapUrl: CMAP_URL,
		cMapPacked: true,
		standardFontDataUrl: STANDARD_FONT_URL,
		useSystemFonts: false,
		// No isEvalSupported here: pdfjs 6 dropped the option along with its eval path; it builds
		// no code from a file's fonts or functions.
		verbosity: pdfjs.VerbosityLevel.ERRORS,
	});
}

/** The longest one PDF is read for; then its reading is stopped, so a hostile file cannot hold the service. */
const PDF_TIME_LIMIT_MS = 60_000;

function stopAfterLimit(task: { destroy(): Promise<void> }): NodeJS.Timeout {
	return setTimeout(() => void task.destroy().catch(() => {}), PDF_TIME_LIMIT_MS);
}

function formatTextItems(items: readonly unknown[]): string {
	let out = "";
	for (const raw of items) {
		if (!raw || typeof raw !== "object" || !("str" in raw)) continue;
		const item = raw as { str: string; hasEOL?: boolean };
		out += item.str;
		if (item.hasEOL) out += "\n";
		else if (item.str && !out.endsWith(" ") && !out.endsWith("\n")) out += " ";
	}
	return out
		.split("\n")
		.map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Returns the page count of a PDF document. */
export async function inspectPdf(data: Uint8Array): Promise<{ pages: number }> {
	const loadingTask = openPdf(data);
	const limit = stopAfterLimit(loadingTask);
	try {
		const doc = await loadingTask.promise;
		return { pages: doc.numPages };
	} finally {
		clearTimeout(limit);
		await loadingTask.destroy().catch(() => {});
	}
}

/**
 * Extracts text from the requested pages of a PDF. Pages with almost no extractable text are
 * detected as scanned; when `renderScanned` is true, up to `maxScannedImages` of them are rendered
 * as PNGs so a vision-capable model can read them.
 */
export async function readPdf(
	data: Uint8Array,
	options: {
		pages?: string;
		renderScanned?: boolean;
		maxPages?: number;
		maxBytes?: number;
		maxScannedImages?: number;
	} = {},
): Promise<PdfReadResult> {
	const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
	const maxBytes = options.maxBytes ?? MAX_BYTES;
	const maxScannedImages = options.maxScannedImages ?? DEFAULT_MAX_SCANNED_IMAGES;
	const loadingTask = openPdf(data);
	const limit = stopAfterLimit(loadingTask);
	try {
		const doc = await loadingTask.promise;
		const totalPages = doc.numPages;
		const { pages, truncated: truncatedPages } = parsePageRange(
			options.pages,
			totalPages,
			maxPages,
		);
		const sections: string[] = [];
		const readPages: number[] = [];
		const images: PdfImagePage[] = [];
		const scannedUnrenderedPages: number[] = [];
		let bytes = 0;
		let truncatedBytes = false;

		for (const pageNum of pages) {
			const page = await doc.getPage(pageNum);
			const content = await page.getTextContent();
			const pageText = formatTextItems(content.items);
			const nonSpace = pageText.replace(/\s+/g, "").length;
			let section: string;
			if (nonSpace < SCANNED_CHAR_THRESHOLD) {
				let rendered = false;
				if (options.renderScanned && images.length < maxScannedImages) {
					const png = await renderPageToPng(doc, page);
					if (png) {
						images.push({ page: pageNum, data: png, mimeType: "image/png" });
						rendered = true;
					}
				}
				if (rendered) {
					section = pageText
						? `--- Page ${pageNum} of ${totalPages} (rendered as image) ---\n${pageText}`
						: `--- Page ${pageNum} of ${totalPages} (scanned page, rendered as image) ---`;
				} else {
					scannedUnrenderedPages.push(pageNum);
					section = pageText
						? `--- Page ${pageNum} of ${totalPages} ---\n${pageText}`
						: `--- Page ${pageNum} of ${totalPages} (no extractable text; scanned page) ---`;
				}
			} else {
				section = `--- Page ${pageNum} of ${totalPages} ---\n${pageText}`;
			}
			const nextBytes = Buffer.byteLength(section) + 2;
			if (bytes + nextBytes > maxBytes && sections.length > 0) {
				truncatedBytes = true;
				break;
			}
			if (bytes + nextBytes > maxBytes) {
				const clipped = `${Buffer.from(section).subarray(0, maxBytes).toString("utf8")}\n[page text truncated at ${maxBytes} bytes]`;
				sections.push(clipped);
				readPages.push(pageNum);
				truncatedBytes = true;
				break;
			}
			sections.push(section);
			readPages.push(pageNum);
			bytes += nextBytes;
		}

		return {
			totalPages,
			readPages,
			text: sections.join("\n\n"),
			images,
			truncatedPages,
			truncatedBytes,
			scannedUnrenderedPages,
		};
	} finally {
		clearTimeout(limit);
		await loadingTask.destroy().catch(() => {});
	}
}

async function renderPageToPng(
	doc: { canvasFactory?: unknown },
	page: pdfjs.PDFPageProxy,
): Promise<Buffer | null> {
	const factory = doc.canvasFactory as PdfCanvasFactory | undefined;
	if (!factory || typeof factory.create !== "function") return null;
	const base = page.getViewport({ scale: 1.5 });
	const largest = Math.max(base.width, base.height);
	const scale = largest > MAX_RENDER_DIMENSION ? (1.5 * MAX_RENDER_DIMENSION) / largest : 1.5;
	const viewport = page.getViewport({ scale });
	const width = Math.max(1, Math.ceil(viewport.width));
	const height = Math.max(1, Math.ceil(viewport.height));
	let created: NodeCanvasAndContext | null = null;
	try {
		created = factory.create(width, height);
		if (!created?.canvas || typeof created.canvas.toBuffer !== "function") return null;
		const params = {
			canvas: created.canvas,
			canvasContext: created.context,
			viewport,
		} as unknown as Parameters<pdfjs.PDFPageProxy["render"]>[0];
		await page.render(params).promise;
		return created.canvas.toBuffer("image/png");
	} catch {
		return null;
	} finally {
		if (created) {
			try {
				factory.destroy(created);
			} catch {
				// Best-effort cleanup.
			}
		}
	}
}
