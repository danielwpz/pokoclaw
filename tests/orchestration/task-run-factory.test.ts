import { afterEach, describe, expect, test } from "vitest";

import { AgentSessionService } from "@/src/agent/session.js";
import { createTaskExecution } from "@/src/orchestration/task-run-factory.js";
import { resolveTaskRunLiveState } from "@/src/runtime/live-state.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
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

  test("does not fork when only initiatorSessionId is provided", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    handle.storage.sqlite.exec(`
      UPDATE sessions
      SET compact_cursor = 1,
          compact_summary = 'main summary through seq 1',
          compact_summary_token_total = 42,
          compact_summary_usage_json = '{"input":30,"output":12,"cacheRead":0,"cacheWrite":0,"totalTokens":42}'
      WHERE id = 'sess_main';
    `);
    messagesRepo.append({
      id: "msg_main_1",
      sessionId: "sess_main",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"older context"}',
      createdAt: new Date("2026-03-26T00:00:00.500Z"),
    });
    messagesRepo.append({
      id: "msg_main_2",
      sessionId: "sess_main",
      seq: 2,
      role: "assistant",
      provider: "anthropic_main",
      model: "claude-sonnet-4-5",
      modelApi: "anthropic-messages",
      stopReason: "stop",
      payloadJson: '{"content":[{"type":"text","text":"latest visible context"}]}',
      createdAt: new Date("2026-03-26T00:00:01.000Z"),
    });

    const created = createTaskExecution({
      db: handle.storage.db,
      params: {
        runType: "delegate",
        ownerAgentId: "agent_sub",
        conversationId: "conv_sub",
        branchId: "branch_sub",
        initiatorSessionId: "sess_main",
        contextMode: "isolated",
        description: "Isolated follow-up task.",
        inputJson: '{"task":"isolated"}',
        createdAt: new Date("2026-03-26T00:02:00.000Z"),
      },
    });

    expect(created.executionSession).toMatchObject({
      purpose: "task",
      contextMode: "isolated",
      ownerAgentId: "agent_sub",
      forkedFromSessionId: null,
      forkSourceSeq: null,
      compactCursor: 0,
      compactSummary: null,
      compactSummaryTokenTotal: null,
    });
    expect(created.taskRun).toMatchObject({
      runType: "delegate",
      initiatorSessionId: "sess_main",
      description: "Isolated follow-up task.",
      inputJson: '{"task":"isolated"}',
      status: "running",
    });

    const service = new AgentSessionService(new SessionsRepo(handle.storage.db), messagesRepo);
    const context = service.getContext(created.executionSession.id);
    expect(context.compactSummary).toBeNull();
    expect(context.messages).toHaveLength(0);
  });

  test("preserves initiator, parent, priority, attempt, and explicit fork source", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    handle.storage.sqlite.exec(`
      INSERT INTO task_runs (
        id, run_type, owner_agent_id, conversation_id, branch_id,
        execution_session_id, status, started_at
      ) VALUES (
        'run_parent', 'delegate', 'agent_sub', 'conv_sub', 'branch_sub',
        NULL, 'completed', '2026-03-26T00:00:30.000Z'
      );
    `);
    handle.storage.sqlite.exec(`
      UPDATE sessions
      SET compact_cursor = 1,
          compact_summary = 'main summary through seq 1',
          compact_summary_token_total = 42,
          compact_summary_usage_json = '{"input":30,"output":12,"cacheRead":0,"cacheWrite":0,"totalTokens":42}'
      WHERE id = 'sess_main';
    `);
    messagesRepo.append({
      id: "msg_main_1",
      sessionId: "sess_main",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"older context"}',
      createdAt: new Date("2026-03-26T00:00:00.500Z"),
    });
    messagesRepo.append({
      id: "msg_main_2",
      sessionId: "sess_main",
      seq: 2,
      role: "assistant",
      provider: "anthropic_main",
      model: "claude-sonnet-4-5",
      modelApi: "anthropic-messages",
      stopReason: "stop",
      payloadJson: '{"content":[{"type":"text","text":"latest visible context"}]}',
      createdAt: new Date("2026-03-26T00:00:01.000Z"),
    });
    messagesRepo.append({
      id: "msg_main_3",
      sessionId: "sess_main",
      seq: 3,
      role: "user",
      payloadJson: '{"content":"latest user request"}',
      createdAt: new Date("2026-03-26T00:00:01.500Z"),
    });

    const created = createTaskExecution({
      db: handle.storage.db,
      params: {
        runType: "delegate",
        ownerAgentId: "agent_sub",
        conversationId: "conv_sub",
        branchId: "branch_sub",
        initiatorSessionId: "sess_main",
        forkSourceSessionId: "sess_main",
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
      forkedFromSessionId: "sess_main",
      forkSourceSeq: 3,
      compactCursor: 0,
      compactSummary: "main summary through seq 1",
      compactSummaryTokenTotal: 42,
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

    const service = new AgentSessionService(new SessionsRepo(handle.storage.db), messagesRepo);
    const context = service.getContext(created.executionSession.id);
    expect(context.compactSummary).toBe("main summary through seq 1");
    expect(context.messages).toHaveLength(2);
    expect(context.messages.map((message) => message.seq)).toEqual([1, 2]);
    expect(context.messages.map((message) => message.payloadJson)).toEqual([
      '{"content":[{"type":"text","text":"latest visible context"}]}',
      '{"content":"latest user request"}',
    ]);
  });
});
