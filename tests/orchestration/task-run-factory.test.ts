import { afterEach, describe, expect, test } from "vitest";

import { createTaskExecution } from "@/src/orchestration/task-run-factory.js";
import { resolveTaskRunLiveState } from "@/src/runtime/live-state.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
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
    VALUES
      ('conv_main', 'ci_1', 'chat_main', 'dm', '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z'),
      ('conv_sub', 'ci_1', 'chat_sub', 'group', '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES
      ('branch_main', 'conv_main', 'dm_main', 'main', '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z'),
      ('branch_sub', 'conv_sub', 'group_main', 'main', '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z');

    INSERT INTO agents (id, conversation_id, main_agent_id, kind, created_at)
    VALUES
      ('agent_main', 'conv_main', NULL, 'main', '2026-03-26T00:00:00.000Z'),
      ('agent_sub', 'conv_sub', 'agent_main', 'sub', '2026-03-26T00:00:00.000Z');

    INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, context_mode, status, compact_cursor, created_at, updated_at)
    VALUES ('sess_main', 'conv_main', 'branch_main', 'agent_main', 'chat', 'isolated', 'active', 0, '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z');

    INSERT INTO cron_jobs (
      id, owner_agent_id, target_conversation_id, target_branch_id,
      schedule_kind, schedule_value, payload_json, created_at, updated_at
    ) VALUES (
      'cron_1', 'agent_sub', 'conv_sub', 'branch_sub',
      'cron', '0 * * * *', '{}', '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z'
    );
  `);
}

describe("task run factory", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("creates a running task_run and task execution session together", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);

    const created = createTaskExecution({
      db: handle.storage.db,
      params: {
        runType: "cron",
        ownerAgentId: "agent_sub",
        conversationId: "conv_sub",
        branchId: "branch_sub",
        cronJobId: "cron_1",
        description: "Daily finance cron execution.",
        inputJson: '{"job":"daily-finance"}',
        createdAt: new Date("2026-03-26T00:01:00.000Z"),
      },
    });

    expect(created.executionSession.purpose).toBe("task");
    expect(created.executionSession.ownerAgentId).toBe("agent_sub");
    expect(created.taskRun.executionSessionId).toBe(created.executionSession.id);
    expect(created.taskRun.status).toBe("running");
    expect(created.taskRun.cronJobId).toBe("cron_1");
    expect(created.taskRun.description).toBe("Daily finance cron execution.");

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    expect(sessionsRepo.getById(created.executionSession.id)?.purpose).toBe("task");

    const liveState = resolveTaskRunLiveState({
      db: handle.storage.db,
      taskRunId: created.taskRun.id,
    });
    expect(liveState).toMatchObject({
      taskRun: { id: created.taskRun.id, executionSessionId: created.executionSession.id },
      executionSession: { id: created.executionSession.id },
      mainAgentId: "agent_main",
      ownerRole: "subagent",
    });
  });

  test("preserves initiator, parent, priority, attempt, and context mode", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    handle.storage.sqlite.exec(`
      INSERT INTO task_runs (
        id, run_type, owner_agent_id, conversation_id, branch_id,
        execution_session_id, status, started_at
      ) VALUES (
        'run_parent', 'delegate', 'agent_sub', 'conv_sub', 'branch_sub',
        NULL, 'completed', '2026-03-26T00:00:30.000Z'
      );
    `);

    const created = createTaskExecution({
      db: handle.storage.db,
      params: {
        runType: "delegate",
        ownerAgentId: "agent_sub",
        conversationId: "conv_sub",
        branchId: "branch_sub",
        initiatorSessionId: "sess_main",
        parentRunId: "run_parent",
        contextMode: "inherited",
        priority: 5,
        attempt: 3,
        description: "Follow up on the earlier delegated task.",
        inputJson: '{"task":"follow-up"}',
        createdAt: new Date("2026-03-26T00:02:00.000Z"),
      },
    });

    expect(created.executionSession).toMatchObject({
      purpose: "task",
      contextMode: "inherited",
      ownerAgentId: "agent_sub",
    });
    expect(created.taskRun).toMatchObject({
      runType: "delegate",
      initiatorSessionId: "sess_main",
      parentRunId: "run_parent",
      priority: 5,
      attempt: 3,
      description: "Follow up on the earlier delegated task.",
      inputJson: '{"task":"follow-up"}',
      status: "running",
    });
  });
});
