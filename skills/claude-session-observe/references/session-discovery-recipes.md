# Session discovery recipes

Use this file when the task is to locate Claude Code sessions for a project, or to decide which recent session is the best candidate to inspect.

## Core idea

Finding the right session is mostly a file-discovery problem:

- resolve the project path
- map it to the encoded project directory
- inspect active-session PID files
- inspect project-local transcript files
- rank candidates using timestamps and nearby evidence

You do not need a magic script to do this. A script can help, but the workflow should still make sense manually.

## Manual recipe: find sessions for project X

### 1. Resolve the project path

Turn the user-facing project name into a concrete absolute path.

Do not skip this step. The encoded Claude directory depends on the exact path.

### 2. Map the path to the encoded project directory

Compute the expected directory under `~/.claude/projects/` using the path-encoding rule from `layout-overview.md`.

Then verify that directory exists.

### 3. Check active sessions first

Inspect `~/.claude/sessions/*.json` and match by `cwd`.

If one or more entries match the project path:

- treat them as strong candidates for the current active session
- inspect them first
- if multiple active entries match, rank them using transcript evidence instead of guessing

### 4. Enumerate transcript candidates

Within the project directory, inspect:

- `*.jsonl`

Each file is a candidate main session transcript.

Session IDs are not time-ordered. Do not rank by filename.

### 5. Rank candidates using evidence

Preferred ranking order:

1. active-session match
2. latest valid transcript timestamp
3. latest `file-history-snapshot.snapshot.timestamp` if needed
4. nearby `progress` / `last-prompt` evidence near the tail
5. file mtime only as fallback

### 6. Handle ambiguity explicitly

If two or more candidates are close:

- inspect the tail of each transcript
- compare evidence such as:
  - `last-prompt`
  - latest progress timestamp
  - latest assistant activity
  - interruption markers
- present the ranked candidates and your reasoning

## Manual recipe: continue the recent work

Once you choose the best candidate session:

1. read the transcript tail
2. inspect `last-prompt`
3. inspect recent `user`, `assistant`, and `progress` records
4. inspect sidecar artifacts if the transcript suggests they matter
5. inspect the current repo/worktree for that session's `cwd`
6. only then decide what the session was doing and what remains

This workflow is the real contract. Scripts only accelerate the retrieval parts.

## Optional helper script

If repetitive candidate listing is useful, you may use:

- `scripts/find_project_sessions.py --project /abs/path/to/project`

Treat it as a query helper, not as a final answer engine.
