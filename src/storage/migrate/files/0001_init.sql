CREATE TABLE IF NOT EXISTS channel_instances (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  account_key TEXT NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  config_ref TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z' AND datetime(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z' AND datetime(updated_at) IS NOT NULL),
  UNIQUE(provider, account_key)
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  channel_instance_id TEXT NOT NULL REFERENCES channel_instances(id) ON DELETE RESTRICT,
  external_chat_id TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('dm', 'group')),
  title TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z' AND datetime(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z' AND datetime(updated_at) IS NOT NULL),
  UNIQUE(channel_instance_id, external_chat_id)
);

CREATE TABLE IF NOT EXISTS conversation_branches (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  branch_key TEXT NOT NULL,
  external_branch_id TEXT,
  parent_branch_id TEXT REFERENCES conversation_branches(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z' AND datetime(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z' AND datetime(updated_at) IS NOT NULL),
  UNIQUE(conversation_id, branch_key)
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL
    CHECK (kind IN ('main', 'sub')),
  display_name TEXT,
  policy_profile TEXT,
  default_model TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z' AND datetime(created_at) IS NOT NULL),
  archived_at TEXT CHECK (archived_at IS NULL OR (archived_at GLOB '????-??-??T??:??:??*Z' AND datetime(archived_at) IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL REFERENCES conversation_branches(id) ON DELETE CASCADE,
  owner_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  purpose TEXT NOT NULL,
  context_mode TEXT NOT NULL DEFAULT 'isolated',
  forked_from_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  fork_source_seq INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  compact_cursor INTEGER NOT NULL DEFAULT 0,
  compact_summary TEXT,
  compact_summary_token_total INTEGER,
  compact_summary_usage_json TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z' AND datetime(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z' AND datetime(updated_at) IS NOT NULL),
  ended_at TEXT CHECK (ended_at IS NULL OR (ended_at GLOB '????-??-??T??:??:??*Z' AND datetime(ended_at) IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'text',
  visibility TEXT NOT NULL DEFAULT 'user_visible',
  channel_message_id TEXT,
  provider TEXT,
  model TEXT,
  model_api TEXT,
  stop_reason TEXT,
  error_message TEXT,
  payload_json TEXT NOT NULL,
  token_input INTEGER,
  token_output INTEGER,
  token_cache_read INTEGER,
  token_cache_write INTEGER,
  token_total INTEGER,
  usage_json TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z' AND datetime(created_at) IS NOT NULL),
  UNIQUE(session_id, seq)
);

CREATE TABLE IF NOT EXISTS cron_jobs (
  id TEXT PRIMARY KEY,
  owner_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  target_conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  target_branch_id TEXT NOT NULL REFERENCES conversation_branches(id) ON DELETE CASCADE,
  name TEXT,
  schedule_kind TEXT NOT NULL
    CHECK (schedule_kind IN ('at', 'every', 'cron')),
  schedule_value TEXT NOT NULL,
  timezone TEXT,
  enabled INTEGER NOT NULL DEFAULT 1
    CHECK (enabled IN (0, 1)),
  session_target TEXT NOT NULL DEFAULT 'isolated'
    CHECK (session_target IN ('main', 'isolated')),
  context_mode TEXT NOT NULL DEFAULT 'isolated'
    CHECK (context_mode IN ('group', 'isolated')),
  payload_json TEXT NOT NULL,
  next_run_at TEXT CHECK (next_run_at IS NULL OR (next_run_at GLOB '????-??-??T??:??:??*Z' AND datetime(next_run_at) IS NOT NULL)),
  last_run_at TEXT CHECK (last_run_at IS NULL OR (last_run_at GLOB '????-??-??T??:??:??*Z' AND datetime(last_run_at) IS NOT NULL)),
  last_status TEXT,
  last_output TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  delete_after_run INTEGER NOT NULL DEFAULT 0
    CHECK (delete_after_run IN (0, 1)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z' AND datetime(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z' AND datetime(updated_at) IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  run_type TEXT NOT NULL
    CHECK (run_type IN ('delegate', 'cron', 'system')),
  owner_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL REFERENCES conversation_branches(id) ON DELETE CASCADE,
  initiator_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  parent_run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  cron_job_id TEXT REFERENCES cron_jobs(id) ON DELETE SET NULL,
  execution_session_id TEXT UNIQUE REFERENCES sessions(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 1,
  input_json TEXT,
  result_summary TEXT,
  error_text TEXT,
  started_at TEXT NOT NULL CHECK (started_at GLOB '????-??-??T??:??:??*Z' AND datetime(started_at) IS NOT NULL),
  finished_at TEXT CHECK (finished_at IS NULL OR (finished_at GLOB '????-??-??T??:??:??*Z' AND datetime(finished_at) IS NOT NULL)),
  duration_ms INTEGER,
  cancelled_by TEXT,
  CHECK (
    (run_type = 'cron' AND cron_job_id IS NOT NULL)
    OR (run_type <> 'cron')
  )
);

CREATE TABLE IF NOT EXISTS approval_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  task_run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  requested_by_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  request_source TEXT NOT NULL,
  requested_scope_json TEXT NOT NULL,
  decision TEXT NOT NULL
    CHECK (decision IN ('approve', 'deny')),
  reason_text TEXT,
  used_history_lookup INTEGER NOT NULL DEFAULT 0
    CHECK (used_history_lookup IN (0, 1)),
  model_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  decided_at TEXT NOT NULL CHECK (decided_at GLOB '????-??-??T??:??:??*Z' AND datetime(decided_at) IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS agent_permission_grants (
  id TEXT PRIMARY KEY,
  owner_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  source_approval_id INTEGER REFERENCES approval_ledger(id) ON DELETE SET NULL,
  scope_json TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  ttl_seconds INTEGER,
  granted_at TEXT NOT NULL CHECK (granted_at GLOB '????-??-??T??:??:??*Z' AND datetime(granted_at) IS NOT NULL),
  expires_at TEXT CHECK (expires_at IS NULL OR (expires_at GLOB '????-??-??T??:??:??*Z' AND datetime(expires_at) IS NOT NULL)),
  revoked_at TEXT CHECK (revoked_at IS NULL OR (revoked_at GLOB '????-??-??T??:??:??*Z' AND datetime(revoked_at) IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS auth_events (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  provider TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('ok', 'error')),
  details_json TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z' AND datetime(created_at) IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_conversations_channel_chat
  ON conversations(channel_instance_id, external_chat_id);
CREATE INDEX IF NOT EXISTS idx_branches_root_key
  ON conversation_branches(conversation_id, branch_key);
CREATE INDEX IF NOT EXISTS idx_sessions_branch_status_updated
  ON sessions(branch_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_sessions_conversation_status_updated
  ON sessions(conversation_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_messages_session_seq
  ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_channel_msg
  ON messages(channel_message_id);
CREATE INDEX IF NOT EXISTS idx_cron_due
  ON cron_jobs(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_runs_conversation_status_started
  ON task_runs(conversation_id, status, started_at);
CREATE INDEX IF NOT EXISTS idx_runs_owner_status_started
  ON task_runs(owner_agent_id, status, started_at);
CREATE INDEX IF NOT EXISTS idx_runs_cron_started
  ON task_runs(cron_job_id, started_at);
CREATE INDEX IF NOT EXISTS idx_approval_owner_time
  ON approval_ledger(owner_agent_id, decided_at);
CREATE INDEX IF NOT EXISTS idx_approval_task_run
  ON approval_ledger(task_run_id);
CREATE INDEX IF NOT EXISTS idx_grants_owner_status_exp
  ON agent_permission_grants(owner_agent_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_events_time
  ON auth_events(created_at);
