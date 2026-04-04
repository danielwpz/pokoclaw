---
name: system-observe
description: Use this skill for pokeclaw observability and self-diagnosis, including delegated approval review. It shows how to inspect pokeclaw through the system database, runtime logs, and authoritative source definitions.
skillKey: pokeclaw/system-observe
---

# System Observe

Use this skill to inspect pokeclaw itself.

## Channels

- Live runtime status: in-memory state for active runs plus retained snapshots for specific finished runs that still remain in process memory. Use `get_runtime_status` first when you need to know whether something is actively running right now, whether a just-finished run is still inspectable in memory, or whether the latest LLM request is waiting for first token vs already streaming vs already finished.
- System database: durable facts such as sessions, messages, task runs, cron jobs, approvals, permission grants, and delegated approval history.
- Runtime log: host-side operational evidence such as failures, routing decisions, retries, crashes, and subsystem errors.
- Source code and references: authoritative schema definitions and implementation behavior.
- Live in-memory state beyond the exposed tool may still be unavailable. If the answer depends on unavailable live state, say so clearly instead of guessing.

Choose one or more channels based on the question. Do not force a fixed order for every task.

## Required first reads

- If the task involves database facts, approval history, delegated approval, or SQL:
  - Read `references/query-recipes.md` first.
  - If exact table or column names matter, read `references/schema-overview.md`.
  - If that is still insufficient, inspect:
    - `../../src/storage/schema/tables.ts`
    - `../../src/storage/schema/types.ts`
    - `../../src/storage/db/init.ts`
    - `../../src/storage/migrate/files/0001_init.sql`
  - Only then use `query_system_db` for live schema discovery.
- If the task involves runtime logs:
  - Read `references/log-recipes.md` first.
- If the task is really about implementation behavior:
  - Read the relevant source files first, then use DB facts or logs as supporting evidence.

## Working rules

- For a question about a run that may still be active now, start with `get_runtime_status` before querying the DB.
- Read the live payload in two layers:
  - `phase` is run-level orchestration state: for example `running`, `tool_running`, `waiting_approval`, `completed`, `failed`, or `cancelled`.
  - `latestRequest.status` is request-level LLM state: for example `waiting_first_token`, `streaming`, `finished`, `failed`, or `cancelled`.
- Do not interpret `latestRequest.ttftMs = null` as "this run never responded". It only means the latest request has not emitted a first token yet. Use `responseSummary.hasAnyResponse`, `responseSummary.respondedRequestCount`, and `responseSummary.lastRespondedRequestTtftMs` to tell whether earlier requests in the same run already responded.
- If `get_runtime_status` says a run is not present in live memory, treat that as "not currently active here and no retained in-memory snapshot was found" rather than proof of success; then use the DB to determine whether it completed, failed, or was cancelled.
- Adapt an existing query recipe before inventing a new exploratory query.
- Delegated approval investigation uses the same DB and log channels; start from the approval recipes and approval log hints in the references.
- Separate facts from inference.
- Include exact IDs, statuses, timestamps, and error text when available.
- If one source is insufficient, combine multiple sources and say how they relate.

## Interpreting `get_runtime_status`

### Return shape overview

When you inspect one run, read the payload as three layers:

- Top-level run identity and lifecycle
  - `runId`, `sessionId`, `conversationId`, `branchId`, `scenario`
  - `phase`: run-level orchestration state
  - `runStartedAt`, `timeSinceStartMs`
- `latestRequest`: the newest LLM request known for this run
  - `sequence`
  - `status`: request-level lifecycle state
  - `startedAt`, `finishedAt`
  - `firstTokenAt`, `lastTokenAt`
  - `ttftMs`, `timeSinceLastTokenMs`
  - `outputChars`, `estimatedOutputTokens`, `finalOutputTokens`, `avgTokensPerSecond`
  - `activeAssistantMessageId`
- `responseSummary`: historical response summary across the run so far
  - `requestCount`
  - `respondedRequestCount`
  - `hasAnyResponse`
  - `firstResponseAt`, `lastResponseAt`
  - `lastRespondedRequestSequence`
  - `lastRespondedRequestTtftMs`

### State semantics

- `phase` answers: what is the overall run doing now?
  - `running`: no tool or approval wait is currently active
  - `tool_running`: a tool call is currently executing
  - `waiting_approval`: the run is blocked on an approval decision
  - `completed` / `failed` / `cancelled`: terminal run states
- `latestRequest.status` answers: what happened to the newest LLM request?
  - `waiting_first_token`: request started but no first token yet
  - `streaming`: at least one token arrived and the request is still the active streamed request
  - `finished`: that request completed normally from the runtime point of view
  - `failed` / `cancelled`: that request itself was interrupted before normal completion

Important: `phase` and `latestRequest.status` are allowed to differ.
For example, a run can be `tool_running` while `latestRequest.status = "finished"`.
That means the model request already ended and the run has moved on to tool work.

Example 1: the run has responded before, but the newest request has not produced a first token yet.

```json
{
  "phase": "running",
  "latestRequest": {
    "sequence": 4,
    "status": "waiting_first_token",
    "startedAt": "2026-04-04T00:00:10.000Z",
    "ttftMs": null
  },
  "responseSummary": {
    "requestCount": 4,
    "respondedRequestCount": 3,
    "hasAnyResponse": true,
    "lastRespondedRequestSequence": 3,
    "lastRespondedRequestTtftMs": 1200
  }
}
```

Correct reading: the current request is still waiting for first token, but the run already responded in earlier requests. This is not evidence that the whole run is dead or that TTFT has never happened.

Example 2: the latest request has finished and the run is currently executing a tool.

```json
{
  "phase": "tool_running",
  "latestRequest": {
    "sequence": 2,
    "status": "finished",
    "ttftMs": 800
  },
  "activeToolName": "grep"
}
```

Correct reading: the model finished that request and produced tool work; the run is now spending time in tool execution rather than waiting on model tokens.

Example 3: a finished run can still be fetched directly by `runId` while it remains in process memory.

```json
{
  "found": true,
  "run": {
    "phase": "completed",
    "latestRequest": {
      "status": "finished",
      "ttftMs": 950
    }
  }
}
```

Correct reading: the run is no longer active, but its retained in-memory snapshot is still available for immediate diagnosis without DB lookup.

Example 4: the run failed after the latest request already finished.

```json
{
  "phase": "failed",
  "latestRequest": {
    "sequence": 2,
    "status": "finished",
    "ttftMs": 700
  },
  "activeToolName": null,
  "waitingApprovalId": null
}
```

Correct reading: the run failed later in orchestration, tool execution, or another non-request step. Do not rewrite this as "the latest request failed" unless `latestRequest.status` itself says `failed`.

## Available references

- `references/schema-overview.md`
- `references/query-recipes.md`
- `references/log-recipes.md`

Do not skip the required first reads above when they directly apply.

## Anti-patterns

- Do not guess table names or column names.
- Do not skip required reference files when they directly cover the task.
- Do not start with exploratory schema probing when the references or source files already tell you what to query.
- Do not spam repeated `sqlite_master` or `PRAGMA table_info(...)` queries unless you genuinely need schema discovery.
- Do not use `query_system_db` as your first move for schema exploration when a recipe or source definition is already available.
- Do not rely on logs alone when the database already contains the durable fact you need.
- Do not present inference as fact.
