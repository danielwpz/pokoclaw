CREATE TABLE IF NOT EXISTS a2ui_surface_publications (
  id TEXT PRIMARY KEY,
  surface_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL REFERENCES conversation_branches(id) ON DELETE CASCADE,
  channel_type TEXT NOT NULL,
  channel_installation_id TEXT NOT NULL,
  channel_artifact_id TEXT NOT NULL,
  channel_message_id TEXT,
  channel_sequence INTEGER NOT NULL DEFAULT 1
    CHECK (channel_sequence >= 1),
  surface_state_json TEXT NOT NULL,
  consumed_action_keys_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'stale')),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z' AND datetime(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z' AND datetime(updated_at) IS NOT NULL),
  UNIQUE(channel_type, channel_installation_id, channel_artifact_id)
);

CREATE INDEX IF NOT EXISTS idx_a2ui_publications_channel_surface
  ON a2ui_surface_publications(channel_type, channel_installation_id, surface_id);

CREATE INDEX IF NOT EXISTS idx_a2ui_publications_conversation_branch
  ON a2ui_surface_publications(conversation_id, branch_id);

CREATE INDEX IF NOT EXISTS idx_a2ui_publications_session
  ON a2ui_surface_publications(session_id);
