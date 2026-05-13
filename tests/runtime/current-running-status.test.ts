import { afterEach, describe, expect, test } from "vitest";

import { buildCurrentRunningRuntimeStatus } from "@/src/runtime/current-running-status.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

describe("current running runtime status", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("does not cap durable running consistency checks at 100 rows", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedRuntimeSurface(handle);
    seedManyRunningTaskRunsAndCronJobs(handle, 101);

    const status = buildCurrentRunningRuntimeStatus({
      storage: handle.storage.db,
      now: "2026-04-04T00:00:05.000Z",
      liveRuns: [],
    });

    expect(status.suspectRunningTaskRuns).toHaveLength(101);
    expect(status.suspectRunningCronJobs).toHaveLength(101);
    expect(status.suspectRunningTaskRuns.map((item) => item.taskRun.id)).toContain("task_101");
    expect(status.suspectRunningCronJobs.map((item) => item.cronJob.id)).toContain(
      "orphan_cron_101",
    );
    expect(status.suspectRunningCronJobs.map((item) => item.cronJob.id)).not.toContain(
      "linked_cron_101",
    );
  });
});

function seedRuntimeSurface(handle: TestDatabaseHandle): void {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_1', 'lark', 'acct_runtime', '2026-04-04T00:00:00.000Z', '2026-04-04T00:00:00.000Z');

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES ('conv_1', 'ci_1', 'chat_1', 'dm', '2026-04-04T00:00:00.000Z', '2026-04-04T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-04-04T00:00:00.000Z', '2026-04-04T00:00:00.000Z');

    INSERT INTO agents (id, conversation_id, main_agent_id, kind, display_name, created_at)
    VALUES ('agent_main', 'conv_1', NULL, 'main', 'Main Agent', '2026-04-04T00:00:00.000Z');
  `);
}

function seedManyRunningTaskRunsAndCronJobs(handle: TestDatabaseHandle, count: number): void {
  const linkedCronRows = Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    return `(
      'linked_cron_${n}', 'agent_main', 'conv_1', 'branch_1',
      'Linked cron ${n}', 'every', '60000', 'Linked cron payload ${n}',
      '2026-04-04T00:00:00.000Z', '2026-04-04T00:01:00.000Z',
      '2026-04-04T00:00:00.000Z', '2026-04-04T00:00:00.000Z'
    )`;
  }).join(",\n");

  const orphanCronRows = Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    return `(
      'orphan_cron_${n}', 'agent_main', 'conv_1', 'branch_1',
      'Orphan cron ${n}', 'every', '60000', 'Orphan cron payload ${n}',
      '2026-04-04T00:00:00.000Z', '2026-04-04T00:01:00.000Z',
      '2026-04-04T00:00:00.000Z', '2026-04-04T00:00:00.000Z'
    )`;
  }).join(",\n");

  const taskRunRows = Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    return `(
      'task_${n}', 'delegate', 'agent_main', 'conv_1', 'branch_1',
      NULL, 'linked_cron_${n}', NULL, 'running',
      'Task ${n}', '{"kind":"background_task","version":1,"taskDefinition":"Task ${n}"}',
      '2026-04-04T00:00:00.000Z'
    )`;
  }).join(",\n");

  handle.storage.sqlite.exec(`
    INSERT INTO cron_jobs (
      id, owner_agent_id, target_conversation_id, target_branch_id,
      name, schedule_kind, schedule_value, payload_json, running_at, next_run_at, created_at, updated_at
    ) VALUES
      ${linkedCronRows},
      ${orphanCronRows};

    INSERT INTO task_runs (
      id, run_type, owner_agent_id, conversation_id, branch_id,
      initiator_session_id, cron_job_id, execution_session_id, status,
      description, input_json, started_at
    ) VALUES
      ${taskRunRows};
  `);
}
