---
name: system-observe
description: Use this skill for pokoclaw observability and self-diagnosis, including delegated approval review. It shows how to inspect pokoclaw through the system database, runtime logs, and authoritative source definitions.
skillKey: pokoclaw/system-observe
---

# System Observe

Use this skill to inspect pokoclaw itself.

## Channels

- Live runtime status: in-memory state for active runs plus retained snapshots for specific finished runs that still remain in process memory. Use `get_runtime_status` first when you need to know whether something is actively running right now, whether a just-finished run is still inspectable in memory, or whether the latest LLM request is waiting for first token vs already streaming vs already finished.
- System database: durable facts such as sessions, messages, task runs, cron jobs, approvals, permission grants, and delegated approval history.
- Runtime log: host-side operational evidence such as failures, routing decisions, retries, crashes, and subsystem errors.
- Source code and references: authoritative schema definitions and implementation behavior.
- Meditation self-harness: a background self-optimization flow. It is not part of the core live run-status surface, but when the question is specifically about whether Meditation ran, why it skipped or failed, or where its artifacts and outputs live, use `references/meditation.md`.

Choose one or more channels based on the question. Do not force a fixed order for every task.

## Required first reads

- If the task involves database facts, approval history, delegated approval, or SQL:
  - Read `references/query-recipes.md` first.
  - If exact table or column names matter, read `references/schema-overview.md`.
  - If that is still insufficient, inspect:
    - `../../src/storage/schema/tables.ts`
    - `../../src/storage/schema/types.ts`
    - `../../src/storage/migrate/files/0001_init.sql`
    - `../../src/storage/db/init.ts`
      This file is only the bootstrap entrypoint now. The schema truth lives in `tables.ts` and `0001_init.sql`.
  - Only then use `query_system_db` for live schema discovery.
- If the task involves live runtime status payload semantics for `get_runtime_status`:
  - Read `references/runtime-status.md` first.
- If the task involves runtime logs:
  - Read `references/log-recipes.md` first.
- If the task explicitly involves Meditation or self-harness background runs:
  - Read `references/meditation.md` first.
- If the task is really about implementation behavior:
  - Read the relevant source files first, then use DB facts or logs as supporting evidence.

## Working rules

- For a question about a run that may still be active now, start with `get_runtime_status` before querying the DB.
- If `get_runtime_status` says a run is not present in live memory, treat that as "not currently active here and no retained in-memory snapshot was found" rather than proof of success; then use the DB to determine whether it completed, failed, or was cancelled.
- If the answer depends on live in-memory state that `get_runtime_status` does not expose, say that clearly and do not guess.
- Adapt an existing query recipe before inventing a new exploratory query.
- Delegated approval investigation uses the same DB and log channels; start from the approval recipes and approval log hints in the references.
- Separate facts from inference.
- Include exact IDs, statuses, timestamps, and error text when available.
- If one source is insufficient, combine multiple sources and say how they relate.

## Available references

- `references/schema-overview.md`
- `references/query-recipes.md`
- `references/log-recipes.md`
- `references/runtime-status.md`
- `references/meditation.md`

Do not skip the required first reads above when they directly apply.

## Anti-patterns

- Do not guess table names or column names.
- Do not skip required reference files when they directly cover the task.
- Do not start with exploratory schema probing when the references or source files already tell you what to query.
- Do not spam repeated `sqlite_master` or `PRAGMA table_info(...)` queries unless you genuinely need schema discovery.
- Do not use `query_system_db` as your first move for schema exploration when a recipe or source definition is already available.
- Do not rely on logs alone when the database already contains the durable fact you need.
- Do not present inference as fact.
