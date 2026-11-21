/**
 * Schema migrations, applied in order. `PRAGMA user_version` records how many have run.
 * Never edit a migration that has shipped; add a new one.
 */
export const migrations: string[] = [
	`
CREATE TABLE groups (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	position REAL NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE sessions (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('standing', 'task')),
	group_id TEXT REFERENCES groups (id) ON DELETE SET NULL,
	responsibility TEXT NOT NULL DEFAULT '',
	cwd TEXT,
	provider TEXT NOT NULL,
	model TEXT NOT NULL,
	thinking TEXT NOT NULL DEFAULT 'medium',
	rules TEXT NOT NULL DEFAULT '[]',
	options TEXT NOT NULL DEFAULT '{}',
	todos TEXT NOT NULL DEFAULT '[]',
	context TEXT,
	status TEXT NOT NULL DEFAULT 'idle'
		CHECK (status IN ('idle', 'working', 'waiting', 'error', 'needs_review')),
	status_detail TEXT,
	pinned INTEGER NOT NULL DEFAULT 0,
	unread INTEGER NOT NULL DEFAULT 0,
	archived_at INTEGER,
	usage_input INTEGER NOT NULL DEFAULT 0,
	usage_output INTEGER NOT NULL DEFAULT 0,
	usage_cache_read INTEGER NOT NULL DEFAULT 0,
	usage_cache_write INTEGER NOT NULL DEFAULT 0,
	usage_cost REAL NOT NULL DEFAULT 0,
	context_tokens INTEGER NOT NULL DEFAULT 0,
	event_seq INTEGER NOT NULL DEFAULT 0,
	message_seq INTEGER NOT NULL DEFAULT 0,
	last_activity_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX sessions_name ON sessions (name COLLATE NOCASE);

CREATE TABLE messages (
	id TEXT PRIMARY KEY,
	session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
	seq INTEGER NOT NULL,
	role TEXT NOT NULL
		CHECK (role IN ('system', 'user', 'assistant', 'toolResult', 'compaction', 'notice')),
	body TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	UNIQUE (session_id, seq)
) STRICT;

CREATE VIRTUAL TABLE message_search USING fts5 (
	text,
	session_id UNINDEXED,
	message_id UNINDEXED,
	tokenize = 'trigram'
);

CREATE TABLE tool_calls (
	id TEXT PRIMARY KEY,
	session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
	message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
	call_id TEXT NOT NULL,
	tool TEXT NOT NULL,
	args TEXT NOT NULL,
	status TEXT NOT NULL
		CHECK (status IN ('pending', 'waiting', 'running', 'done', 'error', 'denied', 'needs_review')),
	detail TEXT,
	result_message_id TEXT,
	started_at INTEGER,
	finished_at INTEGER,
	created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX tool_calls_message ON tool_calls (message_id);
CREATE INDEX tool_calls_open ON tool_calls (session_id)
	WHERE status IN ('pending', 'waiting', 'running');

CREATE TABLE approvals (
	id TEXT PRIMARY KEY,
	session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
	tool_call_id TEXT REFERENCES tool_calls (id) ON DELETE CASCADE,
	kind TEXT NOT NULL CHECK (kind IN ('permission', 'question')),
	request TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'cancelled')),
	response TEXT,
	created_at INTEGER NOT NULL,
	resolved_at INTEGER
) STRICT;
CREATE INDEX approvals_session ON approvals (session_id, created_at);
CREATE INDEX approvals_pending ON approvals (session_id) WHERE status = 'pending';

CREATE TABLE queued_messages (
	id TEXT PRIMARY KEY,
	session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
	body TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX queued_messages_session ON queued_messages (session_id, id);

CREATE TABLE session_events (
	session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
	seq INTEGER NOT NULL,
	type TEXT NOT NULL,
	data TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (session_id, seq)
) STRICT, WITHOUT ROWID;

CREATE TABLE providers (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	config TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
) STRICT;

CREATE TABLE idempotency_keys (
	scope TEXT NOT NULL,
	key TEXT NOT NULL,
	fingerprint TEXT NOT NULL,
	status INTEGER NOT NULL,
	body TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (scope, key)
) STRICT;

CREATE TABLE auth_tokens (
	hash TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('login', 'browser')),
	expires_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	last_used_at INTEGER
) STRICT;
`,
	// M2: letters between sessions, decision cards, and the session tree (blueprint sections 6 and 7).
	`
ALTER TABLE sessions ADD COLUMN parent_id TEXT REFERENCES sessions (id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN outcome TEXT CHECK (outcome IN ('done', 'given_up', 'failed'));
ALTER TABLE sessions ADD COLUMN interventions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN letters_sent INTEGER NOT NULL DEFAULT 0;
CREATE INDEX sessions_parent ON sessions (parent_id) WHERE parent_id IS NOT NULL;

CREATE TABLE letters (
	id TEXT PRIMARY KEY,
	thread_id TEXT NOT NULL,
	reply_to TEXT,
	from_kind TEXT NOT NULL CHECK (from_kind IN ('session', 'person', 'cli', 'jig')),
	from_session TEXT REFERENCES sessions (id) ON DELETE SET NULL,
	from_name TEXT NOT NULL,
	to_session TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
	kind TEXT NOT NULL CHECK (kind IN ('notice', 'request', 'decision', 'report')),
	summary TEXT NOT NULL,
	body TEXT NOT NULL,
	status TEXT NOT NULL
		CHECK (status IN ('queued', 'held', 'delivered', 'done', 'refused', 'dropped')),
	status_reason TEXT,
	path TEXT NOT NULL DEFAULT '[]',
	auto INTEGER NOT NULL DEFAULT 0,
	decision INTEGER,
	entry_id TEXT,
	created_at INTEGER NOT NULL,
	delivered_at INTEGER,
	updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX letters_inbox ON letters (to_session, status);
CREATE INDEX letters_time ON letters (created_at, id);
CREATE INDEX letters_pair ON letters (from_session, to_session, created_at);

CREATE TABLE cards (
	id TEXT PRIMARY KEY,
	number INTEGER NOT NULL UNIQUE,
	created_by TEXT REFERENCES sessions (id) ON DELETE SET NULL,
	requested_by TEXT REFERENCES sessions (id) ON DELETE SET NULL,
	title TEXT NOT NULL,
	context TEXT NOT NULL DEFAULT '',
	options TEXT NOT NULL DEFAULT '[]',
	recommended INTEGER,
	deadline TEXT,
	sessions TEXT NOT NULL DEFAULT '[]',
	reversible TEXT NOT NULL DEFAULT '',
	after TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'decided', 'withdrawn')),
	choice INTEGER,
	note TEXT,
	decided_at INTEGER,
	withdrawn_reason TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX cards_status ON cards (status, updated_at);
`,
	// Whether a decision can be undone, as yes or no for the card's top line; null on older cards.
	`
ALTER TABLE cards ADD COLUMN undoable INTEGER;
`,
	// organize_sessions became manage_jig; what "always allow" remembered for it stays limited to organizing.
	`
UPDATE sessions SET rules = replace(rules, '"tool":"organize_sessions"', '"tool":"manage_jig","pattern":"organize"')
WHERE rules LIKE '%"tool":"organize_sessions"%';
`,
	// Phones paired through the relay (M3 plan, section 4): their Noise static keys, never a secret.
	`
CREATE TABLE devices (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	public_key TEXT NOT NULL UNIQUE,
	push_token TEXT,
	push INTEGER NOT NULL DEFAULT 1,
	created_at INTEGER NOT NULL,
	last_seen_at INTEGER
) STRICT;
`,
	// Scheduled tasks (M3 plan, section 9): letters Yew sends a standing session at set times.
	`
CREATE TABLE schedules (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	cron TEXT NOT NULL,
	session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
	message TEXT NOT NULL,
	permission_mode TEXT CHECK (permission_mode IN ('auto', 'manual', 'skip')),
	catch_up INTEGER NOT NULL DEFAULT 1,
	enabled INTEGER NOT NULL DEFAULT 1,
	next_run_at INTEGER,
	last_run_at INTEGER,
	last_status TEXT CHECK (last_status IN ('running', 'done', 'error', 'stopped', 'skipped')),
	last_detail TEXT,
	last_letter_id TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX schedules_name ON schedules (name COLLATE NOCASE);
ALTER TABLE letters ADD COLUMN schedule_id TEXT REFERENCES schedules (id) ON DELETE SET NULL;
`,
	// What each session used on each local calendar day, for the daily spending limits (M3 plan, section 10).
	`
CREATE TABLE usage_daily (
	session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
	day TEXT NOT NULL,
	input INTEGER NOT NULL DEFAULT 0,
	output INTEGER NOT NULL DEFAULT 0,
	cache_read INTEGER NOT NULL DEFAULT 0,
	cache_write INTEGER NOT NULL DEFAULT 0,
	cost REAL NOT NULL DEFAULT 0,
	PRIMARY KEY (session_id, day)
) STRICT, WITHOUT ROWID;
CREATE INDEX usage_daily_day ON usage_daily (day);
`,
	// Artifacts (M4 plan, section 6): the list here, each version's file in the data folder.
	`
CREATE TABLE artifacts (
	id TEXT PRIMARY KEY,
	session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('markdown', 'html', 'json', 'chart')),
	version INTEGER NOT NULL,
	size INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (session_id, name)
) STRICT;
CREATE INDEX artifacts_updated ON artifacts (updated_at);
CREATE TABLE artifact_versions (
	artifact_id TEXT NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,
	version INTEGER NOT NULL,
	size INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (artifact_id, version)
) STRICT, WITHOUT ROWID;
`,
	// Taking a conversation back (blueprint 6.11, item 42): entries after the point stay in the
	// database, marked, and are no longer shown or sent to the model.
	"ALTER TABLE messages ADD COLUMN rewound INTEGER NOT NULL DEFAULT 0;",
	// Rewinding deletes what was taken back; entries taken back before that lose their content now.
	`UPDATE messages SET body = json_object('role', role, 'content', json('[]'), 'timestamp', created_at)
	WHERE rewound = 1;
DELETE FROM approvals WHERE tool_call_id IN (SELECT tool_calls.id FROM tool_calls
	JOIN messages ON messages.id = tool_calls.message_id WHERE messages.rewound = 1);
UPDATE tool_calls SET args = '{}', detail = NULL
	WHERE message_id IN (SELECT id FROM messages WHERE rewound = 1);`,
	// Jig was renamed Yew (blueprint, section 12): stored values that carried the old name take the
	// new one. A letter sent by Yew itself (a scheduled task) was from kind 'jig', and the check on
	// that column can only change by rebuilding the table; nothing refers to it, so it is copied over.
	`CREATE TABLE letters_yew (
	id TEXT PRIMARY KEY,
	thread_id TEXT NOT NULL,
	reply_to TEXT,
	from_kind TEXT NOT NULL CHECK (from_kind IN ('session', 'person', 'cli', 'yew')),
	from_session TEXT REFERENCES sessions (id) ON DELETE SET NULL,
	from_name TEXT NOT NULL,
	to_session TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
	kind TEXT NOT NULL CHECK (kind IN ('notice', 'request', 'decision', 'report')),
	summary TEXT NOT NULL,
	body TEXT NOT NULL,
	status TEXT NOT NULL
		CHECK (status IN ('queued', 'held', 'delivered', 'done', 'refused', 'dropped')),
	status_reason TEXT,
	path TEXT NOT NULL DEFAULT '[]',
	auto INTEGER NOT NULL DEFAULT 0,
	decision INTEGER,
	entry_id TEXT,
	created_at INTEGER NOT NULL,
	delivered_at INTEGER,
	updated_at INTEGER NOT NULL,
	schedule_id TEXT REFERENCES schedules (id) ON DELETE SET NULL
) STRICT;
INSERT INTO letters_yew (id, thread_id, reply_to, from_kind, from_session, from_name, to_session, kind,
	summary, body, status, status_reason, path, auto, decision, entry_id, created_at, delivered_at,
	updated_at, schedule_id)
SELECT id, thread_id, reply_to, CASE from_kind WHEN 'jig' THEN 'yew' ELSE from_kind END, from_session,
	from_name, to_session, kind, summary, body, status, status_reason, path, auto, decision, entry_id,
	created_at, delivered_at, updated_at, schedule_id FROM letters;
DROP TABLE letters;
ALTER TABLE letters_yew RENAME TO letters;
CREATE INDEX letters_inbox ON letters (to_session, status);
CREATE INDEX letters_time ON letters (created_at, id);
CREATE INDEX letters_pair ON letters (from_session, to_session, created_at);
UPDATE tool_calls SET tool = 'manage_yew' WHERE tool = 'manage_jig';
UPDATE messages SET body = replace(replace(body, '"name":"manage_jig"', '"name":"manage_yew"'),
	'"toolName":"manage_jig"', '"toolName":"manage_yew"')
	WHERE body LIKE '%manage_jig%';
UPDATE approvals SET request = replace(replace(request, '"tool":"manage_jig"', '"tool":"manage_yew"'),
	'"jig-cli"', '"yew-cli"')
	WHERE request LIKE '%manage_jig%' OR request LIKE '%jig-cli%';
UPDATE sessions SET rules = replace(rules, '"tool":"manage_jig"', '"tool":"manage_yew"')
	WHERE rules LIKE '%manage_jig%';
DELETE FROM session_events;`,
	// Yew no longer reads anything by Jig's names: Jig's notes in old conversations are rewritten once
	// as Yew's, so they still count as Yew's own words and not the person's.
	`UPDATE messages SET body = replace(body, '[From Jig, not from the person]', '[From Yew, not from the person]')
	WHERE body LIKE '%[From Jig, not from the person]%';`,
	// Permission modes (blueprint 6.1, item 6): "auto" (ask when needed) is the default mode now and
	// "manual" (ask each time) is gone, so both become "default". The table of scheduled tasks checks
	// its modes, so it is made again; letters keep the task they belong to.
	`
UPDATE sessions SET options = json_set(options, '$.permissionMode', 'default')
	WHERE json_extract(options, '$.permissionMode') IN ('auto', 'manual');
UPDATE settings SET value = '"default"'
	WHERE key = 'defaultPermissionMode' AND value IN ('"auto"', '"manual"');
CREATE TEMP TABLE schedule_letters AS SELECT id, schedule_id FROM letters WHERE schedule_id IS NOT NULL;
CREATE TABLE schedules_new (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	cron TEXT NOT NULL,
	session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
	message TEXT NOT NULL,
	permission_mode TEXT CHECK (permission_mode IN ('default', 'review', 'skip')),
	catch_up INTEGER NOT NULL DEFAULT 1,
	enabled INTEGER NOT NULL DEFAULT 1,
	next_run_at INTEGER,
	last_run_at INTEGER,
	last_status TEXT CHECK (last_status IN ('running', 'done', 'error', 'stopped', 'skipped')),
	last_detail TEXT,
	last_letter_id TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
) STRICT;
INSERT INTO schedules_new (id, name, cron, session_id, message, permission_mode, catch_up, enabled,
	next_run_at, last_run_at, last_status, last_detail, last_letter_id, created_at, updated_at)
SELECT id, name, cron, session_id, message,
	CASE WHEN permission_mode IN ('auto', 'manual') THEN 'default' ELSE permission_mode END,
	catch_up, enabled, next_run_at, last_run_at, last_status, last_detail, last_letter_id, created_at,
	updated_at FROM schedules;
DROP TABLE schedules;
ALTER TABLE schedules_new RENAME TO schedules;
CREATE UNIQUE INDEX schedules_name ON schedules (name COLLATE NOCASE);
UPDATE letters SET schedule_id = (
	SELECT schedule_letters.schedule_id FROM schedule_letters WHERE schedule_letters.id = letters.id
) WHERE id IN (SELECT id FROM schedule_letters);
DROP TABLE schedule_letters;`,
	// Message attachments (blueprint 6.12, item 46): metadata here, files in ~/.yew/attachments/.
	`
CREATE TABLE attachments (
	id TEXT PRIMARY KEY,
	session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
	entry_id TEXT REFERENCES messages (id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	mime_type TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('image', 'pdf', 'text')),
	size INTEGER NOT NULL,
	sha256 TEXT NOT NULL,
	width INTEGER,
	height INTEGER,
	pages INTEGER,
	created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX attachments_session ON attachments (session_id, created_at);
CREATE INDEX attachments_entry ON attachments (entry_id) WHERE entry_id IS NOT NULL;`,
	// Dual-mode scheduled tasks (blueprint 6.5) and server-stamped origin tracing for review mode (6.1).
	`ALTER TABLE schedules ADD COLUMN mode TEXT NOT NULL DEFAULT 'letter' CHECK (mode IN ('letter', 'task_session'));
ALTER TABLE schedules ADD COLUMN auto_archive INTEGER NOT NULL DEFAULT 1;
ALTER TABLE schedules ADD COLUMN last_session_id TEXT REFERENCES sessions (id) ON DELETE SET NULL;
ALTER TABLE letters ADD COLUMN origin_entry_id TEXT;
CREATE INDEX letters_origin ON letters (to_session, origin_entry_id) WHERE origin_entry_id IS NOT NULL;`,
];
