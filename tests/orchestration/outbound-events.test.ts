import { afterEach, describe, expect, test } from "vitest";

import { projectRuntimeEvent, projectTaskRunEvent } from "@/src/orchestration/outbound-events.js";
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

    INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, context_mode, status, compact_cursor, created_at, updated_at)
    VALUES ('sess_task', 'conv_sub', 'branch_sub', 'agent_sub', 'task', 'isolated', 'active', 0, '2026-03-26T00:00:01.000Z', '2026-03-26T00:00:01.000Z');

    INSERT INTO task_runs (
      id, run_type, owner_agent_id, conversation_id, branch_id,
      execution_session_id, status, started_at
    ) VALUES (
      'run_1', 'delegate', 'agent_sub', 'conv_sub', 'branch_sub',
      'sess_task', 'running', '2026-03-26T00:00:02.000Z'
    );
  `);
}

describe("outbound runtime events", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("projects raw runtime events with logical delivery target and live context", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);

    const envelope = projectRuntimeEvent({
      db: handle.storage.db,
      event: {
        type: "run_completed",
        eventId: "evt_1",
        createdAt: "2026-03-26T00:00:03.000Z",
        sessionId: "sess_task",
        conversationId: "conv_sub",
        branchId: "branch_sub",
        runId: "run_1",
        scenario: "chat",
        modelId: "model_x",
        appendedMessageIds: [],
        toolExecutions: 1,
        compactionRequested: false,
      },
    });

    expect(envelope).toMatchObject({
      kind: "runtime_event",
      target: {
        conversationId: "conv_sub",
        branchId: "branch_sub",
      },
      session: {
        sessionId: "sess_task",
        purpose: "task",
      },
      agent: {
        ownerAgentId: "agent_sub",
        ownerRole: "subagent",
        mainAgentId: "agent_main",
      },
      taskRun: {
        taskRunId: "run_1",
        runType: "delegate",
        status: "running",
        executionSessionId: "sess_task",
      },
      run: {
        runId: "run_1",
      },
      object: {
        messageId: null,
        toolCallId: null,
        toolName: null,
        approvalId: null,
      },
      event: {
        type: "run_completed",
      },
    });
  });

  test("still projects raw runtime events when session live state is missing", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);

    const envelope = projectRuntimeEvent({
      db: handle.storage.db,
      event: {
        type: "run_failed",
        eventId: "evt_2",
        createdAt: "2026-03-26T00:00:04.000Z",
        sessionId: "missing_session",
        conversationId: "conv_main",
        branchId: "branch_main",
        runId: "run_missing",
        scenario: "chat",
        modelId: "model_x",
        errorKind: "unknown",
        errorMessage: "failed",
        retryable: false,
      },
    });

    expect(envelope).toMatchObject({
      target: {
        conversationId: "conv_main",
        branchId: "branch_main",
      },
      session: {
        sessionId: "missing_session",
        purpose: null,
      },
      agent: {
        ownerAgentId: null,
        ownerRole: null,
        mainAgentId: null,
      },
      taskRun: {
        taskRunId: null,
        runType: null,
        status: null,
        executionSessionId: null,
      },
      run: {
        runId: "run_missing",
      },
      object: {
        messageId: null,
        toolCallId: null,
        toolName: null,
        approvalId: null,
      },
      event: {
        type: "run_failed",
      },
    });
  });

  test("projects task run lifecycle events with stable ownership and task context", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);

    const taskRun = new TaskRunsRepo(handle.storage.db).getById("run_1");
    const executionSession = new SessionsRepo(handle.storage.db).getById("sess_task");
    if (taskRun == null || executionSession == null) {
      throw new Error("Expected seeded task run and execution session.");
    }

    const envelope = projectTaskRunEvent({
      db: handle.storage.db,
      event: {
        type: "task_run_started",
        taskRunId: "run_1",
        runType: "delegate",
        status: "running",
        startedAt: "2026-03-26T00:00:02.000Z",
        initiatorSessionId: null,
        parentRunId: null,
        cronJobId: null,
        executionSessionId: "sess_task",
      },
      taskRun,
      executionSession,
    });

    expect(envelope).toMatchObject({
      kind: "task_run_event",
      target: {
        conversationId: "conv_sub",
        branchId: "branch_sub",
      },
      session: {
        sessionId: "sess_task",
        purpose: "task",
      },
      agent: {
        ownerAgentId: "agent_sub",
        ownerRole: "subagent",
        mainAgentId: "agent_main",
      },
      taskRun: {
        taskRunId: "run_1",
        runType: "delegate",
        status: "running",
        executionSessionId: "sess_task",
      },
      run: {
        runId: null,
      },
      event: {
        type: "task_run_started",
        executionSessionId: "sess_task",
      },
    });
  });
});
