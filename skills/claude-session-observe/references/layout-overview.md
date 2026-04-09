# Claude Code local storage layout

Use this file when the task is about where Claude Code stores local state under `~/.claude` and which directories matter for session inspection.

## Top-level locations to know

Important paths under `~/.claude`:

- `history.jsonl` - global cross-project input/history hints
- `projects/` - per-project session transcripts and sidecar artifacts
- `sessions/` - active-session PID map files
- `session-env/` - per-session environment snapshots
- `file-history/` - per-session file history snapshots
- `plans/` - plan-mode files
- `tasks/` - task list storage
- `teams/` - team inboxes and shared coordination files
- `skills/` - installed user/global skills
- `settings.json` - Claude Code settings

For "continue recent work on project X", start with `projects/` and `sessions/`, not `history.jsonl`.

## Project path encoding

Project session data is keyed by an encoded absolute path under `~/.claude/projects/`.

Observed pattern:

- start from the absolute project path
- replace `/` with `-`
- keep the leading slash as a leading `-`

Example:

- project path: `/absolute/path/to/project`
- project dir: `~/.claude/projects/-absolute-path-to-project/`

Treat this as the practical lookup rule, but still verify the resulting directory exists.

## Project directory layout

Inside one encoded project directory you may see:

- `<session-id>.jsonl` - main transcript for one Claude Code session
- `<session-id>/` - sidecar directory for that session

Inside the sidecar directory you may see:

- `subagents/*.jsonl` - subagent transcripts
- `subagents/*.meta.json` - subagent labels/types/descriptions
- `tool-results/*.txt` - captured tool outputs or spill files

This means a full reconstruction may need both:

- the main transcript file
- the sidecar session directory

## Active session map

`~/.claude/sessions/*.json` is the best place to detect a likely live session.

Observed fields include:

- `pid`
- `sessionId`
- `cwd`
- `startedAt`

For a project-specific question, match `cwd` to the real project path.

If there is a match, inspect that `sessionId` first.

Important: this is strong evidence of a currently open session, but not proof that the work is healthy, complete, or still making progress.

## What `history.jsonl` is for

`~/.claude/history.jsonl` is useful for broad cross-project recall and prompt history.

It is **not** the primary source for:

- latest session for one project
- latest progress for one project
- continuation state for one project

For those tasks, use the project transcript directory first.

## Other useful but secondary directories

- `session-env/` - useful when environment context matters
- `file-history/` - useful when you need file-tracking snapshots
- `plans/`, `tasks/`, `teams/` - useful when recent work involved plan mode, task lists, or teammate coordination

These are secondary to the main project transcript for most continuation tasks.
