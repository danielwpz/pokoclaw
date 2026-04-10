import { afterEach, describe, expect, test } from "vitest";

import { TaskRunsRepo } from "@/src/storage/repos/task-runs.repo.js";
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
    VALUES ('sess_1', 'conv_1', 'branch_1', 'agent_1', 'task', 'isolated', 'active', 0, '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z');

    INSERT INTO cron_jobs (
      id, owner_agent_id, target_conversation_id, target_branch_id,
      schedule_kind, schedule_value, payload_json, created_at, updated_at
    ) VALUES (
      'cron_1', 'agent_1', 'conv_1', 'branch_1',
      'cron', '0 * * * *', '{}', '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z'
    );
  `);
}

describe("task runs repo", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("creates and reads a task run by id and execution session", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    const repo = new TaskRunsRepo(handle.storage.db);

    repo.create({
      id: "run_1",
      runType: "delegate",
      ownerAgentId: "agent_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      executionSessionId: "sess_1",
      status: "running",
      description: "Inspect the demo task and report back.",
      inputJson: '{"task":"demo"}',
      startedAt: new Date("2026-03-26T00:00:01.000Z"),
    });

    expect(repo.getById("run_1")).toMatchObject({
      id: "run_1",
      runType: "delegate",
      executionSessionId: "sess_1",
      status: "running",
      description: "Inspect the demo task and report back.",
      inputJson: '{"task":"demo"}',
    });
    expect(repo.getByExecutionSessionId("sess_1")?.id).toBe("run_1");
  });

  test("updates lifecycle fields when a task run finishes", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    const repo = new TaskRunsRepo(handle.storage.db);

    repo.create({
      id: "run_1",
      runType: "cron",
      ownerAgentId: "agent_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      cronJobId: "cron_1",
      executionSessionId: "sess_1",
      status: "running",
      description: "Run the hourly cron workflow.",
      startedAt: new Date("2026-03-26T00:00:01.000Z"),
    });

    repo.updateStatus({
      id: "run_1",
      status: "completed",
      resultSummary: "finished successfully",
      finishedAt: new Date("2026-03-26T00:00:09.000Z"),
      durationMs: 8000,
    });

    expect(repo.getById("run_1")).toMatchObject({
      status: "completed",
      resultSummary: "finished successfully",
      durationMs: 8000,
      finishedAt: "2026-03-26T00:00:09.000Z",
    });
  });

  test("lists task runs for an owner in reverse started-at order", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    const repo = new TaskRunsRepo(handle.storage.db);

    repo.create({
      id: "run_old",
      runType: "delegate",
      ownerAgentId: "agent_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      status: "running",
      description: "Older delegated run.",
      startedAt: new Date("2026-03-26T00:00:01.000Z"),
    });
    repo.create({
      id: "run_new",
      runType: "system",
      ownerAgentId: "agent_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      status: "running",
      description: "Newer system run.",
      startedAt: new Date("2026-03-26T00:00:02.000Z"),
    });

    expect(repo.listByOwner("agent_1").map((run) => run.id)).toEqual(["run_new", "run_old"]);
  });

  test("preserves cancellation and partial status update fields", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    const repo = new TaskRunsRepo(handle.storage.db);

    repo.create({
      id: "run_1",
      runType: "delegate",
      ownerAgentId: "agent_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      executionSessionId: "sess_1",
      status: "running",
      priority: 3,
      attempt: 2,
      description: "Cancellable delegated run.",
      startedAt: new Date("2026-03-26T00:00:01.000Z"),
    });

    repo.updateStatus({
      id: "run_1",
      status: "cancelled",
      cancelledBy: "user:test-user",
    });

    expect(repo.getById("run_1")).toMatchObject({
      id: "run_1",
      status: "cancelled",
      cancelledBy: "user:test-user",
      priority: 3,
      attempt: 2,
      finishedAt: null,
    });
  });
});
