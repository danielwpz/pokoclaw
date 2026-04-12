# System Observe Query Recipes

Use these as starting points and adapt them to the concrete IDs or time window you need.

If the task is about approvals or delegated approval, start from this file before writing custom SQL.

## Recent task runs

```sql
SELECT
  id,
  run_type,
  owner_agent_id,
  workstream_id,
  thread_root_run_id,
  cron_job_id,
  execution_session_id,
  status,
  attempt,
  started_at,
  finished_at,
  error_text
FROM task_runs
ORDER BY started_at DESC
LIMIT 20;
```

## Follow one task thread lineage

Use this when the question is really about "this run thread and its follow-ups", not the entire cron job history.

```sql
SELECT
  id,
  run_type,
  workstream_id,
  thread_root_run_id,
  parent_run_id,
  initiator_thread_id,
  execution_session_id,
  status,
  started_at,
  finished_at,
  error_text
FROM task_runs
WHERE thread_root_run_id = 'REPLACE_ROOT_TASK_RUN_ID'
ORDER BY started_at ASC, id ASC;
```

## Resolve a task thread to its root run

```sql
SELECT
  id,
  channel_installation_id,
  external_chat_id,
  external_thread_id,
  subject_kind,
  root_task_run_id,
  opened_from_message_id,
  updated_at
FROM channel_threads
WHERE channel_type = 'lark'
  AND subject_kind = 'task'
  AND external_thread_id = 'REPLACE_EXTERNAL_THREAD_ID';
```

## Compare one workstream versus multiple run threads

Use this when the user is asking whether multiple runs from the same cron job were kept separate.

```sql
SELECT
  id,
  run_type,
  workstream_id,
  thread_root_run_id,
  status,
  started_at,
  finished_at
FROM task_runs
WHERE workstream_id = 'REPLACE_WORKSTREAM_ID'
ORDER BY started_at DESC, id DESC
LIMIT 20;
```

## Recent pending approvals

```sql
SELECT
  id,
  owner_agent_id,
  requested_by_session_id,
  approval_target,
  status,
  reason_text,
  created_at,
  expires_at
FROM approval_ledger
WHERE status = 'pending'
ORDER BY created_at DESC
LIMIT 20;
```

## Recent delegated approvals

```sql
SELECT
  id,
  owner_agent_id,
  requested_by_session_id,
  approval_target,
  status,
  reason_text,
  created_at,
  decided_at
FROM approval_ledger
WHERE approval_target = 'main_agent'
ORDER BY created_at DESC
LIMIT 20;
```

## Approval sessions for delegated approval review

```sql
SELECT
  id,
  owner_agent_id,
  purpose,
  approval_for_session_id,
  status,
  created_at,
  updated_at
FROM sessions
WHERE purpose = 'approval'
ORDER BY created_at DESC
LIMIT 20;
```

## Follow one delegated approval from request to session

Start from the approval row:

```sql
SELECT
  id,
  owner_agent_id,
  requested_by_session_id,
  approval_target,
  status,
  reason_text,
  created_at,
  decided_at
FROM approval_ledger
WHERE id = 123;
```

Then inspect the approval session created for that source session:

```sql
SELECT
  id,
  owner_agent_id,
  purpose,
  approval_for_session_id,
  status,
  created_at,
  updated_at
FROM sessions
WHERE purpose = 'approval'
  AND approval_for_session_id = 'REPLACE_SOURCE_SESSION_ID'
ORDER BY created_at DESC
LIMIT 10;
```

## Recent session activity

```sql
SELECT
  id,
  owner_agent_id,
  purpose,
  status,
  approval_for_session_id,
  created_at,
  updated_at,
  ended_at
FROM sessions
ORDER BY updated_at DESC
LIMIT 20;
```

## Latest assistant outputs for one session

```sql
SELECT
  seq,
  role,
  stop_reason,
  error_message,
  usage_json,
  created_at
FROM messages
WHERE session_id = 'REPLACE_SESSION_ID'
ORDER BY seq DESC
LIMIT 20;
```

## Latest task run for one cron job

```sql
SELECT
  id,
  workstream_id,
  thread_root_run_id,
  status,
  attempt,
  started_at,
  finished_at,
  result_summary,
  error_text
FROM task_runs
WHERE cron_job_id = 'REPLACE_CRON_JOB_ID'
ORDER BY started_at DESC
LIMIT 10;
```

## Cron job status

```sql
SELECT
  id,
  owner_agent_id,
  workstream_id,
  enabled,
  next_run_at,
  running_at,
  last_run_at,
  last_status,
  consecutive_failures,
  last_output
FROM cron_jobs
ORDER BY updated_at DESC
LIMIT 20;
```

## Recent permission grants

```sql
SELECT
  owner_agent_id,
  scope_json,
  granted_by,
  created_at,
  expires_at
FROM agent_permission_grants
ORDER BY created_at DESC
LIMIT 20;
```

## Tips

- Select only the columns you need.
- Filter by `session_id`, `owner_agent_id`, `cron_job_id`, `workstream_id`, `thread_root_run_id`, or time window before reading large tables.
- For task-thread incidents, prefer `thread_root_run_id` over `workstream_id`.
- For "same cron job, different runs" questions, inspect both `workstream_id` and `thread_root_run_id` so you do not accidentally merge distinct run threads.
- If a message payload is the only likely source of detail, first identify the relevant rows, then do a second narrower query for `payload_json`.
