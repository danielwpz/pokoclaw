# System Observe Query Recipes

Use these as starting points and adapt them to the concrete IDs or time window you need.

If the task is about approvals or delegated approval, start from this file before writing custom SQL.

## Recover conversation history before compaction or context clear

Use this when earlier messages are not loaded into the current LLM context. The current session ID and, after `/clear`, the previous-context boundary are provided by the host.

Start with the newest 100 user-visible messages at or before the boundary. This extracts only visible text and avoids loading reasoning signatures, tool payloads, and other large internal JSON.

```sql
WITH history_page AS (
  SELECT
    seq,
    role,
    message_type,
    payload_json,
    stop_reason,
    error_message,
    created_at
  FROM messages
  WHERE session_id = 'REPLACE_SESSION_ID'
    AND seq <= REPLACE_UPPER_SEQ
    AND visibility = 'user_visible'
  ORDER BY seq DESC
  LIMIT 100
)
SELECT
  p.seq,
  p.role,
  p.message_type,
  CASE json_type(p.payload_json, '$.content')
    WHEN 'text' THEN json_extract(p.payload_json, '$.content')
    WHEN 'array' THEN (
      SELECT group_concat(json_extract(block.value, '$.text'), char(10))
      FROM json_each(p.payload_json, '$.content') AS block
      WHERE json_extract(block.value, '$.type') = 'text'
    )
    ELSE NULL
  END AS text_content,
  p.stop_reason,
  p.error_message,
  p.created_at
FROM history_page AS p
ORDER BY p.seq ASC;
```

- Replace `REPLACE_UPPER_SEQ` with the clear boundary when recovering pre-clear history. Remove that predicate when no boundary is needed.
- To page farther back, replace it with `seq < REPLACE_OLDEST_RETURNED_SEQ` and repeat.
- Query a narrow `payload_json` range separately only when a non-text message or exact tool detail is genuinely required.

## Context clear status for one session

```sql
SELECT
  id,
  session_id,
  handoff_session_id,
  source_seq,
  status,
  error_text,
  requested_at,
  started_at,
  completed_at,
  failed_at,
  updated_at
FROM context_clear_runs
WHERE session_id = 'REPLACE_SESSION_ID'
ORDER BY requested_at DESC
LIMIT 10;
```

## Agent and SubAgent inventory

Use this instead of guessing a `subagents` table. SubAgents are stored in `agents`.

```sql
SELECT
  a.id,
  a.kind,
  a.display_name,
  a.status,
  a.main_agent_id,
  a.workdir,
  c.title AS conversation_title,
  c.external_chat_id,
  a.created_at
FROM agents a
LEFT JOIN conversations c ON c.id = a.conversation_id
ORDER BY a.created_at DESC
LIMIT 50;
```

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

## Running or problematic task runs with owner agent

Use `task_runs.owner_agent_id`; there is no `task_runs.agent_id`.

```sql
SELECT
  tr.id,
  tr.run_type,
  tr.owner_agent_id,
  a.kind AS owner_agent_kind,
  a.display_name AS owner_agent_name,
  tr.workstream_id,
  tr.thread_root_run_id,
  tr.cron_job_id,
  tr.execution_session_id,
  tr.status,
  tr.description,
  tr.started_at,
  tr.finished_at,
  tr.error_text
FROM task_runs tr
LEFT JOIN agents a ON a.id = tr.owner_agent_id
WHERE tr.status IN ('running', 'failed', 'cancelled', 'blocked')
ORDER BY tr.started_at DESC
LIMIT 50;
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

## Scheduled tasks with owner agent

`cron_jobs.id` is the scheduled task id used by `schedule_task`.

```sql
SELECT
  cj.id AS scheduled_task_id,
  cj.owner_agent_id,
  a.kind AS owner_agent_kind,
  a.display_name AS owner_agent_name,
  cj.name,
  cj.enabled,
  cj.schedule_kind,
  cj.schedule_value,
  cj.timezone,
  cj.context_mode,
  cj.workstream_id,
  cj.next_run_at,
  cj.running_at,
  cj.last_run_at,
  cj.last_status,
  cj.consecutive_failures,
  cj.last_output
FROM cron_jobs cj
LEFT JOIN agents a ON a.id = cj.owner_agent_id
WHERE cj.deleted_at IS NULL
ORDER BY COALESCE(cj.last_run_at, cj.next_run_at, cj.created_at) DESC
LIMIT 50;
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

`sessions.updated_at` is lifecycle state and is not updated for every appended message. Use the latest message timestamp when ordering by real conversation activity.

```sql
SELECT
  s.id,
  s.owner_agent_id,
  s.purpose,
  s.status,
  s.approval_for_session_id,
  s.created_at,
  s.updated_at AS session_updated_at,
  s.ended_at,
  (
    SELECT MAX(m.created_at)
    FROM messages AS m
    WHERE m.session_id = s.id
  ) AS last_message_at
FROM sessions AS s
ORDER BY COALESCE(last_message_at, s.updated_at) DESC
LIMIT 20;
```

## Latest assistant outputs for one session

```sql
WITH assistant_text AS (
  SELECT
    m.seq,
    (
      SELECT group_concat(json_extract(block.value, '$.text'), char(10))
      FROM json_each(m.payload_json, '$.content') AS block
      WHERE json_extract(block.value, '$.type') = 'text'
    ) AS text_content,
    m.stop_reason,
    m.error_message,
    m.usage_json,
    m.created_at
  FROM messages AS m
  WHERE m.session_id = 'REPLACE_SESSION_ID'
    AND m.role = 'assistant'
    AND m.visibility = 'user_visible'
),
recent_assistant AS (
  SELECT *
  FROM assistant_text
  WHERE text_content IS NOT NULL
    AND trim(text_content) <> ''
  ORDER BY seq DESC
  LIMIT 20
)
SELECT
  a.seq,
  a.text_content,
  a.stop_reason,
  a.error_message,
  a.usage_json,
  a.created_at
FROM recent_assistant AS a
ORDER BY a.seq DESC;
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

## Latest task runs for scheduled tasks

Use this to connect scheduled task definitions to their concrete executions.

```sql
SELECT
  cj.id AS scheduled_task_id,
  cj.name,
  tr.id AS task_run_id,
  tr.thread_root_run_id,
  tr.execution_session_id,
  tr.status,
  tr.attempt,
  tr.started_at,
  tr.finished_at,
  tr.result_summary,
  tr.error_text
FROM cron_jobs cj
LEFT JOIN task_runs tr ON tr.cron_job_id = cj.id
WHERE cj.deleted_at IS NULL
ORDER BY tr.started_at DESC
LIMIT 50;
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

## Lark run card and task card bindings

Task status cards use `internal_object_kind = 'run_card'` and `internal_object_id = 'task:' || task_run_id`.
Run transcript pages also use `run_card`, with page-specific internal ids.

```sql
SELECT
  internal_object_kind,
  internal_object_id,
  conversation_id,
  branch_id,
  lark_message_id,
  lark_open_message_id,
  lark_card_id,
  thread_root_message_id,
  card_element_id,
  last_sequence,
  status,
  updated_at
FROM lark_object_bindings
WHERE internal_object_kind = 'run_card'
ORDER BY updated_at DESC
LIMIT 50;
```

## Lark binding for one task run

```sql
SELECT
  internal_object_kind,
  internal_object_id,
  lark_message_id,
  lark_open_message_id,
  lark_card_id,
  thread_root_message_id,
  status,
  metadata_json,
  updated_at
FROM lark_object_bindings
WHERE internal_object_kind = 'run_card'
  AND internal_object_id = 'task:REPLACE_TASK_RUN_ID';
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
- Use `agents.display_name`, not `agents.title`.
- Use `task_runs.owner_agent_id`, not `task_runs.agent_id`.
- Use `SELECT ... FROM agents WHERE kind = 'sub'`, not a `subagents` table.
- For task-thread incidents, prefer `thread_root_run_id` over `workstream_id`.
- For "same cron job, different runs" questions, inspect both `workstream_id` and `thread_root_run_id` so you do not accidentally merge distinct run threads.
- If a message payload is the only likely source of detail, first identify the relevant rows, then do a second narrower query for `payload_json`.
