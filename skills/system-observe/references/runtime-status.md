# System Observe Runtime Status Reference

Use this reference when the question is specifically about the `get_runtime_status` payload.

## What this tool is for

`get_runtime_status` is the Main Agent's global current-running runtime view.
Its default result combines live in-memory run observability with durable task and cron ownership facts from storage.

Use it to answer questions like:

- What is actively running anywhere in the system right now?
- Which agent owns each active run, background task, or cron task run?
- Is a currently running item in model execution, tool execution, or approval wait?
- Is a durable task or cron row still marked running even though no matching live run is present?
- Has the run already produced any response in earlier requests?
- Is the latest request still waiting for first token, already streaming, or already finished?
- Is a just-finished run still retained in memory by `runId`?

This tool is not a durable history source.
The default result intentionally answers "what is running now"; it does not list completed, failed, cancelled, or not-yet-scheduled work.
If you need history, completion details, or failure causes, use the database and logs next.

This tool only exposes live run fields that runtime control currently publishes plus selected durable ownership metadata.
Other runtime state may still exist internally but remain unavailable through this tool.
If your conclusion depends on live state that is not exposed here, say that clearly and use the database, logs, or source inspection instead of guessing.

SubAgents should not receive this tool. Cross-agent and whole-system runtime diagnosis is a Main Agent responsibility.

## Return shape overview

### Default call

Calling `get_runtime_status` without arguments returns:

- `now`
- `scope = "global_current_running"`
- `runningWork`: active live runs enriched with ownership metadata
- `suspectRunningTaskRuns`: `task_runs.status = 'running'` rows whose execution session is absent from current live runs
- `suspectRunningCronJobs`: `cron_jobs.running_at IS NOT NULL` rows without a matching running task run/current representation

Each `runningWork` item contains:

- `kind`: one of `main_chat`, `subagent_chat`, `approval`, `background_task`, `cron_task`, `task_run`, `run`
- `runId`
- `liveRun`: the low-level live run observability snapshot
- `ownerAgent`: owner agent identity when known
- `session`: execution session identity when known
- `taskRun`: durable task run metadata when the run belongs to a task
- `cronJob`: durable cron job metadata when the run belongs to a cron job
- `backgroundTask`: background task preview when the task input has the background task payload

### `runId` call

Calling `get_runtime_status` with `runId` returns one enriched `run` item when that low-level run is present in live memory or retained memory:

- `now`
- `found = true`
- `run`: the same enriched work item shape used in `runningWork`

If not found, the tool returns the runtime-control not-found payload.
Use DB/log inspection to determine whether it completed, failed, cancelled, or disappeared after a process restart.

## Live run shape

When inspecting `runningWork[].liveRun` or `run.liveRun`, read the payload in three layers, from broadest to most specific.

### 1. Run-level state

`liveRun` fields describe the overall low-level run:

- `runId`, `sessionId`, `conversationId`, `branchId`, `scenario`
- `phase`
- `runStartedAt`
- `timeSinceStartMs`
- `activeToolCallId`, `activeToolName`
- `waitingApprovalId`

### 2. `latestRequest`

`liveRun.latestRequest` describes the newest LLM request known for this run:

- `sequence`
- `status`
- `startedAt`, `finishedAt`
- `firstTokenAt`, `lastTokenAt`
- `ttftMs`, `timeSinceLastTokenMs`
- `outputChars`, `estimatedOutputTokens`, `finalOutputTokens`, `avgCharsPerSecond`
- `activeAssistantMessageId`

### 3. `responseSummary`

`liveRun.responseSummary` summarizes response history across the run so far:

- `requestCount`
- `respondedRequestCount`
- `hasAnyResponse`
- `firstResponseAt`, `lastResponseAt`
- `lastRespondedRequestSequence`
- `lastRespondedRequestTtftMs`

## State semantics

### Run-level `phase`

`phase` answers: what is the whole run doing now?

- `null`: the run was registered in runtime control, but no observability transition has been recorded yet
- `running`
- `tool_running`
- `waiting_approval`
- `completed`
- `failed`
- `cancelled`

### Request-level `latestRequest.status`

`latestRequest.status` answers: what happened to the newest LLM request?

- `waiting_first_token`
- `streaming`
- `finished`
- `failed`
- `cancelled`

These two layers are intentionally separate.
A run may be `tool_running` while `latestRequest.status = 'finished'`.
That means the latest model request already ended and the run has moved on to tool work.

## Cross-check helper fields with `phase`

- `phase = 'tool_running'` pairs with non-null `activeToolCallId` and `activeToolName`
- `phase = 'waiting_approval'` pairs with non-null `waitingApprovalId`
- `phase = 'running'` means both `activeToolCallId` and `waitingApprovalId` are null
- terminal phases may keep the latest completed request snapshot even when tool and approval fields are null

## Important interpretation rules

- Do not read `latestRequest.ttftMs = null` as proof that the run never responded.
- `latestRequest.ttftMs = null` only means the newest request has not emitted a first token yet.
- To decide whether the run has responded before, inspect:
  - `responseSummary.hasAnyResponse`
  - `responseSummary.respondedRequestCount`
  - `responseSummary.lastRespondedRequestTtftMs`
- `latestRequest.avgCharsPerSecond` is a user-facing output-stability signal, not a model tokenizer metric.
  - It is computed only from visible output characters and the interval from `firstTokenAt` to `lastTokenAt`.
  - It intentionally does not switch to model-reported token counts after completion.
  - This keeps the metric stable during streaming and aligned with what users can actually perceive on screen.
- Only `phase = 'running'` accepts streaming updates. If the run is in `tool_running`, `waiting_approval`, or any terminal phase, incoming stream deltas are ignored.
- If `phase = failed` or `phase = cancelled`, do not automatically assume the latest request failed or was cancelled too. Check `latestRequest.status` directly.

## Examples

### Example 1: default global current-running result

```json
{
  "scope": "global_current_running",
  "runningWork": [
    {
      "kind": "background_task",
      "runId": "run_bg",
      "ownerAgent": { "id": "agent_sub", "kind": "sub" },
      "taskRun": { "id": "task_bg", "status": "running" },
      "backgroundTask": { "taskDefinitionPreview": "Scan the repository." },
      "liveRun": {
        "phase": "running",
        "latestRequest": { "status": "waiting_first_token", "ttftMs": null }
      }
    },
    {
      "kind": "cron_task",
      "runId": "run_cron",
      "taskRun": { "id": "task_cron", "status": "running", "cronJobId": "cron_daily" },
      "cronJob": { "id": "cron_daily", "runningAt": "2026-04-04T00:00:00.000Z" },
      "liveRun": { "phase": "tool_running", "activeToolName": "bash" }
    }
  ],
  "suspectRunningTaskRuns": [],
  "suspectRunningCronJobs": []
}
```

Correct reading: these are current-running items across the runtime, not just the current conversation.

### Example 2: durable row still says running, but no live run is present

```json
{
  "scope": "global_current_running",
  "runningWork": [],
  "suspectRunningTaskRuns": [
    {
      "reason": "running_task_run_without_live_run",
      "taskRun": { "id": "task_orphan", "status": "running" }
    }
  ],
  "suspectRunningCronJobs": [
    {
      "reason": "running_cron_job_without_running_task_run",
      "cronJob": { "id": "cron_orphan", "runningAt": "2026-04-04T00:01:00.000Z" }
    }
  ]
}
```

Correct reading: this is not ordinary active work. It is an observable inconsistency that should be investigated through DB/logs.

### Example 3: earlier requests responded, latest request still waiting for first token

```json
{
  "liveRun": {
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
}
```

Correct reading: the newest request is still waiting for first token, but the run already produced responses in earlier requests.

### Example 4: latest request finished, run is currently executing a tool

```json
{
  "liveRun": {
    "phase": "tool_running",
    "latestRequest": {
      "sequence": 2,
      "status": "finished",
      "ttftMs": 800
    },
    "activeToolName": "grep"
  },
}
```

Correct reading: the model request already ended and the run is now spending time in tool execution.

### Example 5: finished run still available by `runId`

```json
{
  "found": true,
  "run": {
    "kind": "main_chat",
    "runId": "run_done",
    "liveRun": {
      "phase": "completed",
      "latestRequest": {
        "status": "finished",
        "ttftMs": 950
      }
    }
  }
}
```

Correct reading: the run is no longer active, but its retained in-memory snapshot is still available.

### Example 6: run failed after the latest request had already finished

```json
{
  "liveRun": {
    "phase": "failed",
    "latestRequest": {
      "sequence": 2,
      "status": "finished",
      "ttftMs": 700
    }
  }
}
```

Correct reading: the run failed later in orchestration or tool work. Do not restate this as “the latest request failed” unless `latestRequest.status` itself is `failed`.

## Notes

- The default result is current-running only.
- Snapshots are retained in memory while they remain in runtime control after the run leaves the active list. A completed, failed, or cancelled run may still be accessible by `runId` for immediate diagnosis even though it is no longer active.
- This tool only exposes the live run fields that runtime control currently publishes plus selected durable owner/task/cron metadata. Other live state may exist internally but is not accessible here.
