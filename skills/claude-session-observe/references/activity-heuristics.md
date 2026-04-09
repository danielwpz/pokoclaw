# Activity and continuation heuristics

Use this file when the task is to answer questions like:

- what was Claude Code doing lately
- what was this session trying to do
- can I continue from the latest session
- is the work finished or still pending

## Core rule

The heuristics in this file are for the **agent**, not for the helper scripts.

Scripts may retrieve evidence slices. They should not be treated as the entity that understands the meaning of the session.

## What a good answer requires

A good answer usually combines two evidence planes:

1. **Session evidence** from `~/.claude`
2. **Current repo/worktree evidence** from the recovered `cwd`

For many continuation tasks, transcript evidence tells you the direction, but the repo state tells you whether the work actually landed.

## Recommended evidence order

### 1. Active-session map

Check `~/.claude/sessions/*.json` for a matching `cwd`.

If there is a match, that session is a strong candidate for "currently open".

This is only a liveness hint, not proof that the work is complete or healthy.

### 2. Main transcript tail

Read the latest valid records in `<session-id>.jsonl`.

Use timestamps to establish recency. If needed, `file-history-snapshot.snapshot.timestamp` can help when a nearby top-level timestamp is missing.

### 3. `progress`

Inspect recent `progress` records before trusting the latest assistant text alone.

`progress` often reveals:

- delegated work
- subagent activity
- in-flight actions
- more current operational state than a nearby assistant reply

### 4. `last-prompt`

Use `last-prompt` to quickly recover the latest direct user intent.

### 5. Recent `user` and `assistant`

Use nearby `user` and `assistant` turns to understand:

- what the user wanted
- what Claude said it did
- whether the flow stopped mid-tool-use
- whether the user interrupted it

### 6. Sidecar artifacts when relevant

If the parent transcript suggests delegated work or compressed tool output, inspect:

- `subagents/*.jsonl`
- `subagents/*.meta.json`
- `tool-results/*.txt`

Do this when needed, not by default for every session.

### 7. Current repo/worktree state

When the user wants continuation, verification, or completion:

- inspect the recovered `cwd`
- check `git status --short --branch`
- check `git diff --stat`
- inspect specific files or diffs that the transcript suggests matter
- inspect recent commits when commit state matters

This is often the difference between "Claude said it was done" and "the work is actually on disk and landed".

## Reasoning pattern

After collecting evidence, reason in this order:

1. Which session is the best candidate?
2. What was the user trying to get done?
3. What did Claude already do?
4. Did the flow stop cleanly, get interrupted, or stay in flight?
5. What does the current repo/worktree state confirm or contradict?
6. What should happen next?

That final reasoning step belongs to the agent.

## Suggested answer shape

When asked to explain or continue a session, answer in this order:

1. **Recovered objective**
2. **Completed so far**
3. **Current stopping point**
4. **Current repo/worktree state**
5. **What remains**
6. **Immediate next action**

If confidence is low, include ranked alternatives and explain the uncertainty.

## Important interpretation rules

- Prefer direct evidence over guesswork.
- Prefer project-local transcript evidence over global history.
- Prefer `progress` and sidecar evidence over assumptions from the last assistant text alone.
- If the last assistant action is a `tool_use` with no later resolution, consider unfinished work as a possibility.
- If multiple candidate sessions are plausible, show them instead of silently picking one.
- Do not stop at `~/.claude` if the user asked whether the work was finished.
- Do not ask the helper scripts to explain the semantics for you.

## Optional helper scripts

- `scripts/find_project_sessions.py --project /abs/path/to/project`
- `scripts/read_session_records.py --session-file /path/to/session.jsonl`

Use them to retrieve data more quickly. The judgment still belongs to the agent.
