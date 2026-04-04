# System Observe Runtime Status Reference

Use this reference when the question is specifically about the live in-memory `get_runtime_status` payload.

## What this tool is for

`get_runtime_status` is the live in-memory view for current runtime diagnosis.

Use it to answer questions like:

- Is a run still active right now?
- Is the run currently in model execution, tool execution, or approval wait?
- Has the run already produced any response in earlier requests?
- Is the latest request still waiting for first token, already streaming, or already finished?
- Is a just-finished run still retained in memory by `runId`?

This tool is not a durable history source.
If the run is absent from live memory, use the database and logs next.

## Return shape overview

When inspecting one run, read the payload in three layers.

### 1. Run-level state

Top-level fields describe the overall run:

- `runId`, `sessionId`, `conversationId`, `branchId`, `scenario`
- `phase`
- `runStartedAt`
- `timeSinceStartMs`
- `activeToolCallId`, `activeToolName`
- `waitingApprovalId`

### 2. `latestRequest`

`latestRequest` describes the newest LLM request known for this run:

- `sequence`
- `status`
- `startedAt`, `finishedAt`
- `firstTokenAt`, `lastTokenAt`
- `ttftMs`, `timeSinceLastTokenMs`
- `outputChars`, `estimatedOutputTokens`, `finalOutputTokens`, `avgCharsPerSecond`
- `activeAssistantMessageId`

### 3. `responseSummary`

`responseSummary` summarizes response history across the run so far:

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

Cross-check helper fields with `phase`:

- `phase = 'tool_running'` usually pairs with non-null `activeToolCallId` and `activeToolName`
- `phase = 'waiting_approval'` usually pairs with non-null `waitingApprovalId`
- `phase = 'running'` usually means both `activeToolCallId` and `waitingApprovalId` are null
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

### Example 1: earlier requests responded, latest request still waiting for first token

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

Correct reading: the newest request is still waiting for first token, but the run already produced responses in earlier requests.

### Example 2: latest request finished, run is currently executing a tool

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

Correct reading: the model request already ended and the run is now spending time in tool execution.

### Example 3: finished run still available by `runId`

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

Correct reading: the run is no longer active, but its retained in-memory snapshot is still available.

### Example 4: run failed after the latest request had already finished

```json
{
  "phase": "failed",
  "latestRequest": {
    "sequence": 2,
    "status": "finished",
    "ttftMs": 700
  }
}
```

Correct reading: the run failed later in orchestration or tool work. Do not restate this as “the latest request failed” unless `latestRequest.status` itself is `failed`.
