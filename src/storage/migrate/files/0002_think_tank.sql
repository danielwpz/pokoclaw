CREATE TABLE IF NOT EXISTS think_tank_consultations (
  id TEXT PRIMARY KEY,
  source_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source_conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source_branch_id TEXT NOT NULL REFERENCES conversation_branches(id) ON DELETE CASCADE,
  owner_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  moderator_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  moderator_model_id TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('running', 'idle')),
  topic TEXT NOT NULL,
  context_text TEXT NOT NULL,
  latest_summary_json TEXT,
  first_completed_at TEXT CHECK (
    first_completed_at IS NULL
    OR (first_completed_at GLOB '????-??-??T??:??:??*Z' AND datetime(first_completed_at) IS NOT NULL)
  ),
  first_completion_notice_at TEXT CHECK (
    first_completion_notice_at IS NULL
    OR (
      first_completion_notice_at GLOB '????-??-??T??:??:??*Z'
      AND datetime(first_completion_notice_at) IS NOT NULL
    )
  ),
  last_episode_started_at TEXT CHECK (
    last_episode_started_at IS NULL
    OR (
      last_episode_started_at GLOB '????-??-??T??:??:??*Z'
      AND datetime(last_episode_started_at) IS NOT NULL
    )
  ),
  last_episode_finished_at TEXT CHECK (
    last_episode_finished_at IS NULL
    OR (
      last_episode_finished_at GLOB '????-??-??T??:??:??*Z'
      AND datetime(last_episode_finished_at) IS NOT NULL
    )
  ),
  created_at TEXT NOT NULL CHECK (
    created_at GLOB '????-??-??T??:??:??*Z' AND datetime(created_at) IS NOT NULL
  ),
  updated_at TEXT NOT NULL CHECK (
    updated_at GLOB '????-??-??T??:??:??*Z' AND datetime(updated_at) IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_think_tank_consultations_source_session
  ON think_tank_consultations(source_session_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_think_tank_consultations_owner_status_updated
  ON think_tank_consultations(owner_agent_id, status, updated_at);

CREATE TABLE IF NOT EXISTS think_tank_participants (
  id TEXT PRIMARY KEY,
  consultation_id TEXT NOT NULL REFERENCES think_tank_consultations(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL,
  title TEXT,
  model_id TEXT NOT NULL,
  persona_text TEXT NOT NULL,
  continuation_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL CHECK (
    created_at GLOB '????-??-??T??:??:??*Z' AND datetime(created_at) IS NOT NULL
  ),
  updated_at TEXT NOT NULL CHECK (
    updated_at GLOB '????-??-??T??:??:??*Z' AND datetime(updated_at) IS NOT NULL
  ),
  UNIQUE(consultation_id, participant_id)
);

CREATE INDEX IF NOT EXISTS idx_think_tank_participants_consultation_sort
  ON think_tank_participants(consultation_id, sort_order);

CREATE TABLE IF NOT EXISTS think_tank_episodes (
  id TEXT PRIMARY KEY,
  consultation_id TEXT NOT NULL REFERENCES think_tank_consultations(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  prompt_text TEXT NOT NULL,
  result_json TEXT,
  error_text TEXT,
  started_at TEXT NOT NULL CHECK (
    started_at GLOB '????-??-??T??:??:??*Z' AND datetime(started_at) IS NOT NULL
  ),
  finished_at TEXT CHECK (
    finished_at IS NULL
    OR (finished_at GLOB '????-??-??T??:??:??*Z' AND datetime(finished_at) IS NOT NULL)
  ),
  UNIQUE(consultation_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_think_tank_episodes_consultation_status_started
  ON think_tank_episodes(consultation_id, status, started_at);

PRAGMA foreign_keys = OFF;

DROP INDEX IF EXISTS uidx_channel_threads_external;
DROP INDEX IF EXISTS uidx_channel_threads_branch;
DROP INDEX IF EXISTS uidx_channel_threads_root_run;
DROP INDEX IF EXISTS idx_channel_threads_home_conversation;
DROP INDEX IF EXISTS idx_runs_conversation_status_started;
DROP INDEX IF EXISTS idx_runs_owner_status_started;
DROP INDEX IF EXISTS idx_runs_cron_started;
DROP INDEX IF EXISTS idx_runs_workstream_started;
DROP INDEX IF EXISTS idx_runs_thread_root_started;

ALTER TABLE task_runs RENAME TO task_runs__pre_think_tank;
ALTER TABLE channel_threads RENAME TO channel_threads__pre_think_tank;
ALTER TABLE harness_events RENAME TO harness_events__pre_think_tank;

CREATE TABLE channel_threads (
  id TEXT PRIMARY KEY,
  channel_type TEXT NOT NULL,
  channel_installation_id TEXT NOT NULL,
  home_conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  external_chat_id TEXT NOT NULL,
  external_thread_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL
    CHECK (subject_kind IN ('chat', 'task', 'think_tank')),
  branch_id TEXT REFERENCES conversation_branches(id) ON DELETE CASCADE,
  root_task_run_id TEXT REFERENCES task_runs(id) ON DELETE CASCADE,
  root_think_tank_consultation_id TEXT REFERENCES think_tank_consultations(id) ON DELETE CASCADE,
  opened_from_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL CHECK (
    created_at GLOB '????-??-??T??:??:??*Z' AND datetime(created_at) IS NOT NULL
  ),
  updated_at TEXT NOT NULL CHECK (
    updated_at GLOB '????-??-??T??:??:??*Z' AND datetime(updated_at) IS NOT NULL
  ),
  CHECK (
    (subject_kind = 'chat' AND branch_id IS NOT NULL AND root_task_run_id IS NULL AND root_think_tank_consultation_id IS NULL)
    OR (subject_kind = 'task' AND root_task_run_id IS NOT NULL AND branch_id IS NULL AND root_think_tank_consultation_id IS NULL)
    OR (subject_kind = 'think_tank' AND root_think_tank_consultation_id IS NOT NULL AND branch_id IS NULL AND root_task_run_id IS NULL)
  ),
  UNIQUE(channel_type, channel_installation_id, external_chat_id, external_thread_id),
  UNIQUE(channel_type, branch_id),
  UNIQUE(channel_type, root_task_run_id),
  UNIQUE(channel_type, root_think_tank_consultation_id)
);

CREATE TABLE task_runs (
  id TEXT PRIMARY KEY,
  run_type TEXT NOT NULL
    CHECK (run_type IN ('delegate', 'cron', 'system', 'thread')),
  owner_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL REFERENCES conversation_branches(id) ON DELETE CASCADE,
  workstream_id TEXT REFERENCES task_workstreams(id) ON DELETE SET NULL,
  thread_root_run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  initiator_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  initiator_thread_id TEXT REFERENCES channel_threads(id) ON DELETE SET NULL,
  parent_run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  cron_job_id TEXT REFERENCES cron_jobs(id) ON DELETE SET NULL,
  execution_session_id TEXT UNIQUE REFERENCES sessions(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  input_json TEXT,
  result_summary TEXT,
  error_text TEXT,
  started_at TEXT NOT NULL CHECK (
    started_at GLOB '????-??-??T??:??:??*Z' AND datetime(started_at) IS NOT NULL
  ),
  finished_at TEXT CHECK (
    finished_at IS NULL
    OR (finished_at GLOB '????-??-??T??:??:??*Z' AND datetime(finished_at) IS NOT NULL)
  ),
  duration_ms INTEGER,
  cancelled_by TEXT,
  CHECK (
    (run_type = 'cron' AND cron_job_id IS NOT NULL)
    OR (run_type <> 'cron')
  )
);

CREATE TABLE harness_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  run_id TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  branch_id TEXT REFERENCES conversation_branches(id) ON DELETE SET NULL,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  task_run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  cron_job_id TEXT REFERENCES cron_jobs(id) ON DELETE SET NULL,
  actor TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  request_scope TEXT NOT NULL,
  reason_text TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL CHECK (
    created_at GLOB '????-??-??T??:??:??*Z' AND datetime(created_at) IS NOT NULL
  )
);

INSERT INTO channel_threads (
  id,
  channel_type,
  channel_installation_id,
  home_conversation_id,
  external_chat_id,
  external_thread_id,
  subject_kind,
  branch_id,
  root_task_run_id,
  root_think_tank_consultation_id,
  opened_from_message_id,
  status,
  created_at,
  updated_at
)
SELECT
  id,
  channel_type,
  channel_installation_id,
  home_conversation_id,
  external_chat_id,
  external_thread_id,
  subject_kind,
  branch_id,
  root_task_run_id,
  NULL,
  opened_from_message_id,
  status,
  created_at,
  updated_at
FROM channel_threads__pre_think_tank;

INSERT INTO task_runs (
  id,
  run_type,
  owner_agent_id,
  conversation_id,
  branch_id,
  workstream_id,
  thread_root_run_id,
  initiator_session_id,
  initiator_thread_id,
  parent_run_id,
  cron_job_id,
  execution_session_id,
  status,
  priority,
  attempt,
  description,
  input_json,
  result_summary,
  error_text,
  started_at,
  finished_at,
  duration_ms,
  cancelled_by
)
SELECT
  id,
  run_type,
  owner_agent_id,
  conversation_id,
  branch_id,
  workstream_id,
  thread_root_run_id,
  initiator_session_id,
  initiator_thread_id,
  parent_run_id,
  cron_job_id,
  execution_session_id,
  status,
  priority,
  attempt,
  description,
  input_json,
  result_summary,
  error_text,
  started_at,
  finished_at,
  duration_ms,
  cancelled_by
FROM task_runs__pre_think_tank;

INSERT INTO harness_events (
  id,
  event_type,
  run_id,
  session_id,
  conversation_id,
  branch_id,
  agent_id,
  task_run_id,
  cron_job_id,
  actor,
  source_kind,
  request_scope,
  reason_text,
  details_json,
  created_at
)
SELECT
  id,
  event_type,
  run_id,
  session_id,
  conversation_id,
  branch_id,
  agent_id,
  task_run_id,
  cron_job_id,
  actor,
  source_kind,
  request_scope,
  reason_text,
  details_json,
  created_at
FROM harness_events__pre_think_tank;

DROP TABLE task_runs__pre_think_tank;
DROP TABLE channel_threads__pre_think_tank;
DROP TABLE harness_events__pre_think_tank;

CREATE INDEX IF NOT EXISTS idx_channel_threads_home_conversation
  ON channel_threads(home_conversation_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_runs_conversation_status_started
  ON task_runs(conversation_id, status, started_at);

CREATE INDEX IF NOT EXISTS idx_runs_owner_status_started
  ON task_runs(owner_agent_id, status, started_at);

CREATE INDEX IF NOT EXISTS idx_runs_cron_started
  ON task_runs(cron_job_id, started_at);

CREATE INDEX IF NOT EXISTS idx_runs_workstream_started
  ON task_runs(workstream_id, started_at);

CREATE INDEX IF NOT EXISTS idx_runs_thread_root_started
  ON task_runs(thread_root_run_id, started_at);

CREATE INDEX IF NOT EXISTS idx_harness_events_run_time
  ON harness_events(run_id, created_at);

CREATE INDEX IF NOT EXISTS idx_harness_events_session_time
  ON harness_events(session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_harness_events_conversation_time
  ON harness_events(conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_harness_events_task_run_time
  ON harness_events(task_run_id, created_at);

CREATE INDEX IF NOT EXISTS idx_harness_events_type_time
  ON harness_events(event_type, created_at);

PRAGMA foreign_keys = ON;
