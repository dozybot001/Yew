import { createContext, type ReactNode, useContext, useEffect, useId, useRef } from "react";
import { t } from "../i18n.ts";
import { CloseIcon } from "./icons.tsx";
import { Button } from "./ui.tsx";

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
