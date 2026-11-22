import { type ClipboardEvent, useState } from "react";
import type { AttachmentKind, AttachmentRef } from "../../../src/shared/messages.ts";
import { t, useLang } from "../i18n.ts";
import { Dialog } from "./dialog.tsx";
import { CloseIcon, ExportIcon, NotesIcon } from "./icons.tsx";
import { Button } from "./ui.tsx";

export const MAX_STAGED_ATTACHMENTS = 10;

export const ATTACHMENT_ACCEPT = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"application/pdf",
	".txt",
	".md",
	".markdown",
	".json",
	".csv",
	".tsv",
	".xml",
	".yaml",
	".yml",
	".toml",
	".log",
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".swift",
	".kt",
	".go",
	".rs",
	".rb",
	".java",
	".c",
	".h",
	".cpp",
	".css",
	".html",
	".sh",
	".sql",
	".ini",
	".conf",
].join(",");

export interface StagedAttachment {
	key: string;
	name: string;
	kind: AttachmentKind;
	size: number;
	previewUrl?: string;
	ref?: AttachmentRef;
	file?: File;
	uploading?: boolean;
	error?: string;
	pages?: number | null;
}

export function guessAttachmentKind(file: File): AttachmentKind {
	if (file.type.startsWith("image/")) return "image";
	if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) return "pdf";
	return "text";
}

export function formatAttachmentSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Extracts pasted files (such as screenshots from the clipboard) from a paste event. */
export function filesFromClipboard(event: ClipboardEvent): File[] {
	const files: File[] = [];
	const items = event.clipboardData?.items;
	if (!items) return files;
	for (const item of Array.from(items)) {
		if (item.kind !== "file") continue;
		const file = item.getAsFile();
		if (file) files.push(file);
	}
	return files;
}

export function StagedAttachmentStrip({
	items,
	onRemove,
}: {
	items: StagedAttachment[];
	onRemove: (key: string) => void;
}) {
	useLang();
	if (items.length === 0) return null;
	return (
		<ul className="staged-attachments" aria-label={t("attachmentsLabel")}>
			{items.map((item) => {
				const preview =
					item.previewUrl ??
					(item.ref && item.ref.kind === "image"
						? `/api/attachments/${item.ref.id}?thumb=1`
						: null);
				const pages = item.ref?.pages ?? item.pages;
				const meta = item.uploading
					? t("attachUploading")
					: item.error
						? item.error
						: [
								formatAttachmentSize(item.ref?.size ?? item.size),
								pages ? t("attachPages", { n: pages }) : null,
							]
								.filter(Boolean)
								.join(" · ");
				return (
					<li
						key={item.key}
						className={`staged-chip${item.error ? " staged-chip-error" : ""}${item.uploading ? " staged-chip-busy" : ""}`}
					>
						{preview ? (
							<img className="staged-thumb" src={preview} alt={item.name} />
						) : (
							<span className="staged-icon" aria-hidden="true">
								<NotesIcon />
							</span>
						)}
						<div className="staged-info">
							<span className="staged-name" title={item.name}>
								{item.name}
							</span>
							<span className="staged-meta">{meta}</span>
						</div>
						<Button
							variant="icon"
							className="staged-remove"
							aria-label={t("attachRemove", { name: item.name })}
							onClick={() => onRemove(item.key)}
						>
							<CloseIcon />
						</Button>
					</li>
				);
			})}
		</ul>
	);
}

/** Compact chips for attachments waiting in a queued message. */
export function QueuedAttachments({ attachments }: { attachments: AttachmentRef[] }) {
	if (attachments.length === 0) return null;
	return (
		<ul className="queued-attachments">
			{attachments.map((item) => (
				<li key={item.id} className="queued-attachment-chip">
					{item.kind === "image" ? (
						<img
							className="queued-attachment-thumb"
							src={`/api/attachments/${item.id}?thumb=1`}
							alt={item.name}
						/>
					) : (
						<NotesIcon />
					)}
					<span>{item.name}</span>
				</li>
			))}
		</ul>
	);
}

/** Attachments displayed inside a user's sent message in the transcript. */
export function MessageAttachments({ attachments }: { attachments: AttachmentRef[] }) {
	useLang();
	const [lightbox, setLightbox] = useState<AttachmentRef | null>(null);
	if (attachments.length === 0) return null;
	const images = attachments.filter((item) => item.kind === "image");
	const files = attachments.filter((item) => item.kind !== "image");
	return (
		<div className="msg-attachments">
			{images.length > 0 && (
				<div className={`msg-image-grid${images.length === 1 ? " msg-image-single" : ""}`}>
					{images.map((item) => (
						<button
							key={item.id}
							type="button"
							className="msg-image-button"
							aria-label={t("attachPreview", { name: item.name })}
							onClick={() => setLightbox(item)}
						>
							<img
								className="msg-image-thumb"
								src={`/api/attachments/${item.id}?thumb=1`}
								alt={item.name}
								loading="lazy"
							/>
						</button>
					))}
				</div>
			)}
			{files.length > 0 && (
				<ul className="msg-file-list">
					{files.map((item) => {
						const meta = [
							formatAttachmentSize(item.size),
							item.pages ? t("attachPages", { n: item.pages }) : null,
						]
							.filter(Boolean)
							.join(" · ");
						return (
							<li key={item.id} className="msg-file-chip">
								<span className="staged-icon" aria-hidden="true">
									<NotesIcon />
								</span>
								<div className="staged-info">
									<span className="staged-name" title={item.name}>
										{item.name}
									</span>
									<span className="staged-meta">{meta}</span>
								</div>
								<a
									className="btn btn-ghost btn-icon"
									href={`/api/attachments/${item.id}?download=1`}
									download={item.name}
									aria-label={t("attachDownload", { name: item.name })}
									title={t("attachDownload", { name: item.name })}
								>
									<ExportIcon />
								</a>
							</li>
						);
					})}
				</ul>
			)}
			{lightbox && (
				<Dialog
					title={lightbox.name}
					size="l"
					onClose={() => setLightbox(null)}
					footer={
						<div className="lightbox-footer">
							<span className="hint">
								{[
									lightbox.width && lightbox.height
										? `${lightbox.width} × ${lightbox.height}`
										: null,
									formatAttachmentSize(lightbox.size),
								]
									.filter(Boolean)
									.join(" · ")}
							</span>
							<a
								className="btn"
								href={`/api/attachments/${lightbox.id}?download=1`}
								download={lightbox.name}
							>
								<ExportIcon />
								{t("download")}
							</a>
						</div>
					}
				>
					<div className="lightbox-stage">
						<img
							className="lightbox-image"
							src={`/api/attachments/${lightbox.id}`}
							alt={lightbox.name}
						/>
					</div>
				</Dialog>
			)}
		</div>
	);
}
