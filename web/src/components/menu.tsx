import {
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { SubmenuIcon } from "./icons.tsx";
import { place } from "./ui.tsx";

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
export function usePress(toggle: () => void) {
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
