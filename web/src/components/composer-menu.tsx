import {
	type KeyboardEvent,
	type RefObject,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	loadSessionSkills,
	type SessionFileMatch,
	type SessionSkillItem,
	searchSessionFiles,
} from "../actions.ts";
import { t, useLang } from "../i18n.ts";
import { isImeEvent } from "../ime.ts";
import { useAppState } from "../state.ts";
import { CompactIcon, FolderIcon, RenewIcon, SkillsIcon, TeamIcon } from "./icons.tsx";

export type ComposerCommand = "compact" | "renew";

interface Trigger {
	kind: "at" | "slash";
	start: number;
	end: number;
	query: string;
}

export type MenuItem =
	| {
			id: string;
			section: "sessions";
			kind: "session";
			label: string;
			detail?: string;
			insert: string;
	  }
	| {
			id: string;
			section: "files";
			kind: "file";
			label: string;
			detail?: string;
			insert: string;
	  }
	| {
			id: string;
			section: "commands";
			kind: "command";
			command: ComposerCommand;
			label: string;
			detail: string;
	  }
	| {
			id: string;
			section: "skills";
			kind: "skill";
			label: string;
			detail?: string;
			insert: string;
	  };

function detectTrigger(text: string, caret: number, allowSlash: boolean): Trigger | null {
	const pos = Math.max(0, Math.min(caret, text.length));
	const before = text.slice(0, pos);
	if (allowSlash) {
		const slash = /^\/([^\s]*)$/.exec(before);
		if (slash) {
			return { kind: "slash", start: 0, end: pos, query: slash[1] ?? "" };
		}
	}
	const at = /(?:^|\s)@([^\s@]*)$/.exec(before);
	if (at) {
		const query = at[1] ?? "";
		return { kind: "at", start: pos - query.length - 1, end: pos, query };
	}
	return null;
}

export interface UseComposerMenuOptions {
	sessionId: string | null;
	hasFolders: boolean;
	working: boolean;
	hasContext: boolean;
	text: string;
	caret: number;
	setText: (next: string) => void;
	setCaret: (next: number) => void;
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	onCommand?: (command: ComposerCommand) => void;
}

export interface ComposerMenuController {
	open: boolean;
	listId: string;
	items: MenuItem[];
	activeIndex: number;
	setActiveIndex: (index: number) => void;
	pick: (item: MenuItem) => void;
	dismiss: () => void;
	onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

/**
 * Unified `@` (sessions + workspace/extraDir files) and `/` (commands + enabled skills) autocomplete
 * for the composer.
 */
export function useComposerMenu(options: UseComposerMenuOptions): ComposerMenuController {
	const {
		sessionId,
		hasFolders,
		working,
		hasContext,
		text,
		caret,
		setText,
		setCaret,
		textareaRef,
		onCommand,
	} = options;
	useLang();
	const listId = useId();
	const sessions = useAppState((state) => state.sessions);
	const [dismissedKey, setDismissedKey] = useState<string | null>(null);
	const [activeIndex, setActiveIndex] = useState(0);
	const [files, setFiles] = useState<SessionFileMatch[]>([]);
	const [skills, setSkills] = useState<SessionSkillItem[]>([]);
	const fileReqSeq = useRef(0);

	const trigger = useMemo(
		() => detectTrigger(text, caret, Boolean(sessionId)),
		[text, caret, sessionId],
	);
	const triggerKey = trigger ? `${trigger.kind}:${trigger.start}:${trigger.query}` : null;

	// Clear Escape dismissal once the user moves or edits the trigger token.
	useEffect(() => {
		if (dismissedKey && dismissedKey !== triggerKey) {
			setDismissedKey(null);
		}
	}, [dismissedKey, triggerKey]);

	// Fetch skills when a slash trigger opens in a session.
	useEffect(() => {
		if (!sessionId || trigger?.kind !== "slash") return;
		let alive = true;
		void loadSessionSkills(sessionId)
			.then((items) => {
				if (alive) setSkills(items);
			})
			.catch(() => {
				if (alive) setSkills([]);
			});
		return () => {
			alive = false;
		};
	}, [sessionId, trigger?.kind]);

	// Debounced file lookup when `@` opens in a session with folders.
	useEffect(() => {
		if (!sessionId || !hasFolders || trigger?.kind !== "at") {
			setFiles([]);
			return;
		}
		const seq = ++fileReqSeq.current;
		const query = trigger.query;
		const timer = window.setTimeout(() => {
			void searchSessionFiles(sessionId, query, 15)
				.then((items) => {
					if (fileReqSeq.current === seq) setFiles(items);
				})
				.catch(() => {
					if (fileReqSeq.current === seq) setFiles([]);
				});
		}, 100);
		return () => window.clearTimeout(timer);
	}, [sessionId, hasFolders, trigger?.kind, trigger?.query]);

	const items = useMemo<MenuItem[]>(() => {
		if (!trigger) return [];
		const q = trigger.query.toLowerCase();
		if (trigger.kind === "at") {
			const sessionItems: MenuItem[] = Object.values(sessions)
				.filter(
					(s) =>
						s.archivedAt === null && s.id !== sessionId && (!q || s.name.toLowerCase().includes(q)),
				)
				.sort((a, b) => a.name.localeCompare(b.name))
				.slice(0, 8)
				.map((s) => ({
					id: `session:${s.id}`,
					section: "sessions",
					kind: "session",
					label: `@${s.name}`,
					...(s.responsibility ? { detail: s.responsibility.split("\n")[0]?.slice(0, 60) } : {}),
					insert: `@${s.name} `,
				}));
			const fileItems: MenuItem[] = files.map((f) => ({
				id: `file:${f.path}`,
				section: "files",
				kind: "file",
				label: f.label,
				...(f.root === "extra" ? { detail: t("composerMenuExtraDir") } : {}),
				insert: /\s/.test(f.path) ? `"${f.path}" ` : `${f.path} `,
			}));
			return [...sessionItems, ...fileItems];
		}

		// Slash commands + active skills
		const commands: MenuItem[] = [];
		if (!working && hasContext && onCommand) {
			if (!q || "compact".includes(q) || t("compact").toLowerCase().includes(q)) {
				commands.push({
					id: "cmd:compact",
					section: "commands",
					kind: "command",
					command: "compact",
					label: "/compact",
					detail: t("cmdCompactHint"),
				});
			}
			if (!q || "renew".includes(q) || t("renewButton").toLowerCase().includes(q)) {
				commands.push({
					id: "cmd:renew",
					section: "commands",
					kind: "command",
					command: "renew",
					label: "/renew",
					detail: t("cmdRenewHint"),
				});
			}
		}
		const skillItems: MenuItem[] = skills
			.filter(
				(s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
			)
			.slice(0, 20)
			.map((s) => ({
				id: `skill:${s.name}`,
				section: "skills",
				kind: "skill",
				label: `/${s.name}`,
				...(s.description ? { detail: s.description } : {}),
				insert: `/${s.name} `,
			}));
		return [...commands, ...skillItems];
	}, [trigger, sessions, sessionId, files, working, hasContext, onCommand, skills]);

	const open = Boolean(trigger && triggerKey !== dismissedKey && items.length > 0);

	useEffect(() => {
		setActiveIndex((current) => (items.length === 0 ? 0 : Math.min(current, items.length - 1)));
	}, [items.length]);

	const pick = useCallback(
		(item: MenuItem) => {
			if (!trigger) return;
			if (item.kind === "command") {
				const rest = text.slice(trigger.end).trimStart();
				setText(rest);
				setCaret(0);
				onCommand?.(item.command);
				return;
			}
			const next = `${text.slice(0, trigger.start)}${item.insert}${text.slice(trigger.end)}`;
			const nextPos = trigger.start + item.insert.length;
			setText(next);
			setCaret(nextPos);
			requestAnimationFrame(() => {
				const el = textareaRef.current;
				if (el) {
					el.focus();
					el.setSelectionRange(nextPos, nextPos);
				}
			});
		},
		[trigger, text, setText, setCaret, textareaRef, onCommand],
	);

	const dismiss = useCallback(() => {
		if (triggerKey) setDismissedKey(triggerKey);
	}, [triggerKey]);

	const onKeyDown = useCallback(
		(event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
			if (!open || isImeEvent(event)) return false;
			if (event.key === "ArrowDown") {
				event.preventDefault();
				setActiveIndex((current) => (current + 1) % items.length);
				return true;
			}
			if (event.key === "ArrowUp") {
				event.preventDefault();
				setActiveIndex((current) => (current - 1 + items.length) % items.length);
				return true;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				const chosen = items[activeIndex];
				if (!chosen) return false;
				event.preventDefault();
				pick(chosen);
				return true;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				dismiss();
				return true;
			}
			return false;
		},
		[open, items, activeIndex, pick, dismiss],
	);

	return {
		open,
		listId,
		items,
		activeIndex,
		setActiveIndex,
		pick,
		dismiss,
		onKeyDown,
	};
}

function itemIcon(item: MenuItem) {
	switch (item.kind) {
		case "session":
			return <TeamIcon />;
		case "file":
			return <FolderIcon />;
		case "skill":
			return <SkillsIcon />;
		case "command":
			return item.command === "compact" ? <CompactIcon /> : <RenewIcon />;
	}
}

function sectionTitle(section: MenuItem["section"]): string {
	switch (section) {
		case "sessions":
			return t("composerMenuSessions");
		case "files":
			return t("composerMenuFiles");
		case "commands":
			return t("composerMenuCommands");
		case "skills":
			return t("composerMenuSkills");
	}
}

export function ComposerMenu({ menu }: { menu: ComposerMenuController }) {
	useLang();
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!menu.open) return;
		const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${menu.activeIndex}"]`);
		el?.scrollIntoView({ block: "nearest" });
	}, [menu.open, menu.activeIndex]);

	if (!menu.open) return null;

	const sections: MenuItem["section"][] = [];
	for (const item of menu.items) {
		if (!sections.includes(item.section)) sections.push(item.section);
	}

	return (
		<div
			ref={listRef}
			id={menu.listId}
			role="listbox"
			aria-label={t("composerMenuLabel")}
			className="composer-menu"
		>
			{sections.map((section) => {
				const group = menu.items
					.map((item, index) => ({ item, index }))
					.filter((entry) => entry.item.section === section);
				return (
					<div key={section} className="composer-menu-group">
						<div className="composer-menu-heading">{sectionTitle(section)}</div>
						{group.map(({ item, index }) => {
							const active = index === menu.activeIndex;
							return (
								<button
									key={item.id}
									type="button"
									role="option"
									aria-selected={active}
									data-index={index}
									className={
										active ? "composer-menu-item composer-menu-item-active" : "composer-menu-item"
									}
									onMouseEnter={() => menu.setActiveIndex(index)}
									onMouseDown={(event) => {
										// Keep textarea focus while clicking a completion item.
										event.preventDefault();
										menu.pick(item);
									}}
								>
									<span className="composer-menu-icon">{itemIcon(item)}</span>
									<span className="composer-menu-label">{item.label}</span>
									{item.detail && <span className="composer-menu-detail">{item.detail}</span>}
								</button>
							);
						})}
					</div>
				);
			})}
		</div>
	);
}
