# System Observe Meditation Reference

Use this reference when the question is specifically about Pokoclaw's `Meditation` self-harness flow:

- did Meditation run
- is it currently marked running
- did it skip, fail, or finish
- where are its artifacts and daily outputs
- how to inspect its pipeline inputs and outputs for debugging

## What Meditation is

- `Meditation` is a background self-optimization flow inside self-harness.
- It is not part of the core user-facing live run-status surface.
- It does not use `cron_jobs` as its product-level job store.
- It does not use ordinary user `task_runs` as its durable history source.
- The main durable state is `meditation_state`, plus runtime logs and filesystem artifacts.

Because of that, do not start by querying `task_runs` or `cron_jobs` when the question is really about Meditation itself.

## Fast diagnosis path

When the user asks what happened with Meditation, prefer this order:

1. Check `meditation_state` for the latest durable state.
2. Check runtime logs for scheduler and runner behavior.
3. Check Meditation artifacts on disk for pipeline details.
4. Read source only if the first three still do not explain the behavior.

`get_runtime_status` is usually not the first tool here because Meditation is not currently exposed as a first-class live run payload in that surface.

## 1. Durable state: `meditation_state`

Start here when you need the simplest durable answer.

```sql
SELECT
  id,
  running,
  last_started_at,
  last_finished_at,
  last_success_at,
  last_status,
  updated_at
FROM meditation_state;
```

How to read it:

- `running = 1`
  - Meditation is currently marked as active in durable state.
  - If it has stayed true for too long, investigate stale-running recovery in logs.
- `last_started_at`
  - when the latest run attempt began
- `last_finished_at`
  - when the latest attempt finished, whether success or failure
- `last_success_at`
  - when the latest successful run finished
- `last_status`
  - latest terminal status recorded by the scheduler, for example `completed` or `failed`

If the row is missing entirely, inspect source and initialization behavior before guessing.

## 2. Runtime logs

Meditation runtime behavior is mainly explained through these subsystems:

- `meditation/scheduler`
- `meditation/runner`

Useful search targets include:

- `meditation scheduler started`
- `meditation heartbeat skipped`
- `cleared stale meditation running state`
- `meditation run skipped`
- `meditation run completed`
- `meditation run failed`
- `meditation consolidation`

Typical interpretations:

- `meditation run skipped` with `reason='no_models'`
  - the Meditation models were not configured
- `meditation run skipped` with `reason='no_buckets'`
  - the pipeline found no active bucket worth processing in this window
- `cleared stale meditation running state`
  - stale-running recovery fired before the next attempt
- `meditation consolidation dropped ineligible ... rewrite`
  - host-side safety checks rejected an out-of-scope rewrite from the rewrite phase

Use `references/log-recipes.md` for the runtime log path and general grep workflow.

## 3. Filesystem artifacts and outputs

### Per-run debug artifacts

Meditation writes one artifact directory per run under:

- `~/.pokoclaw/logs/meditation/<YYYY-MM-DD>--<runId>/`

Common files:

- `meta.json`
  - run id, date, timezone, lookback window, chosen models, counts
- `harvest.json`
  - raw harvested fact sets used for clustering
- `clusters.json`
  - clustered signals before per-bucket synthesis
- `buckets.json`
  - bucket summaries and resolved profiles
- `bucket-inputs.json`
  - host-prepared bucket inputs
- `bucket-*.prompt.md`
  - prompt artifacts for bucket synthesis
- `bucket-*.submit.json`
  - bucket factual findings output
- `consolidation-eval.prompt.md`
- `consolidation-eval.submit.json`
- `consolidation-rewrite.prompt.md`
- `consolidation-rewrite.submit.json`
- `daily-note.md`
  - the run-local rendered daily block

Use these when the question is not just "did it run" but "what exactly did the pipeline see and decide".

### Daily human-readable output

Meditation appends the durable daily note under:

- `~/.pokoclaw/workspace/meditation/<YYYY-MM-DD>.md`

Use this when the user wants the final daily note or wants to confirm whether a run produced a visible daily artifact.

## 4. Config questions

When the question is really "why was Meditation disabled or skipped by configuration", inspect the active config and the authoritative config definitions.

Useful keys:

- `self-harness.meditation.enabled`
- `self-harness.meditation.cron`
- `models.scenarios.meditationBucket`
- `models.scenarios.meditationConsolidation`

If exact defaults or validation rules matter, inspect source definitions rather than guessing.

## 5. Source files to read when needed

Read source only after state, logs, and artifacts if you still need implementation truth.

Start with:

- `src/meditation/scheduler.ts`
- `src/meditation/runner.ts`
- `src/meditation/files.ts`
- `src/storage/repos/meditation-state.repo.ts`

Then go deeper only if the question specifically concerns prompt input construction or consolidation routing:

- `src/meditation/consolidation-context.ts`
- `src/meditation/prompts.ts`
- `src/meditation/submit-tools.ts`

## Common mistakes to avoid

- Do not start with `task_runs` or `cron_jobs` for Meditation diagnosis.
- Do not assume `running = 1` means the process is healthy; cross-check logs for stale recovery.
- Do not assume a missing daily note means the scheduler never fired; it may have skipped earlier.
- Do not jump straight into prompt artifacts when a quick `meditation_state` or log check already answers the question.
- Do not present inferred config as fact when you have not checked the actual config or source definitions.
