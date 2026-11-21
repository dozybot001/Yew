import type { Session } from "../../../src/shared/types.ts";
import { formatClock, formatElapsed, t } from "../i18n.ts";
import { SUMMARY_KINDS, type Tally, turnProgress, waitingOn } from "../progress.ts";
import { type TranscriptState, useAppState } from "../state.ts";
import { useNow } from "./ui.tsx";

/** "读取 6 个文件，运行 4 条命令，编辑 2 处": tool calls counted by kind; empty when there are none. */
export function tallyText({ counts, others }: Tally): string {
	const parts = SUMMARY_KINDS.filter((kind) => counts[kind]).map((kind) => {
		const n = counts[kind] ?? 0;
		return t(n === 1 ? `sum_${kind}_one` : `sum_${kind}`, { n });
	});
	if (others > 0) parts.push(t(others === 1 ? "sum_other_one" : "sum_other", { n: others }));
	// "Read 1 file, ran 2 commands": only the first part keeps its capital (Chinese has none).
	return parts
		.map((part, index) => (index === 0 ? part : part.charAt(0).toLowerCase() + part.slice(1)))
		.join(t("listSeparator"));
}

/** What the middle of a session's header shows. */
export interface Clock {
	/** The words on screen; empty while the session is idle. */
	text: string;
	/** What a screen reader hears instead of the ticking time: when the turn or the wait began. */
	spoken: string;
	/** While a failed model request is tried again: the error, shown on hover. */
	retry: string | null;
}

/**
 * How long this turn has taken while the session works, or how long it has waited for the person;
 * while a failed model request is about to be tried again, that instead.
 * What the turn did is counted in the conversation's folded line, so it is not repeated here.
 */
export function useSessionClock(session: Session, transcript: TranscriptState | null): Clock {
	const cards = useAppState((state) => state.center.cards);
	const approvals = useAppState((state) => state.center.approvals);
	const working = session.status === "working";
	// A session that works on while a card of its own waits shows its work; the card is in the center.
	const wait = working
		? null
		: waitingOn(session.id, Object.values(approvals), Object.values(cards));
	const turn = working && transcript ? turnProgress(transcript.entries, transcript.draft) : null;
	const since = wait ? wait.since : (turn?.startedAt ?? null);
	const now = useNow(since === null ? 0 : 1000);
	const retry = working ? (transcript?.retry ?? null) : null;
	if (retry) {
		return {
			text: t("clockRetrying", { s: retry.seconds, n: retry.attempt, of: retry.of }),
			spoken: "",
			retry: retry.text,
		};
	}
	if (since === null) return { text: "", spoken: "", retry: null };
	const time = formatElapsed(Math.max(0, now - since));
	return wait
		? {
				text: t("clockWaited", { t: time }),
				spoken: t("progressSince", { time: formatClock(since) }),
				retry: null,
			}
		: {
				text: t("progressSpent", { t: time }),
				spoken: t("progressStarted", { time: formatClock(since) }),
				retry: null,
			};
}

/**
 * The middle of a session's header. It is always in the page, empty while the session is idle, so a
 * screen reader hears it as soon as a turn or a wait begins or a retry is announced; the ticking time
 * itself is kept from it.
 */
export function SessionClock({ clock }: { clock: Clock }) {
	return (
		<div className="session-clock">
			<span
				role="status"
				className={clock.retry === null ? "visually-hidden" : undefined}
				title={clock.retry || undefined}
			>
				{clock.retry === null ? clock.spoken : clock.text}
			</span>
			{clock.retry === null && clock.text && <span aria-hidden="true">{clock.text}</span>}
		</div>
	);
}
