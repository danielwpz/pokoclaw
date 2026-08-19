ALTER TABLE sessions ADD COLUMN context_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN compactions_since_clear INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN last_clear_reminder_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE context_clear_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  request_key TEXT,
  handoff_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  source_seq INTEGER NOT NULL CHECK (source_seq >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  kickoff_message TEXT,
  error_text TEXT,
  requested_at TEXT NOT NULL CHECK (requested_at GLOB '????-??-??T??:??:??*Z' AND datetime(requested_at) IS NOT NULL),
  started_at TEXT CHECK (started_at IS NULL OR (started_at GLOB '????-??-??T??:??:??*Z' AND datetime(started_at) IS NOT NULL)),
  completed_at TEXT CHECK (completed_at IS NULL OR (completed_at GLOB '????-??-??T??:??:??*Z' AND datetime(completed_at) IS NOT NULL)),
  failed_at TEXT CHECK (failed_at IS NULL OR (failed_at GLOB '????-??-??T??:??:??*Z' AND datetime(failed_at) IS NOT NULL)),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z' AND datetime(updated_at) IS NOT NULL)
);

CREATE UNIQUE INDEX uidx_context_clear_runs_active_session
  ON context_clear_runs(session_id)
  WHERE status IN ('pending', 'running');

CREATE UNIQUE INDEX uidx_context_clear_runs_session_request_key
  ON context_clear_runs(session_id, request_key)
  WHERE request_key IS NOT NULL;

CREATE INDEX idx_context_clear_runs_status_updated
  ON context_clear_runs(status, updated_at);

CREATE TABLE context_clear_pending_inputs (
  id TEXT PRIMARY KEY,
  clear_run_id TEXT NOT NULL REFERENCES context_clear_runs(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position > 0),
  scenario TEXT NOT NULL,
  content TEXT NOT NULL,
  user_payload_json TEXT,
  runtime_images_json TEXT,
  message_type TEXT,
  visibility TEXT,
  channel_message_id TEXT,
  channel_parent_message_id TEXT,
  channel_thread_id TEXT,
  max_turns INTEGER,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z' AND datetime(created_at) IS NOT NULL),
  UNIQUE(clear_run_id, position)
);

CREATE INDEX idx_context_clear_pending_inputs_run_position
  ON context_clear_pending_inputs(clear_run_id, position);
