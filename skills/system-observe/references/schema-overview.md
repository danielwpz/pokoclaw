# System Observe Schema Overview

These tables are the main structured evidence sources for pokeclaw runtime diagnosis.

This file is only a guide.
For exact column names and current truth, inspect the live schema with SQL.

If you need the authoritative code definition, inspect:

- `../../src/storage/schema/tables.ts`
- `../../src/storage/schema/types.ts`
- `../../src/storage/db/init.ts`
- `../../src/storage/migrate/files/0001_init.sql`

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
  - Important columns: `id`, `conversation_id`, `branch_id`, `owner_agent_id`, `purpose`, `approval_for_session_id`, `forked_from_session_id`, `status`, `created_at`, `updated_at`, `ended_at`.

- `messages`
  - Stored conversation messages and tool results.
  - Important columns: `session_id`, `seq`, `role`, `message_type`, `visibility`, `provider`, `model`, `model_api`, `stop_reason`, `error_message`, `payload_json`, `usage_json`, `created_at`.

- `task_runs`
  - Task and cron execution records.
  - Important columns: `id`, `run_type`, `owner_agent_id`, `conversation_id`, `branch_id`, `initiator_session_id`, `parent_run_id`, `cron_job_id`, `execution_session_id`, `status`, `attempt`, `description`, `result_summary`, `error_text`, `started_at`, `finished_at`.

- `cron_jobs`
  - Scheduled tasks.
  - Important columns: `id`, `owner_agent_id`, `target_conversation_id`, `target_branch_id`, `schedule_kind`, `schedule_value`, `enabled`, `payload_json`, `next_run_at`, `running_at`, `last_run_at`, `last_status`, `last_output`, `consecutive_failures`.

- `approval_ledger`
  - Approval requests and outcomes.
  - Important columns: `id`, `owner_agent_id`, `requested_by_session_id`, `requested_scope_json`, `approval_target`, `status`, `reason_text`, `expires_at`, `created_at`, `decided_at`.

- `agent_permission_grants`
  - Active and historical granted scopes.
  - Important columns: `owner_agent_id`, `scope_json`, `granted_by`, `created_at`, `expires_at`.

## Helpful supporting tables

- `conversations`
- `conversation_branches`
- `channel_surfaces`
- `lark_object_bindings`
- `auth_events`

## Notes

- There is no durable `runtime_status_snapshots` table yet.
- For "currently running right now" questions, the DB gives durable facts and recent history, but not the full live in-memory state.
- `messages.payload_json` and `messages.usage_json` often contain the details you need, but can be large. Narrow queries before selecting many rows.
