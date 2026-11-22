import {
	type ButtonHTMLAttributes,
	createContext,
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { PermissionRule } from "../../../src/shared/types.ts";
import { ApiError } from "../api.ts";
import { hasMessage, type MessageKey, t } from "../i18n.ts";
import { CloseIcon, InfoIcon, SubmenuIcon } from "./icons.tsx";

/** Places a top-layer popover next to its trigger, flipping above when there is no room below. */
export function place(popover: HTMLElement, trigger: HTMLElement, width?: number): void {
	const rect = trigger.getBoundingClientRect();
	const margin = 16;
	const gap = 8;
	popover.style.minWidth = `${Math.max(rect.width, 180)}px`;
	const w = width ?? Math.max(rect.width, popover.offsetWidth);
	let left = Math.min(rect.left, window.innerWidth - w - margin);
	left = Math.max(margin, left);
	const below = window.innerHeight - rect.bottom - gap - margin;
	const height = popover.offsetHeight;
	const top =
		height > below && rect.top > below
			? Math.max(margin, rect.top - gap - height)
			: rect.bottom + gap;
	popover.style.left = `${left}px`;
	popover.style.top = `${top}px`;
}

export function Button({
	busy,
	variant = "default",
	children,
	disabled,
	...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
	busy?: boolean;
	variant?: "default" | "primary" | "danger" | "ghost" | "icon";
}) {
	const classes = [
		"btn",
		variant === "default" ? "" : `btn-${variant}`,
		variant === "icon" ? "btn-ghost" : "",
	];
	return (
		<button
			type="button"
			{...rest}
			className={`${classes.join(" ")} ${rest.className ?? ""}`.trim()}
			disabled={disabled || busy}
			aria-busy={busy ? "true" : undefined}
		>
			{children}
		</button>
	);
}

/**
 * Runs an async action from a button: shows the loading state at once and blocks a second submit
 * until it settles. Errors are kept for display.
 */
export function useAction<A extends unknown[]>(action: (...args: A) => Promise<unknown>) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<unknown>(null);
	const running = useRef(false);
	const run = useCallback(
		async (...args: A) => {
			if (running.current) return false;
			running.current = true;
			setBusy(true);
			setError(null);
			try {
				await action(...args);
				return true;
			} catch (caught) {
				setError(caught);
				return false;
			} finally {
				running.current = false;
				setBusy(false);
			}
		},
		[action],
	);
	return { run, busy, error, setError };
}

const FIELD_MESSAGES: Record<string, MessageKey> = {
	name: "err_field_name",
	cwd: "err_field_cwd",
	text: "err_field_text",
	decision: "err_field_decision",
	answer: "err_field_answer",
	options: "err_field_options",
	key: "err_field_key",
	id: "err_field_id",
	baseUrl: "err_field_baseUrl",
	models: "err_field_models",
	rules: "err_field_rules",
	workspaces: "err_field_workspaces",
	model: "err_field_model",
	provider: "err_field_model",
	cron: "err_field_cron",
	session: "err_field_session",
	message: "err_field_message",
	server: "err_field_server",
	command: "err_field_command",
	url: "err_field_url",
	args: "err_field_args",
	env: "err_field_env",
	headers: "err_field_headers",
	remote: "err_field_remote",
	folder: "err_field_folder",
	file: "err_field_file",
	attachments: "err_field_attachments",
	extraDirs: "err_field_extraDirs",
	allowedDomains: "err_field_sandboxDomains",
	sandboxAllowedDomains: "err_field_sandboxDomains",
};

const CODE_MESSAGES: Record<string, MessageKey> = {
	network: "err_network",
	"sign-in-required": "err_signin",
	"invalid-login-token": "err_signin",
	"not-found": "err_notFound",
	"internal-error": "err_internal",
	"session-busy": "err_sessionBusy",
	"session-archived": "err_sessionArchived",
	"nothing-to-continue": "err_nothingToContinue",
	"already-answered": "err_alreadyAnswered",
	"already-delivered": "err_alreadyDelivered",
	"not-supported": "err_noPicker",
	"picker-failed": "err_pickerFailed",
	"schedule-busy": "err_scheduleBusy",
	"mcp-exists": "err_mcpExists",
	"mcp-unreadable": "err_mcpUnreadable",
	"not-on-this-system": "err_notOnThisSystem",
	"service-failed": "err_serviceFailed",
	"reveal-failed": "err_revealFailed",
	"temp-outside": "err_tempOutside",
	"no-export": "err_noExport",
};

/** What went wrong and what to do, in the interface language; server text is a fallback. */
export function describeError(error: unknown): string {
	if (!(error instanceof ApiError)) return t("err_unknown");
	if (error.code === "missing-api-key")
		return t("err_missingKey", { provider: error.provider ?? "" });
	if (error.code === "conflict" && error.field === "name") return t("nameTaken");
	if (error.field && FIELD_MESSAGES[error.field])
		return t(FIELD_MESSAGES[error.field] as MessageKey);
	const known = CODE_MESSAGES[error.code];
	if (known) return t(known);
	if (error.status === 400 || error.status === 422) return t("err_invalid");
	return t("err_unknown");
}

export function ErrorBox({ error }: { error: unknown }) {
	const [copied, setCopied] = useState(false);
	if (!error) return null;
	const requestId = error instanceof ApiError ? error.requestId : undefined;
	return (
		<div className="error-box" role="alert">
			<strong>{t("errorTitle")}</strong>
			<span>{describeError(error)}</span>
			{requestId && (
				<span className="hint error-id">
					{t("requestId")}: <code className="error-code">{requestId}</code>
					<Button
						variant="ghost"
						onClick={() => {
							void navigator.clipboard?.writeText(requestId).then(() => setCopied(true));
						}}
					>
						{copied ? t("copied") : t("copyRequestId")}
					</Button>
				</span>
			)}
		</div>
	);
}

export function Switch({
	checked,
	onChange,
	label,
	labelledBy,
	disabled,
	busy,
	info,
}: {
	checked: boolean;
	onChange: (value: boolean) => void;
	/** Shown beside the switch; in a setting row the row's name labels it instead (`labelledBy`). */
	label?: string;
	labelledBy?: string;
	disabled?: boolean;
	busy?: boolean;
	info?: string;
}) {
	if (labelledBy) {
		return (
			<button
				type="button"
				role="switch"
				aria-checked={checked}
				aria-labelledby={labelledBy}
				className="switch"
				disabled={disabled || busy}
				aria-busy={busy ? "true" : undefined}
				onClick={() => onChange(!checked)}
			>
				<span className="switch-track" aria-hidden="true">
					<span className="switch-thumb" />
				</span>
			</button>
		);
	}
	return (
		<span className="field-label">
			<button
				type="button"
				role="switch"
				aria-checked={checked}
				className="switch"
				disabled={disabled || busy}
				aria-busy={busy ? "true" : undefined}
				onClick={() => onChange(!checked)}
			>
				<span className="switch-track" aria-hidden="true">
					<span className="switch-thumb" />
				</span>
				<span>{label}</span>
			</button>
			{info && label && <Toggletip label={label} text={info} />}
		</span>
	);
}

/** The ⓘ button and its click-to-open explanation. */
export function Toggletip({ label, text }: { label: string; text: string }) {
	const [open, setOpen] = useState(false);
	const button = useRef<HTMLButtonElement>(null);
	const pop = useRef<HTMLDivElement>(null);
	const id = useId();
	const hover = useRef(false);

	useLayoutEffect(() => {
		const element = pop.current;
		if (!element || !button.current) return;
		if (open) {
			element.showPopover?.();
			place(element, button.current, 260);
		} else if (element.matches(":popover-open")) {
			element.hidePopover?.();
		}
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const onKey = (event: globalThis.KeyboardEvent) => event.key === "Escape" && setOpen(false);
		const onDown = (event: MouseEvent) => {
			const target = event.target as Node;
			if (!pop.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("mousedown", onDown);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("mousedown", onDown);
		};
	}, [open]);

	const hoverable = window.matchMedia("(hover: hover)").matches;
	return (
		<>
			<button
				ref={button}
				type="button"
				className="info-button"
				aria-label={t("infoAbout", { label })}
				aria-expanded={open}
				aria-describedby={open ? id : undefined}
				onClick={() => setOpen((value) => !value)}
				onFocus={() => hoverable && setOpen(true)}
				onMouseEnter={() => {
					if (!hoverable) return;
					hover.current = true;
					setOpen(true);
				}}
				onMouseLeave={() => {
					hover.current = false;
				}}
			>
				<InfoIcon />
			</button>
			<div ref={pop} id={id} popover="manual" className="toggletip" role="tooltip">
				{text}
			</div>
		</>
	);
}

export interface Option {
	value: string;
	label: string;
	/** A second, quieter line in the list that says what the choice does. */
	hint?: string;
	group?: string;
}

/** A select-only combobox with its own listbox (WAI-ARIA APG). */
export function Select({
	value,
	options,
	onChange,
	label,
	labelledBy,
	disabled,
	busy,
}: {
	value: string;
	options: Option[];
	onChange: (value: string) => void;
	label?: string;
	labelledBy?: string;
	disabled?: boolean;
	busy?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(0);
	const trigger = useRef<HTMLButtonElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const id = useId();
	const selected = options.find((option) => option.value === value);

	useLayoutEffect(() => {
		const element = list.current;
		if (!element || !trigger.current) return;
		if (open) {
			element.showPopover?.();
			place(element, trigger.current);
			element.querySelector(".active")?.scrollIntoView({ block: "nearest" });
		} else if (element.matches(":popover-open")) {
			element.hidePopover?.();
		}
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const onDown = (event: MouseEvent) => {
			const target = event.target as Node;
			if (!list.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [open]);

	// Keys move the active option and the list scrolls to keep it in view. The pointer only marks the
	// option under it: scrolling then would move the list under the pointer.
	const byKey = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the active option changes
	useEffect(() => {
		if (!byKey.current) return;
		byKey.current = false;
		list.current?.querySelector(".active")?.scrollIntoView({ block: "nearest" });
	}, [active]);

	const press = usePress(() => (open ? setOpen(false) : openList()));
	const openList = () => {
		setActive(
			Math.max(
				0,
				options.findIndex((option) => option.value === value),
			),
		);
		setOpen(true);
	};
	const choose = (index: number) => {
		const option = options[index];
		setOpen(false);
		trigger.current?.focus();
		if (option && option.value !== value) onChange(option.value);
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (!open) {
			if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
				event.preventDefault();
				openList();
			}
			return;
		}
		if (event.key === "Escape" || event.key === "Tab") {
			setOpen(false);
			return;
		}
		event.preventDefault();
		byKey.current = true;
		if (event.key === "ArrowDown") setActive((i) => Math.min(options.length - 1, i + 1));
		else if (event.key === "ArrowUp") setActive((i) => Math.max(0, i - 1));
		else if (event.key === "Home") setActive(0);
		else if (event.key === "End") setActive(options.length - 1);
		else if (event.key === "Enter" || event.key === " ") choose(active);
	};

	let lastGroup: string | undefined;
	return (
		<>
			<button
				ref={trigger}
				type="button"
				role="combobox"
				className="btn select-trigger"
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={id}
				aria-label={label}
				aria-labelledby={labelledBy}
				aria-activedescendant={open ? `${id}-${active}` : undefined}
				disabled={disabled || busy}
				aria-busy={busy ? "true" : undefined}
				{...press}
				onKeyDown={onKeyDown}
			>
				<span>{selected?.label ?? value}</span>
			</button>
			<div
				ref={list}
				id={id}
				role="listbox"
				popover="manual"
				className="listbox"
				aria-label={label}
			>
				{options.map((option, index) => {
					const heading = option.group && option.group !== lastGroup ? option.group : null;
					lastGroup = option.group;
					return [
						heading && (
							<div key={`g-${option.group}`} className="group-label" role="presentation">
								{heading}
							</div>
						),
						// biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled on the combobox, which owns focus (APG active-descendant pattern)
						<div
							key={option.value}
							id={`${id}-${index}`}
							role="option"
							tabIndex={-1}
							aria-selected={option.value === value}
							className={index === active ? "active" : undefined}
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => choose(index)}
							onMouseMove={() => setActive(index)}
						>
							{option.hint ? (
								<span className="option-text">
									<span>{option.label}</span>
									<span className="option-hint">{option.hint}</span>
								</span>
							) : (
								option.label
							)}
						</div>,
					];
				})}
			</div>
		</>
	);
}

export interface MenuItem {
	label: string;
	/** What choosing the item does; an item with `items` opens them instead. */
	onSelect?: () => void;
	/** A submenu, opened beside the item (as in Claude's session menu). */
	items?: MenuEntry[];
	/** Distinguishes items with the same label in different groups. */
	id?: string;
	danger?: boolean;
	/** Set for a choice among options (menuitemradio); a check marks the current one. */
	checked?: boolean;
	icon?: ReactNode;
	/** The current value of a submenu's choice, shown quietly before the arrow. */
	detail?: string;
}

/** A menu entry: an item, a line between sections, or a labelled group of choices. */
export type MenuEntry =
	| MenuItem
	| { separator: true; id: string }
	| { group: string; items: MenuItem[] };

/** Puts a submenu beside the item that opened it: to the right, or to the left when there is no room. */
function placeBeside(popover: HTMLElement, anchor: HTMLElement): void {
	const rect = anchor.getBoundingClientRect();
	const margin = 8;
	const width = popover.offsetWidth;
	const height = popover.offsetHeight;
	let left = rect.right + 6;
	if (left + width > window.innerWidth - margin) left = Math.max(margin, rect.left - width - 6);
	const top = Math.max(margin, Math.min(rect.top - 6, window.innerHeight - margin - height));
	popover.style.left = `${left}px`;
	popover.style.top = `${top}px`;
}

/** From a flyout's trigger to the flyout: past the sidebar's own padding. */
const FLYOUT_GAP = 14;
/** The pointer rests on a flyout's trigger this long before it opens: crossing the row opens nothing. */
const FLYOUT_OPENS_MS = 100;
/** A flyout opened by the pointer stays this long after the pointer leaves, so it can cross the gap. */
const FLYOUT_STAYS_MS = 250;

/**
 * Puts a flyout to the right of its trigger, its first item level with it and clear of the sidebar's
 * edge. False when the window has no room there, as on a phone, where the sidebar takes the width.
 */
function placeRightOf(popover: HTMLElement, trigger: HTMLElement): boolean {
	const rect = trigger.getBoundingClientRect();
	const margin = 8;
	popover.style.minWidth = "";
	const left = rect.right + FLYOUT_GAP;
	if (left + popover.offsetWidth > window.innerWidth - margin) return false;
	const top = Math.min(rect.top - 6, window.innerHeight - margin - popover.offsetHeight);
	popover.style.left = `${left}px`;
	popover.style.top = `${Math.max(margin, top)}px`;
	return true;
}

function MenuItemButton({
	item,
	close,
	onPointerEnter,
	submenu,
}: {
	item: MenuItem;
	close: () => void;
	onPointerEnter?: (button: HTMLButtonElement) => void;
	/** For an item with a submenu: whether it is open, and how to open it. */
	submenu?: { open: boolean; show: (button: HTMLButtonElement, focusFirst: boolean) => void };
}) {
	const onClick = (event: { stopPropagation(): void; currentTarget: HTMLButtonElement }) => {
		event.stopPropagation();
		if (submenu) {
			if (item.onSelect && submenu.open) {
				close();
				item.onSelect();
				return;
			}
			submenu.show(event.currentTarget, true);
			return;
		}
		close();
		item.onSelect?.();
	};
	if (submenu) {
		return (
			<button
				type="button"
				role="menuitem"
				tabIndex={-1}
				aria-haspopup="menu"
				aria-expanded={submenu.open}
				className={`menu-parent${item.checked ? " menu-selected" : ""}`}
				onClick={onClick}
				onPointerEnter={(event) => submenu.show(event.currentTarget, false)}
				onKeyDown={(event) => {
					if (event.key === "ArrowRight") {
						event.preventDefault();
						event.stopPropagation();
						submenu.show(event.currentTarget, true);
					}
				}}
			>
				{item.icon}
				<span className="menu-label">{item.label}</span>
				{item.detail && <span className="menu-detail">{item.detail}</span>}
				<SubmenuIcon />
			</button>
		);
	}
	const content = (
		<>
			{item.icon}
			<span className="menu-label">{item.label}</span>
			{item.checked && (
				<span className="menu-check" aria-hidden="true">
					✓
				</span>
			)}
		</>
	);
	if (item.checked !== undefined) {
		return (
			<button
				type="button"
				role="menuitemradio"
				aria-checked={item.checked}
				tabIndex={-1}
				onClick={onClick}
				onPointerEnter={(event) => onPointerEnter?.(event.currentTarget)}
			>
				{content}
			</button>
		);
	}
	return (
		<button
			type="button"
			role="menuitem"
			tabIndex={-1}
			className={item.danger ? "menu-danger" : undefined}
			onClick={onClick}
			onPointerEnter={(event) => onPointerEnter?.(event.currentTarget)}
		>
			{content}
		</button>
	);
}

/** Separators, groups and items, as one menu level shows them. */
function MenuEntries({
	entries,
	render,
}: {
	entries: MenuEntry[];
	render: (item: MenuItem, key: string) => ReactNode;
}) {
	return (
		<>
			{entries.map((entry) => {
				if ("separator" in entry) return <hr key={entry.id} className="menu-separator" />;
				if ("group" in entry) {
					return (
						// biome-ignore lint/a11y/useSemanticElements: a group of menu items is role="group" in the APG menu pattern; a fieldset does not belong in a menu
						<div key={entry.group} role="group" aria-label={entry.group}>
							<div className="menu-heading" aria-hidden="true">
								{entry.group}
							</div>
							{entry.items.map((item) => render(item, item.id ?? item.label))}
						</div>
					);
				}
				return render(entry, entry.id ?? entry.label);
			})}
		</>
	);
}

/**
 * Opens on the press, as menus on the desktop do: with a mouse the list shows when the button goes
 * down, not when it comes up. Touch and the keyboard open it with the click, so a scroll that starts
 * on the trigger does not open anything.
 */
function usePress(toggle: () => void) {
	const pointer = useRef("");
	return {
		onPointerDown: (event: { pointerType: string; button: number }) => {
			pointer.current = event.pointerType;
			if (event.pointerType === "mouse" && event.button === 0) toggle();
		},
		onClick: (event: { detail: number; stopPropagation(): void }) => {
			event.stopPropagation();
			// The click that ends a mouse press: the press already did it. A keyboard click has detail 0.
			if (event.detail > 0 && pointer.current === "mouse") return;
			toggle();
		},
	};
}

/**
 * A menu behind a button (APG menu button): by default a "…" icon button, or a visible trigger such as
 * a sidebar entry. It can be opened from outside (a keyboard shortcut) through `open`.
 *
 * A flyout is the menu of a sidebar entry: it shows beside the entry, so nothing in the sidebar
 * moves, and the pointer resting on the entry opens it. Opened that way it leaves the focus where it
 * is and closes once the pointer has left both; a click or the keyboard opens it as any menu, and
 * then it stays until something is chosen or it is dismissed.
 */
export function Menu({
	label,
	items,
	trigger,
	open: controlled,
	onOpenChange,
	width = 200,
	flyout = false,
}: {
	label: string;
	items: MenuEntry[];
	trigger?: {
		className: string;
		content: ReactNode;
		title?: string;
		disabled?: boolean;
		busy?: boolean;
		labelledBy?: string;
		/** The trigger stands for the page that is open: one of the pages its menu holds. */
		current?: boolean;
	};
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	width?: number;
	flyout?: boolean;
}) {
	const [own, setOwn] = useState(false);
	const open = controlled ?? own;
	const setOpen = (next: boolean) => {
		if (controlled === undefined) setOwn(next);
		onOpenChange?.(next);
	};
	const button = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const subMenu = useRef<HTMLDivElement>(null);
	const id = useId();
	// The open submenu: which item opened it, and whether its first item takes the focus (keyboard).
	const [sub, setSub] = useState<{ key: string; anchor: HTMLButtonElement; focus: boolean } | null>(
		null,
	);
	// A flyout the pointer opened, and the timer that opens or closes it.
	const hovered = useRef({ open: false, timer: 0 });
	const firstItem = () => menu.current?.querySelector<HTMLElement>("[role^=menuitem]");
	const press = usePress(() => {
		window.clearTimeout(hovered.current.timer);
		// Clicking the entry of a flyout that is already showing keeps it: from then on it stays.
		if (open && hovered.current.open) {
			hovered.current.open = false;
			firstItem()?.focus();
			return;
		}
		hovered.current.open = false;
		setOpen(!open);
	});
	const pointer = flyout
		? {
				onPointerEnter: (event: { pointerType: string }) => {
					if (event.pointerType !== "mouse") return;
					window.clearTimeout(hovered.current.timer);
					if (open) return;
					hovered.current.timer = window.setTimeout(() => {
						hovered.current.open = true;
						setOpen(true);
					}, FLYOUT_OPENS_MS);
				},
				onPointerLeave: (event: { pointerType: string }) => {
					if (event.pointerType !== "mouse") return;
					window.clearTimeout(hovered.current.timer);
					if (open && hovered.current.open) {
						hovered.current.timer = window.setTimeout(() => setOpen(false), FLYOUT_STAYS_MS);
					}
				},
			}
		: {};
	// Moving the mouse across other items on the way to an open submenu must not close or swap it:
	// while the pointer heads toward the submenu, what the item under it would do waits a moment,
	// and is dropped when the pointer arrives.
	const aim = useRef({ x: 0, y: 0, dx: 0, dy: 0, timer: 0 });
	const settle = () => {
		window.clearTimeout(aim.current.timer);
		aim.current.timer = 0;
	};
	const hover = (act: () => void) => {
		settle();
		const side = subMenu.current?.getBoundingClientRect();
		const own = menu.current?.getBoundingClientRect();
		// Heading for the submenu means moving sideways toward it, not down or up the list: going
		// from one item to the next must switch at once.
		const { dx, dy } = aim.current;
		const across = side && own ? (side.left >= own.left ? dx : -dx) : 0;
		const toward = across >= 2 && across > Math.abs(dy) * 0.5;
		if (sub && toward) aim.current.timer = window.setTimeout(act, 160);
		else act();
	};

	useLayoutEffect(() => {
		const element = menu.current;
		if (!element || !button.current) return;
		if (open) {
			element.showPopover?.();
			if (!flyout || !placeRightOf(element, button.current)) place(element, button.current, width);
			if (!hovered.current.open) {
				(element.querySelector("[role^=menuitem]") as HTMLElement | null)?.focus();
			}
		} else if (element.matches(":popover-open")) {
			element.hidePopover?.();
		}
		if (!open) {
			window.clearTimeout(aim.current.timer);
			window.clearTimeout(hovered.current.timer);
			hovered.current.open = false;
			setSub(null);
		}
	}, [open, width, flyout]);

	useEffect(() => {
		const state = hovered.current;
		return () => window.clearTimeout(state.timer);
	}, []);

	useLayoutEffect(() => {
		const element = subMenu.current;
		if (!element || !sub) return;
		element.showPopover?.();
		placeBeside(element, sub.anchor);
		if (sub.focus) (element.querySelector("[role^=menuitem]") as HTMLElement | null)?.focus();
	}, [sub]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: setOpen is rebuilt each render; the listener only needs to follow `open`
	useEffect(() => {
		if (!open) return;
		const onDown = (event: MouseEvent) => {
			const target = event.target as Node;
			const inside =
				menu.current?.contains(target) ||
				subMenu.current?.contains(target) ||
				button.current?.contains(target);
			if (!inside) setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [open]);

	const onKeyDown = (event: KeyboardEvent) => {
		const entries = [...(menu.current?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? [])];
		const index = entries.indexOf(document.activeElement as HTMLElement);
		if (event.key === "Escape" || (flyout && event.key === "ArrowLeft")) {
			setOpen(false);
			button.current?.focus();
		} else if (event.key === "ArrowDown") {
			event.preventDefault();
			entries[(index + 1) % entries.length]?.focus();
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			entries[(index - 1 + entries.length) % entries.length]?.focus();
		} else if (event.key === "Tab") {
			setOpen(false);
		}
	};
	const close = () => setOpen(false);
	const subItems = sub
		? (items.find(
				(entry): entry is MenuItem =>
					!("separator" in entry) && !("group" in entry) && (entry.id ?? entry.label) === sub.key,
			)?.items ?? null)
		: null;
	const onSubKeyDown = (event: KeyboardEvent) => {
		const entries = [...(subMenu.current?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? [])];
		const index = entries.indexOf(document.activeElement as HTMLElement);
		if (event.key === "Escape" || event.key === "ArrowLeft") {
			event.preventDefault();
			event.stopPropagation();
			const anchor = sub?.anchor;
			setSub(null);
			anchor?.focus();
		} else if (event.key === "ArrowDown") {
			event.preventDefault();
			entries[(index + 1) % entries.length]?.focus();
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			entries[(index - 1 + entries.length) % entries.length]?.focus();
		} else if (event.key === "Tab") {
			setOpen(false);
		}
	};
	const renderItem = (item: MenuItem, key: string) =>
		item.items ? (
			<MenuItemButton
				key={key}
				item={item}
				close={close}
				submenu={{
					open: sub?.key === key,
					show: (anchor, focus) => {
						const show = () => setSub({ key, anchor, focus });
						// The keyboard and a click open it at once; a hover minds where the pointer is going.
						if (focus || sub?.key === key) {
							settle();
							show();
						} else hover(show);
					},
				}}
			/>
		) : (
			<MenuItemButton
				key={key}
				item={item}
				close={close}
				// Moving onto a plain item closes an open submenu, as menus do elsewhere.
				onPointerEnter={() => hover(() => setSub(null))}
			/>
		);

	return (
		<>
			<button
				ref={button}
				type="button"
				className={trigger?.className ?? "btn btn-ghost btn-icon"}
				title={trigger?.title}
				aria-label={trigger?.labelledBy ? undefined : label}
				aria-labelledby={trigger?.labelledBy}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-controls={id}
				aria-current={trigger?.current ? "page" : undefined}
				disabled={trigger?.disabled || trigger?.busy}
				aria-busy={trigger?.busy ? "true" : undefined}
				{...press}
				{...pointer}
				// A click leaves the focus on the trigger in some browsers, and a hover always does: Escape
				// closes the menu from here too, and an arrow goes into it (a flyout's opens it as well).
				onKeyDown={(event) => {
					if (open && event.key === "Escape") {
						setOpen(false);
					} else if (
						(open && event.key === "ArrowDown") ||
						(flyout && event.key === "ArrowRight")
					) {
						event.preventDefault();
						hovered.current.open = false;
						if (open) firstItem()?.focus();
						else setOpen(true);
					}
				}}
			>
				{trigger ? trigger.content : <span aria-hidden="true">⋯</span>}
			</button>
			<div
				ref={menu}
				id={id}
				role="menu"
				aria-label={label}
				popover="manual"
				className="menu"
				onKeyDown={onKeyDown}
				{...pointer}
				onPointerMove={(event) => {
					aim.current.dx = event.clientX - aim.current.x;
					aim.current.dy = event.clientY - aim.current.y;
					aim.current.x = event.clientX;
					aim.current.y = event.clientY;
				}}
			>
				<MenuEntries entries={items} render={renderItem} />
			</div>
			{open && sub && subItems && (
				<div
					ref={subMenu}
					role="menu"
					aria-label={sub.anchor.textContent ?? label}
					popover="manual"
					className="menu submenu"
					onKeyDown={onSubKeyDown}
					onPointerEnter={settle}
				>
					<MenuEntries
						entries={subItems}
						render={(item, key) => <MenuItemButton key={key} item={item} close={close} />}
					/>
				</div>
			)}
		</>
	);
}

/** A modal dialog with a fixed size tier; only the body scrolls. */
interface DialogProps {
	title: string;
	size: "s" | "m" | "l";
	onClose: () => void;
	children: ReactNode;
	footer?: ReactNode;
	tabs?: ReactNode;
}

/**
 * Inside the settings window a settings dialog is not a dialog of its own: it fills the window's right
 * side, with the same title, body and footer. Dialogs opened from inside it
 * (adding a server, confirming a deletion) are real dialogs again.
 */
const InWindow = createContext(false);

export function InSettingsWindow({ children }: { children: ReactNode }) {
	return <InWindow.Provider value={true}>{children}</InWindow.Provider>;
}

export function Dialog(props: DialogProps) {
	return useContext(InWindow) ? <DialogPanel {...props} /> : <ModalDialog {...props} />;
}

function DialogPanel({ title, onClose, children, footer, tabs }: DialogProps) {
	const titleId = useId();
	return (
		<section className="dialog-panel" aria-labelledby={titleId}>
			<div className="dialog-header">
				<h2 id={titleId}>{title}</h2>
				<Button variant="icon" aria-label={t("close")} onClick={onClose}>
					<CloseIcon />
				</Button>
			</div>
			<InWindow.Provider value={false}>
				{tabs}
				<div className="dialog-body panel-body">{children}</div>
				{footer && <div className="dialog-footer">{footer}</div>}
			</InWindow.Provider>
		</section>
	);
}

/** A menu or a hint that is open over the page. */
function popoverOpen(): boolean {
	try {
		return document.querySelector(":popover-open") !== null;
	} catch {
		// A browser without popovers does not know the selector.
		return false;
	}
}

/**
 * Closes a dialog when the person clicks the dimmed page around it, as Escape does. The press and the
 * release must both be outside the box: selecting text and letting go outside closes nothing, and
 * neither does a press that puts away an open menu.
 */
export function useBackdropClose(onClose: () => void) {
	const pressed = useRef(false);
	const outside = (event: {
		target: EventTarget;
		currentTarget: HTMLDialogElement;
		clientX: number;
		clientY: number;
	}) => {
		// A click on the dimmed page arrives at the dialog itself, one inside the box at its content.
		if (event.target !== event.currentTarget) return false;
		const box = event.currentTarget.getBoundingClientRect();
		return (
			event.clientX < box.left ||
			event.clientX > box.right ||
			event.clientY < box.top ||
			event.clientY > box.bottom
		);
	};
	return {
		onPointerDown: (event: Parameters<typeof outside>[0]) => {
			pressed.current = outside(event) && !popoverOpen();
		},
		onClick: (event: Parameters<typeof outside>[0]) => {
			const close = pressed.current && outside(event);
			pressed.current = false;
			if (close) onClose();
		},
	};
}

function ModalDialog({ title, size, onClose, children, footer, tabs }: DialogProps) {
	const ref = useRef<HTMLDialogElement>(null);
	const titleId = useId();
	const backdrop = useBackdropClose(onClose);
	useEffect(() => {
		const dialog = ref.current;
		if (!dialog) return;
		dialog.showModal();
		document.body.classList.add("scroll-locked");
		return () => {
			document.body.classList.remove("scroll-locked");
			if (dialog.open) dialog.close();
		};
	}, []);
	return (
		<dialog
			ref={ref}
			className={`dialog dialog-${size}`}
			aria-labelledby={titleId}
			onCancel={(event) => {
				// React passes a dialog's cancel on to the dialogs around it; only the top one closes.
				if (event.target !== event.currentTarget) return;
				event.preventDefault();
				onClose();
			}}
			{...backdrop}
		>
			<div
				className="dialog-frame"
				style={tabs ? { gridTemplateRows: "auto auto 1fr auto" } : undefined}
			>
				<div className="dialog-header">
					<h2 id={titleId}>{title}</h2>
					<Button variant="icon" aria-label={t("close")} onClick={onClose}>
						<CloseIcon />
					</Button>
				</div>
				{tabs}
				<div className="dialog-body">{children}</div>
				{footer && <div className="dialog-footer">{footer}</div>}
			</div>
		</dialog>
	);
}

/** Settings that belong together, under a small title, in one rounded box of rows. */
export function SettingGroup({
	title,
	info,
	children,
}: {
	title: string;
	info?: string;
	children: ReactNode;
}) {
	const id = useId();
	return (
		<section className="setting-group" aria-labelledby={id}>
			<h3 className="setting-group-title">
				<span id={id}>{title}</span>
				{info && <Toggletip label={title} text={info} />}
			</h3>
			<div className="setting-box">{children}</div>
		</section>
	);
}

/**
 * One setting: its name and a short explanation on the left, the control on the right, sized to what
 * it holds. Give `htmlFor` for an input, or `labelId` for a control labelled by the name.
 */
export function SettingRow({
	label,
	hint,
	info,
	htmlFor,
	labelId,
	error,
	errorId,
	children,
}: {
	label: string;
	hint?: string;
	info?: string;
	htmlFor?: string;
	labelId?: string;
	error?: string | null;
	errorId?: string;
	children: ReactNode;
}) {
	return (
		<div className="setting-row">
			<div className="setting-text">
				<span className="setting-label">
					{htmlFor ? (
						<label htmlFor={htmlFor} id={labelId}>
							{label}
						</label>
					) : (
						<span id={labelId}>{label}</span>
					)}
					{info && <Toggletip label={label} text={info} />}
				</span>
				{hint && <span className="hint">{hint}</span>}
				{error && (
					<span id={errorId} className="field-error">
						{error}
					</span>
				)}
			</div>
			<div className="setting-control">{children}</div>
		</div>
	);
}

export function Field({
	label,
	children,
	error,
	info,
	htmlFor,
	labelId,
	errorId,
}: {
	label: string;
	children: ReactNode;
	error?: string | null;
	info?: string;
	htmlFor?: string;
	labelId?: string;
	/** Give the input `aria-describedby={errorId}` so the error is read with it. */
	errorId?: string;
}) {
	return (
		<div className="field">
			<span className="field-label">
				<label htmlFor={htmlFor} id={labelId}>
					{label}
				</label>
				{info && <Toggletip label={label} text={info} />}
			</span>
			{children}
			{error && (
				<span id={errorId} className="field-error">
					{error}
				</span>
			)}
		</div>
	);
}

/**
 * Re-renders every minute so relative times (in the sidebar, on cards) stay current; with a shorter
 * interval, as often as that, for a time that counts seconds. An interval of 0 does not tick.
 */
export function useNow(interval = 60_000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (interval <= 0) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), interval);
		return () => clearInterval(timer);
	}, [interval]);
	return now;
}

/**
 * The first line of a card waiting for the person: who is waiting, through whom and for how long, with
 * the tags that change the weight of the answer (deadline, can it be undone, asks every time) on the right.
 */
export function CardHead({
	icon,
	parts,
	tags,
}: {
	icon: ReactNode;
	parts: ReactNode[];
	tags?: ReactNode;
}) {
	return (
		<div className="card-head">
			{icon}
			<span className="card-head-parts">
				{parts.filter(Boolean).map((part, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: the parts are fixed per card and have no ids
					<span key={index}>{part}</span>
				))}
			</span>
			{tags && <span className="card-head-tags">{tags}</span>}
		</div>
	);
}

/** One remembered approval in plain words: "运行 npm install", "访问 github.com"… */
export function describeRule(rule: PermissionRule): string {
	const pattern = rule.pattern ?? "";
	const what =
		rule.pattern === "**" && rule.tool === "write"
			? t("ruleWriteAll")
			: rule.pattern === "**" && rule.tool === "edit"
				? t("ruleEditAll")
				: rule.pattern === "**"
					? t("allFilesInFolder", { tool: rule.tool })
					: rule.tool === "shell" && pattern
						? t("ruleRun", { p: pattern })
						: rule.tool === "web_fetch" && pattern
							? t("ruleFetch", { p: pattern })
							: rule.tool === "sandbox_site" && pattern
								? t("ruleSite", { p: pattern })
								: rule.tool === "read" && pattern
									? t("ruleRead", { p: pattern })
									: rule.tool === "manage_yew" &&
											(pattern === "organize" || pattern === "configure")
										? t(`manage_${pattern}`)
										: !pattern && hasMessage(`ask_${rule.tool}`)
											? t(`ask_${rule.tool}` as MessageKey)
											: `${rule.tool}${pattern ? ` ${pattern}` : ""}`;
	if (rule.effect === "deny") return t("ruleDeny", { rule: what });
	if (rule.effect === "ask") return t("ruleAsk", { rule: what });
	return what;
}
