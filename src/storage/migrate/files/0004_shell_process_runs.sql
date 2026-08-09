CREATE TABLE shell_process_runs (
  id TEXT PRIMARY KEY,
  owner_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  source_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL REFERENCES conversation_branches(id) ON DELETE CASCADE,
  tool_call_id TEXT,
  source_run_id TEXT,
  command_preview TEXT NOT NULL,
  command_hash TEXT NOT NULL,
  cwd TEXT NOT NULL,
  sandbox_mode TEXT NOT NULL,
  status TEXT NOT NULL,
  pid INTEGER,
  timeout_ms INTEGER,
  notify_on_exit TEXT NOT NULL DEFAULT 'next_turn',
  started_at TEXT NOT NULL CHECK (started_at GLOB '????-??-??T??:??:??*Z' AND datetime(started_at) IS NOT NULL),
  handed_off_at TEXT CHECK (handed_off_at IS NULL OR (handed_off_at GLOB '????-??-??T??:??:??*Z' AND datetime(handed_off_at) IS NOT NULL)),
  finished_at TEXT CHECK (finished_at IS NULL OR (finished_at GLOB '????-??-??T??:??:??*Z' AND datetime(finished_at) IS NOT NULL)),
  duration_ms INTEGER,
  exit_code INTEGER,
  exit_signal TEXT,
  exit_reason TEXT,
  error_text TEXT,
  stdout_chars INTEGER NOT NULL DEFAULT 0,
  stderr_chars INTEGER NOT NULL DEFAULT 0,
  output_tail TEXT NOT NULL DEFAULT '',
  output_truncated INTEGER NOT NULL DEFAULT 0,
  notification_status TEXT NOT NULL DEFAULT 'none'
);

CREATE INDEX idx_shell_process_runs_owner_status_started
  ON shell_process_runs(owner_agent_id, status, started_at);
CREATE INDEX idx_shell_process_runs_session_started
  ON shell_process_runs(source_session_id, started_at);
CREATE INDEX idx_shell_process_runs_notification_status_finished
  ON shell_process_runs(notification_status, finished_at);
