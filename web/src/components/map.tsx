import { useEffect, useId, useState } from "react";
import type { Group, LetterFlow, Session } from "../../../src/shared/types.ts";
import { loadMap, selectSession } from "../actions.ts";
import { t, useLang } from "../i18n.ts";
import {
	ARROW_LEN,
	ARROW_W,
	COUNT_H,
	type FlowRoute,
	HEAD_H,
	layoutMap,
	MARK_W,
	NODE_H,
	NODE_W,
	openedPath,
	pairParts,
	pickFlows,
} from "../map-layout.ts";
import { blockedSessions } from "../progress.ts";
import { useAppState } from "../state.ts";
import { ChatIcon, CodeIcon, RetryIcon } from "./icons.tsx";
import { SidebarToggle } from "./session.tsx";
import { Button, ErrorBox } from "./ui.tsx";

/** The picture draws letter lines for this many pairs, the busiest ones. */
const FLOW_LIMIT = 10;

/** Half the height of the mark beside a count that points the way its letters went. */
const MARK_HALF = 3.5;

/**
 * The count on a letter line. Letters one way: the number. Both ways: two numbers side by side, the
 * letters that went left on the left and the ones that went right on the right, each with a small
 * mark on its outer side pointing that way.
 */
function FlowCount({ flow }: { flow: FlowRoute }) {
	const { label } = flow;
	if (!label) return null;
	const y = label.y + 4;
	if (flow.back === 0) {
		return (
			<text className="chart-tick map-flow-count" x={label.x} y={y} textAnchor="middle">
				{flow.count}
			</text>
		);
	}
	const [left, right] = label.forward ? [flow.back, flow.count] : [flow.count, flow.back];
	const at = pairParts(left, right, label.x);
	/** A mark with its base at `base`, pointing left (-1) or right (1). */
	const mark = (base: number, toward: 1 | -1) =>
		`M${base + toward * MARK_W} ${label.y}L${base} ${label.y - MARK_HALF}V${label.y + MARK_HALF}Z`;
	return (
		<>
			<rect
				className="map-flow-ground"
				x={at.x0}
				y={label.y - COUNT_H / 2}
				width={at.x1 - at.x0}
				height={COUNT_H}
			/>
			<path className="map-flow-mark" d={mark(at.leftMark, -1)} />
			<text className="chart-tick map-flow-count" x={at.leftEnd} y={y} textAnchor="end">
				{left}
			</text>
			<text className="chart-tick map-flow-count" x={at.rightStart} y={y} textAnchor="start">
				{right}
			</text>
			<path className="map-flow-mark" d={mark(at.rightMark, 1)} />
		</>
	);
}

/** The statuses a dot stands for, in the order the caption explains them. */
const DOTS = ["working", "waiting", "error", "needs_review"] as const;

/** What a session shows as its status: its own, or "waiting for you" while a card of its own waits. */
function shownStatus(session: Session, blocked: ReadonlySet<string>): Session["status"] {
	return session.status === "idle" && blocked.has(session.id) ? "waiting" : session.status;
}

/** A session in words: its name, then team, kind, status, the main conversation and who opened it. */
function useDescribe(sessions: Record<string, Session>, groups: Group[], mainId: string | null) {
	const blocked = useAppState((state) => state.center);
	const waiting = blockedSessions(Object.values(blocked.approvals), Object.values(blocked.cards));
	const facts = (session: Session): string[] => {
		const team = groups.find((group) => group.id === session.groupId)?.name;
		const opener = session.parentId ? sessions[session.parentId] : undefined;
		return [
			...(session.id === mainId ? [t("mainConversation")] : []),
			team ?? t("mapHeading_none"),
			session.cwd ? t("mode_code") : t("mode_chat"),
			t(`status_${shownStatus(session, waiting)}`),
			...(opener && opener.archivedAt === null ? [t("openedBy", { name: opener.name })] : []),
		];
	};
	return { facts, waiting };
}

/**
 * All sessions in one picture: who opened whom, where the letters of the last 24 hours went, and what
 * each session is doing. A page of its own, like usage. The lines are a picture: every session on it
 * is a button whose name says its team, its status and who opened it, and the letters are listed in
 * words for a screen reader.
 */
export function MapPage() {
	useLang();
	const all = useAppState((state) => state.sessions);
	const groups = useAppState((state) => state.groups);
	const mainId = useAppState((state) => state.settings?.mainSessionId ?? null);
	// Every letter that is sent or changes state moves this, and the lines are read again.
	const tick = useAppState((state) => state.letterTick);
	const [flows, setFlows] = useState<LetterFlow[] | null>(null);
	const [error, setError] = useState<unknown>(null);
	const [tries, setTries] = useState(0);
	// The session under the pointer or with the focus: its letter lines stay, the others fade.
	const [active, setActive] = useState<string | null>(null);
	const marker = useId();
	const { facts, waiting } = useDescribe(all, groups, mainId);
	const live = Object.values(all).filter((session) => session.archivedAt === null);
	// A session that is archived or restored takes its letters off the map or brings them back.
	const count = live.length;

	// biome-ignore lint/correctness/useExhaustiveDependencies: tick, count and tries are what make it read again
	useEffect(() => {
		let current = true;
		loadMap()
			.then((result) => {
				if (!current) return;
				setFlows(result.letters);
				setError(null);
			})
			.catch((failure) => current && setError(failure));
		return () => {
			current = false;
		};
	}, [tick, count, tries]);

	const onMap = new Set(live.map((session) => session.id));
	const { drawn, hidden } = pickFlows(flows ?? [], onMap, FLOW_LIMIT);
	const listed = (flows ?? []).filter((flow) => onMap.has(flow.from) && onMap.has(flow.to));
	// The lines are laid out with the sessions: a gap that carries many of them grows wider.
	const layout = layoutMap(live, groups, mainId, drawn);
	const at = new Map(layout.nodes.map((node) => [node.id, node]));
	return (
		<main className="main center-main">
			<header className="session-header">
				<SidebarToggle />
				<div className="session-title">
					<h1>{t("map")}</h1>
				</div>
			</header>
			<div
				className="center-body"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll area must be reachable by keyboard
				tabIndex={0}
			>
				<div className="map-page">
					{error ? (
						<>
							<ErrorBox error={error} />
							<div>
								<Button onClick={() => setTries((n) => n + 1)}>
									<RetryIcon /> {t("retry")}
								</Button>
							</div>
						</>
					) : null}
					{live.length === 0 ? (
						<p className="empty-box">{t("mapEmpty")}</p>
					) : (
						<>
							<div className="map-caption">
								<p className="hint">
									{t("mapCaption")}
									{hidden > 0 ? ` ${t("mapCapped", { n: FLOW_LIMIT, m: hidden })}` : ""}
								</p>
								<ul className="map-legend hint">
									{DOTS.map((status) => (
										<li key={status}>
											<span className={`dot row-dot dot-${status}`} aria-hidden="true" />
											{t(`status_${status}`)}
										</li>
									))}
								</ul>
							</div>
							{/* biome-ignore lint/a11y/useSemanticElements: a fieldset would add a border and a legend; the group only names the scroll area */}
							<div
								className="map-scroll"
								role="group"
								aria-label={t("mapPicture")}
								// biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll area must be reachable by keyboard
								tabIndex={0}
							>
								<div className="map-canvas" style={{ width: layout.width, height: layout.height }}>
									<svg
										className="map-lines"
										width={layout.width}
										height={layout.height}
										aria-hidden="true"
									>
										<defs>
											<marker
												id={marker}
												markerWidth={ARROW_LEN}
												markerHeight={ARROW_W}
												refX={ARROW_LEN - 0.5}
												refY={ARROW_W / 2}
												orient="auto-start-reverse"
												markerUnits="userSpaceOnUse"
											>
												<path
													className="map-arrow"
													d={`M0 0L${ARROW_LEN} ${ARROW_W / 2}L0 ${ARROW_W}Z`}
												/>
											</marker>
										</defs>
										{layout.nodes.map((node) => {
											const parent = node.parentId ? at.get(node.parentId) : undefined;
											return parent ? (
												<path key={node.id} className="map-opened" d={openedPath(parent, node)} />
											) : null;
										})}
										{layout.flows.map((flow) => {
											const faded = active !== null && flow.from !== active && flow.to !== active;
											return (
												<g
													key={`${flow.from}>${flow.to}`}
													className={faded ? "map-faded" : undefined}
												>
													<path
														className="map-flow"
														d={flow.d}
														markerStart={flow.back > 0 ? `url(#${marker})` : undefined}
														markerEnd={`url(#${marker})`}
													/>
													<FlowCount flow={flow} />
												</g>
											);
										})}
									</svg>
									{layout.headings.map((heading) => (
										<span
											// A group that continues in the other bank has its heading in both.
											key={`${heading.kind}:${heading.groupId ?? ""}:${heading.x}`}
											className="map-head"
											style={{
												left: heading.x,
												top: heading.y,
												width: heading.width,
												height: HEAD_H,
											}}
										>
											{heading.kind === "team"
												? (groups.find((group) => group.id === heading.groupId)?.name ?? "")
												: t(`mapHeading_${heading.kind}`)}
										</span>
									))}
									{layout.nodes.map((node) => {
										const session = all[node.id];
										if (!session) return null;
										const status = shownStatus(session, waiting);
										const words = [session.name, ...facts(session)].join(t("hintSeparator"));
										return (
											<button
												key={node.id}
												type="button"
												className="map-node"
												data-main={session.id === mainId ? "true" : undefined}
												// The main conversation lies across the top, its name in the middle.
												data-bar={node.width > NODE_W ? "true" : undefined}
												style={{ left: node.x, top: node.y, width: node.width, height: NODE_H }}
												aria-label={words}
												title={words}
												onClick={() => void selectSession(session.id)}
												onPointerEnter={() => setActive(session.id)}
												onPointerLeave={() => setActive(null)}
												onFocus={() => setActive(session.id)}
												onBlur={() => setActive(null)}
											>
												<span className="session-icon" aria-hidden="true">
													{session.cwd ? <CodeIcon /> : <ChatIcon />}
												</span>
												<span className="map-node-name">{session.name}</span>
												{status !== "idle" && (
													<span className={`dot row-dot dot-${status}`} aria-hidden="true" />
												)}
											</button>
										);
									})}
								</div>
							</div>
							{listed.length > 0 && (
								<ul className="visually-hidden" aria-label={t("mapLetters")}>
									{listed.map((flow) => (
										<li key={`${flow.from}>${flow.to}`}>
											{t("mapFlow", {
												from: all[flow.from]?.name ?? "",
												to: all[flow.to]?.name ?? "",
												n: flow.count,
											})}
										</li>
									))}
								</ul>
							)}
						</>
					)}
				</div>
			</div>
		</main>
	);
}
