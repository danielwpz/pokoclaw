ALTER TABLE context_clear_runs ADD COLUMN queued_inputs_processed_at TEXT
  CHECK (
    queued_inputs_processed_at IS NULL OR (
      queued_inputs_processed_at GLOB '????-??-??T??:??:??*Z'
      AND datetime(queued_inputs_processed_at) IS NOT NULL
    )
  );

ALTER TABLE context_clear_pending_inputs ADD COLUMN appended_message_id TEXT
  REFERENCES messages(id) ON DELETE SET NULL;

CREATE INDEX idx_context_clear_runs_unprocessed_queue
  ON context_clear_runs(status, queued_inputs_processed_at, requested_at);

CREATE INDEX idx_context_clear_pending_inputs_appended_message
  ON context_clear_pending_inputs(appended_message_id);
