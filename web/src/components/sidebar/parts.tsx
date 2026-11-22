import { type ReactNode, useEffect, useRef, useState } from "react";
import { t, useLang } from "../../i18n.ts";
import { isImeEvent } from "../../ime.ts";
import { type SidebarSection, setSectionFolded, setState, useAppState } from "../../state.ts";
import { ChevronIcon } from "../icons.tsx";
import { describeError, useAction } from "../ui.tsx";

export function closeDrawer(): void {
	setState({ drawerOpen: false });
}

/** True on narrow screens, where the sidebar is a drawer instead of a column. */
export function useNarrow(): boolean {
	const query = "(max-width: 760px)";
	const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
	useEffect(() => {
		const list = window.matchMedia(query);
		const change = () => setNarrow(list.matches);
		list.addEventListener("change", change);
		return () => list.removeEventListener("change", change);
	}, []);
	return narrow;
}

/**
 * Renaming in place: the row's name becomes a field. Enter or clicking away saves, Escape cancels.
 * A renamed session keeps its id, so messages to it still arrive.
 */
export function InlineRename({
	icon,
	value: initial,
	onSave,
	onDone,
}: {
	icon: React.ReactNode;
	value: string;
	onSave: (name: string) => Promise<unknown>;
	onDone: () => void;
}) {
	useLang();
	const [value, setValue] = useState(initial);
	const input = useRef<HTMLInputElement>(null);
	// Escape closes the field; the blur that follows must not save what was typed.
	const cancelled = useRef(false);
	useEffect(() => {
		input.current?.focus();
		input.current?.select();
	}, []);
	const save = useAction(async () => {
		const name = value.trim();
		if (name && name !== initial) await onSave(name);
		onDone();
	});
	return (
		<div className="session-row session-row-editing">
			<span className="session-icon" aria-hidden="true">
				{icon}
			</span>
			<input
				ref={input}
				className="row-input"
				value={value}
				maxLength={60}
				aria-label={t("rename")}
				aria-invalid={save.error ? "true" : undefined}
				onChange={(event) => setValue(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						cancelled.current = true;
						onDone();
					}
					if (event.key === "Enter" && !isImeEvent(event)) {
						event.preventDefault();
						void save.run();
					}
				}}
				onBlur={() => {
					if (!cancelled.current && !save.busy) void save.run();
				}}
			/>
			{save.error !== null && save.error !== undefined && (
				<span className="field-error row-error" role="alert">
					{describeError(save.error)}
				</span>
			)}
		</div>
	);
}

/** What a dragged session row carries: the session's id. */
export const SESSION_DRAG = "application/x-yew-session";

function useFolded(section: SidebarSection): boolean {
	return useAppState((state) => state.foldedSections.includes(section));
}

/** A list's heading: its name folds the list to this line or opens it again; buttons sit after it. */
export function SectionHeading({
	section,
	children,
	actions,
}: {
	section: SidebarSection;
	children: ReactNode;
	actions?: ReactNode;
}) {
	const folded = useFolded(section);
	return (
		<div className="group-heading">
			<button
				type="button"
				className="heading-toggle"
				aria-expanded={!folded}
				aria-controls={`sidebar-${section}`}
				onClick={() => setSectionFolded(section, !folded)}
			>
				<span className="heading-text">{children}</span>
				<ChevronIcon />
			</button>
			{actions}
		</div>
	);
}

/** A list's rows, left out while the list is folded. */
export function SectionBody({
	section,
	children,
}: {
	section: SidebarSection;
	children: ReactNode;
}) {
	const folded = useFolded(section);
	return (
		<div id={`sidebar-${section}`} hidden={folded}>
			{!folded && children}
		</div>
	);
}
