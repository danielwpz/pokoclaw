# Continuation and handoff workflow

Use this file when the task is not just to observe a session, but to **take it over, verify it, or finish the unfinished work**.

## Core idea

Continuation is not a script feature. Continuation is **your workflow**.

A good continuation answer needs at least two evidence planes:

1. **Session evidence** from `~/.claude`
2. **Current repo/worktree evidence** from the recovered `cwd`

If you only read the transcript, you often know the direction but not the current execution state.

## Phase 1: recover the session story

1. Choose the best candidate session.
2. Read the transcript tail.
3. Recover:
   - what the user wanted
   - what Claude already did
   - where the flow seems to have stopped
4. Inspect `subagents/` and `tool-results/` only when the transcript suggests they matter.

Useful evidence:

- `last-prompt`
- recent `user`
- recent `assistant`
- recent `progress`
- `subagents/*.jsonl`
- `subagents/*.meta.json`
- `tool-results/*.txt`

## Phase 2: inspect the current repo/worktree

Inspect the recovered `cwd` directly.

Typical read-only checks:

- `git status --short --branch`
- `git diff --stat`
- `git diff -- <relevant-file>`
- `git log --oneline --decorate -n 5`
- file reads for touched artifacts when needed

This phase answers questions the transcript cannot settle by itself.

## Phase 3: reconcile transcript with repo state

Ask these questions explicitly:

1. Does the work described in the transcript actually exist on disk?
2. Is it uncommitted, committed, or absent?
3. Does the repo state match Claude's claims?
4. Is the task actually finished, or only apparently finished inside the transcript?

## Common continuation states

### A. Implemented locally, not landed

Signals:

- transcript says work was done
- relevant files are modified or untracked

Likely next action:

- review files
- run the minimum validation needed
- commit / PR / report

### B. Partially implemented

Signals:

- transcript shows active coding or tool use
- repo has some relevant edits
- obvious work remains

Likely next action:

- continue implementation from the touched files

### C. Finished and landed

Signals:

- transcript says done
- repo state is clean or recent commits already contain the work

Likely next action:

- report completion or move to the next task

### D. Ambiguous or divergent

Signals:

- transcript and repo state do not line up
- multiple sessions are plausible
- workspace includes unrelated changes

Likely next action:

- report the ambiguity explicitly
- present ranked possibilities

## Continuation brief template

When you answer a continuation / takeover request, prefer this structure:

1. **Recovered objective**
2. **Artifacts touched**
3. **Completed so far**
4. **Current repo/worktree state**
5. **What remains**
6. **Immediate next action**

## Optional helper scripts

If they help with retrieval, you may use:

- `scripts/find_project_sessions.py`
- `scripts/read_session_records.py`

But continuation itself is not delegated to the scripts.
