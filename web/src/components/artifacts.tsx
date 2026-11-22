import { useEffect, useId, useMemo, useState } from "react";
import type { Artifact } from "../../../src/shared/types.ts";
import { artifactText, artifactVersions, deleteArtifact, openArtifact } from "../actions/pages.ts";
import { selectSession } from "../actions.ts";
import { formatNumber, formatWhen, t, useLang } from "../i18n.ts";
import { useAppState } from "../state.ts";
import { Markdown } from "./content.tsx";
import { ConfirmDialog } from "./dialogs.tsx";
import { TrashIcon } from "./icons.tsx";
import { Mascot } from "./mascot.tsx";
import { SidebarToggle } from "./sidebar-toggle.tsx";
import { Button, ErrorBox, Select, useAction } from "./ui.tsx";

interface ChartData {
	type: "bar" | "line";
	title?: string;
	labels: (string | number)[];
	series: { name: string; values: number[] }[];
}

const W = 640;
const H = 300;
const PAD = { top: 16, right: 16, bottom: 36, left: 48 };
/** Series are told apart by pattern and shade, not by hue: the interface is black, white and gray. */
const SHADES = [1, 0.55, 0.3, 0.8, 0.42, 0.68, 0.2, 0.9];

/** A chart drawn as SVG from the artifact's data; no chart library. */
export function Chart({ data }: { data: ChartData }) {
	const all = data.series.flatMap((series) => series.values);
	const top = Math.max(0, ...all);
	const bottom = Math.min(0, ...all);
	const span = top - bottom || 1;
	const width = W - PAD.left - PAD.right;
	const height = H - PAD.top - PAD.bottom;
	const y = (value: number) => PAD.top + ((top - value) / span) * height;
	const slot = width / data.labels.length;
	const ticks = [top, (top + bottom) / 2, bottom];
	const every = Math.ceil(data.labels.length / 12);
	return (
		<figure className="chart">
			{data.title && <figcaption>{data.title}</figcaption>}
			<svg
				className="chart-svg"
				viewBox={`0 0 ${W} ${H}`}
				role="img"
				aria-label={data.title ?? t("artifactKind_chart")}
			>
				{ticks.map((tick) => (
					<g key={tick}>
						<line
							className="chart-grid"
							x1={PAD.left}
							x2={W - PAD.right}
							y1={y(tick)}
							y2={y(tick)}
						/>
						<text className="chart-tick" x={PAD.left - 6} y={y(tick) + 4} textAnchor="end">
							{formatNumber(Math.round(tick * 100) / 100)}
						</text>
					</g>
				))}
				{data.labels.map(
					(label, i) =>
						i % every === 0 && (
							<text
								// biome-ignore lint/suspicious/noArrayIndexKey: labels may repeat; their position is their identity
								key={i}
								className="chart-tick"
								x={PAD.left + slot * (i + 0.5)}
								y={H - PAD.bottom + 16}
								textAnchor="middle"
							>
								{String(label).slice(0, 12)}
							</text>
						),
				)}
				{data.series.map((series, s) =>
					data.type === "bar" ? (
						<g key={series.name} opacity={SHADES[s % SHADES.length]}>
							{series.values.map((value, i) => {
								const bar = (slot * 0.8) / data.series.length;
								return (
									<rect
										// biome-ignore lint/suspicious/noArrayIndexKey: one bar per label position
										key={i}
										className="chart-bar"
										x={PAD.left + slot * (i + 0.1) + bar * s}
										y={Math.min(y(value), y(0))}
										width={Math.max(1, bar - 1)}
										height={Math.abs(y(value) - y(0))}
									>
										<title>{`${series.name} · ${data.labels[i]}: ${formatNumber(value)}`}</title>
									</rect>
								);
							})}
						</g>
					) : (
						<polyline
							key={series.name}
							className="chart-line"
							opacity={SHADES[s % SHADES.length]}
							strokeDasharray={s === 0 ? undefined : `${4 + s * 2} ${3}`}
							points={series.values
								.map((value, i) => `${PAD.left + slot * (i + 0.5)},${y(value)}`)
								.join(" ")}
						/>
					),
				)}
			</svg>
			{data.series.length > 1 && (
				<ul className="chart-legend">
					{data.series.map((series, s) => (
						<li key={series.name}>
							<span className="chart-swatch" style={{ opacity: SHADES[s % SHADES.length] }} />
							{series.name}
						</li>
					))}
				</ul>
			)}
			<details className="chart-table">
				<summary>{t("chartData")}</summary>
				<table>
					<thead>
						<tr>
							<th />
							{data.series.map((series) => (
								<th key={series.name}>{series.name}</th>
							))}
						</tr>
					</thead>
					<tbody>
						{data.labels.map((label, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: one row per label position
							<tr key={i}>
								<th>{String(label)}</th>
								{data.series.map((series) => (
									<td key={series.name}>{formatNumber(series.values[i] ?? 0)}</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</details>
		</figure>
	);
}

/** One version of an artifact, drawn by its kind. HTML runs shut in: its own origin, no requests. */
function ArtifactBody({ artifact, version }: { artifact: Artifact; version: number }) {
	const [content, setContent] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		setContent(null);
		setFailed(false);
		if (artifact.kind === "html") return;
		let current = true;
		artifactText(artifact.id, version)
			.then((text) => current && setContent(text))
			.catch(() => current && setFailed(true));
		return () => {
			current = false;
		};
	}, [artifact.id, artifact.kind, version]);
	if (artifact.kind === "html") {
		return (
			<iframe
				className="artifact-frame"
				title={artifact.name}
				sandbox="allow-scripts"
				referrerPolicy="no-referrer"
				src={`/artifact-view/${artifact.id}/${version}`}
			/>
		);
	}
	if (failed) return <p className="hint">{t("artifactUnreadable")}</p>;
	if (content === null) return <p className="hint">{t("loading")}</p>;
	if (artifact.kind === "markdown") {
		return (
			<div className="artifact-text">
				<Markdown text={content} />
			</div>
		);
	}
	if (artifact.kind === "chart") {
		try {
			return <Chart data={JSON.parse(content) as ChartData} />;
		} catch {
			return <p className="hint">{t("artifactUnreadable")}</p>;
		}
	}
	let pretty = content;
	try {
		pretty = JSON.stringify(JSON.parse(content), null, 2);
	} catch {
		// Shown as it was saved.
	}
	return <pre className="artifact-json">{pretty}</pre>;
}

function ArtifactViewer({ artifact }: { artifact: Artifact }) {
	const sessionName = useAppState((state) => state.sessions[artifact.sessionId]?.name);
	const [version, setVersion] = useState(artifact.version);
	const [versions, setVersions] = useState<{ version: number; createdAt: number }[]>([]);
	const [deleting, setDeleting] = useState(false);
	const label = useId();
	// A new version that arrives while the artifact is open is shown.
	useEffect(() => {
		setVersion(artifact.version);
		artifactVersions(artifact.id)
			.then(setVersions)
			.catch(() => setVersions([]));
	}, [artifact.id, artifact.version]);
	const remove = useAction(() => deleteArtifact(artifact.id));
	return (
		<section className="artifact-viewer" aria-labelledby={label}>
			<header className="artifact-head">
				<div className="artifact-title">
					<h2 id={label}>{artifact.name}</h2>
					<span className="session-meta">
						{t(`artifactKind_${artifact.kind}`)}
						{sessionName && (
							<>
								{" · "}
								<button
									type="button"
									className="link-button"
									onClick={() => void selectSession(artifact.sessionId)}
								>
									{sessionName}
								</button>
							</>
						)}
					</span>
				</div>
				<div className="artifact-actions">
					{versions.length > 1 && (
						<>
							<span id={`${label}-v`} className="visually-hidden">
								{t("artifactVersion")}
							</span>
							<Select
								labelledBy={`${label}-v`}
								value={String(version)}
								options={versions.map((v) => ({
									value: String(v.version),
									label: t("artifactVersionN", { n: v.version }),
									hint: formatWhen(v.createdAt),
								}))}
								onChange={(value) => setVersion(Number(value))}
							/>
						</>
					)}
					<a
						className="btn"
						href={`/api/artifacts/${artifact.id}/versions/${version}`}
						download={`${artifact.name}.${artifact.kind === "markdown" ? "md" : artifact.kind === "html" ? "html" : "json"}`}
					>
						{t("download")}
					</a>
					<Button variant="danger" onClick={() => setDeleting(true)}>
						<TrashIcon />
						{t("delete")}
					</Button>
				</div>
			</header>
			<ErrorBox error={remove.error} />
			<ArtifactBody artifact={artifact} version={version} />
			{deleting && (
				<ConfirmDialog
					title={t("artifactDeleteTitle", { name: artifact.name })}
					body={t("artifactDeleteBody")}
					confirmLabel={t("delete")}
					onClose={() => setDeleting(false)}
					onConfirm={() => remove.run()}
				/>
			)}
		</section>
	);
}

/** Everything sessions saved for you to look at, newest first; one is open beside the list. */
export function ArtifactsPage() {
	useLang();
	const artifacts = useAppState((state) => state.artifacts);
	const openId = useAppState((state) => state.artifactId);
	const sessions = useAppState((state) => state.sessions);
	const list = useMemo(
		() => (artifacts ? [...artifacts].sort((a, b) => b.updatedAt - a.updatedAt) : null),
		[artifacts],
	);
	const open = list?.find((artifact) => artifact.id === openId) ?? null;
	return (
		<main className="main center-main">
			<header className="session-header">
				<SidebarToggle />
				<div className="session-title">
					<h1>{t("artifacts")}</h1>
					{list && list.length > 0 && (
						<span className="session-meta">{t("artifactsCount", { n: list.length })}</span>
					)}
				</div>
			</header>
			<div
				className="center-body"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll area must be reachable by keyboard
				tabIndex={0}
			>
				<div className={`center-inner artifacts${open ? " artifacts-open" : ""}`}>
					{!list ? (
						<p className="hint">{t("loading")}</p>
					) : list.length === 0 ? (
						<div className="empty-state">
							<Mascot pose="writing" height={96} />
							<p className="empty-box">{t("artifactsEmpty")}</p>
						</div>
					) : (
						<ul className="artifact-list">
							{list.map((artifact) => (
								<li key={artifact.id}>
									<button
										type="button"
										className="artifact-row"
										aria-current={artifact.id === openId ? "true" : undefined}
										onClick={() => openArtifact(artifact.id)}
									>
										<span className="artifact-name">{artifact.name}</span>
										<span className="artifact-meta">
											{[
												t(`artifactKind_${artifact.kind}`),
												sessions[artifact.sessionId]?.name,
												artifact.version > 1
													? t("artifactVersionN", { n: artifact.version })
													: null,
												formatWhen(artifact.updatedAt),
											]
												.filter(Boolean)
												.join(" · ")}
										</span>
									</button>
								</li>
							))}
						</ul>
					)}
					{open && <ArtifactViewer key={open.id} artifact={open} />}
				</div>
			</div>
		</main>
	);
}

/** In a conversation: the artifact a save_artifact call made, as a button that opens it. */
export function ArtifactChip({
	id,
	name,
	kind,
	version,
}: {
	id: string;
	name: string;
	kind: string;
	version: number;
}) {
	useLang();
	return (
		<button type="button" className="artifact-chip" onClick={() => openArtifact(id)}>
			<span className="artifact-name">{name}</span>
			<span className="artifact-meta">
				{t(`artifactKind_${kind}` as "artifactKind_markdown")}
				{version > 1 ? ` · ${t("artifactVersionN", { n: version })}` : ""}
			</span>
		</button>
	);
}
