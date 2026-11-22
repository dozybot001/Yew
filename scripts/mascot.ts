/**
 * Turns the mascot's generated pictures into the files Yew shows.
 *
 * Poses: every <pose>.png in the source folder (by default ~/Pictures/素材/Yew/poses, where the
 * originals stay out of git) becomes web/public/mascot/<pose>.webp:
 * - the background goes: a picture with real transparency has its alpha snapped (nearly solid becomes
 *   solid, faint haze clear); a picture on a flat colour has that colour taken out, the whole colour
 *   when it is a strong one such as pure blue, otherwise only where it joins the border;
 * - only the figure stays: loose bits much smaller than her (emotion marks, specks) go, unless the
 *   pose keeps its marks;
 * - she is cropped and scaled onto the shared 373×400 canvas, centred and standing on its bottom
 *   edge, as large as fits, so a slot never jumps when the pose changes (some poses fit otherwise, see
 *   FIT);
 * - the WebP is written at the highest quality that stays within about 50 KB.
 *
 * The portrait (her full-length picture beside sessions and the home page) is cut the same way,
 * cropped to her and kept large, its long side at least 2400 pixels.
 *
 * The pixels are worked on in Google Chrome, which also encodes the WebP: headless, driven by
 * playwright-core, the copy in ~/.yew/mcp-builtin/node_modules as for scripts/screenshots.ts
 * (PLAYWRIGHT_CORE=<folder> points to another). Run it from the repository root:
 *
 *   node scripts/mascot.ts [pose…] [--from <folder>] [--to <folder>] [--preview <file.png>]
 *   node scripts/mascot.ts --portrait <file.png> [--out <file.webp>] [--preview <file.png>]
 *
 * --preview draws the results on Yew's light and dark backgrounds, to look at before committing.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const WIDTH = 373;
const HEIGHT = 400;
/** Pose files stay within about this size (the first ten are 41 to 49 KB). */
const POSE_BYTES = 50 * 1024;
const PORTRAIT_LONG_SIDE = 2400;
const PORTRAIT_BYTES = 300 * 1024;

/**
 * Poses that fit otherwise than centred, standing on the bottom edge and as tall as fits: `anchor`
 * puts her against the left edge (she leans in from it), `height` caps how tall she is drawn so a
 * close-up does not come out larger than the others, `marks` keeps her emotion marks.
 */
const FIT: Record<string, { anchor?: "left"; height?: number; marks?: boolean }> = {
	nap: { marks: true },
	peek: { anchor: "left" },
};

/** Yew's sidebar and page backgrounds, light and dark (web/src/styles/base.css). */
const BACKDROPS = ["#f9f9f9", "#ffffff", "#1f1f1f", "#181818"];

interface CutOptions {
	data: string;
	/** Drop loose pieces smaller than this share of the largest. */
	keep: number;
	/** Where the result goes: the pose canvas, or the portrait's own size. */
	fit:
		| { kind: "pose"; width: number; height: number; maxHeight: number; anchor: "centre" | "left" }
		| { kind: "portrait"; longSide: number };
	bytes: number;
}

interface CutResult {
	webp: string;
	width: number;
	height: number;
	quality: number;
	background: string;
	dropped: number;
}

/**
 * Runs inside the page, so it uses nothing from outside itself. Returns the WebP as base64.
 */
async function cut(options: CutOptions): Promise<CutResult> {
	const blob = await (await fetch(`data:image/png;base64,${options.data}`)).blob();
	const bitmap = await createImageBitmap(blob, {
		premultiplyAlpha: "none",
		colorSpaceConversion: "none",
	});
	const w = bitmap.width;
	const h = bitmap.height;
	const source = new OffscreenCanvas(w, h);
	const sourceContext = source.getContext("2d", { willReadFrequently: true });
	if (!sourceContext) throw new Error("no 2d context");
	sourceContext.drawImage(bitmap, 0, 0);
	const image = sourceContext.getImageData(0, 0, w, h);
	const px = image.data;
	const count = w * h;

	// 1. The background.
	let clearish = 0;
	for (let i = 0; i < count; i++) if ((px[i * 4 + 3] as number) < 250) clearish++;
	let background = "alpha";
	if (clearish > count * 0.05) {
		for (let i = 0; i < count; i++) {
			const a = px[i * 4 + 3] as number;
			px[i * 4 + 3] = a >= 240 ? 255 : a <= 12 ? 0 : a;
		}
	} else {
		// A flat colour: the median of the border.
		const border: number[][] = [];
		for (let x = 0; x < w; x += 4) border.push([x, 0], [x, h - 1]);
		for (let y = 0; y < h; y += 4) border.push([0, y], [w - 1, y]);
		const channel = (c: number) =>
			border
				.map(([x, y]) => px[((y as number) * w + (x as number)) * 4 + c] as number)
				.sort((a, b) => a - b)[border.length >> 1] as number;
		const key = [channel(0), channel(1), channel(2)] as const;
		background = `rgb(${key.join(",")})`;
		const distance = (i: number) =>
			Math.hypot(
				(px[i * 4] as number) - key[0],
				(px[i * 4 + 1] as number) - key[1],
				(px[i * 4 + 2] as number) - key[2],
			);
		const near = 40;
		const far = 110;
		// A strong colour that she never wears (pure blue) is taken out everywhere. White, grey or
		// black only where it joins the border, plus a two-pixel band of soft edge along it, so the
		// whites of her eyes and her dark outline stay.
		const strong = Math.max(...key) - Math.min(...key) > 150;
		const reach = new Uint8Array(count);
		if (strong) reach.fill(1);
		else {
			const stack: number[] = [];
			for (const [x, y] of border) stack.push((y as number) * w + (x as number));
			while (stack.length > 0) {
				const i = stack.pop() as number;
				if (reach[i] || distance(i) >= near) continue;
				reach[i] = 1;
				const x = i % w;
				if (x > 0) stack.push(i - 1);
				if (x < w - 1) stack.push(i + 1);
				if (i >= w) stack.push(i - w);
				if (i < count - w) stack.push(i + w);
			}
			for (let band = 2; band <= 3; band++) {
				for (let i = 0; i < count; i++) {
					if (reach[i] || distance(i) >= far) continue;
					const x = i % w;
					const y = (i - x) / w;
					let touches = false;
					for (let dy = -1; dy <= 1 && !touches; dy++) {
						for (let dx = -1; dx <= 1 && !touches; dx++) {
							const nx = x + dx;
							const ny = y + dy;
							if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
							const r = reach[ny * w + nx] as number;
							touches = r > 0 && r < band;
						}
					}
					if (touches) reach[i] = band;
				}
			}
		}
		for (let i = 0; i < count; i++) {
			if (!reach[i]) continue;
			const d = distance(i);
			const alpha = d <= near ? 0 : d >= far ? 1 : (d - near) / (far - near);
			if (alpha < 1) {
				// Take the background's share out of the colour, so edges carry no halo.
				for (let c = 0; c < 3; c++) {
					const value =
						((px[i * 4 + c] as number) - (1 - alpha) * (key[c] as number)) / Math.max(alpha, 0.01);
					px[i * 4 + c] = Math.max(0, Math.min(255, Math.round(value)));
				}
			}
			px[i * 4 + 3] = Math.round(alpha * (px[i * 4 + 3] as number));
		}
	}

	// 2. Only the figure: pieces of visible pixels, eight-connected; small loose ones go.
	const label = new Int32Array(count).fill(-1);
	const sizes: number[] = [];
	for (let start = 0; start < count; start++) {
		if (label[start] !== -1 || (px[start * 4 + 3] as number) === 0) continue;
		const id = sizes.length;
		let size = 0;
		const stack = [start];
		label[start] = id;
		while (stack.length > 0) {
			const i = stack.pop() as number;
			size++;
			const x = i % w;
			const y = (i - x) / w;
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const nx = x + dx;
					const ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
					const j = ny * w + nx;
					if (label[j] !== -1 || (px[j * 4 + 3] as number) === 0) continue;
					label[j] = id;
					stack.push(j);
				}
			}
		}
		sizes.push(size);
	}
	const largest = Math.max(0, ...sizes);
	let dropped = 0;
	let minX = w;
	let minY = h;
	let maxX = -1;
	let maxY = -1;
	for (let i = 0; i < count; i++) {
		const id = label[i] as number;
		if (id === -1) continue;
		if ((sizes[id] as number) < largest * options.keep) {
			px[i * 4 + 3] = 0;
			dropped++;
			continue;
		}
		const x = i % w;
		const y = (i - x) / w;
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}
	if (maxX < 0) throw new Error("nothing left after taking out the background");
	sourceContext.putImageData(image, 0, 0);
	const cropW = maxX - minX + 1;
	const cropH = maxY - minY + 1;

	// 3. Onto the canvas.
	let canvas: OffscreenCanvas;
	let dx: number;
	let dy: number;
	let scale: number;
	if (options.fit.kind === "pose") {
		const { width, height, maxHeight, anchor } = options.fit;
		const side = anchor === "left" ? 0 : 2;
		scale = Math.min((width - 2 * side) / cropW, maxHeight / cropH);
		canvas = new OffscreenCanvas(width, height);
		dx = anchor === "left" ? 0 : (width - cropW * scale) / 2;
		dy = height - 3 - cropH * scale;
	} else {
		scale = Math.max(1, options.fit.longSide / Math.max(cropW, cropH));
		canvas = new OffscreenCanvas(Math.round(cropW * scale), Math.round(cropH * scale));
		dx = 0;
		dy = 0;
	}
	const context = canvas.getContext("2d");
	if (!context) throw new Error("no 2d context");
	context.imageSmoothingEnabled = true;
	context.imageSmoothingQuality = "high";
	context.drawImage(source, minX, minY, cropW, cropH, dx, dy, cropW * scale, cropH * scale);

	// 4. WebP at the highest quality within the size.
	let low = 0.5;
	let high = 0.98;
	let best: Blob | null = null;
	let quality = low;
	for (let step = 0; step < 7; step++) {
		const q = (low + high) / 2;
		const out = await canvas.convertToBlob({ type: "image/webp", quality: q });
		if (out.size <= options.bytes) {
			best = out;
			quality = q;
			low = q;
		} else high = q;
	}
	if (!best) {
		best = await canvas.convertToBlob({ type: "image/webp", quality: 0.5 });
		quality = 0.5;
	}
	const bytes = new Uint8Array(await best.arrayBuffer());
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return {
		webp: btoa(binary),
		width: canvas.width,
		height: canvas.height,
		quality: Math.round(quality * 100) / 100,
		background,
		dropped,
	};
}

/** Runs inside the page: each picture on each backdrop, at the sidebar's size and twice that. */
async function sheet(input: {
	pictures: string[];
	backdrops: string[];
	height: number;
}): Promise<string> {
	const bitmaps = await Promise.all(
		input.pictures.map(async (data) =>
			createImageBitmap(await (await fetch(`data:image/webp;base64,${data}`)).blob()),
		),
	);
	const sizes = [input.height, input.height * 2];
	const gap = 8;
	const cell = (bitmap: ImageBitmap, height: number) =>
		Math.round((bitmap.width / bitmap.height) * height);
	const rowWidth = (height: number) =>
		gap + bitmaps.reduce((sum, bitmap) => sum + cell(bitmap, height) + gap, 0);
	const width = Math.max(...sizes.map(rowWidth));
	const total = input.backdrops.length * sizes.reduce((sum, size) => sum + size + gap * 2, 0);
	const canvas = new OffscreenCanvas(width, total);
	const context = canvas.getContext("2d");
	if (!context) throw new Error("no 2d context");
	context.imageSmoothingQuality = "high";
	let y = 0;
	for (const backdrop of input.backdrops) {
		for (const size of sizes) {
			context.fillStyle = backdrop;
			context.fillRect(0, y, width, size + gap * 2);
			let x = gap;
			for (const bitmap of bitmaps) {
				const w = cell(bitmap, size);
				context.drawImage(bitmap, x, y + gap, w, size);
				x += w + gap;
			}
			y += size + gap * 2;
		}
	}
	const bytes = new Uint8Array(
		await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer(),
	);
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

/** The little of playwright-core's API the script uses. */
interface Page {
	evaluate<T, A>(fn: (arg: A) => Promise<T>, arg: A): Promise<T>;
}

interface Browser {
	newPage(): Promise<Page>;
	close(): Promise<void>;
}

async function launchBrowser(): Promise<Browser> {
	const folder =
		process.env.PLAYWRIGHT_CORE ?? join(homedir(), ".yew/mcp-builtin/node_modules/playwright-core");
	const module = (await import(pathToFileURL(join(folder, "index.mjs")).href)) as {
		chromium: { launch(options: Record<string, unknown>): Promise<Browser> };
	};
	try {
		return await module.chromium.launch({ channel: "chrome", headless: true });
	} catch {
		// No Google Chrome: Playwright's own Chromium, if it is installed.
		return await module.chromium.launch({ headless: true });
	}
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			from: { type: "string", default: join(homedir(), "Pictures/素材/Yew/poses") },
			to: { type: "string", default: "web/public/mascot" },
			portrait: { type: "string" },
			out: { type: "string" },
			preview: { type: "string" },
		},
	});
	const browser = await launchBrowser();
	try {
		const page = await browser.newPage();
		const made: string[] = [];
		if (values.portrait) {
			const out = values.out ?? "web/public/mascot/portrait.webp";
			const result = await page.evaluate(cut, {
				data: readFileSync(values.portrait).toString("base64"),
				keep: 0.02,
				fit: { kind: "portrait", longSide: PORTRAIT_LONG_SIDE },
				bytes: PORTRAIT_BYTES,
			});
			writeFileSync(out, Buffer.from(result.webp, "base64"));
			made.push(result.webp);
			report(out, result);
		} else {
			const files = readdirSync(values.from).filter((name) => name.endsWith(".png"));
			const poses =
				positionals.length > 0 ? positionals : files.map((name) => basename(name, ".png"));
			for (const pose of poses) {
				if (!/^[a-z][a-z-]*$/.test(pose)) throw new Error(`not a pose name: ${pose}`);
				const fit = FIT[pose] ?? {};
				const out = join(values.to, `${pose}.webp`);
				const result = await page.evaluate(cut, {
					data: readFileSync(join(values.from, `${pose}.png`)).toString("base64"),
					keep: fit.marks ? 0.0005 : 0.02,
					fit: {
						kind: "pose",
						width: WIDTH,
						height: HEIGHT,
						maxHeight: fit.height ?? HEIGHT - 6,
						anchor: fit.anchor ?? "centre",
					},
					bytes: POSE_BYTES,
				});
				writeFileSync(out, Buffer.from(result.webp, "base64"));
				made.push(result.webp);
				report(out, result);
			}
		}
		if (values.preview && made.length > 0) {
			const png = await page.evaluate(sheet, { pictures: made, backdrops: BACKDROPS, height: 76 });
			writeFileSync(values.preview, Buffer.from(png, "base64"));
			process.stderr.write(`preview: ${values.preview}\n`);
		}
	} finally {
		await browser.close();
	}
}

function report(out: string, result: CutResult): void {
	const kb = Math.round(Buffer.from(result.webp, "base64").length / 102.4) / 10;
	process.stdout.write(
		`${out}  ${result.width}×${result.height}  ${kb} KB  quality ${result.quality}  background ${result.background}  dropped ${result.dropped} px\n`,
	);
}

await main();
