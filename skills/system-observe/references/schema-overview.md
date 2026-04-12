# System Observe Schema Overview

These tables are the main structured evidence sources for pokoclaw runtime diagnosis.

This file is only a guide.
For exact column names and current truth, inspect the live schema with SQL.

If you need the authoritative code definition, inspect:

- `../../src/storage/schema/tables.ts`
- `../../src/storage/schema/types.ts`
- `../../src/storage/migrate/files/0001_init.sql`
- `../../src/storage/db/init.ts`
  This file only bootstraps `0001_init.sql`; it is no longer a schema-upgrade source.

Useful schema introspection queries:

```sql
SELECT name, sql
FROM sqlite_master
WHERE type = 'table'
ORDER BY name ASC;
```

```sql
PRAGMA table_info(messages);
```

```sql
PRAGMA table_info(task_runs);
```

## Core tables

- `agents`
  - Long-lived agents.
  - Important columns: `id`, `kind`, `conversation_id`, `main_agent_id`, `workdir`, `status`.

- `sessions`
  - Execution and chat sessions.
  - Important columns: `id`, `conversation_id`, `branch_id`, `owner_agent_id`, `purpose`, `approval_for_session_id`, `forked_from_session_id`, `status`, `context_mode`, `created_at`, `updated_at`, `ended_at`.
  - `context_mode` (e.g. `"isolated"`, `"branched"`) controls session isolation and is critical for delegated approval routing — check this first when diagnosing why a permission request went to the wrong target.
  - Compaction fields (`compact_cursor`, `compact_summary`, `compact_summary_token_total`, `compact_summary_usage_json`) track memory compaction state; relevant for long-session cost and context analysis.

- `messages`
  - Stored conversation messages and tool results.
  - Important columns: `session_id`, `seq`, `role`, `message_type`, `visibility`, `provider`, `model`, `model_api`, `stop_reason`, `error_message`, `payload_json`, `created_at`.
  - Token and cost fields: `token_input`, `token_output`, `token_cache_read`, `token_cache_write`, `token_total`, `usage_json`. Use these for cost analysis and token budget investigation.
  - Channel linkage: `channel_message_id`, `channel_parent_message_id`, `channel_thread_id` — useful for correlating DB records with Feishu message IDs.

- `task_runs`
  - Task and cron execution records.
  - Important columns:
    - `id`, `run_type`, `status`, `attempt`, `priority`
    - `owner_agent_id`, `conversation_id`, `branch_id`
    - `workstream_id`
    - `thread_root_run_id`
    - `initiator_session_id`, `initiator_thread_id`
    - `parent_run_id`, `cron_job_id`, `execution_session_id`
    - `description`, `input_json`, `result_summary`, `error_text`
    - `duration_ms`, `cancelled_by`
    - `started_at`, `finished_at`
  - `input_json` holds the task input payload — check this to understand what a run was asked to do.
  - `duration_ms` and `cancelled_by` are useful for diagnosing run longevity and stop intent.
  - `priority` controls scheduling order when multiple runs are queued.

- `cron_jobs`
  - Scheduled tasks.
  - Important columns:
    - `id`, `owner_agent_id`, `name`
    - `target_conversation_id`, `target_branch_id`
    - `workstream_id`
    - `schedule_kind`, `schedule_value`, `timezone`, `enabled`
    - `session_target`, `context_mode`
    - `payload_json`
    - `next_run_at`, `running_at`, `last_run_at`
    - `last_status`, `last_output`, `consecutive_failures`
    - `delete_after_run`, `deleted_at`
  - `timezone` is critical for diagnosing unexpected cron execution timing.
  - `context_mode` and `session_target` control how the cron task session is structured — check these when a cron run behaves unexpectedly regarding approvals or context isolation.

- `approval_ledger`
  - Approval requests and outcomes.
  - Important columns: `id`, `owner_agent_id`, `requested_by_session_id`, `requested_scope_json`, `approval_target`, `status`, `reason_text`, `expires_at`, `resume_payload_json`, `created_at`, `decided_at`.
  - `resume_payload_json` holds the state needed to resume the task after approval — inspect it when investigating why a resumed task got stuck or produced unexpected output.

- `agent_permission_grants`
  - Active and historical granted scopes.
  - Important columns: `owner_agent_id`, `scope_json`, `granted_by`, `created_at`, `expires_at`.

## Helpful supporting tables

- `conversations`
- `conversation_branches`
- `task_workstreams`
  - Long-lived task source identity. Useful for grouping runs from the same cron job or task source.
- `channel_threads`
  - Durable mapping from external thread identity to either a chat branch or a task run lineage.
  - Important columns: `id`, `channel_type`, `channel_installation_id`, `home_conversation_id`, `external_chat_id`, `external_thread_id`, `subject_kind`, `branch_id`, `root_task_run_id`, `opened_from_message_id`, `status`, `updated_at`.
- `channel_surfaces`
- `lark_object_bindings`
- `auth_events`

## Notes

- For task-thread questions, do not treat `workstream_id` and `thread_root_run_id` as the same thing.
  - `workstream_id` groups long-lived task source history.
  - `thread_root_run_id` identifies one concrete run thread and its follow-up chain.
- `channel_threads.root_task_run_id` is the durable thread-routing key for task threads.
- There is no durable `runtime_status_snapshots` table yet.
- For "currently running right now" questions, the DB gives durable facts and recent history, but not the full live in-memory state.
- `messages.payload_json` and `messages.usage_json` often contain the details you need, but can be large. Narrow queries before selecting many rows.
