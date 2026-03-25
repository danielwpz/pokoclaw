import { afterEach, describe, expect, test } from "vitest";

import {
  cancelTaskExecution,
  completeTaskExecution,
  failTaskExecution,
} from "@/src/orchestration/task-run-lifecycle.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

function seedFixture(handle: TestDatabaseHandle): void {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_1', 'lark', 'acct_a', '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z');

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES ('conv_1', 'ci_1', 'chat_1', 'dm', '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z');

    INSERT INTO agents (id, conversation_id, main_agent_id, kind, created_at)
    VALUES ('agent_1', 'conv_1', NULL, 'main', '2026-03-26T00:00:00.000Z');

    INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, context_mode, status, compact_cursor, created_at, updated_at)
    VALUES ('sess_1', 'conv_1', 'branch_1', 'agent_1', 'task', 'isolated', 'active', 0, '2026-03-26T00:00:01.000Z', '2026-03-26T00:00:01.000Z');

    INSERT INTO task_runs (
      id, run_type, owner_agent_id, conversation_id, branch_id,
      execution_session_id, status, started_at
    ) VALUES (
      'run_1', 'system', 'agent_1', 'conv_1', 'branch_1',
      'sess_1', 'running', '2026-03-26T00:00:02.000Z'
    );
  `);
}

describe("task run lifecycle", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("completes task execution and ends its execution session", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);

    const settled = completeTaskExecution({
      db: handle.storage.db,
      taskRunId: "run_1",
      resultSummary: "done",
      finishedAt: new Date("2026-03-26T00:00:07.000Z"),
    });

    expect(settled.taskRun).toMatchObject({
      id: "run_1",
      status: "completed",
      resultSummary: "done",
      finishedAt: "2026-03-26T00:00:07.000Z",
      durationMs: 5000,
    });
    expect(settled.executionSession).toMatchObject({
      id: "sess_1",
      status: "completed",
      endedAt: "2026-03-26T00:00:07.000Z",
    });
  });

  test("fails task execution and preserves error text", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);

    const settled = failTaskExecution({
      db: handle.storage.db,
      taskRunId: "run_1",
      errorText: "tool crashed",
      resultSummary: "execution failed",
      finishedAt: new Date("2026-03-26T00:00:08.000Z"),
    });

    expect(settled.taskRun).toMatchObject({
      status: "failed",
      errorText: "tool crashed",
      resultSummary: "execution failed",
      durationMs: 6000,
    });
    expect(settled.executionSession?.status).toBe("failed");
  });

  test("cancels task execution and records the cancelling actor", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);

    const settled = cancelTaskExecution({
      db: handle.storage.db,
      taskRunId: "run_1",
      cancelledBy: "user:daniel",
      resultSummary: "cancelled by user",
      finishedAt: new Date("2026-03-26T00:00:09.000Z"),
    });

    expect(settled.taskRun).toMatchObject({
      status: "cancelled",
      cancelledBy: "user:daniel",
      resultSummary: "cancelled by user",
      durationMs: 7000,
    });
    expect(settled.executionSession?.status).toBe("cancelled");
  });

  test("throws when settling an unknown task run", async () => {
    handle = await createTestDatabase(import.meta.url);
    const currentHandle = handle;
    seedFixture(currentHandle);

    expect(() =>
      completeTaskExecution({
        db: currentHandle.storage.db,
        taskRunId: "missing_run",
      }),
    ).toThrow("Cannot settle unknown task run missing_run");
  });
});
