import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { usePress } from "./menu.tsx";
import { place } from "./ui.tsx";

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
	placeholder,
}: {
	value: string;
	options: Option[];
	onChange: (value: string) => void;
	label?: string;
	labelledBy?: string;
	disabled?: boolean;
	busy?: boolean;
	/** What the trigger says while no option is chosen. */
	placeholder?: string;
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
				<span>{selected?.label ?? placeholder ?? value}</span>
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
