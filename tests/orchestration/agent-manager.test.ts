import { describe, expect, test, vi } from "vitest";

import { AgentManager } from "@/src/orchestration/agent-manager.js";
import { createMainAgentApprovalSessionId } from "@/src/orchestration/approval-session.js";
import type { SubmitMessageInput, SubmitMessageResult } from "@/src/runtime/ingress.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

async function withHandle(fn: (handle: TestDatabaseHandle) => Promise<void>): Promise<void> {
  const handle = await createTestDatabase(import.meta.url);
  try {
    await fn(handle);
  } finally {
    await destroyTestDatabase(handle);
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function seedFixture(handle: TestDatabaseHandle): void {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_1', 'lark', 'acct_a', '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:00.000Z');

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES
      ('conv_main', 'ci_1', 'chat_main', 'dm', '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:00.000Z'),
      ('conv_sub', 'ci_1', 'chat_sub', 'group', '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES
      ('branch_main', 'conv_main', 'dm_main', 'main', '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:00.000Z'),
      ('branch_sub', 'conv_sub', 'group_main', 'main', '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:00.000Z');

    INSERT INTO agents (id, conversation_id, main_agent_id, kind, created_at)
    VALUES
      ('agent_main', 'conv_main', NULL, 'main', '2026-03-25T00:00:00.000Z'),
      ('agent_sub', 'conv_sub', 'agent_main', 'sub', '2026-03-25T00:00:00.000Z');

    INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, context_mode, status, compact_cursor, created_at, updated_at)
    VALUES
      ('sess_main', 'conv_main', 'branch_main', 'agent_main', 'chat', 'isolated', 'active', 0, '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:01.000Z'),
      ('sess_sub', 'conv_sub', 'branch_sub', 'agent_sub', 'task', 'isolated', 'active', 0, '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:01.000Z');

    INSERT INTO approval_ledger (
      owner_agent_id, requested_by_session_id, requested_scope_json, approval_target, status,
      reason_text, created_at
    ) VALUES (
      'agent_sub',
      'sess_sub',
      '{"scopes":[{"kind":"fs.write","path":"/tmp/demo.txt"}]}',
      'main_agent',
      'pending',
      'Need to update the requested task output.',
      '2026-03-25T00:00:02.000Z'
    );
  `);
}

describe("AgentManager", () => {
  test("forwards user messages to runtime ingress", async () => {
    const submitMessage = vi.fn(
      async (_input: SubmitMessageInput): Promise<SubmitMessageResult> => {
        return { status: "steered" };
      },
    );
    const submitApprovalDecision = vi.fn(() => false);
    const manager = new AgentManager({
      storage: null as never,
      ingress: {
        submitMessage,
        submitApprovalDecision,
      },
    });

    const result = await manager.submitUserMessage({
      sessionId: "sess_1",
      scenario: "chat",
      content: "hello",
    });

    expect(result).toEqual({ status: "steered" });
    expect(submitMessage).toHaveBeenCalledExactlyOnceWith({
      sessionId: "sess_1",
      scenario: "chat",
      content: "hello",
    });
    expect(submitApprovalDecision).not.toHaveBeenCalled();
  });

  test("forwards approval decisions to runtime ingress", () => {
    const submitMessage = vi.fn();
    const submitApprovalDecision = vi.fn(() => true);
    const manager = new AgentManager({
      storage: null as never,
      ingress: {
        submitMessage,
        submitApprovalDecision,
      },
    });

    const matched = manager.submitApprovalDecision({
      approvalId: 42,
      decision: "approve",
      actor: "user:demo",
    });

    expect(matched).toBe(true);
    expect(submitApprovalDecision).toHaveBeenCalledExactlyOnceWith({
      approvalId: 42,
      decision: "approve",
      actor: "user:demo",
    });
    expect(submitMessage).not.toHaveBeenCalled();
  });

  test("delivers delegated approval requests for main-agent-targeted runtime events", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);

      const submitted: SubmitMessageInput[] = [];
      const manager = new AgentManager({
        storage: handle.storage.db,
        ingress: {
          async submitMessage(input: SubmitMessageInput): Promise<SubmitMessageResult> {
            submitted.push(input);
            return { status: "steered" };
          },
          submitApprovalDecision: vi.fn(() => false),
        },
      });

      const result = await manager.handleRuntimeEvent({
        type: "approval_requested",
        eventId: "evt_1",
        createdAt: "2026-03-25T00:00:03.000Z",
        sessionId: "sess_sub",
        conversationId: "conv_sub",
        branchId: "branch_sub",
        runId: "run_1",
        approvalId: "1",
        approvalTarget: "main_agent",
        title: "Need approval",
        reasonText: "Need to update the requested task output.",
        options: [],
        expiresAt: null,
      });

      expect(result).toEqual({
        status: "delivered",
        approvalId: 1,
        targetSessionId: createMainAgentApprovalSessionId({
          sourceSessionId: "sess_sub",
          approvalId: 1,
        }),
      });
      expect(submitted).toHaveLength(2);
      expect(submitted[0]).toMatchObject({
        sessionId: createMainAgentApprovalSessionId({
          sourceSessionId: "sess_sub",
          approvalId: 1,
        }),
        scenario: "chat",
        messageType: "approval_request",
        visibility: "hidden_system",
      });
      expect(submitted[1]).toMatchObject({
        sessionId: createMainAgentApprovalSessionId({
          sourceSessionId: "sess_sub",
          approvalId: 1,
        }),
        scenario: "chat",
        messageType: "approval_followup",
        visibility: "hidden_system",
      });
    });
  });

  test("ignores non-delegated approval events", async () => {
    const submitMessage = vi.fn(
      async (_input: SubmitMessageInput): Promise<SubmitMessageResult> => {
        return { status: "steered" };
      },
    );
    const manager = new AgentManager({
      storage: null as never,
      ingress: {
        submitMessage,
        submitApprovalDecision: vi.fn(() => false),
      },
    });

    const result = await manager.handleRuntimeEvent({
      type: "approval_requested",
      eventId: "evt_1",
      createdAt: "2026-03-25T00:00:03.000Z",
      sessionId: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      runId: "run_1",
      approvalId: "1",
      approvalTarget: "user",
      title: "Need approval",
      reasonText: "Need permission.",
      options: [],
      expiresAt: null,
    });

    expect(result).toBeNull();
    expect(submitMessage).not.toHaveBeenCalled();
  });

  test("exposes live session and task-run state for orchestration consumers", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      handle.storage.sqlite.exec(`
        INSERT INTO task_runs (
          id, run_type, owner_agent_id, conversation_id, branch_id,
          execution_session_id, status, started_at
        ) VALUES (
          'run_delegate', 'delegate', 'agent_sub', 'conv_sub', 'branch_sub',
          'sess_sub', 'running', '2026-03-25T00:00:02.500Z'
        );
      `);

      const manager = new AgentManager({
        storage: handle.storage.db,
        ingress: {
          submitMessage: vi.fn(async () => ({ status: "steered" as const })),
          submitApprovalDecision: vi.fn(() => false),
        },
      });

      expect(manager.getSessionLiveState("sess_sub")).toMatchObject({
        session: { id: "sess_sub" },
        ownerAgentId: "agent_sub",
        ownerRole: "subagent",
        mainAgentId: "agent_main",
        taskRun: { id: "run_delegate", runType: "delegate" },
      });

      expect(manager.getTaskRunLiveState("run_delegate")).toMatchObject({
        taskRun: { id: "run_delegate", executionSessionId: "sess_sub" },
        executionSession: { id: "sess_sub" },
        ownerRole: "subagent",
        mainAgentId: "agent_main",
      });
    });
  });

  test("creates task executions through the orchestration entrypoint", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      handle.storage.sqlite.exec(`
        INSERT INTO cron_jobs (
          id, owner_agent_id, target_conversation_id, target_branch_id,
          schedule_kind, schedule_value, payload_json, created_at, updated_at
        ) VALUES (
          'cron_1', 'agent_sub', 'conv_sub', 'branch_sub',
          'cron', '0 * * * *', '{}', '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:00.000Z'
        );
      `);

      const manager = new AgentManager({
        storage: handle.storage.db,
        ingress: {
          submitMessage: vi.fn(async () => ({ status: "steered" as const })),
          submitApprovalDecision: vi.fn(() => false),
        },
      });

      const created = manager.createTaskExecution({
        runType: "cron",
        ownerAgentId: "agent_sub",
        conversationId: "conv_sub",
        branchId: "branch_sub",
        cronJobId: "cron_1",
        initiatorSessionId: "sess_main",
        inputJson: '{"job":"daily-finance"}',
        createdAt: new Date("2026-03-25T00:00:05.000Z"),
      });

      expect(created.executionSession).toMatchObject({
        purpose: "task",
        ownerAgentId: "agent_sub",
        conversationId: "conv_sub",
      });
      expect(created.taskRun).toMatchObject({
        runType: "cron",
        ownerAgentId: "agent_sub",
        executionSessionId: created.executionSession.id,
        initiatorSessionId: "sess_main",
        cronJobId: "cron_1",
        status: "running",
      });

      expect(manager.getTaskRunLiveState(created.taskRun.id)).toMatchObject({
        taskRun: { id: created.taskRun.id, executionSessionId: created.executionSession.id },
        executionSession: { id: created.executionSession.id },
        ownerRole: "subagent",
        mainAgentId: "agent_main",
      });
    });
  });

  test("runs delegated task executions through the orchestration entrypoint", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);

      const submitMessage = vi.fn(
        async (input: SubmitMessageInput): Promise<SubmitMessageResult> => {
          expect(input).toMatchObject({
            scenario: "subagent",
            messageType: "task_kickoff",
            visibility: "hidden_system",
          });
          expect(input.content).toContain("<task_execution>");

          return {
            status: "started",
            messageId: "msg_task_1",
            run: {
              runId: "run_loop_1",
              sessionId: input.sessionId,
              scenario: "subagent",
              modelId: "test-model",
              appendedMessageIds: [],
              toolExecutions: 0,
              compaction: {
                shouldCompact: false,
                reason: null,
                thresholdTokens: 1000,
                effectiveWindow: 2000,
              },
              events: [],
            },
          };
        },
      );

      const manager = new AgentManager({
        storage: handle.storage.db,
        ingress: {
          submitMessage,
          submitApprovalDecision: vi.fn(() => false),
        },
      });

      const result = await manager.runTaskExecution({
        runType: "delegate",
        ownerAgentId: "agent_sub",
        conversationId: "conv_sub",
        branchId: "branch_sub",
        description: "Review the incoming repository changes.",
        createdAt: new Date("2026-03-25T00:00:05.000Z"),
      });

      expect(result.status).toBe("completed");
      expect(submitMessage).toHaveBeenCalledOnce();
      expect(result.settled.taskRun).toMatchObject({
        runType: "delegate",
        status: "completed",
      });
      expect(result.settled.executionSession).toMatchObject({
        purpose: "task",
        status: "completed",
      });
    });
  });

  test("rejects task execution creation for unknown agents", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);

      const manager = new AgentManager({
        storage: handle.storage.db,
        ingress: {
          submitMessage: vi.fn(async () => ({ status: "steered" as const })),
          submitApprovalDecision: vi.fn(() => false),
        },
      });

      expect(() =>
        manager.createTaskExecution({
          runType: "system",
          ownerAgentId: "missing_agent",
          conversationId: "conv_sub",
          branchId: "branch_sub",
        }),
      ).toThrow("Cannot create task execution for unknown agent missing_agent");
    });
  });

  test("settles task executions through the orchestration entrypoint", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);

      const manager = new AgentManager({
        storage: handle.storage.db,
        ingress: {
          submitMessage: vi.fn(async () => ({ status: "steered" as const })),
          submitApprovalDecision: vi.fn(() => false),
        },
      });

      const created = manager.createTaskExecution({
        runType: "system",
        ownerAgentId: "agent_sub",
        conversationId: "conv_sub",
        branchId: "branch_sub",
        createdAt: new Date("2026-03-25T00:00:05.000Z"),
      });

      const settled = manager.completeTaskExecution({
        taskRunId: created.taskRun.id,
        resultSummary: "finished",
        finishedAt: new Date("2026-03-25T00:00:08.000Z"),
      });

      expect(settled.taskRun).toMatchObject({
        id: created.taskRun.id,
        status: "completed",
        resultSummary: "finished",
        durationMs: 3000,
      });
      expect(settled.executionSession).toMatchObject({
        id: created.executionSession.id,
        status: "completed",
      });
      expect(manager.getTaskRunLiveState(created.taskRun.id)?.taskRun.status).toBe("completed");
    });
  });

  test("creates cron task executions from cron job definitions", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      handle.storage.sqlite.exec(`
        INSERT INTO cron_jobs (
          id, owner_agent_id, target_conversation_id, target_branch_id,
          schedule_kind, schedule_value, context_mode, payload_json, created_at, updated_at
        ) VALUES (
          'cron_2', 'agent_sub', 'conv_sub', 'branch_sub',
          'cron', '*/5 * * * *', 'group', '{"job":"reconcile"}',
          '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:00.000Z'
        );
      `);

      const manager = new AgentManager({
        storage: handle.storage.db,
        ingress: {
          submitMessage: vi.fn(async () => ({ status: "steered" as const })),
          submitApprovalDecision: vi.fn(() => false),
        },
      });

      const created = manager.createCronTaskExecutionFromJob({
        cronJobId: "cron_2",
        attempt: 4,
        createdAt: new Date("2026-03-25T00:00:10.000Z"),
      });

      expect(created.executionSession).toMatchObject({
        purpose: "task",
        contextMode: "group",
        conversationId: "conv_sub",
        branchId: "branch_sub",
        ownerAgentId: "agent_sub",
      });
      expect(created.taskRun).toMatchObject({
        runType: "cron",
        cronJobId: "cron_2",
        attempt: 4,
        inputJson: '{"job":"reconcile"}',
        ownerAgentId: "agent_sub",
      });
    });
  });

  test("runs cron task executions from cron job definitions", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      handle.storage.sqlite.exec(`
        INSERT INTO cron_jobs (
          id, owner_agent_id, target_conversation_id, target_branch_id,
          schedule_kind, schedule_value, context_mode, payload_json, created_at, updated_at
        ) VALUES (
          'cron_2', 'agent_sub', 'conv_sub', 'branch_sub',
          'cron', '*/5 * * * *', 'group', '{"job":"reconcile"}',
          '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:00.000Z'
        );
      `);

      const submitMessage = vi.fn(
        async (input: SubmitMessageInput): Promise<SubmitMessageResult> => {
          expect(input).toMatchObject({
            scenario: "cron",
            messageType: "cron_kickoff",
            visibility: "hidden_system",
          });
          expect(input.content).toContain("<run_type>cron</run_type>");

          return {
            status: "started",
            messageId: "msg_cron_1",
            run: {
              runId: "run_loop_cron_1",
              sessionId: input.sessionId,
              scenario: "cron",
              modelId: "test-model",
              appendedMessageIds: [],
              toolExecutions: 0,
              compaction: {
                shouldCompact: false,
                reason: null,
                thresholdTokens: 1000,
                effectiveWindow: 2000,
              },
              events: [],
            },
          };
        },
      );

      const manager = new AgentManager({
        storage: handle.storage.db,
        ingress: {
          submitMessage,
          submitApprovalDecision: vi.fn(() => false),
        },
      });

      const result = await manager.runCronTaskExecutionFromJob({
        cronJobId: "cron_2",
        attempt: 2,
        createdAt: new Date("2026-03-25T00:00:10.000Z"),
      });

      expect(result.status).toBe("completed");
      expect(submitMessage).toHaveBeenCalledOnce();
      expect(result.settled.taskRun).toMatchObject({
        runType: "cron",
        cronJobId: "cron_2",
        status: "completed",
        attempt: 2,
      });
      expect(result.settled.executionSession).toMatchObject({
        purpose: "task",
        contextMode: "group",
        status: "completed",
      });
    });
  });

  test("rejects cron task execution creation for unknown cron jobs", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);

      const manager = new AgentManager({
        storage: handle.storage.db,
        ingress: {
          submitMessage: vi.fn(async () => ({ status: "steered" as const })),
          submitApprovalDecision: vi.fn(() => false),
        },
      });

      expect(() =>
        manager.createCronTaskExecutionFromJob({
          cronJobId: "missing_cron",
        }),
      ).toThrow("Cannot create task execution for unknown cron job missing_cron");
    });
  });

  test("manually runs cron jobs through CronService semantics", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      handle.storage.sqlite.exec(`
        INSERT INTO cron_jobs (
          id, owner_agent_id, target_conversation_id, target_branch_id,
          schedule_kind, schedule_value, context_mode, payload_json, next_run_at, created_at, updated_at
        ) VALUES (
          'cron_2', 'agent_sub', 'conv_sub', 'branch_sub',
          'cron', '*/5 * * * *', 'group', '{"prompt":"reconcile"}',
          '2026-03-25T00:05:00.000Z', '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:00.000Z'
        );
      `);

      const submitMessage = vi.fn(
        async (input: SubmitMessageInput): Promise<SubmitMessageResult> => ({
          status: "started",
          messageId: "msg_cron_1",
          run: {
            runId: "run_loop_cron_1",
            sessionId: input.sessionId,
            scenario: "cron",
            modelId: "test-model",
            appendedMessageIds: [],
            toolExecutions: 0,
            compaction: {
              shouldCompact: false,
              reason: null,
              thresholdTokens: 1000,
              effectiveWindow: 2000,
            },
            events: [],
          },
        }),
      );

      const manager = new AgentManager({
        storage: handle.storage.db,
        ingress: {
          submitMessage,
          submitApprovalDecision: vi.fn(() => false),
        },
      });

      const result = await manager.runCronJobNow({
        jobId: "cron_2",
      });

      expect(result).toEqual({
        accepted: true,
        cronJobId: "cron_2",
      });
      expect(submitMessage).toHaveBeenCalledOnce();
      await flushMicrotasks();

      const row = handle.storage.sqlite
        .prepare("SELECT running_at, last_status FROM cron_jobs WHERE id = ?")
        .get("cron_2") as { running_at: string | null; last_status: string | null };
      expect(row).toEqual({
        running_at: null,
        last_status: "completed",
      });
    });
  });

  test("projects raw runtime events with live orchestration context", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      handle.storage.sqlite.exec(`
        INSERT INTO task_runs (
          id, run_type, owner_agent_id, conversation_id, branch_id,
          execution_session_id, status, started_at
        ) VALUES (
          'run_delegate', 'delegate', 'agent_sub', 'conv_sub', 'branch_sub',
          'sess_sub', 'running', '2026-03-25T00:00:02.500Z'
        );
      `);

      const manager = new AgentManager({
        storage: handle.storage.db,
        ingress: {
          submitMessage: vi.fn(async () => ({ status: "steered" as const })),
          submitApprovalDecision: vi.fn(() => false),
        },
      });

      const envelope = manager.projectRuntimeEvent({
        type: "turn_completed",
        eventId: "evt_1",
        createdAt: "2026-03-25T00:00:03.000Z",
        sessionId: "sess_sub",
        conversationId: "conv_sub",
        branchId: "branch_sub",
        runId: "run_delegate",
        turn: 1,
        toolCallsRequested: 1,
        toolExecutions: 1,
      });

      expect(envelope).toMatchObject({
        target: { conversationId: "conv_sub", branchId: "branch_sub" },
        session: { sessionId: "sess_sub", purpose: "task" },
        agent: {
          ownerAgentId: "agent_sub",
          ownerRole: "subagent",
          mainAgentId: "agent_main",
        },
        taskRun: {
          taskRunId: "run_delegate",
          runType: "delegate",
        },
        event: { type: "turn_completed" },
      });
    });
  });

  test("returns null for invalid delegated approval ids", async () => {
    const submitMessage = vi.fn(
      async (_input: SubmitMessageInput): Promise<SubmitMessageResult> => {
        return { status: "steered" };
      },
    );
    const manager = new AgentManager({
      storage: null as never,
      ingress: {
        submitMessage,
        submitApprovalDecision: vi.fn(() => false),
      },
    });

    const result = await manager.handleRuntimeEvent({
      type: "approval_requested",
      eventId: "evt_1",
      createdAt: "2026-03-25T00:00:03.000Z",
      sessionId: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      runId: "run_1",
      approvalId: "not-a-number",
      approvalTarget: "main_agent",
      title: "Need approval",
      reasonText: "Need permission.",
      options: [],
      expiresAt: null,
    });

    expect(result).toBeNull();
    expect(submitMessage).not.toHaveBeenCalled();
  });
});
