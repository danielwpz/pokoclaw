# System Observe Log Recipes

Runtime logs live at:

- `~/.pokoclaw/logs/runtime.log`

Use logs as supporting evidence when the database does not fully explain what happened.

## Good targets to grep

- `agent-loop`
- `runtime-lane`
- `cron/service`
- `orchestration/agent-manager`
- `orchestration/delegated-approval`
- `orchestration/subagents`
- `runtime/approval-routing`
- `approval-waits`
- `security/sandbox`
- `llm-bridge`
- `tools`
- `channels/lark-inbound`
- `channels/lark-outbound`

## Common workflows

### Find recent errors

Search for:

- `ERROR`
- `failed`
- `terminated`
- `timeout`
- `approval`

### Investigate one run or task

Search for the exact:

- `runId`
- `taskRunId`
- `sessionId`
- `approvalId`
- `cronJobId`

### Investigate delegated approval

Search for:

- `delegated approval`
- `approval session`
- `approvalId`
- `requestedBySessionId`
- `review_permission_request`
- `auto-denied delegated approval`

### Explain behavior

When you cite logs:

- Quote the exact subsystem and timestamp.
- Prefer a short excerpt over a huge block.
- Cross-check the log claim against DB state before drawing conclusions.

## Caution

- Logs are not guaranteed to contain the full truth.
- If DB facts and logs disagree, say that clearly and prefer the structured DB record unless the DB is obviously stale or incomplete.
