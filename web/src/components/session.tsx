import { useId, useState } from "react";
import type { Session } from "../../../src/shared/types.ts";
import { selectSession } from "../actions.ts";
import { formatCost, formatNumber, t, useLang } from "../i18n.ts";
import { setTranscriptDetail, type TranscriptState, useAppState } from "../state.ts";
import { Composer } from "./composer.tsx";
import { Capped } from "./content.tsx";
import { HomeView } from "./home.tsx";
import {
	ChevronIcon,
	CompactViewIcon,
	DetailedViewIcon,
	TodoActiveIcon,
	TodoDoneIcon,
	TodoIcon,
	TodoPendingIcon,
} from "./icons.tsx";
import { SessionClock, useSessionClock } from "./progress.tsx";
import { SidebarToggle } from "./sidebar-toggle.tsx";
import { Transcript } from "./transcript.tsx";
import { Button } from "./ui.tsx";
import { useWorkspaces, workspaceLabel } from "./workspaces.tsx";

/**
 * The header names the session; its actions live in the composer and in the sidebar's row menu. While
 * the session works or waits for the person, the time it has taken sits in the middle.
 */
function SessionHeader({
	session,
	transcript,
}: {
	session: Session;
	transcript: TranscriptState | null;
}) {
	useLang();
	const workspaces = useWorkspaces();
	const isMain = useAppState((state) => state.settings?.mainSessionId === session.id);
	const parentId = session.parentId;
	const parent = useAppState((state) =>
		parentId ? (state.sessions[parentId]?.name ?? null) : null,
	);
	const detailed = useAppState((state) => state.transcriptDetail);
	const tokens =
		session.usage.input + session.usage.output + session.usage.cacheRead + session.usage.cacheWrite;
	const clock = useSessionClock(session, transcript);
	return (
		<header className={`session-header${clock.text ? " session-header-clock" : ""}`}>
			<SidebarToggle />
			{/* The title takes the left; marks, status and usage sit on the right and give way first. */}
			<div className="session-title">
				<h1>{session.name}</h1>
			</div>
			<SessionClock clock={clock} />
			<div className="session-aside">
				{isMain && <span className="tag">{t("mainConversation")}</span>}
				{session.outcome && <span className="tag">{t(`outcome_${session.outcome}`)}</span>}
				{parentId && parent && (
					<button
						type="button"
						className="link-button session-parent"
						onClick={() => void selectSession(parentId)}
					>
						{t("openedBy", { name: parent })}
					</button>
				)}
				<span className="session-meta" title={session.cwd ?? undefined}>
					{t(`status_${session.status}`)} ·{" "}
					{session.cwd ? workspaceLabel(workspaces, session.cwd) : t("chat")} ·{" "}
					{t("tokens", { n: formatNumber(tokens) })} ·{" "}
					{t("cost", { n: formatCost(session.usage.cost) })}
				</span>
				<Button
					variant="icon"
					className={`view-mode-toggle${detailed ? " view-mode-detailed" : ""}`}
					aria-pressed={detailed}
					aria-label={t(detailed ? "transcriptViewDetailed" : "transcriptViewCompact")}
					title={t(detailed ? "transcriptViewDetailed" : "transcriptViewCompact")}
					onClick={() => setTranscriptDetail(!detailed)}
				>
					{detailed ? <DetailedViewIcon /> : <CompactViewIcon />}
				</Button>
			</div>
		</header>
	);
}

const TODO_MARKS = {
	pending: <TodoPendingIcon />,
	in_progress: <TodoActiveIcon />,
	done: <TodoDoneIcon />,
} as const;

/**
 * The session's task list as a card floating at the transcript's top right, so it never narrows the
 * conversation. Folded, it shows the progress and the task under way; opened, every task.
 */
function TodoCard({ session }: { session: Session }) {
	useLang();
	const [open, setOpen] = useState(false);
	const listId = useId();
	const todos = session.todos;
	if (todos.length === 0) return null;
	const done = todos.filter((todo) => todo.status === "done").length;
	const current = todos.find((todo) => todo.status === "in_progress");
	return (
		<aside className={open ? "todo-card open" : "todo-card"} aria-label={t("todoTitle")}>
			<button
				type="button"
				className="todo-toggle"
				aria-expanded={open}
				aria-controls={listId}
				onClick={() => setOpen(!open)}
			>
				<TodoIcon />
				<span className="todo-count">{t("todoProgress", { done, total: todos.length })}</span>
				{current && <span className="todo-current">{current.text}</span>}
				<ChevronIcon />
			</button>
			<Capped as="ol" id={listId} className="todo-list" hidden={!open} label={t("todoTitle")}>
				{todos
					.map((todo, position) => ({ ...todo, key: `todo-${position}` }))
					.map((todo) => (
						<li key={todo.key} className={`todo-${todo.status}`}>
							{TODO_MARKS[todo.status]}
							<span>{todo.text}</span>
						</li>
					))}
			</Capped>
		</aside>
	);
}

export function SessionView() {
	useLang();
	const selectedId = useAppState((state) => state.selectedId);
	const session = useAppState((state) =>
		state.selectedId ? state.sessions[state.selectedId] : undefined,
	);
	const transcript = useAppState((state) => state.transcript);
	if (!selectedId || !session) {
		return <HomeView />;
	}
	return (
		<main className="main">
			<SessionHeader
				session={session}
				transcript={transcript && transcript.sessionId === session.id ? transcript : null}
			/>
			<div className="session-body">
				{transcript && transcript.sessionId === session.id ? (
					<Transcript transcript={transcript} />
				) : (
					<p className="notice">{t("loading")}</p>
				)}
				<TodoCard session={session} />
			</div>
			{transcript && transcript.sessionId === session.id && (
				<Composer session={session} transcript={transcript} />
			)}
		</main>
	);
}
