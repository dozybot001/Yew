import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { UsageDay, UsageDetail, UsageOverview } from "../../../src/shared/types.ts";
import { loadUsage, loadUsageDay } from "../actions/pages.ts";
import { selectSession } from "../actions.ts";
import { formatCost, formatNumber, getLang, t, useLang } from "../i18n.ts";
import { useAppState } from "../state.ts";
import { RetryIcon } from "./icons.tsx";
import { SidebarToggle } from "./sidebar-toggle.tsx";
import { Button, ErrorBox } from "./ui.tsx";

const DAYS = 30;
const H = 200;
const PAD = { top: 14, right: 8, bottom: 26, left: 44 };

/** A calendar day (YYYY-MM-DD) as people write it: "11月16日周一", "Mon, Nov 16". */
function formatDay(day: string, weekday = false): string {
	const [year, month, date] = day.split("-").map(Number);
	return new Intl.DateTimeFormat(getLang() === "zh" ? "zh-CN" : "en-US", {
		month: getLang() === "zh" ? "long" : "short",
		day: "numeric",
		...(weekday ? { weekday: "short" } : {}),
	}).format(new Date(year ?? 0, (month ?? 1) - 1, date ?? 1));
}

/** The top of the cost axis: the first of 1, 2, 5, 10 times a power of ten that holds every bar. */
function axisTop(most: number): number {
	if (most <= 0) return 1;
	const power = 10 ** Math.floor(Math.log10(most));
	const step = [1, 2, 5, 10].find((n) => n * power >= most * (1 - 1e-9)) ?? 10;
	return Math.max(0.01, step * power);
}

function formatTick(value: number, top: number): string {
	return new Intl.NumberFormat(getLang() === "zh" ? "zh-CN" : "en-US", {
		maximumFractionDigits: top < 0.1 ? 3 : 2,
	}).format(value);
}

/**
 * Cost per day as bars, drawn at the width of its container so the labels keep their size. The bars
 * are a picture; under them lies one button per day, which is what the pointer and the keyboard reach.
 */
function CostChart({
	days,
	budget,
	selected,
	onSelect,
}: {
	days: UsageDay[];
	budget: number | null;
	selected: string;
	onSelect: (day: string) => void;
}) {
	const box = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(640);
	useLayoutEffect(() => {
		const element = box.current;
		if (!element) return;
		setWidth(element.clientWidth);
		const observer = new ResizeObserver(() => setWidth(element.clientWidth));
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	const top = axisTop(Math.max(0, ...days.map((day) => day.cost)));
	const plotW = Math.max(1, width - PAD.left - PAD.right);
	const plotH = H - PAD.top - PAD.bottom;
	const base = PAD.top + plotH;
	const y = (value: number) => PAD.top + (1 - value / top) * plotH;
	const slot = plotW / days.length;
	const bar = Math.max(1, Math.min(slot - 1, slot * 0.7));
	const last = days.length - 1;
	const middle = Math.floor(last / 2);
	// The first, middle and last day are named; with one or two days, none of them twice.
	const labels = (
		[
			[0, "start", PAD.left],
			[middle, "middle", PAD.left + slot * (middle + 0.5)],
			[last, "end", PAD.left + plotW],
		] as const
	).filter(([index, anchor]) =>
		anchor === "start" ? true : anchor === "end" ? last > 0 : index > 0 && index < last,
	);
	const limit = budget !== null && budget <= top ? budget : null;
	return (
		<div className="usage-chart" ref={box} style={{ height: H }}>
			<div
				className="usage-hits"
				style={{ left: PAD.left, width: plotW, top: PAD.top, height: plotH + 6 }}
			>
				{days.map((day) => (
					<button
						key={day.day}
						type="button"
						className="usage-hit"
						aria-pressed={day.day === selected}
						aria-label={t("usageBar", { day: formatDay(day.day), n: formatCost(day.cost) })}
						title={t("usageBar", { day: formatDay(day.day), n: formatCost(day.cost) })}
						onClick={() => onSelect(day.day)}
					/>
				))}
			</div>
			<svg className="usage-svg" width={width} height={H} aria-hidden="true">
				{[top, top / 2].map((tick) => (
					<line
						key={tick}
						className="chart-grid"
						x1={PAD.left}
						x2={PAD.left + plotW}
						y1={y(tick)}
						y2={y(tick)}
					/>
				))}
				{[top, top / 2, 0].map((tick) => (
					<text key={tick} className="chart-tick" x={PAD.left - 8} y={y(tick) + 4} textAnchor="end">
						{formatTick(tick, top)}
					</text>
				))}
				{days.map((day, i) => {
					const height = day.cost > 0 ? Math.max(1, base - y(day.cost)) : 0;
					const x = PAD.left + slot * i + (slot - bar) / 2;
					const on = day.day === selected;
					return (
						<g key={day.day}>
							{height > 0 && (
								<rect
									className={`usage-bar${on ? " usage-bar-on" : ""}`}
									x={x}
									y={base - height}
									width={bar}
									height={height}
								/>
							)}
							{on && <rect className="usage-bar-on" x={x} y={base + 3} width={bar} height={2} />}
						</g>
					);
				})}
				<line className="usage-base" x1={PAD.left} x2={PAD.left + plotW} y1={base} y2={base} />
				{limit !== null && (
					<>
						<line
							className="usage-limit"
							x1={PAD.left}
							x2={PAD.left + plotW}
							y1={y(limit)}
							y2={y(limit)}
						/>
						<text
							className="chart-tick usage-limit-label"
							x={PAD.left + plotW}
							y={y(limit) - 4}
							textAnchor="end"
						>
							{t("usageLimitLine")}
						</text>
					</>
				)}
				{labels.map(([index, anchor, x]) => (
					<text key={anchor} className="chart-tick" x={x} y={H - 6} textAnchor={anchor}>
						{formatDay(days[index]?.day ?? "")}
					</text>
				))}
			</svg>
		</div>
	);
}

/** Today's spending against the daily limit for all sessions. */
function Today({ spent, budget }: { spent: number; budget: number | null }) {
	const left = budget === null ? 0 : budget - spent;
	return (
		<section className="usage-today">
			<div className="usage-figure">
				<span className="hint">{t("usageToday")}</span>
				<strong>{t("cost", { n: formatCost(spent) })}</strong>
			</div>
			{budget === null ? (
				<p className="hint">{t("usageNoLimit")}</p>
			) : (
				<>
					<p className="hint">
						{t("usageOfLimit", { limit: formatCost(budget) })}
						{" · "}
						{left >= 0
							? t("usageLeft", { n: formatCost(left) })
							: t("usageOver", { n: formatCost(-left) })}
					</p>
					{/* The sentence above says the same in words, so the meter is only a picture. */}
					<div className="usage-meter" aria-hidden="true">
						<span style={{ width: `${Math.min(100, Math.max(0, (spent / budget) * 100))}%` }} />
					</div>
				</>
			)}
		</section>
	);
}

function DayTable({ detail }: { detail: UsageDetail }) {
	const sum = (pick: (row: UsageDetail["sessions"][number]) => number) =>
		detail.sessions.reduce((total, row) => total + pick(row), 0);
	return (
		<div
			className="usage-table-wrap"
			// biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll area must be reachable by keyboard
			tabIndex={0}
		>
			<table className="usage-table">
				<thead>
					<tr>
						<th scope="col">{t("usageSession")}</th>
						<th scope="col">{t("usageCost")}</th>
						<th scope="col">{t("usageInput")}</th>
						<th scope="col">{t("usageOutput")}</th>
						<th scope="col">{t("usageCacheRead")}</th>
					</tr>
				</thead>
				<tbody>
					{detail.sessions.map((row) => (
						<tr key={row.sessionId}>
							<th scope="row">
								<button
									type="button"
									className="link-button usage-name"
									onClick={() => void selectSession(row.sessionId)}
								>
									{row.name}
								</button>
								{row.archived && <span className="hint"> · {t("archived")}</span>}
							</th>
							<td>{formatCost(row.cost)}</td>
							<td>{formatNumber(row.input)}</td>
							<td>{formatNumber(row.output)}</td>
							<td>{formatNumber(row.cacheRead)}</td>
						</tr>
					))}
				</tbody>
				<tfoot>
					<tr>
						<th scope="row">{t("usageTotal")}</th>
						<td>{formatCost(detail.total)}</td>
						<td>{formatNumber(sum((row) => row.input))}</td>
						<td>{formatNumber(sum((row) => row.output))}</td>
						<td>{formatNumber(sum((row) => row.cacheRead))}</td>
					</tr>
				</tfoot>
			</table>
		</div>
	);
}

/**
 * What the sessions cost: today against the daily limit, each of the last 30
 * days as a bar, and the sessions of the day you pick. A page of its own, like scheduled tasks.
 */
export function UsagePage() {
	useLang();
	const [overview, setOverview] = useState<UsageOverview | null>(null);
	const [detail, setDetail] = useState<UsageDetail | null>(null);
	const [picked, setPicked] = useState<string | null>(null);
	const [error, setError] = useState<unknown>(null);
	const [tries, setTries] = useState(0);
	const heading = useId();
	// Every model request changes its session's cost, and a deleted session takes its usage with it:
	// either moves this sum, and the page reads its numbers again. A new limit does the same.
	const spent = useAppState((state) =>
		Object.values(state.sessions).reduce((total, session) => total + session.usage.cost, 0),
	);
	const budget = useAppState((state) => state.settings?.dailyBudget ?? null);
	const day = picked ?? overview?.today ?? null;

	// biome-ignore lint/correctness/useExhaustiveDependencies: spent, budget and tries are what make it read again
	useEffect(() => {
		let current = true;
		loadUsage(DAYS)
			.then((result) => {
				if (!current) return;
				setOverview(result);
				setError(null);
			})
			.catch((failure) => current && setError(failure));
		return () => {
			current = false;
		};
	}, [spent, budget, tries]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: spent and tries are what make it read again
	useEffect(() => {
		if (!day) return;
		let current = true;
		loadUsageDay(day)
			.then((result) => {
				if (!current) return;
				setDetail(result);
				setError(null);
			})
			.catch((failure) => current && setError(failure));
		return () => {
			current = false;
		};
	}, [day, spent, tries]);

	const today = overview?.days.find((row) => row.day === overview.today);
	const shown = detail && detail.day === day ? detail : null;
	return (
		<main className="main center-main">
			<header className="session-header">
				<SidebarToggle />
				<div className="session-title">
					<h1>{t("usage")}</h1>
				</div>
			</header>
			<div
				className="center-body"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll area must be reachable by keyboard
				tabIndex={0}
			>
				<div className="center-inner usage">
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
					{!overview || !day ? (
						!error && <p className="hint">{t("loading")}</p>
					) : (
						<>
							<Today spent={today?.cost ?? 0} budget={overview.budget} />
							<section className="usage-section" aria-label={t("usageChart", { n: DAYS })}>
								<p className="hint">{t("usageChart", { n: DAYS })}</p>
								<CostChart
									days={overview.days}
									budget={overview.budget}
									selected={day}
									onSelect={setPicked}
								/>
							</section>
							<section className="usage-section" aria-labelledby={heading}>
								<h2 id={heading} className="usage-day">
									{formatDay(day, true)}
									{day === overview.today && (
										<span className="hint usage-note"> · {t("today")}</span>
									)}
								</h2>
								{!shown ? (
									!error && <p className="hint">{t("loading")}</p>
								) : shown.sessions.length === 0 ? (
									<p className="empty-box">{t("usageDayEmpty")}</p>
								) : (
									<DayTable detail={shown} />
								)}
							</section>
						</>
					)}
				</div>
			</div>
		</main>
	);
}
