import { useEffect, useRef, useState } from "react";
import type { Session } from "../../../../src/shared/types.ts";
import { selectSession } from "../../actions.ts";
import { api } from "../../api.ts";
import { t, useLang } from "../../i18n.ts";
import { setState, useAppState } from "../../state.ts";
import { Snippet } from "../content.tsx";
import { FolderIcon, SearchIcon, TeamIcon } from "../icons.tsx";
import { shortPath, useWorkspaces } from "../workspaces.tsx";
import { closeDrawer } from "./parts.tsx";

interface SearchResult {
	sessions: Session[];
	hits: { sessionId: string; entryId: string; seq: number; snippet: string }[];
}

export function Search() {
	useLang();
	const [query, setQuery] = useState("");
	const [result, setResult] = useState<SearchResult | null>(null);
	const sessions = useAppState((state) => state.sessions);
	const groups = useAppState((state) => state.groups);
	const workspaces = useWorkspaces();
	// Teams and workspaces are few and already loaded; they are matched here, by name or folder.
	const needle = query.trim().toLowerCase();
	const teams = needle ? groups.filter((group) => group.name.toLowerCase().includes(needle)) : [];
	const places = needle
		? workspaces.filter(
				(workspace) =>
					workspace.name.toLowerCase().includes(needle) ||
					workspace.path.toLowerCase().includes(needle),
			)
		: [];
	const box = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const q = query.trim();
		if (!q) {
			setResult(null);
			return;
		}
		const timer = setTimeout(() => {
			void api<SearchResult>("GET", `/api/search?q=${encodeURIComponent(q)}&limit=20`).then(
				setResult,
				() => setResult(null),
			);
		}, 200);
		return () => clearTimeout(timer);
	}, [query]);
	useEffect(() => {
		const onDown = (event: MouseEvent) => {
			if (!box.current?.contains(event.target as Node)) setResult(null);
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, []);
	const done = () => {
		setQuery("");
		setResult(null);
		closeDrawer();
	};
	const open = (id: string) => {
		done();
		void selectSession(id);
	};
	return (
		<div className="sidebar-search" ref={box}>
			<div className="search-field">
				<SearchIcon />
				<input
					className="input"
					type="search"
					placeholder={t("search")}
					aria-label={t("search")}
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					onKeyDown={(event) => event.key === "Escape" && setQuery("")}
				/>
			</div>
			{result && (
				<section className="search-results" aria-label={t("searchResults")}>
					{result.sessions.length + result.hits.length + teams.length + places.length === 0 && (
						<p className="hint">{t("noResults")}</p>
					)}
					{teams.map((group) => (
						<button
							key={group.id}
							type="button"
							className="search-hit search-hit-row"
							onClick={() => {
								done();
								setState({ teamFilter: group.id });
							}}
						>
							<TeamIcon />
							<strong>{group.name}</strong>
							<span className="hint">{t("teams")}</span>
						</button>
					))}
					{places.map((workspace) => (
						<button
							key={workspace.id}
							type="button"
							className="search-hit search-hit-row"
							title={workspace.path}
							onClick={() => {
								done();
								setState({ homeFolder: workspace.path });
								void selectSession(null);
							}}
						>
							<FolderIcon />
							<strong>{workspace.name}</strong>
							<span className="hint">{shortPath(workspace.path)}</span>
						</button>
					))}
					{result.sessions.map((session) => (
						<button
							key={session.id}
							type="button"
							className="search-hit"
							onClick={() => open(session.id)}
						>
							<strong>{session.name}</strong>
						</button>
					))}
					{result.hits.map((hit) => (
						<button
							key={hit.entryId}
							type="button"
							className="search-hit"
							onClick={() => open(hit.sessionId)}
						>
							<span className="hint">{sessions[hit.sessionId]?.name ?? ""}</span>
							<br />
							<Snippet text={hit.snippet} />
						</button>
					))}
				</section>
			)}
		</div>
	);
}
