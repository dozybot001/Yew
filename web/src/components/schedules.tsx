import { useId, useMemo, useState } from "react";
import { CronError, nextRuns, parseCron } from "../../../src/shared/cron.ts";
import {
	PERMISSION_MODES,
	type PermissionMode,
	permissionModeOf,
	SCHEDULE_MODES,
	type Schedule,
	type ScheduleMode,
} from "../../../src/shared/types.ts";
import {
	deleteSchedule,
	runScheduleNow,
	type ScheduleInput,
	saveSchedule,
} from "../actions/pages.ts";
import { selectSession } from "../actions.ts";
import { ApiError } from "../api.ts";
import { formatWhen, type MessageKey, t, useLang } from "../i18n.ts";
import { useAppState } from "../state.ts";
import { ConfirmDialog } from "./dialogs.tsx";
import { CheckIcon, PlayIcon, PlusIcon, RenameIcon, TrashIcon } from "./icons.tsx";
import { Mascot } from "./mascot.tsx";
import { SidebarToggle } from "./session.tsx";
import {
	Button,
	Dialog,
	describeError,
	ErrorBox,
	Field,
	Select,
	SettingRow,
	Switch,
	useAction,
	useNow,
} from "./ui.tsx";

/** Common times; anything else is written as cron. */
const PRESETS = [
	["daily", "0 9 * * *"],
	["weekdays", "0 9 * * 1-5"],
	["weekly", "0 9 * * 1"],
	["monthly", "0 9 1 * *"],
	["hourly", "0 * * * *"],
] as const;

/** The next three runs of a cron expression, or what is wrong with it, in the person's language. */
function cronPreview(text: string, now: number): { runs: number[]; error: string | null } {
	try {
		const runs = nextRuns(parseCron(text), now, 3);
		return { runs, error: runs.length === 0 ? t("scheduleNoRun") : null };
	} catch (error) {
		if (!(error instanceof CronError)) throw error;
		return {
			runs: [],
			error:
				error.field === null
					? t("cronFields")
					: t("cronField", {
							field: t(`cronField_${error.field}` as MessageKey),
							part: error.part,
						}),
		};
	}
}

function lastRun(schedule: Schedule): string {
	if (!schedule.lastStatus || schedule.lastRunAt === null) return t("scheduleNeverRan");
	const status = t(`scheduleStatus_${schedule.lastStatus}`);
	const detail =
		schedule.lastStatus === "skipped"
			? t(`scheduleSkip_${schedule.lastDetail ?? "busy"}` as MessageKey)
			: schedule.lastDetail;
	return t("scheduleLast", {
		time: formatWhen(schedule.lastRunAt),
		status: detail ? t("scheduleResult", { status, detail }) : status,
	});
}

function ScheduleItem({ schedule, onEdit }: { schedule: Schedule; onEdit: () => void }) {
	useLang();
	const session = useAppState((state) => state.sessions[schedule.sessionId] ?? null);
	const team = useAppState((state) =>
		session?.groupId
			? (state.groups.find((group) => group.id === session.groupId)?.name ?? null)
			: null,
	);
	const toggle = useAction((on: boolean) => saveSchedule(schedule.id, { enabled: on }));
	const run = useAction(() => runScheduleNow(schedule.id));
	const [deleting, setDeleting] = useState(false);
	const heading = useId();
	const name = t("quoted", { s: schedule.name });
	const [first = ""] = schedule.message.split("\n");
	// Runs in skip mode ask nothing; only decisions stop them.
	const skips =
		(schedule.permissionMode ?? (session ? permissionModeOf(session.options) : null)) === "skip";
	return (
		<li className="card schedule-card">
			<div className="schedule-head">
				<h3 id={heading}>{schedule.name}</h3>
				{schedule.mode === "task_session" && (
					<span className="tag" title={t("scheduleModeHint_task_session")}>
						{t("scheduleMode_task_session")}
					</span>
				)}
				{skips && (
					<span className="tag" title={t("scheduleSkipsHint")}>
						{t("scheduleSkips")}
					</span>
				)}
				<Switch
					checked={schedule.enabled}
					labelledBy={heading}
					busy={toggle.busy}
					onChange={(on) => void toggle.run(on)}
				/>
			</div>
			<p className="schedule-line">
				<code className="schedule-cron">{schedule.cron}</code>
				<span>
					{schedule.enabled && schedule.nextRunAt !== null
						? t("scheduleNext", { time: formatWhen(schedule.nextRunAt) })
						: t("scheduleOff")}
				</span>
			</p>
			<p className="schedule-line">
				<span>
					{t("scheduleSession")}{" "}
					{session ? (
						<button
							type="button"
							className="link-button"
							onClick={() => void selectSession(session.id)}
						>
							{session.name}
						</button>
					) : (
						"—"
					)}
				</span>
				{team && <span>{t("scheduleTeam", { team })}</span>}
			</p>
			<p className="schedule-message">{first}</p>
			<p className="hint">
				{lastRun(schedule)}
				{schedule.lastSessionId && (
					<>
						{" · "}
						<button
							type="button"
							className="link-button"
							onClick={() => void selectSession(schedule.lastSessionId as string)}
						>
							{t("scheduleLastSession")}
						</button>
					</>
				)}
			</p>
			<div className="schedule-actions">
				<Button busy={run.busy} onClick={() => void run.run()}>
					<PlayIcon />
					{t("scheduleRunNow")}
				</Button>
				<Button onClick={onEdit}>
					<RenameIcon /> {t("edit")}
				</Button>
				<Button variant="ghost" onClick={() => setDeleting(true)}>
					<TrashIcon />
					{t("delete")}
				</Button>
			</div>
			<ErrorBox error={toggle.error ?? run.error} />
			{deleting && (
				<ConfirmDialog
					title={t("scheduleDelete")}
					body={t("scheduleDeleteBody", { name })}
					confirmLabel={t("delete")}
					onConfirm={() => deleteSchedule(schedule.id)}
					onClose={() => setDeleting(false)}
				/>
			)}
		</li>
	);
}

/**
 * Scheduled tasks, a page of its own like the approval center: each task, when it
 * runs next and how its last run went; new tasks and changes in a dialog.
 */
export function SchedulesPage() {
	useLang();
	const loaded = useAppState((state) => state.schedules);
	const [editing, setEditing] = useState<Schedule | "new" | null>(null);
	// The next to run first; tasks that are off last.
	const schedules = useMemo(
		() =>
			loaded
				? [...loaded].sort(
						(a, b) =>
							(a.nextRunAt ?? Number.POSITIVE_INFINITY) -
								(b.nextRunAt ?? Number.POSITIVE_INFINITY) || a.name.localeCompare(b.name),
					)
				: null,
		[loaded],
	);
	return (
		<main className="main center-main">
			<header className="session-header">
				<SidebarToggle />
				<div className="session-title">
					<h1>{t("schedules")}</h1>
					{schedules && schedules.length > 0 && (
						<span className="session-meta">{t("schedulesCount", { n: schedules.length })}</span>
					)}
				</div>
				<Button onClick={() => setEditing("new")}>
					<PlusIcon />
					{t("newSchedule")}
				</Button>
			</header>
			<div
				className="center-body"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll area must be reachable by keyboard
				tabIndex={0}
			>
				<div className="center-inner">
					<p className="hint">{t("schedulesIntro")}</p>
					{!schedules ? (
						<p className="hint">{t("loading")}</p>
					) : schedules.length === 0 ? (
						<div className="empty-state">
							<Mascot pose="sleepy" height={96} />
							<p className="empty-box">{t("schedulesEmpty")}</p>
						</div>
					) : (
						<ul className="schedule-list">
							{schedules.map((schedule) => (
								<ScheduleItem
									key={schedule.id}
									schedule={schedule}
									onEdit={() => setEditing(schedule)}
								/>
							))}
						</ul>
					)}
				</div>
			</div>
			{editing && (
				<ScheduleDialog
					schedule={editing === "new" ? null : editing}
					onClose={() => setEditing(null)}
				/>
			)}
		</main>
	);
}

function fieldError(error: unknown, field: string): string | null {
	if (!(error instanceof ApiError) || error.field !== field) return null;
	if (field === "name" && error.code === "conflict") return t("scheduleNameTaken");
	return describeError(error);
}

const FIELDS = ["name", "cron", "session", "message"];

/** A new task, or changes to one: name, times (a common one or cron, with the next runs), session, letter. */
function ScheduleDialog({ schedule, onClose }: { schedule: Schedule | null; onClose: () => void }) {
	useLang();
	const sessions = useAppState((state) => state.sessions);
	const standing = useMemo(
		() =>
			Object.values(sessions)
				.filter((session) => session.kind === "standing" && session.archivedAt === null)
				.sort((a, b) => a.name.localeCompare(b.name)),
		[sessions],
	);
	const [name, setName] = useState(schedule?.name ?? "");
	const [cron, setCron] = useState(schedule?.cron ?? "0 9 * * *");
	const [sessionId, setSessionId] = useState(schedule?.sessionId ?? standing[0]?.id ?? "");
	const [message, setMessage] = useState(schedule?.message ?? "");
	const [permMode, setPermMode] = useState<PermissionMode | "">(schedule?.permissionMode ?? "");
	const [runMode, setRunMode] = useState<ScheduleMode>(schedule?.mode ?? "letter");
	const [autoArchive, setAutoArchive] = useState(schedule?.autoArchive ?? true);
	const [catchUp, setCatchUp] = useState(schedule?.catchUp ?? true);
	const now = useNow();
	const preview = useMemo(() => cronPreview(cron, now), [cron, now]);
	const ids = {
		name: useId(),
		nameError: useId(),
		cron: useId(),
		cronNote: useId(),
		message: useId(),
		messageError: useId(),
		autoArchive: useId(),
	};
	const target = sessions[sessionId];
	const save = useAction(async () => {
		const input: ScheduleInput = {
			name,
			cron,
			session: sessionId,
			message,
			permissionMode: permMode || null,
			mode: runMode,
			autoArchive,
			catchUp,
		};
		await saveSchedule(schedule?.id ?? null, input);
		onClose();
	});
	const preset = PRESETS.find(([, value]) => value === cron.trim().split(/\s+/).join(" "))?.[0];
	const nameError = fieldError(save.error, "name");
	const cronError = fieldError(save.error, "cron") ?? preview.error;
	const messageError = fieldError(save.error, "message");
	const ready = name.trim() && message.trim() && sessionId && !preview.error;
	return (
		<Dialog
			title={schedule ? t("editSchedule") : t("newSchedule")}
			size="m"
			onClose={onClose}
			footer={
				<>
					<Button onClick={onClose}>{t("cancel")}</Button>
					<Button
						variant="primary"
						busy={save.busy}
						disabled={!ready}
						onClick={() => void save.run()}
					>
						<CheckIcon />
						{schedule ? t("save") : t("create")}
					</Button>
				</>
			}
		>
			<Field label={t("scheduleName")} htmlFor={ids.name} error={nameError} errorId={ids.nameError}>
				<input
					id={ids.name}
					className="input"
					value={name}
					maxLength={60}
					autoFocus
					aria-invalid={nameError ? "true" : undefined}
					aria-describedby={nameError ? ids.nameError : undefined}
					onChange={(event) => setName(event.target.value)}
				/>
			</Field>
			<div className="field-row">
				<Field label={t("scheduleWhen")}>
					<Select
						label={t("scheduleWhen")}
						value={preset ?? "custom"}
						options={[
							...PRESETS.map(([key]) => ({
								value: key,
								label: t(`preset_${key}` as MessageKey),
							})),
							{ value: "custom", label: t("preset_custom") },
						]}
						onChange={(value) => {
							const chosen = PRESETS.find(([key]) => key === value);
							if (chosen) setCron(chosen[1]);
						}}
					/>
				</Field>
				<Field label={t("scheduleCronLabel")} htmlFor={ids.cron} info={t("scheduleCronHint")}>
					<input
						id={ids.cron}
						className="input schedule-cron"
						value={cron}
						maxLength={200}
						spellCheck={false}
						autoComplete="off"
						aria-invalid={cronError ? "true" : undefined}
						aria-describedby={ids.cronNote}
						onChange={(event) => setCron(event.target.value)}
					/>
				</Field>
			</div>
			<p id={ids.cronNote} className={cronError ? "field-error" : "hint"} aria-live="polite">
				{cronError ??
					t("scheduleNextRuns", {
						times: preview.runs.map((run) => formatWhen(run)).join(t("enumSeparator")),
					})}
			</p>
			<Field
				label={t("scheduleSession")}
				info={t("scheduleSessionHint")}
				error={fieldError(save.error, "session")}
			>
				{standing.length === 0 ? (
					<p className="empty-box">{t("scheduleNoSessions")}</p>
				) : (
					<Select
						label={t("scheduleSession")}
						value={sessionId}
						options={standing.map((session) => ({ value: session.id, label: session.name }))}
						onChange={setSessionId}
					/>
				)}
			</Field>
			<Field
				label={t("scheduleMessage")}
				htmlFor={ids.message}
				error={messageError}
				errorId={ids.messageError}
			>
				<textarea
					id={ids.message}
					className="textarea textarea-large"
					placeholder={t("scheduleMessagePlaceholder")}
					value={message}
					aria-invalid={messageError ? "true" : undefined}
					aria-describedby={messageError ? ids.messageError : undefined}
					onChange={(event) => setMessage(event.target.value)}
				/>
			</Field>
			<div className="field-row">
				<Field label={t("scheduleMode")} info={t("scheduleModeHelp")}>
					<Select
						label={t("scheduleMode")}
						value={runMode}
						options={SCHEDULE_MODES.map((value) => ({
							value,
							label: t(`scheduleMode_${value}`),
							hint: t(`scheduleModeHint_${value}`),
						}))}
						onChange={(value) => setRunMode(value as ScheduleMode)}
					/>
				</Field>
				<Field label={t("schedulePermission")}>
					<Select
						label={t("schedulePermission")}
						value={permMode}
						options={[
							{
								value: "",
								label: t("schedulePermission_session", {
									mode: target ? t(`perm_${permissionModeOf(target.options)}`) : "—",
								}),
							},
							...PERMISSION_MODES.map((value) => ({ value, label: t(`perm_${value}`) })),
						]}
						onChange={(value) => setPermMode(value as PermissionMode | "")}
					/>
				</Field>
			</div>
			<Field label={t("scheduleCatchUp")} info={t("scheduleCatchUpHint")}>
				<Select
					label={t("scheduleCatchUp")}
					value={catchUp ? "yes" : "no"}
					options={[
						{ value: "yes", label: t("scheduleCatchUp_yes") },
						{ value: "no", label: t("scheduleCatchUp_no") },
					]}
					onChange={(value) => setCatchUp(value === "yes")}
				/>
			</Field>
			{runMode === "task_session" && (
				<div className="setting-box">
					<SettingRow
						label={t("scheduleAutoArchive")}
						hint={t("scheduleAutoArchiveHint")}
						labelId={ids.autoArchive}
					>
						<Switch checked={autoArchive} labelledBy={ids.autoArchive} onChange={setAutoArchive} />
					</SettingRow>
				</div>
			)}
			<ErrorBox error={generalError(save.error)} />
		</Dialog>
	);
}

function generalError(error: unknown): unknown {
	if (error instanceof ApiError && error.field && FIELDS.includes(error.field)) return null;
	return error;
}
