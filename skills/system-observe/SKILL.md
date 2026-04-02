---
name: system-observe
description: Use this skill for pokeclaw observability and self-diagnosis, including delegated approval review. It shows how to inspect pokeclaw through the system database, runtime logs, and authoritative source definitions.
skillKey: pokeclaw/system-observe
---

# System Observe

Use this skill to inspect pokeclaw itself.

## Channels

- System database: durable facts such as sessions, messages, task runs, cron jobs, approvals, permission grants, and delegated approval history.
- Runtime log: host-side operational evidence such as failures, routing decisions, retries, crashes, and subsystem errors.
- Source code and references: authoritative schema definitions and implementation behavior.
- Live in-memory state: only partially exposed right now. If the answer depends on live state that is not available, say so clearly instead of guessing.

Choose one or more channels based on the question. Do not force a fixed order for every task.

## Required first reads

- If the task involves database facts, approval history, delegated approval, or SQL:
  - Read `references/query-recipes.md` first.
  - If exact table or column names matter, read `references/schema-overview.md`.
  - If that is still insufficient, inspect:
    - `../../src/storage/schema/tables.ts`
    - `../../src/storage/schema/types.ts`
    - `../../src/storage/db/init.ts`
    - `../../src/storage/migrate/files/0001_init.sql`
  - Only then use `query_system_db` for live schema discovery.
- If the task involves runtime logs:
  - Read `references/log-recipes.md` first.
- If the task is really about implementation behavior:
  - Read the relevant source files first, then use DB facts or logs as supporting evidence.

## Working rules

- Adapt an existing query recipe before inventing a new exploratory query.
- Delegated approval investigation uses the same DB and log channels; start from the approval recipes and approval log hints in the references.
- Separate facts from inference.
- Include exact IDs, statuses, timestamps, and error text when available.
- If one source is insufficient, combine multiple sources and say how they relate.

## Available references

- `references/schema-overview.md`
- `references/query-recipes.md`
- `references/log-recipes.md`

Do not skip the required first reads above when they directly apply.

## Anti-patterns

- Do not guess table names or column names.
- Do not skip required reference files when they directly cover the task.
- Do not start with exploratory schema probing when the references or source files already tell you what to query.
- Do not spam repeated `sqlite_master` or `PRAGMA table_info(...)` queries unless you genuinely need schema discovery.
- Do not use `query_system_db` as your first move for schema exploration when a recipe or source definition is already available.
- Do not rely on logs alone when the database already contains the durable fact you need.
- Do not present inference as fact.
