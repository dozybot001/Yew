import type { AttachmentRef, EntryBody, JsonObject, PersonQuote } from "./messages.ts";

export type SessionKind = "standing" | "task";
export type SessionStatus = "idle" | "working" | "waiting" | "error" | "needs_review";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const SESSION_KINDS: readonly SessionKind[] = ["standing", "task"];
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export type RuleEffect = "allow" | "ask" | "deny";

/** One permission rule: an effect for a tool, optionally narrowed by a path glob, command prefix or domain. */
export interface PermissionRule {
	effect: RuleEffect;
	tool: string;
	pattern?: string;
}

/** An additional directory a session can read or write alongside its main working folder. */
export const EXTRA_DIR_ACCESS = ["read", "write"] as const;
export type ExtraDirAccess = (typeof EXTRA_DIR_ACCESS)[number];

export interface ExtraDir {
	path: string;
	access: ExtraDirAccess;
}

export interface SessionOptions {
	/** Compact when the context reaches this many tokens; null uses the default. */
	compactAt?: number | null;
	/** Before 0.1: let write and edit change files without asking. Read as the default mode now. */
	directEdits?: boolean;
	/**
	 * How permission (授权) works for the session's calls: default (calls run
	 * unless risky or marked with confirm), review (what would be asked goes to a separate check by
	 * the model first) or skip (no permission is asked; what would have been asked is marked).
	 * Approvals (审批) are another thing: what a session puts to the person to decide, with ask_user
	 * or a card; no mode skips those. Earlier modes ("auto", "manual") read as default.
	 */
	permissionMode?: PermissionMode;
	/** Yew's read-only helpers only (never stored): anything but looking is asked about. */
	readerOnly?: boolean;
	/** Additional folders this session may read or write alongside cwd. */
	extraDirs?: ExtraDir[];
	/** Additional domains this session's sandboxed commands may reach without asking. */
	allowedDomains?: string[];
	/**
	 * Its commands outside the sandbox may use container engines and virtual machines (Docker and the
	 * like). A container can mount any folder, Yew's data too, so only the person turns this on.
	 */
	allowContainers?: boolean;
	/** What happens to letters from other sessions: delivered, held for the person, or refused. */
	receive?: ReceivePolicy;
	/** Letters the session may send per message or decision from the person; null or absent: the default. */
	letterQuota?: number | null;
	/** May put decision cards in the approval center directly, as the main conversation can. */
	canPostCards?: boolean;
	/** May rename sessions and teams and move sessions between teams, as the main conversation can. */
	canOrganize?: boolean;
	/** The most this session may spend in a day, in US dollars; null or absent: no limit of its own. */
	dailyBudget?: number | null;
	/** More room for one day, given when the person continued the session after it reached a limit. */
	budgetExtra?: { day: string; amount: number } | null;
	/** Named after its first message; after its first turn Yew gives it a short name of its own. */
	autoName?: boolean;
}

export const RECEIVE_POLICIES = ["accept", "hold", "refuse"] as const;
export type ReceivePolicy = (typeof RECEIVE_POLICIES)[number];

/**
 * Letters a session may send between two messages or decisions from the person, so sessions cannot
 * keep writing to each other without the person.
 */
export const DEFAULT_LETTER_QUOTA = 30;
export const MAIN_LETTER_QUOTA = 60;

export function letterQuotaOf(options: SessionOptions, isMain: boolean): number {
	return options.letterQuota ?? (isMain ? MAIN_LETTER_QUOTA : DEFAULT_LETTER_QUOTA);
}

export const TASK_OUTCOMES = ["done", "given_up", "failed"] as const;
export type TaskOutcome = (typeof TASK_OUTCOMES)[number];

/** The relay Tenon runs, which phone access uses unless the person sets their own. */
export const DEFAULT_RELAY_URL = "wss://relay.tenonai.cn";

export const PERMISSION_MODES = ["default", "review", "skip"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Program used to open local file links clicked in replies. */
export const FILE_OPENERS = ["system", "vscode", "cursor", "zed", "finder"] as const;
export type FileOpener = (typeof FILE_OPENERS)[number];

/**
 * A mode as stored or sent: the three of now, and the ones before 1.7: "auto" (ask when needed) is
 * the default now, and "manual" (ask each time) is gone and reads as default.
 */
export function normalizePermissionMode(value: unknown): PermissionMode | null {
	if (value === "default" || value === "review" || value === "skip") return value;
	if (value === "auto" || value === "manual") return "default";
	return null;
}

/** The session's permission mode. */
export function permissionModeOf(options: SessionOptions): PermissionMode {
	return normalizePermissionMode(options.permissionMode) ?? "default";
}

/** The most tokens the default compaction threshold reaches, however large the model's window is. */
export const COMPACT_CAP = 300_000;

/**
 * The context size at which a session's history is compacted unless the session sets its own: 80% of
 * the model's window, at most COMPACT_CAP. A window of a million tokens would otherwise fill to
 * 800,000 before compacting, and every request is billed for the context it carries.
 */
export function defaultCompactAt(contextWindow: number): number {
	return Math.min(Math.floor(contextWindow * 0.8), COMPACT_CAP);
}

export interface Todo {
	text: string;
	status: "pending" | "in_progress" | "done";
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** US dollars. */
	cost: number;
}

/** What all sessions together used on one local calendar day (YYYY-MM-DD). */
export interface UsageDay extends UsageTotals {
	day: string;
}

/** What one session used on one day. */
export interface SessionUsage extends UsageTotals {
	sessionId: string;
	name: string;
	archived: boolean;
}

/** The usage page: the last days oldest first, every day present; `budget` is the daily limit for all sessions. */
export interface UsageOverview {
	today: string;
	budget: number | null;
	days: UsageDay[];
}

/** One day on the usage page: the sessions that used a model then, the one that cost most first. */
export interface UsageDetail {
	day: string;
	total: number;
	sessions: SessionUsage[];
}

export interface Group {
	id: string;
	name: string;
	position: number;
	createdAt: number;
	updatedAt: number;
}

export interface Session {
	id: string;
	name: string;
	kind: SessionKind;
	groupId: string | null;
	responsibility: string;
	/** Working folder; null means a chat without file access. */
	cwd: string | null;
	provider: string;
	model: string;
	thinking: ThinkingLevel;
	rules: PermissionRule[];
	options: SessionOptions;
	todos: Todo[];
	status: SessionStatus;
	statusDetail: string | null;
	pinned: boolean;
	unread: number;
	archivedAt: number | null;
	usage: UsageTotals;
	/** Tokens the last model request used; drives compaction and the context meter. */
	contextTokens: number;
	/** Sequence number of the last durable event; the transcript stream resumes after it. */
	eventSeq: number;
	/** The session that opened this one; null when the person opened it. */
	parentId: string | null;
	/** How a task session ended, as it recorded with finish_task. */
	outcome: TaskOutcome | null;
	/**
	 * Times the person stepped in: messages, approvals and answers. Kept with the outcome as
	 * evaluation data.
	 */
	interventions: number;
	/** Letters sent since the person's last message or decision; the quota counts these. */
	lettersSent: number;
	lastActivityAt: number;
	createdAt: number;
	updatedAt: number;
}

export const LETTER_KINDS = ["notice", "request", "decision", "report"] as const;
export type LetterKind = (typeof LETTER_KINDS)[number];
export type LetterStatus = "queued" | "held" | "delivered" | "done" | "refused" | "dropped";
/** Who sent a letter: a session, the person (decisions), the command line (`yew send`) or Yew itself. */
export type SenderKind = "session" | "person" | "cli" | "yew";

/** A letter between sessions. Stored before it is delivered, so a restart loses none. */
export interface Letter {
	id: string;
	threadId: string;
	replyTo: string | null;
	fromKind: SenderKind;
	fromSession: string | null;
	/** The sender's name when the letter was sent. */
	fromName: string;
	toSession: string;
	kind: LetterKind;
	/** The first line, understandable on its own. */
	summary: string;
	body: string;
	status: LetterStatus;
	/** Why the letter was held, refused or dropped. */
	statusReason: string | null;
	/** Sessions that sent letters along this chain, oldest first (for the hop and loop limits). */
	path: string[];
	/** Yew sent the session's final reply on its behalf. */
	auto: boolean;
	/** For a decision letter: the number of the decision it carries. */
	decision: number | null;
	/** The scheduled task whose run this letter starts or reports on. */
	scheduleId: string | null;
	/** Server-stamped ID of the person's message in the main conversation that started this chain. */
	originEntryId?: string | null;
	/** The person's words the letter passes on, each found by Yew in its own records. */
	quotes?: PersonQuote[];
	createdAt: number;
	deliveredAt: number | null;
}

/** Letters one session sent another within the map's window, added up for one line on the map. */
export interface LetterFlow {
	from: string;
	to: string;
	count: number;
	/** When the latest of them was sent. */
	lastAt: number;
}

/**
 * What the sessions map adds to the session list: who wrote to whom since `since`, the busiest
 * pair first. Archived sessions are left out.
 */
export interface SessionMap {
	since: number;
	letters: LetterFlow[];
}

export interface CardOption {
	label: string;
	detail?: string;
}

export type CardStatus = "pending" | "decided" | "withdrawn";

/**
 * A decision card in the approval center: what is to be decided, the options with the recommended
 * one, the deadline, the sessions involved, whether it can be undone, who does what once it is
 * decided, and the person's answer.
 */
export interface Card {
	id: string;
	/** The decision number sessions quote, #1, #2… */
	number: number;
	/** The session that put the card in the approval center. */
	createdBy: string | null;
	/** The session whose request the card is; the decision goes back to it. */
	requestedBy: string | null;
	title: string;
	context: string;
	options: CardOption[];
	/** Index of the recommended option. */
	recommended: number | null;
	deadline: string | null;
	/** Sessions involved. */
	sessions: string[];
	/** Whether the decision can be undone; null on cards from before it was asked. */
	undoable: boolean | null;
	/** How it can be undone, or what cannot be; may be empty. */
	reversible: string;
	/** Who does what once it is decided, beyond what the options say; may be empty. */
	after: string;
	status: CardStatus;
	/** Index of the chosen option; null when the person answered with a note only. */
	choice: number | null;
	note: string | null;
	decidedAt: number | null;
	withdrawnReason: string | null;
	createdAt: number;
	updatedAt: number;
}

export type Entry = EntryBody & {
	id: string;
	sessionId: string;
	seq: number;
	createdAt: number;
};

export type ToolCallStatus =
	| "pending"
	| "waiting"
	| "running"
	| "done"
	| "error"
	| "denied"
	| "needs_review";

export interface ToolCallView {
	id: string;
	sessionId: string;
	messageId: string;
	callId: string;
	tool: string;
	args: JsonObject;
	status: ToolCallStatus;
	/** Tool-specific data for the interface, such as a diff or an exit code. */
	detail: JsonObject | null;
	resultMessageId: string | null;
	startedAt: number | null;
	finishedAt: number | null;
	createdAt: number;
}

export type ApprovalDecision = "allow_once" | "allow_always" | "deny";

/** Why an operation is asked about every time; the interface words each one. */
export type ConfirmReason =
	| "delete-files"
	// Deleting files outside the working folder: they cannot be restored with git.
	| "delete-outside"
	// A command Yew cannot read; only a mark on calls that ran without asking (skip mode).
	| "unreadable-command"
	// A command that names Yew Harness's own data, where decisions are kept.
	| "yew-data"
	// A command that names a folder the person keeps from sessions.
	| "hidden-folder"
	| "delete-untracked"
	| "delete-branch"
	| "delete-tag"
	| "delete-stash"
	| "delete-ref"
	| "delete-worktree"
	| "discard-changes"
	| "rewrite-history"
	| "push"
	// Setting up a repository (.git/config): git init, clone, remote or local config.
	| "git-setup"
	// Launching a desktop application (open -a) outside the sandbox.
	| "launch-app"
	| "publish-package"
	| "change-package"
	| "publish-image"
	| "github"
	| "remote-machine"
	| "remote-copy"
	| "send-data"
	| "write-disk"
	| "cluster"
	| "infrastructure"
	| "system-services"
	| "yew-cli"
	| "credentials"
	| "write-credentials"
	| "admin"
	| "write-outside"
	// A command that runs outside the system sandbox.
	| "outside-sandbox"
	// A command in the sandbox connecting to a site that is not on its list; asked while it runs.
	| "connect-site"
	// The same while other things run in the sandbox, so the connection may be theirs: allowed once.
	| "connect-site-unsure"
	// An action of the computer control tool: a click or keystroke anywhere on the screen.
	| "computer-control"
	// An action of the browser on a page in the person's own Chrome, with their sign-ins.
	| "browser-action"
	// A script the browser runs in a page in the person's own Chrome.
	| "browser-script"
	// An MCP tool that sends, publishes or deletes something in the service it connects to.
	| "service-action"
	// manage_yew changes that widen what a session may do
	| "widen-permission"
	| "change-folder"
	| "open-letters"
	| "raise-quota"
	| "raise-budget"
	| "grant-rights"
	| "change-main"
	| "decision-log";

export interface PermissionRequest {
	tool: string;
	/** One line describing what will happen, e.g. the command or the file. */
	summary: string;
	/** Must-confirm operations can only be allowed once; "always allow" is not offered for them. */
	mustConfirm: boolean;
	/** Rules "allow and remember" would add; absent when remembering is not offered. */
	rememberRules?: PermissionRule[];
	/** Why a must-confirm operation asks every time. */
	reasons?: ConfirmReason[];
	/**
	 * Shown with "always allow": the tool acts in the built-in browser with the person's sign-ins, so
	 * remembering it also covers sending, paying and deleting there.
	 */
	warning?: "acts-as-you";
	/** The same in English words, on requests saved before the reasons had codes. */
	reason?: string;
	/** What the call is for, in the session's words, such as a command's purpose or a task's brief. */
	description?: string;
	/** The change an edit or write would make, as a unified patch, so the person sees it first. */
	diff?: string;
	/** The changes manage_yew would make, with names in place of ids, for the interface to word. */
	changes?: ChangeStep[];
	/**
	 * What ran in the system sandbox when a command asked to reach a site and the connection could
	 * have been any of them ("connect-site-unsure"): commands, background commands, MCP servers.
	 */
	running?: { kind: "command" | "job" | "mcp"; text: string }[];
	/**
	 * A permission only the person gives (the card marks it): the operation cannot be taken back on
	 * this computer or reaches other people, so the automatic mode's check is not asked (personOnly
	 * says when).
	 */
	matter?: boolean;
	/** The automatic mode's check did not allow the call: why, in its words, for the person to see. */
	review?: string;
}

/**
 * Permissions (授权) only the person gives: what cannot be taken back on this computer or reaches
 * other people, Yew Harness's own command line, which manages the person's keys and the service,
 * and the system's services (launchctl, systemctl, crontab), which start programs outside Yew
 * Harness's protection. The default mode asks about them like any risky call; the automatic mode
 * does not put them to its check; skip mode asks about no permission, these included, and marks
 * them in the record.
 */
export const DECISION_REASONS: ReadonlySet<ConfirmReason> = new Set<ConfirmReason>([
	"yew-cli",
	"git-setup",
	"launch-app",
	"publish-package",
	"change-package",
	"publish-image",
	"github",
	"send-data",
	"remote-machine",
	"remote-copy",
	"cluster",
	"infrastructure",
	"write-disk",
	"delete-outside",
	"service-action",
	"system-services",
	"raise-budget",
]);

/**
 * Whether only the person answers a request asked for these reasons under `mode`. In skip mode one
 * thing is left: raising a spending limit, which is an approval (审批) of the person's money rather
 * than a permission, so no mode skips it.
 */
export function personOnly(reasons: readonly ConfirmReason[], mode: PermissionMode): boolean {
	return reasons.some((reason) =>
		mode === "skip" ? reason === "raise-budget" : DECISION_REASONS.has(reason),
	);
}

/** What a call that ran without being asked about carried, for its row. */
export interface PermissionNote {
	/** Skip mode: what it would have been asked about in the default mode. */
	risk?: ConfirmReason[];
	/** Review mode: the check allowed it, and why. */
	reviewed?: string;
}

/**
 * One change manage_yew makes, as the person reads it on the permission card and in the changed
 * session: names in place of ids, settings as codes the interface words in its language.
 */
export type ChangeStep =
	| { action: "create_team"; name: string }
	| { action: "rename_team"; from: string; to: string }
	| {
			action: "create_session";
			name: string;
			folder: string | null;
			model: string;
			team: string | null;
			role: string;
	  }
	| { action: "rename_session"; from: string; to: string }
	| { action: "move_to_team"; sessions: string[]; team: string | null }
	| { action: "set_role"; session: string; role: string }
	| { action: "set_model"; session: string; from: string; to: string }
	| { action: "set_folder"; session: string; from: string | null; to: string | null }
	| { action: "set_permission"; session: string; from: PermissionMode; to: PermissionMode }
	| { action: "set_receive"; session: string; from: ReceivePolicy; to: ReceivePolicy }
	| { action: "set_letter_quota"; session: string; from: number; to: number }
	/** A daily spending limit, of one session or of all together (no session); null is no limit. */
	| { action: "set_daily_budget"; session: string | null; from: number | null; to: number | null }
	| { action: "set_right"; session: string; right: "cards" | "manage"; on: boolean }
	| { action: "pin"; session: string; on: boolean }
	| { action: "archive"; session: string; on: boolean }
	| { action: "set_main"; from: string | null; to: string | null }
	| { action: "set_default_model"; from: string; to: string }
	| { action: "set_decision_log"; from: string | null; to: string | null }
	| { action: "add_workspace"; folder: string }
	| { action: "remove_workspace"; folder: string }
	| { action: "set_theme"; to: "system" | "light" | "dark" }
	| { action: "set_language"; to: "system" | "zh" | "en" }
	| {
			action: "create_schedule";
			name: string;
			cron: string;
			session: string;
			message: string;
			permission: PermissionMode | null;
			mode?: ScheduleMode;
			autoArchive?: boolean;
	  }
	/** Only the fields that change are present; `permission` null means the session's own mode. */
	| {
			action: "change_schedule";
			schedule: string;
			name?: string;
			cron?: string;
			session?: string;
			message?: string;
			permission?: PermissionMode | null;
			mode?: ScheduleMode;
			autoArchive?: boolean;
			catchUp?: boolean;
			enabled?: boolean;
	  }
	| { action: "set_extra_dirs"; session: string; dirs: ExtraDir[] }
	| { action: "set_allowed_domains"; session: string | null; domains: string[] };

export const SCHEDULE_MODES = ["letter", "task_session"] as const;
export type ScheduleMode = (typeof SCHEDULE_MODES)[number];

/**
 * How a scheduled task's latest run went: still running, finished, stopped with an error, stopped by the
 * person, or skipped (the reason says why).
 */
export type ScheduleStatus = "running" | "done" | "error" | "stopped" | "skipped";

/**
 * Why a run was skipped: the last run was not finished, the session is archived, or the time passed
 * while Yew was not running or the computer slept and the task skips missed runs.
 */
export type ScheduleSkip = "busy" | "archived" | "missed";

/**
 * A scheduled task: at the times its cron expression names, Yew either writes a letter to a
 * standing session (`letter`) or opens a fresh task session (`task_session`).
 */
export interface Schedule {
	id: string;
	name: string;
	/** Five fields, in the computer's time zone. */
	cron: string;
	sessionId: string;
	/** The letter's text: the first line is its summary. */
	message: string;
	/** The permission mode for its runs; null uses the session's own. */
	permissionMode: PermissionMode | null;
	/** Whether each run writes to the standing session or opens a fresh task session. */
	mode: ScheduleMode;
	/** In task_session mode, archive the task session automatically when it finishes cleanly. */
	autoArchive: boolean;
	/** A run missed while Yew was not running or the computer slept runs once afterwards. */
	catchUp: boolean;
	enabled: boolean;
	/** When it runs next; null while it is turned off. */
	nextRunAt: number | null;
	lastRunAt: number | null;
	lastStatus: ScheduleStatus | null;
	/** The first line of the run's reply, the error, or a ScheduleSkip code. */
	lastDetail: string | null;
	/** The letter of the latest run. */
	lastLetterId: string | null;
	/** The task session opened for the latest task_session run, if any. */
	lastSessionId: string | null;
	createdAt: number;
	updatedAt: number;
}

export const ARTIFACT_KINDS = ["markdown", "html", "json", "chart"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** Something a session made for the person to keep: a document, a page, data or a chart. */
export interface Artifact {
	id: string;
	sessionId: string;
	name: string;
	kind: ArtifactKind;
	/** The latest version; versions count from 1. */
	version: number;
	/** Bytes of the latest version. */
	size: number;
	createdAt: number;
	updatedAt: number;
}

/** A phone paired with this Mac through the relay. */
export interface Device {
	id: string;
	name: string;
	/** The phone's Noise static key, base64url. */
	publicKey: string;
	/** Whether Yew sends it notifications. */
	push: boolean;
	/** The phone has given an APNs token. */
	canPush: boolean;
	createdAt: number;
	lastSeenAt: number | null;
}

/** One question a session asks the person with ask_user; a card holds up to four. */
export interface Question {
	question: string;
	/** A tag of a few words shown before the question, such as its topic. */
	header?: string;
	options?: QuestionOption[];
	/** Index of the option the session recommends; it is chosen to start with. */
	recommended?: number;
	/** The person may pick more than one option. */
	multiple?: boolean;
}

export interface QuestionOption {
	label: string;
	/** What the choice means or leads to. */
	detail?: string;
}

export interface QuestionRequest {
	questions?: Question[];
	/**
	 * Asked at the end of a reply rather than with ask_user. Yew put it in the approval center; the answer
	 * goes to the session as the person's message.
	 */
	fromReply?: boolean;
	/** One question with plain options, as asked before a card could hold several. */
	question?: string;
	options?: string[];
}

/** The person's answer to one question: the options picked, by index, and words of their own. */
export interface QuestionAnswer {
	choices: number[];
	text?: string;
}

/** The questions of a request, whichever form it was saved in. */
export function questionsOf(request: QuestionRequest): Question[] {
	if (request.questions && request.questions.length > 0) return request.questions;
	const options = request.options?.map((label) => ({ label }));
	return [{ question: request.question ?? "", ...(options?.length ? { options } : {}) }];
}

export interface Approval {
	id: string;
	sessionId: string;
	toolCallId: string | null;
	kind: "permission" | "question";
	request: PermissionRequest | QuestionRequest;
	status: "pending" | "resolved" | "cancelled";
	/** answer is the person's words, or for structured answers the text the session read. */
	response: {
		decision?: ApprovalDecision;
		reason?: string;
		answer?: string;
		answers?: QuestionAnswer[];
	} | null;
	createdAt: number;
	resolvedAt: number | null;
}

export interface QueuedMessage {
	id: string;
	sessionId: string;
	text: string;
	attachments?: AttachmentRef[];
	createdAt: number;
	updatedAt: number;
}

export interface Page<T> {
	items: T[];
	nextCursor: string | null;
}

/** Durable per-session events, replayed by sequence number after a reconnect. */
export type SessionEvent =
	| { type: "session"; session: Session }
	| { type: "entry"; entry: Entry }
	| { type: "toolCall"; toolCall: ToolCallView }
	| { type: "approval"; approval: Approval }
	| { type: "queue"; queue: QueuedMessage[] }
	/** The conversation was taken back to just after this entry: load it again. */
	| { type: "rewound"; throughSeq: number };

export interface Transcript {
	session: Session;
	entries: Entry[];
	toolCalls: ToolCallView[];
	approvals: Approval[];
	queue: QueuedMessage[];
	/** Seq of the oldest entry returned when older ones exist; pass as `before` to load them. */
	olderCursor: number | null;
}

/** How this Yew Harness was installed: a global npm package, a source checkout, or some other way. */
export type InstallKind = "npm" | "source" | "other";

/** Versions and updates, for the About page and the floating Yew. */
export interface UpdateState {
	/** What is running now. */
	version: string;
	build: string | null;
	/** What is installed on this computer now; it differs after an update or a pull without a restart. */
	installed: { version: string; build: string | null };
	/** The service runs older code than is installed: a restart takes it up. */
	restart: boolean;
	kind: InstallKind;
	/** Whether Yew Harness checks npm for a new version once a day. */
	checks: boolean;
	/** The newest version on npm when last checked; null before any check. */
	latest: { version: string; checkedAt: number } | null;
	/** A newer version than the installed one is on npm. */
	available: boolean;
	/** The command to run yourself when Yew Harness cannot update itself here; null when it can. */
	manual: string | null;
	/** An update being installed, or how the last one ended. */
	job: { state: "installing" | "installed" | "failed"; version: string; output: string } | null;
	/** Sessions at work now; a restart waits for them unless you say now. */
	busy: number;
	/** A restart waits for the sessions at work to stop. */
	restartPending: boolean;
}
