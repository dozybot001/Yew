import {
	type ButtonHTMLAttributes,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { PermissionRule } from "../../../src/shared/types.ts";
import { ApiError } from "../api.ts";
import { hasMessage, type MessageKey, t } from "../i18n.ts";
import { InfoIcon } from "./icons.tsx";

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
