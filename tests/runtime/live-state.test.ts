import { afterEach, describe, expect, test } from "vitest";

import {
  resolveAgentOwnershipState,
  resolveSessionLiveState,
  resolveTaskRunLiveState,
} from "@/src/runtime/live-state.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
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
  `);
}

describe("runtime live state", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("resolves agent ownership to the owning main agent", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);

    expect(
      resolveAgentOwnershipState({
        db: handle.storage.db,
        agentId: "agent_sub",
      }),
    ).toEqual({
      agentId: "agent_sub",
      ownerRole: "subagent",
      mainAgentId: "agent_main",
    });
  });

  test("resolves session live state including task run and approval source session", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const taskRunsRepo = new TaskRunsRepo(handle.storage.db);

    sessionsRepo.create({
      id: "sess_main",
      conversationId: "conv_main",
      branchId: "branch_main",
      ownerAgentId: "agent_main",
      purpose: "chat",
      createdAt: new Date("2026-03-26T00:00:00.000Z"),
    });
    sessionsRepo.create({
      id: "sess_task",
      conversationId: "conv_sub",
      branchId: "branch_sub",
      ownerAgentId: "agent_sub",
      purpose: "task",
      createdAt: new Date("2026-03-26T00:00:01.000Z"),
    });
    sessionsRepo.create({
      id: "sess_approval",
      conversationId: "conv_main",
      branchId: "branch_main",
      ownerAgentId: "agent_main",
      purpose: "approval",
      approvalForSessionId: "sess_task",
      forkedFromSessionId: "sess_main",
      forkSourceSeq: 0,
      createdAt: new Date("2026-03-26T00:00:02.000Z"),
    });

    taskRunsRepo.create({
      id: "run_1",
      runType: "delegate",
      ownerAgentId: "agent_sub",
      conversationId: "conv_sub",
      branchId: "branch_sub",
      executionSessionId: "sess_task",
      status: "running",
      startedAt: new Date("2026-03-26T00:00:01.500Z"),
    });

    const state = resolveSessionLiveState({
      db: handle.storage.db,
      sessionId: "sess_approval",
    });

    expect(state).not.toBeNull();
    expect(state?.session.id).toBe("sess_approval");
    expect(state?.mainAgentId).toBe("agent_main");
    expect(state?.ownerRole).toBe("main");
    expect(state?.approvalSourceSession?.id).toBe("sess_task");
    expect(state?.taskRun).toBeNull();

    const taskState = resolveSessionLiveState({
      db: handle.storage.db,
      sessionId: "sess_task",
    });
    expect(taskState?.mainAgentId).toBe("agent_main");
    expect(taskState?.ownerRole).toBe("subagent");
    expect(taskState?.taskRun?.id).toBe("run_1");
  });

  test("resolves latest approval session alongside task-run live state", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const taskRunsRepo = new TaskRunsRepo(handle.storage.db);

    sessionsRepo.create({
      id: "sess_task",
      conversationId: "conv_sub",
      branchId: "branch_sub",
      ownerAgentId: "agent_sub",
      purpose: "task",
      createdAt: new Date("2026-03-26T00:00:01.000Z"),
      updatedAt: new Date("2026-03-26T00:00:01.000Z"),
    });
    sessionsRepo.create({
      id: "sess_approval_old",
      conversationId: "conv_main",
      branchId: "branch_main",
      ownerAgentId: "agent_main",
      purpose: "approval",
      approvalForSessionId: "sess_task",
      createdAt: new Date("2026-03-26T00:00:02.000Z"),
      updatedAt: new Date("2026-03-26T00:00:03.000Z"),
    });
    sessionsRepo.create({
      id: "sess_approval_new",
      conversationId: "conv_main",
      branchId: "branch_main",
      ownerAgentId: "agent_main",
      purpose: "approval",
      approvalForSessionId: "sess_task",
      createdAt: new Date("2026-03-26T00:00:04.000Z"),
      updatedAt: new Date("2026-03-26T00:00:05.000Z"),
    });

    taskRunsRepo.create({
      id: "run_1",
      runType: "delegate",
      ownerAgentId: "agent_sub",
      conversationId: "conv_sub",
      branchId: "branch_sub",
      executionSessionId: "sess_task",
      status: "running",
      startedAt: new Date("2026-03-26T00:00:01.500Z"),
    });

    const state = resolveTaskRunLiveState({
      db: handle.storage.db,
      taskRunId: "run_1",
    });

    expect(state).not.toBeNull();
    expect(state?.executionSession?.id).toBe("sess_task");
    expect(state?.latestApprovalSession?.id).toBe("sess_approval_new");
    expect(state?.mainAgentId).toBe("agent_main");
    expect(state?.ownerRole).toBe("subagent");
  });

  test("returns null when requested live state records do not exist", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);

    expect(
      resolveAgentOwnershipState({
        db: handle.storage.db,
        agentId: "missing_agent",
      }),
    ).toBeNull();

    expect(
      resolveSessionLiveState({
        db: handle.storage.db,
        sessionId: "missing_session",
      }),
    ).toBeNull();

    expect(
      resolveTaskRunLiveState({
        db: handle.storage.db,
        taskRunId: "missing_run",
      }),
    ).toBeNull();
  });
});
