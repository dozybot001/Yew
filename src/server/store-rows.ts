import type { AttachmentRef, EntryBody, JsonObject } from "../shared/messages.ts";
import type {
	Approval,
	Device,
	Entry,
	Group,
	PermissionRequest,
	PermissionRule,
	QuestionRequest,
	QueuedMessage,
	Session,
	SessionKind,
	SessionOptions,
	SessionStatus,
	TaskOutcome,
	ThinkingLevel,
	Todo,
	ToolCallStatus,
	ToolCallView,
	UsageTotals,
} from "../shared/types.ts";
import { json } from "./db/database.ts";

export interface SessionRow {
	id: string;
	name: string;
	kind: SessionKind;
	group_id: string | null;
	responsibility: string;
	cwd: string | null;
	provider: string;
	model: string;
	thinking: ThinkingLevel;
	rules: string;
	options: string;
	todos: string;
	context: string | null;
	status: SessionStatus;
	status_detail: string | null;
	pinned: number;
	unread: number;
	archived_at: number | null;
	usage_input: number;
	usage_output: number;
	usage_cache_read: number;
	usage_cache_write: number;
	usage_cost: number;
	context_tokens: number;
	event_seq: number;
	message_seq: number;
	parent_id: string | null;
	outcome: TaskOutcome | null;
	interventions: number;
	letters_sent: number;
	last_activity_at: number;
	created_at: number;
	updated_at: number;
}

export interface GroupRow {
	id: string;
	name: string;
	position: number;
	created_at: number;
	updated_at: number;
}

export interface EntryRow {
	id: string;
	session_id: string;
	seq: number;
	role: string;
	body: string;
	created_at: number;
}

export interface ToolCallRow {
	id: string;
	session_id: string;
	message_id: string;
	call_id: string;
	tool: string;
	args: string;
	status: ToolCallStatus;
	detail: string | null;
	result_message_id: string | null;
	started_at: number | null;
	finished_at: number | null;
	created_at: number;
}

export interface ApprovalRow {
	id: string;
	session_id: string;
	tool_call_id: string | null;
	kind: "permission" | "question";
	request: string;
	status: Approval["status"];
	response: string | null;
	created_at: number;
	resolved_at: number | null;
}

export interface QueueRow {
	id: string;
	session_id: string;
	body: string;
	created_at: number;
	updated_at: number;
}

export interface UsageRow {
	cost: number;
	input: number;
	output: number;
	cache_read: number;
	cache_write: number;
}

export function usageTotals(row: UsageRow): UsageTotals {
	return {
		cost: row.cost,
		input: row.input,
		output: row.output,
		cacheRead: row.cache_read,
		cacheWrite: row.cache_write,
	};
}

export function toSession(row: SessionRow): Session {
	return {
		id: row.id,
		name: row.name,
		kind: row.kind,
		groupId: row.group_id,
		responsibility: row.responsibility,
		cwd: row.cwd,
		provider: row.provider,
		model: row.model,
		thinking: row.thinking,
		rules: json<PermissionRule[]>(row.rules, []),
		options: json<SessionOptions>(row.options, {}),
		todos: json<Todo[]>(row.todos, []),
		status: row.status,
		statusDetail: row.status_detail,
		pinned: row.pinned === 1,
		unread: row.unread,
		archivedAt: row.archived_at,
		usage: {
			input: row.usage_input,
			output: row.usage_output,
			cacheRead: row.usage_cache_read,
			cacheWrite: row.usage_cache_write,
			cost: row.usage_cost,
		},
		contextTokens: row.context_tokens,
		eventSeq: row.event_seq,
		parentId: row.parent_id,
		outcome: row.outcome,
		interventions: row.interventions,
		lettersSent: row.letters_sent,
		lastActivityAt: row.last_activity_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export interface DeviceRow {
	id: string;
	name: string;
	public_key: string;
	push_token: string | null;
	push: number;
	created_at: number;
	last_seen_at: number | null;
}

export function toDevice(row: DeviceRow): Device {
	return {
		id: row.id,
		name: row.name,
		publicKey: row.public_key,
		push: row.push === 1,
		canPush: row.push_token !== null,
		createdAt: row.created_at,
		lastSeenAt: row.last_seen_at,
	};
}

export function toGroup(row: GroupRow): Group {
	return {
		id: row.id,
		name: row.name,
		position: row.position,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export function toEntry(row: EntryRow): Entry {
	const body = JSON.parse(row.body) as EntryBody;
	return {
		...body,
		id: row.id,
		sessionId: row.session_id,
		seq: row.seq,
		createdAt: row.created_at,
	};
}

export function toToolCall(row: ToolCallRow): ToolCallView {
	return {
		id: row.id,
		sessionId: row.session_id,
		messageId: row.message_id,
		callId: row.call_id,
		tool: row.tool,
		args: JSON.parse(row.args) as JsonObject,
		status: row.status,
		detail: json<JsonObject | null>(row.detail, null),
		resultMessageId: row.result_message_id,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
		createdAt: row.created_at,
	};
}

export function toApproval(row: ApprovalRow): Approval {
	return {
		id: row.id,
		sessionId: row.session_id,
		toolCallId: row.tool_call_id,
		kind: row.kind,
		request: JSON.parse(row.request) as PermissionRequest | QuestionRequest,
		status: row.status,
		response: json<Approval["response"]>(row.response, null),
		createdAt: row.created_at,
		resolvedAt: row.resolved_at,
	};
}

export function toQueued(row: QueueRow): QueuedMessage {
	const body = JSON.parse(row.body) as { text: string; attachments?: AttachmentRef[] };
	return {
		id: row.id,
		sessionId: row.session_id,
		text: body.text,
		...(body.attachments && body.attachments.length > 0 ? { attachments: body.attachments } : {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}
