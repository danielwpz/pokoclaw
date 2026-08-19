---
name: system-observe
description: Use this skill before calling query_system_db or when diagnosing pokoclaw. It teaches how to query the read-only system database, including conversation history before compaction or context clear, and how to combine database facts with runtime logs and authoritative source definitions.
skillKey: pokoclaw/system-observe
---

# System Observe

Use this skill to inspect pokoclaw itself.

## Channels

- Live runtime status: Main Agent only, global current-running state across active runs, background tasks, cron task runs, and suspect durable rows that still claim to be running without a matching live run. Use `get_runtime_status` first when you need to know what is actively running right now. Use its `runId` form to inspect one low-level run, including a retained just-finished snapshot when still available in process memory.
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
    - `../../src/storage/migrate/files/0002_agent_runtime_modes.sql`
    - `../../src/storage/migrate/files/0003_a2ui_surface_publications.sql`
    - `../../src/storage/migrate/files/0004_shell_process_runs.sql`
    - `../../src/storage/migrate/files/0005_shell_process_output_chunks.sql`
    - `../../src/storage/migrate/files/0006_context_clear.sql`
    - `../../src/storage/migrate/files/0007_context_clear_recovery.sql`
      The schema truth lives in `tables.ts` plus the migration SQL files.
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

- For a question about what is running now, start with `get_runtime_status` before querying the DB.
- In the default `get_runtime_status` result, `runningWork` is the current-running main view. Do not treat completed, failed, cancelled, or not-yet-scheduled work as missing evidence; query the DB/logs only when the user asks for history or cause.
- If `get_runtime_status` returns `suspectRunningTaskRuns` or `suspectRunningCronJobs`, treat those as explicit inconsistency signals: durable state still says running, but the matching live run/current task linkage is absent.
- If the `runId` form says a run is not present in live memory, treat that as "not currently active here and no retained in-memory snapshot was found" rather than proof of success; then use the DB to determine whether it completed, failed, or was cancelled.
- If the answer depends on live in-memory state that `get_runtime_status` does not expose, say that clearly and do not guess.
- Adapt an existing query recipe before inventing a new exploratory query.
- When recovering conversation history before compaction or context clear, start with the dedicated recipe in `references/query-recipes.md`. Do not begin by listing tables or running `PRAGMA table_info(...)` unless that recipe fails because the schema has actually changed.
- For conversation history, extract user-visible text and page by `seq`. Do not bulk-select raw `payload_json`, which may contain large reasoning signatures and tool payloads that pollute the current context.
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
- Do not bulk-load raw message payloads when a text-only, bounded history query can answer the question.
- Do not rely on logs alone when the database already contains the durable fact you need.
- Do not present inference as fact.
