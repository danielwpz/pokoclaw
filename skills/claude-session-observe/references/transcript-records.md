# Transcript record guide

Use this file when the task is to interpret Claude Code session JSONL records.

## Core idea

Transcript reading is mostly a structured file-reading task.

You are looking at JSONL records and asking:

- which records matter for this question
- what order they happened in
- what fixed fields they expose
- what additional sidecar files might matter

The interpretation still belongs to you.

## Main record types observed in project transcripts

Observed top-level `type` values include:

- `file-history-snapshot`
- `user`
- `assistant`
- `progress`
- `system`
- `custom-title`
- `agent-name`
- `last-prompt`

Do not assume this list is exhaustive.

## What each record type is useful for

### `file-history-snapshot`

Useful for:

- snapshot timestamps
- file-history state changes

Important note:

- metadata, not a conversational turn
- `snapshot.timestamp` can help when a nearby top-level timestamp is missing

### `user`

Useful for:

- direct user intent
- interruption markers
- tool results nested back into the transcript

Important note:

- not every `user` record is direct human text
- some `user` records mainly carry tool result payloads

### `assistant`

Useful for:

- assistant text output
- assistant tool-use intent
- whether the assistant appears to have stopped mid-action

Important note:

- `tool_use` items often live inside `message.content[]`
- a trailing tool-use record with no later resolution may indicate unfinished work

### `progress`

Useful for:

- recent operational state
- delegated work
- subagent activity
- in-flight actions near the tail

Important note:

- `progress` can be more informative than nearby assistant text
- useful clues may be nested, not always exposed at the top level

### `system`

Useful for:

- metadata like turn timing

Observed subtype:

- `turn_duration`

### `custom-title`

Useful for:

- user/session title hints

### `agent-name`

Useful for:

- named agent labels

### `last-prompt`

Useful for:

- quick recovery of the latest direct user request

This is often one of the fastest ways to recover intent.

## Important parsing caveats

### Tool results are often nested

Do not expect a dedicated top-level `tool` record.

Tool results may appear:

- inside top-level `user.message.content[]`
- mirrored in helper fields like `toolUseResult`
- nested under `progress` payloads

### Interruptions may be plain text markers

Common examples:

- `[Request interrupted by user]`
- `[Request interrupted by user for tool use]`

Do not assume a special interruption schema exists.

### Unknown future record types should not break the analysis

If a new record type appears:

- keep it as unknown metadata
- do not crash
- rely on known record types first

### Large lines and partial writes are normal hazards

Practical handling:

- tolerate very large JSONL lines
- if the trailing line is malformed, ignore it and continue with earlier valid records

## Minimal fields worth extracting

For most session-reading tasks, these fields matter most:

- top-level `type`
- top-level `timestamp`
- `sessionId`
- `cwd`
- `gitBranch`
- `message.role`
- `message.content`
- `lastPrompt`
- `subtype` and `durationMs` on `system`

These are good fields for a query helper to expose.

## Optional helper script

For repeated transcript slicing you may use:

- `scripts/read_session_records.py`

Treat it as a transcript query helper, not as an interpretation engine.
