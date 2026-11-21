import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StatementSync } from "node:sqlite";
import type { JsonObject } from "../shared/messages.ts";
import { ARTIFACT_KINDS, type Artifact, type ArtifactKind } from "../shared/types.ts";
import { conflict, invalid, notFound } from "./errors.ts";
import { newId } from "./ids.ts";
import type { Store } from "./store.ts";
import { errorResult, str, type ToolDefinition, type ToolResult, text } from "./tools/types.ts";

/**
 * Artifacts: what a session makes for the person to keep and
 * look at: a Markdown document, an HTML page, JSON data or a chart. Each belongs to the session
 * that made it and has versions; saving under the same name again adds one. The files are in Yew's
 * data folder, the list in the database.
 */

const EXTENSION: Record<ArtifactKind, string> = {
	markdown: "md",
	html: "html",
	json: "json",
	chart: "json",
};
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_PER_SESSION = 200;

interface ArtifactRow {
	id: string;
	session_id: string;
	name: string;
	kind: ArtifactKind;
	version: number;
	size: number;
	created_at: number;
	updated_at: number;
}

const toArtifact = (row: ArtifactRow): Artifact => ({
	id: row.id,
	sessionId: row.session_id,
	name: row.name,
	kind: row.kind,
	version: row.version,
	size: row.size,
	createdAt: row.created_at,
	updatedAt: row.updated_at,
});

/** A chart is data Yew draws itself: bars or lines over labels, a few series. */
export function checkChart(content: string): void {
	let chart: {
		type?: unknown;
		labels?: unknown;
		series?: unknown;
	};
	try {
		chart = JSON.parse(content);
	} catch {
		throw invalid("A chart is JSON: { type, labels, series }.", "content");
	}
	const labels = chart?.labels;
	const series = chart?.series;
	if (chart?.type !== "bar" && chart?.type !== "line") {
		throw invalid('A chart\'s type is "bar" or "line".', "content");
	}
	if (!Array.isArray(labels) || labels.length === 0 || labels.length > 200) {
		throw invalid("A chart has 1 to 200 labels.", "content");
	}
	if (labels.some((label) => typeof label !== "string" && typeof label !== "number")) {
		throw invalid("A chart's labels are text or numbers.", "content");
	}
	if (!Array.isArray(series) || series.length === 0 || series.length > 8) {
		throw invalid("A chart has 1 to 8 series.", "content");
	}
	for (const one of series) {
		const values = (one as { values?: unknown })?.values;
		if (
			typeof (one as { name?: unknown })?.name !== "string" ||
			!Array.isArray(values) ||
			values.length !== labels.length ||
			values.some((value) => typeof value !== "number" || !Number.isFinite(value))
		) {
			throw invalid(
				"Each series has a name and one number for every label: { name, values }.",
				"content",
			);
		}
	}
}

export class ArtifactStore {
	readonly #store: Store;
	readonly #folder: string;
	readonly #statements = new Map<string, StatementSync>();

	constructor(store: Store, yewHome: string) {
		this.#store = store;
		this.#folder = join(yewHome, "artifacts");
	}

	#q(sql: string): StatementSync {
		let statement = this.#statements.get(sql);
		if (!statement) {
			statement = this.#store.db.prepare(sql);
			this.#statements.set(sql, statement);
		}
		return statement;
	}

	#file(artifact: Pick<Artifact, "id" | "sessionId" | "kind">, version: number): string {
		return join(
			this.#folder,
			artifact.sessionId,
			artifact.id,
			`v${version}.${EXTENSION[artifact.kind]}`,
		);
	}

	/** Saves a version: the first under a new name, or the next of the artifact with that name. */
	save(sessionId: string, input: { name: string; kind: ArtifactKind; content: string }): Artifact {
		const name = input.name.trim().replace(/\s+/g, " ");
		if (!name || name.length > 120) throw invalid("The name is 1 to 120 characters.", "name");
		const size = Buffer.byteLength(input.content);
		if (size === 0) throw invalid("The content is empty.", "content");
		if (size > MAX_ARTIFACT_BYTES) throw invalid("An artifact can be at most 2 MB.", "content");
		if (input.kind === "chart") checkChart(input.content);
		if (input.kind === "json") {
			try {
				JSON.parse(input.content);
			} catch {
				throw invalid("The content is not valid JSON.", "content");
			}
		}
		const artifact = this.#store.tx(() => {
			const now = Date.now();
			const existing = this.#q("SELECT * FROM artifacts WHERE session_id = ? AND name = ?").get(
				sessionId,
				name,
			) as unknown as ArtifactRow | undefined;
			if (existing && existing.kind !== input.kind) {
				throw conflict(
					`"${name}" is already a ${existing.kind} artifact; save this one under another name.`,
					undefined,
					"artifact-kind",
				);
			}
			let id = existing?.id;
			const version = (existing?.version ?? 0) + 1;
			if (id) {
				this.#q("UPDATE artifacts SET version = ?, size = ?, updated_at = ? WHERE id = ?").run(
					version,
					size,
					now,
					id,
				);
			} else {
				const count = this.#q("SELECT COUNT(*) AS n FROM artifacts WHERE session_id = ?").get(
					sessionId,
				) as { n: number };
				if (count.n >= MAX_PER_SESSION) {
					throw conflict("This session already has 200 artifacts.", undefined, "artifact-limit");
				}
				id = newId();
				this.#q(
					`INSERT INTO artifacts (id, session_id, name, kind, version, size, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(id, sessionId, name, input.kind, version, size, now, now);
			}
			this.#q(
				"INSERT INTO artifact_versions (artifact_id, version, size, created_at) VALUES (?, ?, ?, ?)",
			).run(id, version, size, now);
			return this.get(id);
		});
		const file = this.#file(artifact, artifact.version);
		mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
		writeFileSync(file, input.content, { mode: 0o600 });
		this.#store.publish({ type: "artifact", artifact });
		return artifact;
	}

	get(id: string): Artifact {
		const row = this.#q("SELECT * FROM artifacts WHERE id = ?").get(id) as unknown as
			| ArtifactRow
			| undefined;
		if (!row) throw notFound("Artifact", id);
		return toArtifact(row);
	}

	/** Newest first; all of them, or one session's. */
	list(options: { sessionId?: string | null; limit: number }): Artifact[] {
		const rows = (options.sessionId
			? this.#q(
					"SELECT * FROM artifacts WHERE session_id = ? ORDER BY updated_at DESC, id LIMIT ?",
				).all(options.sessionId, options.limit)
			: this.#q("SELECT * FROM artifacts ORDER BY updated_at DESC, id LIMIT ?").all(
					options.limit,
				)) as unknown as ArtifactRow[];
		return rows.map(toArtifact);
	}

	versions(id: string): { version: number; size: number; createdAt: number }[] {
		const rows = this.#q(
			"SELECT version, size, created_at FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC",
		).all(id) as { version: number; size: number; created_at: number }[];
		return rows.map((row) => ({ version: row.version, size: row.size, createdAt: row.created_at }));
	}

	content(id: string, version: number): { artifact: Artifact; content: string } {
		const artifact = this.get(id);
		if (!Number.isInteger(version) || version < 1 || version > artifact.version) {
			throw notFound("Artifact version", `${id} v${version}`);
		}
		return { artifact, content: readFileSync(this.#file(artifact, version), "utf8") };
	}

	delete(id: string): void {
		const artifact = this.get(id);
		this.#q("DELETE FROM artifacts WHERE id = ?").run(id);
		rmSync(join(this.#folder, artifact.sessionId, id), { recursive: true, force: true });
		this.#store.publish({ type: "artifactDeleted", id });
	}

	/** The files of sessions that were deleted for good; their rows went with the sessions. */
	forgetSessions(sessionIds: string[]): void {
		for (const id of sessionIds) rmSync(join(this.#folder, id), { recursive: true, force: true });
	}
}

export function saveArtifactTool(artifacts: ArtifactStore): ToolDefinition {
	return {
		name: "save_artifact",
		description:
			'Save something you made for the person to keep and look at in Yew: a document (markdown), a page (html, self-contained: inline styles and scripts, no network access), data (json) or a chart. A chart is JSON: {"type":"bar"|"line","title":"…","labels":[…],"series":[{"name":"…","values":[…]}]}. Saving under a name this session already used adds a new version. Use it for results worth keeping, not for every reply.',
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "A short title, such as 周报 or Pricing options." },
				kind: { type: "string", enum: [...ARTIFACT_KINDS] },
				content: { type: "string", description: "The whole content of this version." },
			},
			required: ["name", "kind", "content"],
			additionalProperties: false,
		},
		readOnly: false,
		needsFolder: false,
		subject: () => ({ kind: "none" }),
		async run(args: JsonObject, ctx): Promise<ToolResult> {
			const kind = str(args, "kind", true) as ArtifactKind;
			if (!ARTIFACT_KINDS.includes(kind)) {
				return errorResult(`kind is one of: ${ARTIFACT_KINDS.join(", ")}.`);
			}
			try {
				const artifact = artifacts.save(ctx.session.id, {
					name: str(args, "name", true),
					kind,
					content: str(args, "content", true),
				});
				return {
					content: [
						text(
							`Saved "${artifact.name}" as version ${artifact.version}. The person can open it from this conversation and from the artifacts page.`,
						),
					],
					detail: {
						artifactId: artifact.id,
						name: artifact.name,
						kind: artifact.kind,
						version: artifact.version,
					},
				};
			} catch (error) {
				const status = (error as { status?: number }).status;
				if (status === 400 || status === 409) return errorResult((error as Error).message);
				throw error;
			}
		},
	};
}
