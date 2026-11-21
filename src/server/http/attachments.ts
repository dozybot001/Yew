import { Hono } from "hono";
import { type AttachmentStore, MAX_PDF_ATTACHMENT_BYTES } from "../attachments.ts";
import { invalid, YewError } from "../errors.ts";
import { optString, readJson, reqString } from "./input.ts";
import type { AppEnv } from "./problem.ts";

/** `filename` for old clients, `filename*` for the real name (RFC 6266 and 5987). */
function contentDisposition(inline: boolean, filename: string): string {
	const ascii = filename
		.replace(/[^\x20-\x7e]/g, "")
		.replace(/["\\]/g, "_")
		.trim();
	const fallback = ascii || "attachment";
	const encoded = encodeURIComponent(filename).replace(
		/['()*]/g,
		(ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Uploading and reading message attachments.
 * - `POST /api/sessions/:id/attachments` accepts `multipart/form-data` (browser/Mac app) or
 *   `application/json` `{ name, mimeType?, data (base64) }` (paired phones over the Noise channel).
 * - `GET /api/attachments/:id` serves raw bytes (`?thumb=1` for image previews, `?download=1` to
 *   force download), or `?format=json` `{ mimeType, name, data (base64) }` for paired phones.
 */
export function attachmentRoutes(attachments: AttachmentStore): Hono<AppEnv> {
	const app = new Hono<AppEnv>();

	app.post("/sessions/:id/attachments", async (c) => {
		const sessionId = c.req.param("id");
		const contentType = c.req.header("Content-Type") ?? "";

		let name: string;
		let mimeType: string | undefined;
		let data: Buffer;

		if (/^multipart\/form-data\b/i.test(contentType)) {
			const form = await c.req.formData().catch(() => {
				throw invalid("The multipart body could not be read.", "file");
			});
			const entry = form.get("file");
			if (!(entry instanceof File)) {
				throw invalid("Attach a file in the 'file' field.", "file");
			}
			if (entry.size > MAX_PDF_ATTACHMENT_BYTES) {
				throw invalid("The attachment is larger than 25 MB.", "file");
			}
			name = entry.name || "attachment";
			mimeType = entry.type || undefined;
			data = Buffer.from(await entry.arrayBuffer());
		} else if (/^application\/json\b/i.test(contentType)) {
			const fields = await readJson(c);
			name = reqString(fields, "name", 300);
			mimeType = optString(fields, "mimeType", 200);
			// Base64 expands by 4/3; cap raw encoded string accordingly.
			const raw = reqString(fields, "data", Math.ceil((MAX_PDF_ATTACHMENT_BYTES * 4) / 3) + 16);
			const cleaned = raw.replace(/\s+/g, "");
			if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
				throw invalid("data must be base64.", "data");
			}
			data = Buffer.from(cleaned, "base64");
		} else {
			throw new YewError(
				"unsupported-media-type",
				415,
				"Send the attachment as multipart/form-data or application/json.",
			);
		}

		const ref = await attachments.save(sessionId, {
			name,
			...(mimeType ? { mimeType } : {}),
			data,
		});
		return c.json(ref, 201);
	});

	app.get("/attachments/:id", async (c) => {
		const id = c.req.param("id");
		const thumb = c.req.query("thumb") === "1";
		const download = c.req.query("download") === "1";
		const jsonFormat = c.req.query("format") === "json";

		const loaded = thumb
			? await attachments.readThumbnail(id)
			: (() => {
					const { meta, data } = attachments.readBytes(id);
					return { meta, data, mimeType: meta.mimeType };
				})();

		if (jsonFormat) {
			return c.json({
				id: loaded.meta.id,
				name: loaded.meta.name,
				mimeType: loaded.mimeType,
				size: loaded.data.length,
				data: loaded.data.toString("base64"),
			});
		}

		const inline = loaded.meta.kind === "image" && !download;
		c.header("Content-Type", loaded.mimeType);
		c.header("Content-Disposition", contentDisposition(inline, loaded.meta.name));
		c.header("X-Content-Type-Options", "nosniff");
		return c.body(new Uint8Array(loaded.data));
	});

	app.delete("/sessions/:id/attachments/:attachmentId", (c) => {
		attachments.deletePending(c.req.param("id"), [c.req.param("attachmentId")]);
		return c.body(null, 204);
	});

	return app;
}
