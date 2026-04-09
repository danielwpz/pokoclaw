---
name: claude-session-observe
description: Use this skill to inspect Claude Code session history under ~/.claude, recover what sessions exist, and manually determine what a session was doing from transcript evidence.
skillKey: pokeclaw/claude-session-observe
---

# Claude Session Observe

Use this skill to inspect Claude Code's local session artifacts under `~/.claude`.

The goal of this skill is **not** to teach the agent to trust a magic script. The goal is to teach the agent how to:

- find which Claude Code sessions exist for a project
- inspect what happened in a session
- understand what a session was doing from transcript evidence
- check whether work was completed, interrupted, delegated, or still needs follow-up
- compare the session story with the **current repo state** when the user wants to continue or verify work

## Core principle

There are three layers here:

1. **Artifacts**
   - `~/.claude` transcript and sidecar files
   - current repo/worktree state for the recovered `cwd`
2. **Query helpers**
   - optional scripts under `scripts/`
   - ordinary file reads, `ls`, `grep`, `tail`-style inspection
3. **Agent judgment**
   - "what sessions exist"
   - "what this session was doing"
   - "what was completed"
   - "what should happen next"

The scripts are only layer 2. They are read-only retrieval helpers, similar to `ls`, `tail`, or `select ... from ... limit ...`. They do **not** decide the final answer.

If the scripts do not exist, the skill should still work. The real contract of this skill is the investigation workflow.

## Channels

- Active session map: `~/.claude/sessions/*.json`
- Project session transcripts: `~/.claude/projects/<encoded-project>/<session-id>.jsonl`
- Session sidecar directory: `~/.claude/projects/<encoded-project>/<session-id>/`
- Subagent transcripts: `subagents/*.jsonl`
- Subagent metadata: `subagents/*.meta.json`
- Tool output captures: `tool-results/*.txt`
- Global history: `~/.claude/history.jsonl`
- Current repo/worktree for the recovered `cwd`

Choose channels based on the question. Do not force every question through the same path.

## Required first reads

- If the task is about `~/.claude` layout, path encoding, or where files live:
  - read `references/layout-overview.md`
- If the task is about finding which session to inspect:
  - read `references/session-discovery-recipes.md`
- If the task is about how to read transcript JSONL records:
  - read `references/transcript-records.md`
- If the task is about interpreting recent work or takeover / continuation:
  - read `references/activity-heuristics.md`
  - then read `references/continuation-handoff.md`

## Default posture

Start **manually** unless a helper script will obviously save repetitive work.

In many cases you do not need Python at all. The job can often be done with:

- path resolution
- directory listing
- reading one or more transcript files
- checking the tail of the transcript
- checking the current repo state

Use scripts only when they make repetitive retrieval faster or safer.

## Core workflows

### 1. User asks: what Claude Code sessions exist for this project?

1. Resolve the project to an absolute path.
2. Map it to the encoded project directory under `~/.claude/projects/`.
3. Check `~/.claude/sessions/*.json` for active-session matches by `cwd`.
4. List the project's `*.jsonl` files.
5. Rank candidates by evidence:
   - active-session match
   - transcript timestamps
   - nearby `progress` / `last-prompt`
   - file mtime only as fallback
6. Present the candidate sessions and your ranking evidence.

### 2. User asks: what was this session doing?

1. Read the transcript tail.
2. Inspect the latest useful evidence:
   - `last-prompt`
   - recent `user` records
   - recent `assistant` records
   - recent `progress` records
3. If the parent transcript suggests delegated work, inspect `subagents/`.
4. If a tool result is needed, inspect `tool-results/`.
5. Then **you** explain:
   - what the user wanted
   - what Claude already did
   - whether the flow looks finished, interrupted, or still in flight

Do not ask the scripts to produce that explanation for you.

### 3. User asks: continue the latest Claude Code session / finish what it did not finish

1. Choose the best candidate session for the target project.
2. Recover the session story from transcript evidence.
3. Then inspect the **current repo/worktree** for that session's `cwd`.
4. Compare transcript evidence with disk state.
5. Answer with a continuation brief:
   - recovered objective
   - artifacts touched
   - completed so far
   - current repo/worktree state
   - what remains
   - immediate next action

Important: for continuation, transcript evidence alone is not enough.

### 4. User asks: check whether Claude's work actually landed

1. Recover the claimed work from the transcript.
2. Check the relevant repo directly:
   - `git status --short --branch`
   - `git diff --stat`
   - relevant file diffs or file reads
   - recent commits if needed
3. Compare the claim with the actual repo state.
4. Report agreement or mismatch explicitly.

## Working rules

- Prefer direct evidence over guesswork.
- Prefer project-local transcript evidence over global history for project continuation.
- Scripts are optional helpers, not answer generators.
- If you use a script, treat its output as evidence to inspect.
- Do not let a script decide the goal, stopping point, completion state, or next step.
- Inspect `progress` before assuming the latest assistant text tells the whole story.
- Inspect sidecar artifacts only when the transcript suggests they matter or when more detail is needed.
- If the user wants continuation or verification, compare the session story with the current repo/worktree state.
- If evidence is ambiguous, present ranked interpretations instead of pretending certainty.
- If the trailing transcript line is malformed, ignore that line and continue with earlier valid records.

## Optional helper scripts

These are convenience tools only.

- `scripts/find_project_sessions.py`
  - read-only helper to list project-local candidate sessions
- `scripts/read_session_records.py`
  - read-only helper to slice one session transcript and optionally list sidecar artifacts

Use them the same way you would use `ls`, `tail`, or a small `select ... from ... limit ...` query.

## Available references

- `references/layout-overview.md`
- `references/session-discovery-recipes.md`
- `references/transcript-records.md`
- `references/activity-heuristics.md`
- `references/continuation-handoff.md`

## Anti-patterns

- Do not treat helper scripts as semantic summarizers.
- Do not expect a Python script to tell you what a session "means".
- Do not stop at transcript reading when the user asked you to continue or verify work.
- Do not ignore the current repo state for the recovered `cwd`.
- Do not rely only on file mtime when transcript timestamps exist.
- Do not assume tool results are top-level transcript records.
- Do not assume interruptions have a dedicated top-level schema.
- Do not require the scripts when direct file inspection is enough.
