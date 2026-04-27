CREATE TABLE IF NOT EXISTS agent_runtime_modes (
  owner_agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  yolo_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (yolo_enabled IN (0, 1)),
  yolo_enabled_at TEXT
    CHECK (yolo_enabled_at IS NULL OR (yolo_enabled_at GLOB '????-??-??T??:??:??*Z' AND datetime(yolo_enabled_at) IS NOT NULL)),
  yolo_updated_at TEXT NOT NULL
    CHECK (yolo_updated_at GLOB '????-??-??T??:??:??*Z' AND datetime(yolo_updated_at) IS NOT NULL),
  yolo_updated_by TEXT,
  approval_streak_count INTEGER NOT NULL DEFAULT 0,
  approval_streak_started_at TEXT
    CHECK (approval_streak_started_at IS NULL OR (approval_streak_started_at GLOB '????-??-??T??:??:??*Z' AND datetime(approval_streak_started_at) IS NOT NULL)),
  last_approval_requested_at TEXT
    CHECK (last_approval_requested_at IS NULL OR (last_approval_requested_at GLOB '????-??-??T??:??:??*Z' AND datetime(last_approval_requested_at) IS NOT NULL)),
  last_yolo_prompted_at TEXT
    CHECK (last_yolo_prompted_at IS NULL OR (last_yolo_prompted_at GLOB '????-??-??T??:??:??*Z' AND datetime(last_yolo_prompted_at) IS NOT NULL)),
  yolo_prompt_count_today INTEGER NOT NULL DEFAULT 0,
  yolo_prompt_count_day TEXT,
  yolo_snoozed_until TEXT
    CHECK (yolo_snoozed_until IS NULL OR (yolo_snoozed_until GLOB '????-??-??T??:??:??*Z' AND datetime(yolo_snoozed_until) IS NOT NULL))
);
