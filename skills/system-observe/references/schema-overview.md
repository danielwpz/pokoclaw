# System Observe Schema Overview

These tables are the main structured evidence sources for pokoclaw runtime diagnosis.

This file is only a guide.
For exact column names and current truth, inspect the live schema with SQL.

If you need the authoritative code definition, inspect:

- `../../src/storage/schema/tables.ts`
- `../../src/storage/schema/types.ts`
- `../../src/storage/migrate/files/0001_init.sql`
- `../../src/storage/migrate/files/0002_agent_runtime_modes.sql`
- `../../src/storage/migrate/files/0003_a2ui_surface_publications.sql`

Important current-schema pitfalls:

- There is no `subagents` table. SubAgents are rows in `agents` with `kind = 'sub'`.
- `agents` has `display_name`; it does not have a `title` column.
- `task_runs` has `owner_agent_id`; it does not have an `agent_id` column.
- Scheduled tasks are stored in `cron_jobs`; each execution is stored in `task_runs` with `run_type = 'cron'` and `cron_job_id`.
- `cron_jobs.id` is the scheduled task id used by `schedule_task`.

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
PRAGMA table_info(agents);
```

```sql
PRAGMA table_info(task_runs);
```

```sql
PRAGMA table_info(cron_jobs);
```

## Core tables

- `channel_instances`
  - Channel installation/account instances.
  - Columns: `id`, `provider`, `account_key`, `display_name`, `status`, `config_ref`, `created_at`, `updated_at`.

- `conversations`
  - User-facing chat surfaces.
  - Columns: `id`, `channel_instance_id`, `external_chat_id`, `kind`, `title`, `status`, `created_at`, `updated_at`.

- `conversation_branches`
  - Main, thread, task, or control branches under a conversation.
  - Columns: `id`, `conversation_id`, `kind`, `branch_key`, `external_branch_id`, `parent_branch_id`, `status`, `created_at`, `updated_at`.

- `agents`
  - Long-lived agents.
  - Columns: `id`, `conversation_id`, `main_agent_id`, `kind`, `display_name`, `description`, `workdir`, `policy_profile`, `default_model`, `status`, `created_at`, `archived_at`.
  - Main Agent rows have `kind = 'main'`; SubAgent rows have `kind = 'sub'`.
  - Join `agents.conversation_id` to `conversations.id` when you need the chat title or channel surface.

- `agent_runtime_modes`
  - Per-agent YOLO/Autopilot runtime mode state.
  - Columns: `owner_agent_id`, `yolo_enabled`, `yolo_enabled_at`, `yolo_updated_at`, `yolo_updated_by`, `approval_streak_count`, `approval_streak_started_at`, `last_approval_requested_at`, `last_yolo_prompted_at`, `yolo_prompt_count_today`, `yolo_prompt_count_day`, `yolo_snoozed_until`.

- `task_workstreams`
  - Long-lived task source identity. Useful for grouping runs from the same cron job or task source.
  - Columns: `id`, `owner_agent_id`, `conversation_id`, `branch_id`, `status`, `created_at`, `updated_at`.

- `channel_threads`
  - Durable mapping from external thread identity to either a chat branch or a task run lineage.
  - Columns: `id`, `channel_type`, `channel_installation_id`, `home_conversation_id`, `external_chat_id`, `external_thread_id`, `subject_kind`, `branch_id`, `root_task_run_id`, `opened_from_message_id`, `status`, `created_at`, `updated_at`.

- `sessions`
  - Execution and chat sessions.
  - Columns: `id`, `conversation_id`, `branch_id`, `owner_agent_id`, `purpose`, `context_mode`, `approval_for_session_id`, `forked_from_session_id`, `fork_source_seq`, `status`, `compact_cursor`, `compact_summary`, `compact_summary_token_total`, `compact_summary_usage_json`, `created_at`, `updated_at`, `ended_at`.
  - `context_mode` currently uses values such as `"isolated"` and `"group"`; check this when diagnosing approval routing or context isolation.
  - Compaction fields (`compact_cursor`, `compact_summary`, `compact_summary_token_total`, `compact_summary_usage_json`) track memory compaction state; relevant for long-session cost and context analysis.

- `a2ui_surface_publications`
  - Published A2UI surface state and callback consumption records.
  - Columns: `id`, `surface_id`, `session_id`, `conversation_id`, `branch_id`, `channel_type`, `channel_installation_id`, `channel_artifact_id`, `channel_message_id`, `channel_sequence`, `surface_state_json`, `consumed_action_keys_json`, `status`, `created_at`, `updated_at`.

- `messages`
  - Stored conversation messages and tool results.
  - Columns: `id`, `session_id`, `seq`, `role`, `message_type`, `visibility`, `channel_message_id`, `channel_parent_message_id`, `channel_thread_id`, `provider`, `model`, `model_api`, `stop_reason`, `error_message`, `payload_json`, `token_input`, `token_output`, `token_cache_read`, `token_cache_write`, `token_total`, `usage_json`, `created_at`.
  - Token and cost fields: `token_input`, `token_output`, `token_cache_read`, `token_cache_write`, `token_total`, `usage_json`. Use these for cost analysis and token budget investigation.
  - Channel linkage: `channel_message_id`, `channel_parent_message_id`, `channel_thread_id` — useful for correlating DB records with Feishu message IDs.

- `task_runs`
  - Task and cron execution records.
  - Columns:
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
  - Columns:
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
  - Columns: `id`, `owner_agent_id`, `requested_by_session_id`, `requested_scope_json`, `approval_target`, `status`, `reason_text`, `expires_at`, `resume_payload_json`, `created_at`, `decided_at`.
  - `resume_payload_json` holds the state needed to resume the task after approval — inspect it when investigating why a resumed task got stuck or produced unexpected output.

- `agent_permission_grants`
  - Active and historical granted scopes.
  - Columns: `id`, `owner_agent_id`, `source_approval_id`, `scope_json`, `granted_by`, `created_at`, `expires_at`.

- `subagent_creation_requests`
  - Pending and resolved SubAgent creation confirmation requests.
  - Columns: `id`, `source_session_id`, `source_agent_id`, `source_conversation_id`, `channel_instance_id`, `title`, `description`, `initial_task`, `workdir`, `initial_extra_scopes_json`, `status`, `created_subagent_agent_id`, `failure_reason`, `created_at`, `updated_at`, `decided_at`, `expires_at`.

- `auth_events`
  - Authentication and provider status events.
  - Columns: `id`, `conversation_id`, `agent_id`, `event_type`, `provider`, `status`, `details_json`, `created_at`.

- `harness_events`
  - Durable self-harness facts, currently including user stop events.
  - Columns: `id`, `event_type`, `run_id`, `session_id`, `conversation_id`, `branch_id`, `agent_id`, `task_run_id`, `cron_job_id`, `actor`, `source_kind`, `request_scope`, `reason_text`, `details_json`, `created_at`.

- `lark_object_bindings`
  - Durable Feishu/Lark message, card, and thread anchors for internal objects.
  - Columns: `id`, `channel_installation_id`, `conversation_id`, `branch_id`, `internal_object_kind`, `internal_object_id`, `lark_message_uuid`, `lark_message_id`, `lark_open_message_id`, `lark_card_id`, `thread_root_message_id`, `card_element_id`, `last_sequence`, `status`, `metadata_json`, `created_at`, `updated_at`.

## Other supporting tables

- `channel_surfaces`
  - Columns: `id`, `channel_type`, `channel_installation_id`, `conversation_id`, `branch_id`, `surface_key`, `surface_object_json`, `created_at`, `updated_at`.
- `meditation_state`
  - Columns: `id`, `running`, `last_started_at`, `last_finished_at`, `last_success_at`, `last_status`, `updated_at`.
- `schema_migrations`
  - Columns: `version`, `name`, `checksum`, `applied_at`.

## Notes

- For task-thread questions, do not treat `workstream_id` and `thread_root_run_id` as the same thing.
  - `workstream_id` groups long-lived task source history.
  - `thread_root_run_id` identifies one concrete run thread and its follow-up chain.
- `channel_threads.root_task_run_id` is the durable thread-routing key for task threads.
- There is no durable `runtime_status_snapshots` table yet.
- For "currently running right now" questions, the DB gives durable facts and recent history, but not the full live in-memory state.
- `messages.payload_json` and `messages.usage_json` often contain the details you need, but can be large. Narrow queries before selecting many rows.
