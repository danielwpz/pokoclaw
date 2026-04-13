import { describe, expect, test, vi } from "vitest";

import { AgentSessionService } from "@/src/agent/session.js";
import { AgentManager } from "@/src/orchestration/agent-manager.js";
import { createMainAgentApprovalSessionId } from "@/src/orchestration/approval-session.js";
import type { OrchestratedOutboundEventEnvelope } from "@/src/orchestration/outbound-events.js";
import { RuntimeEventBus } from "@/src/runtime/event-bus.js";
import type { SubmitMessageInput, SubmitMessageResult } from "@/src/runtime/ingress.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { SubagentCreationRequestsRepo } from "@/src/storage/repos/subagent-creation-requests.repo.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

function createStartedTaskRunResult(input: {
  sessionId: string;
  scenario: "task";
  completionStatus?: "completed" | "blocked" | "failed";
  summary?: string;
  finalMessage?: string;
}): SubmitMessageResult {
  const completionStatus = input.completionStatus ?? "completed";
  return {
    status: "started",
    messageId: "msg_task_1",
    run: {
      runId: "run_loop_task_1",
      sessionId: input.sessionId,
      scenario: input.scenario,
      modelId: "test-model",
      appendedMessageIds: [],
      toolExecutions: 1,
      compaction: {
        shouldCompact: false,
        reason: null,
        thresholdTokens: 1000,
        effectiveWindow: 2000,
      },
      events: [],
      stopSignal: {
        reason: "task_completion",
        payload: {
          taskCompletion: {
            status: completionStatus,
            summary: input.summary ?? "Task finished.",
            finalMessage: input.finalMessage ?? "Task finished.",
          },
        },
      },
    },
  };
}

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

async function waitForCondition(condition: () => boolean, attempts = 40): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for condition.");
}

function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
        request: {
          scopes: [{ kind: "fs.write", path: "/tmp/demo.txt" }],
        },
        reasonText: "Need to update the requested task output.",
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
      request: {
        scopes: [{ kind: "fs.write", path: "/tmp/demo.txt" }],
      },
      reasonText: "Need permission.",
      expiresAt: null,
    });

    expect(result).toBeNull();
    expect(submitMessage).not.toHaveBeenCalled();
  });

  test("can wait for inflight runtime event orchestration to finish", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);

      const submitMessageGate = createDeferredPromise<SubmitMessageResult>();
      const manager = new AgentManager({
        storage: handle.storage.db,
        ingress: {
          submitMessage: vi.fn(async (input: SubmitMessageInput): Promise<SubmitMessageResult> => {
            if (input.messageType === "approval_request") {
              return submitMessageGate.promise;
            }
            return { status: "steered" };
          }),
          submitApprovalDecision: vi.fn(() => false),
        },
      });

      manager.emitRuntimeEvent({
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
        request: {
          scopes: [{ kind: "fs.write", path: "/tmp/demo.txt" }],
        },
        reasonText: "Need to update the requested task output.",
        expiresAt: null,
      });

      await flushMicrotasks();

      let idleResolved = false;
      const idlePromise = manager.waitForRuntimeEventOrchestrationIdle().then(() => {
        idleResolved = true;
      });

      await flushMicrotasks();
      expect(idleResolved).toBe(false);

      handle.storage.sqlite
        .prepare(
          `
            UPDATE approval_ledger
            SET status = 'approved', decided_at = ?, reason_text = ?
            WHERE id = 1
          `,
        )
        .run("2026-03-25T00:00:04.000Z", "Approved during test drain.");
      submitMessageGate.resolve({ status: "steered" });

      await idlePromise;
      expect(idleResolved).toBe(true);
    });
  });

  test("treats duplicate approve subagent callbacks as idempotent and republishes the resolved event", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      const bus = new RuntimeEventBus<OrchestratedOutboundEventEnvelope>();
      const events: OrchestratedOutboundEventEnvelope[] = [];
      bus.subscribe((event) => {
        events.push(event);
      });

      const manager = new AgentManager({
        storage: handle.storage.db,
        ingress: {
          submitMessage: vi.fn(async () => ({ status: "steered" as const })),
          submitApprovalDecision: vi.fn(() => false),
        },
        outboundEventBus: bus,
        subagentPrivateWorkspace: {
          ensureDirectory: vi.fn(async () => {}),
        },
        subagentProvisioner: {
          provisionSubagentSurface: vi.fn(async () => ({
            status: "provisioned" as const,
            externalChatId: "chat_sub_approved",
            shareLink: "https://example.com/subagent-approved",
            conversationKind: "group" as const,
            channelSurface: {
              channelType: "lark",
              channelInstallationId: "default",
              surfaceKey: "chat:chat_sub_approved",
              surfaceObjectJson: JSON.stringify({ chat_id: "chat_sub_approved" }),
            },
          })),
        },
      });

      manager.submitSubagentCreationRequest({
        sourceSessionId: "sess_main",
        title: "PR Review",
        description: "Review pull requests and summarize findings.",
        initialTask: "Review the current PR and report concrete issues.",
      });
      const request = new SubagentCreationRequestsRepo(handle.storage.db).listBySourceSession(
        "sess_main",
        1,
      )[0];
      if (request == null) {
        throw new Error("Expected a pending subagent request");
      }

      await manager.approveSubagentCreationRequest({
        requestId: request.id,
        decidedAt: new Date("2026-03-25T00:10:00.000Z"),
      });
      await flushMicrotasks();

      const publishedBeforeDuplicate = events.length;
      const resolved = await manager.resolveApproveSubagentCreationRequest({
        requestId: request.id,
        decidedAt: new Date("2026-03-25T00:11:00.000Z"),
      });
      await flushMicrotasks();

      expect(resolved).toMatchObject({
        outcome: "already_created",
        externalChatId: "chat_sub_approved",
        shareLink: null,
      });
      expect(events).toHaveLength(publishedBeforeDuplicate + 1);
      const duplicateEvent = events[events.length - 1];
      expect(duplicateEvent).toMatchObject({
        kind: "subagent_creation_event",
        event: {
          type: "subagent_creation_resolved",
          requestId: request.id,
          status: "created",
          externalChatId: "chat_sub_approved",
          shareLink: null,
        },
      });
    });
  });

  test("treats duplicate deny subagent callbacks as idempotent and republishes the resolved event", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      const bus = new RuntimeEventBus<OrchestratedOutboundEventEnvelope>();
      const events: OrchestratedOutboundEventEnvelope[] = [];
      bus.subscribe((event) => {
        events.push(event);
      });

      const manager = new AgentManager({
        storage: handle.storage.db,
        ingress: {
          submitMessage: vi.fn(async () => ({ status: "steered" as const })),
          submitApprovalDecision: vi.fn(() => false),
        },
        outboundEventBus: bus,
      });

      manager.submitSubagentCreationRequest({
        sourceSessionId: "sess_main",
        title: "PR Review",
        description: "Review pull requests and summarize findings.",
        initialTask: "Review the current PR and report concrete issues.",
      });
      const request = new SubagentCreationRequestsRepo(handle.storage.db).listBySourceSession(
        "sess_main",
        1,
      )[0];
      if (request == null) {
        throw new Error("Expected a pending subagent request");
      }

      manager.denySubagentCreationRequest({
        requestId: request.id,
        decidedAt: new Date("2026-03-25T00:10:00.000Z"),
        reasonText: "User cancelled",
      });
      await flushMicrotasks();

      const publishedBeforeDuplicate = events.length;
      const resolved = manager.resolveDenySubagentCreationRequest({
        requestId: request.id,
        decidedAt: new Date("2026-03-25T00:11:00.000Z"),
        reasonText: "User cancelled",
      });
      await flushMicrotasks();

      expect(resolved).toMatchObject({
        outcome: "already_denied",
        externalChatId: null,
        shareLink: null,
      });
      expect(events).toHaveLength(publishedBeforeDuplicate + 1);
      const duplicateEvent = events[events.length - 1];
      expect(duplicateEvent).toMatchObject({
        kind: "subagent_creation_event",
        event: {
          type: "subagent_creation_resolved",
          requestId: request.id,
          status: "denied",
          externalChatId: null,
          shareLink: null,
        },
      });
    });
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
            scenario: "task",
            messageType: "task_kickoff",
            visibility: "hidden_system",
          });
          expect(input.content).toContain("<task_execution>");

          expect(input.afterToolResultHook).toBeDefined();
          return createStartedTaskRunResult({
            sessionId: input.sessionId,
            scenario: "task",
            summary: "Reviewed the repository changes.",
            finalMessage: "Reviewed the repository changes.",
          });
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

  test("starts background tasks asynchronously and appends a hidden completion notice", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      const messagesRepo = new MessagesRepo(handle.storage.db);
      const manager = new AgentManager({
        storage: handle.storage.db,
        ingress: {
          submitMessage: vi.fn(
            async (input: SubmitMessageInput): Promise<SubmitMessageResult> =>
              createStartedTaskRunResult({
                sessionId: input.sessionId,
                scenario: "task",
                summary: "Background task finished.",
                finalMessage: "Background task finished.",
              }),
          ),
          submitApprovalDecision: vi.fn(() => false),
        },
      });

      const started = await manager.startBackgroundTask({
        sourceSessionId: "sess_main",
        description: "Run background analysis",
        task: "Analyze runtime logs and summarize issues.",
        contextMode: "isolated",
      });

      expect(started.accepted).toBe(true);

      await waitForCondition(() => {
        const taskRun = manager.getTaskRunLiveState(started.taskRunId)?.taskRun;
        return taskRun?.status === "completed";
      });

      const hiddenNotices = messagesRepo
        .listBySession("sess_main")
        .filter(
          (message) =>
            message.messageType === "background_task_completion" &&
            message.visibility === "hidden_system",
        );
      expect(hiddenNotices).toHaveLength(1);
      expect(JSON.parse(hiddenNotices[0]?.payloadJson ?? "{}")).toEqual({
        content: expect.stringContaining('<system_event type="background_task_completion">'),
      });
      expect(JSON.parse(hiddenNotices[0]?.payloadJson ?? "{}").content).toContain(
        started.taskRunId,
      );
    });
  });

  test("defers hidden completion notice while caller run is active and flushes after run completion", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      const messagesRepo = new MessagesRepo(handle.storage.db);
      const manager = new AgentManager({
        storage: handle.storage.db,
        ingress: {
          submitMessage: vi.fn(
            async (input: SubmitMessageInput): Promise<SubmitMessageResult> =>
              createStartedTaskRunResult({
                sessionId: input.sessionId,
                scenario: "task",
                summary: "Background task finished.",
                finalMessage: "Background task finished.",
              }),
          ),
          submitApprovalDecision: vi.fn(() => false),
        },
      });

      manager.emitRuntimeEvent({
        type: "run_started",
        eventId: "evt_run_started_1",
        createdAt: "2026-03-25T00:00:02.000Z",
        sessionId: "sess_main",
        conversationId: "conv_main",
        branchId: "branch_main",
        runId: "run_main_1",
        scenario: "chat",
        modelId: "test-model",
      });

      const started = await manager.startBackgroundTask({
        sourceSessionId: "sess_main",
        description: "Run background analysis",
        task: "Analyze runtime logs and summarize issues.",
        contextMode: "isolated",
      });

      await waitForCondition(() => {
        const taskRun = manager.getTaskRunLiveState(started.taskRunId)?.taskRun;
        return taskRun?.status === "completed";
      });

      const beforeFlush = messagesRepo
        .listBySession("sess_main")
        .filter((message) => message.messageType === "background_task_completion");
      expect(beforeFlush).toHaveLength(0);

      manager.emitRuntimeEvent({
        type: "run_completed",
        eventId: "evt_run_completed_1",
        createdAt: "2026-03-25T00:00:05.000Z",
        sessionId: "sess_main",
        conversationId: "conv_main",
        branchId: "branch_main",
        runId: "run_main_1",
        scenario: "chat",
        modelId: "test-model",
        appendedMessageIds: [],
        toolExecutions: 0,
        compactionRequested: false,
      });

      const hiddenNotices = messagesRepo
        .listBySession("sess_main")
        .filter((message) => message.messageType === "background_task_completion");
      expect(hiddenNotices).toHaveLength(1);
      expect(JSON.parse(hiddenNotices[0]?.payloadJson ?? "{}").content).toContain(
        started.taskRunId,
      );
    });
  });

  test("suppresses hidden completion notice when requested for a background task run", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      const messagesRepo = new MessagesRepo(handle.storage.db);
      const submitGate = createDeferredPromise<SubmitMessageResult>();
      const manager = new AgentManager({
        storage: handle.storage.db,
        ingress: {
          submitMessage: vi.fn(async (_input: SubmitMessageInput): Promise<SubmitMessageResult> => {
            return submitGate.promise;
          }),
          submitApprovalDecision: vi.fn(() => false),
        },
      });

      const started = await manager.startBackgroundTask({
        sourceSessionId: "sess_main",
        description: "Run background analysis",
        task: "Analyze runtime logs and summarize issues.",
        contextMode: "isolated",
      });
      manager.suppressBackgroundTaskCompletionNotice({
        taskRunId: started.taskRunId,
      });

      submitGate.resolve(
        createStartedTaskRunResult({
          sessionId: "sess_main",
          scenario: "task",
          summary: "Background task finished.",
          finalMessage: "Background task finished.",
        }),
      );
      await waitForCondition(() => {
        const taskRun = manager.getTaskRunLiveState(started.taskRunId)?.taskRun;
        return taskRun?.status === "completed";
      });

      const hiddenNotices = messagesRepo
        .listBySession("sess_main")
        .filter((message) => message.messageType === "background_task_completion");
      expect(hiddenNotices).toHaveLength(0);
    });
  });

  test("suppression removes queued hidden completion notice before caller run completes", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      const messagesRepo = new MessagesRepo(handle.storage.db);
      const manager = new AgentManager({
        storage: handle.storage.db,
        ingress: {
          submitMessage: vi.fn(
            async (input: SubmitMessageInput): Promise<SubmitMessageResult> =>
              createStartedTaskRunResult({
                sessionId: input.sessionId,
                scenario: "task",
                summary: "Background task finished.",
                finalMessage: "Background task finished.",
              }),
          ),
          submitApprovalDecision: vi.fn(() => false),
        },
      });

      manager.emitRuntimeEvent({
        type: "run_started",
        eventId: "evt_run_started_2",
        createdAt: "2026-03-25T00:00:02.000Z",
        sessionId: "sess_main",
        conversationId: "conv_main",
        branchId: "branch_main",
        runId: "run_main_2",
        scenario: "chat",
        modelId: "test-model",
      });

      const started = await manager.startBackgroundTask({
        sourceSessionId: "sess_main",
        description: "Run background analysis",
        task: "Analyze runtime logs and summarize issues.",
        contextMode: "isolated",
      });

      await waitForCondition(() => {
        const taskRun = manager.getTaskRunLiveState(started.taskRunId)?.taskRun;
        return taskRun?.status === "completed";
      });
      manager.suppressBackgroundTaskCompletionNotice({
        taskRunId: started.taskRunId,
      });

      manager.emitRuntimeEvent({
        type: "run_completed",
        eventId: "evt_run_completed_2",
        createdAt: "2026-03-25T00:00:06.000Z",
        sessionId: "sess_main",
        conversationId: "conv_main",
        branchId: "branch_main",
        runId: "run_main_2",
        scenario: "chat",
        modelId: "test-model",
        appendedMessageIds: [],
        toolExecutions: 0,
        compactionRequested: false,
      });

      const hiddenNotices = messagesRepo
        .listBySession("sess_main")
        .filter((message) => message.messageType === "background_task_completion");
      expect(hiddenNotices).toHaveLength(0);
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
      const messagesRepo = new MessagesRepo(handle.storage.db);
      handle.storage.sqlite.exec(`
        INSERT INTO cron_jobs (
          id, owner_agent_id, target_conversation_id, target_branch_id,
          schedule_kind, schedule_value, context_mode, payload_json, created_at, updated_at
        ) VALUES (
          'cron_2', 'agent_sub', 'conv_sub', 'branch_sub',
          'cron', '*/5 * * * *', 'group', '{"job":"reconcile"}',
          '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:00.000Z'
        );
        INSERT INTO sessions (
          id, conversation_id, branch_id, owner_agent_id, purpose, context_mode, status,
          compact_cursor, compact_summary, compact_summary_token_total, compact_summary_usage_json,
          created_at, updated_at
        ) VALUES (
          'sess_sub_chat', 'conv_sub', 'branch_sub', 'agent_sub', 'chat', 'group', 'active',
          1, 'subagent summary', 9, '{"input":5,"output":4,"cacheRead":0,"cacheWrite":0,"totalTokens":9}',
          '2026-03-25T00:00:02.000Z', '2026-03-25T00:00:03.000Z'
        );
      `);
      messagesRepo.append({
        id: "msg_sub_1",
        sessionId: "sess_sub_chat",
        seq: 1,
        role: "user",
        payloadJson: '{"content":"older"}',
        createdAt: new Date("2026-03-25T00:00:02.100Z"),
      });
      messagesRepo.append({
        id: "msg_sub_2",
        sessionId: "sess_sub_chat",
        seq: 2,
        role: "assistant",
        provider: "anthropic_main",
        model: "claude-sonnet-4-5",
        modelApi: "anthropic-messages",
        stopReason: "stop",
        payloadJson: '{"content":[{"type":"text","text":"latest branch context"}]}',
        createdAt: new Date("2026-03-25T00:00:02.200Z"),
      });

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
        forkedFromSessionId: "sess_sub_chat",
        forkSourceSeq: 2,
        compactSummary: "subagent summary",
      });
      expect(created.taskRun).toMatchObject({
        runType: "cron",
        cronJobId: "cron_2",
        attempt: 4,
        ownerAgentId: "agent_sub",
      });
      expect(JSON.parse(created.taskRun.inputJson ?? "{}")).toMatchObject({
        taskDefinition: '{"job":"reconcile"}',
        recentRuns: {
          lastRun: null,
          lastSuccessfulRun: null,
        },
      });

      const context = new AgentSessionService(
        new SessionsRepo(handle.storage.db),
        messagesRepo,
      ).getContext(created.executionSession.id);
      expect(context.compactSummary).toBe("subagent summary");
      expect(context.messages).toHaveLength(1);
      expect(context.messages[0]?.payloadJson).toBe(
        '{"content":[{"type":"text","text":"latest branch context"}]}',
      );
    });
  });

  test("creates isolated cron task executions without forking chat context", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      const messagesRepo = new MessagesRepo(handle.storage.db);
      handle.storage.sqlite.exec(`
        INSERT INTO cron_jobs (
          id, owner_agent_id, target_conversation_id, target_branch_id,
          schedule_kind, schedule_value, context_mode, payload_json, created_at, updated_at
        ) VALUES (
          'cron_isolated', 'agent_sub', 'conv_sub', 'branch_sub',
          'cron', '*/5 * * * *', 'isolated', '{"job":"reconcile"}',
          '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:00.000Z'
        );
        INSERT INTO sessions (
          id, conversation_id, branch_id, owner_agent_id, purpose, context_mode, status,
          compact_cursor, compact_summary, compact_summary_token_total, compact_summary_usage_json,
          created_at, updated_at
        ) VALUES (
          'sess_sub_chat', 'conv_sub', 'branch_sub', 'agent_sub', 'chat', 'group', 'active',
          1, 'subagent summary', 9, '{"input":5,"output":4,"cacheRead":0,"cacheWrite":0,"totalTokens":9}',
          '2026-03-25T00:00:02.000Z', '2026-03-25T00:00:03.000Z'
        );
      `);
      messagesRepo.append({
        id: "msg_sub_1",
        sessionId: "sess_sub_chat",
        seq: 1,
        role: "user",
        payloadJson: '{"content":"older"}',
        createdAt: new Date("2026-03-25T00:00:02.100Z"),
      });
      messagesRepo.append({
        id: "msg_sub_2",
        sessionId: "sess_sub_chat",
        seq: 2,
        role: "assistant",
        provider: "anthropic_main",
        model: "claude-sonnet-4-5",
        modelApi: "anthropic-messages",
        stopReason: "stop",
        payloadJson: '{"content":[{"type":"text","text":"latest branch context"}]}',
        createdAt: new Date("2026-03-25T00:00:02.200Z"),
      });

      const manager = new AgentManager({
        storage: handle.storage.db,
        ingress: {
          submitMessage: vi.fn(async () => ({ status: "steered" as const })),
          submitApprovalDecision: vi.fn(() => false),
        },
      });

      const created = manager.createCronTaskExecutionFromJob({
        cronJobId: "cron_isolated",
        attempt: 1,
        createdAt: new Date("2026-03-25T00:00:10.000Z"),
      });

      expect(created.executionSession).toMatchObject({
        purpose: "task",
        contextMode: "isolated",
        conversationId: "conv_sub",
        branchId: "branch_sub",
        ownerAgentId: "agent_sub",
        forkedFromSessionId: null,
        forkSourceSeq: null,
        compactSummary: null,
      });

      const context = new AgentSessionService(
        new SessionsRepo(handle.storage.db),
        messagesRepo,
      ).getContext(created.executionSession.id);
      expect(context.compactSummary).toBeNull();
      expect(context.messages).toHaveLength(0);
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
            scenario: "task",
            messageType: "cron_kickoff",
            visibility: "hidden_system",
          });
          expect(input.content).toContain("<run_type>cron</run_type>");
          expect(input.content).toContain("If inherited transcript is present");
          expect(input.content).toContain(
            "Do not treat inherited transcript as a request to continue the broader conversation",
          );

          expect(input.afterToolResultHook).toBeDefined();
          return createStartedTaskRunResult({
            sessionId: input.sessionId,
            scenario: "task",
            summary: "Cron reconciliation finished.",
            finalMessage: "Cron reconciliation finished.",
          });
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

  test("injects recent cron run context into new cron task executions", async () => {
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

        INSERT INTO task_runs (
          id, run_type, owner_agent_id, conversation_id, branch_id,
          cron_job_id, execution_session_id, status, result_summary, error_text, started_at, finished_at
        ) VALUES
        (
          'run_success_1', 'cron', 'agent_sub', 'conv_sub', 'branch_sub',
          'cron_2', NULL, 'completed', 'Posted report successfully', NULL,
          '2026-03-24T00:05:00.000Z', '2026-03-24T00:05:10.000Z'
        ),
        (
          'run_failed_1', 'cron', 'agent_sub', 'conv_sub', 'branch_sub',
          'cron_2', NULL, 'failed', NULL, 'Slack API timeout',
          '2026-03-25T00:05:00.000Z', '2026-03-25T00:05:12.000Z'
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
      });

      const input = JSON.parse(created.taskRun.inputJson ?? "{}") as {
        taskDefinition?: string;
        recentRuns?: {
          lastRun?: { status?: string; error?: string | null };
          lastSuccessfulRun?: { status?: string; summary?: string | null };
        };
      };

      expect(input.taskDefinition).toBe("reconcile");
      expect(input.recentRuns?.lastRun).toMatchObject({
        status: "failed",
        error: "Slack API timeout",
      });
      expect(input.recentRuns?.lastSuccessfulRun).toMatchObject({
        status: "completed",
        summary: "Posted report successfully",
      });
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
        async (input: SubmitMessageInput): Promise<SubmitMessageResult> => {
          expect(input.afterToolResultHook).toBeDefined();
          return createStartedTaskRunResult({
            sessionId: input.sessionId,
            scenario: "task",
            summary: "Manual cron run finished.",
            finalMessage: "Manual cron run finished.",
          });
        },
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

  test("publishes runtime and task lifecycle envelopes to the outbound event bus", async () => {
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

      const bus = new RuntimeEventBus<OrchestratedOutboundEventEnvelope>();
      const published: OrchestratedOutboundEventEnvelope[] = [];
      bus.subscribe(async (event) => {
        published.push(event);
      });

      const manager = new AgentManager({
        storage: handle.storage.db,
        ingress: {
          submitMessage: vi.fn(async () => ({ status: "steered" as const })),
          submitApprovalDecision: vi.fn(() => false),
        },
        outboundEventBus: bus,
      });

      const created = manager.createTaskExecution({
        runType: "cron",
        ownerAgentId: "agent_sub",
        conversationId: "conv_sub",
        branchId: "branch_sub",
        cronJobId: "cron_1",
      });
      await flushMicrotasks();

      expect(published[0]).toMatchObject({
        kind: "task_run_event",
        event: {
          type: "task_run_started",
          taskRunId: created.taskRun.id,
        },
        taskRun: {
          taskRunId: created.taskRun.id,
          runType: "cron",
          status: "running",
        },
      });

      manager.completeTaskExecution({
        taskRunId: created.taskRun.id,
        resultSummary: "done",
      });
      await flushMicrotasks();

      expect(published[1]).toMatchObject({
        kind: "task_run_event",
        event: {
          type: "task_run_completed",
          taskRunId: created.taskRun.id,
          resultSummary: "done",
        },
        taskRun: {
          taskRunId: created.taskRun.id,
          status: "completed",
        },
      });

      manager.emitRuntimeEvent({
        type: "assistant_message_delta",
        eventId: "evt_1",
        createdAt: "2026-03-25T00:00:06.000Z",
        sessionId: created.executionSession.id,
        conversationId: "conv_sub",
        branchId: "branch_sub",
        runId: "run_loop_1",
        turn: 1,
        messageId: "msg_1",
        delta: "hello",
        accumulatedText: "hello",
      });
      await flushMicrotasks();

      expect(published[2]).toMatchObject({
        kind: "runtime_event",
        session: {
          sessionId: created.executionSession.id,
          purpose: "task",
        },
        taskRun: {
          taskRunId: created.taskRun.id,
          runType: "cron",
        },
        run: {
          runId: "run_loop_1",
        },
        object: {
          messageId: "msg_1",
        },
        event: {
          type: "assistant_message_delta",
          delta: "hello",
        },
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
      request: {
        scopes: [{ kind: "fs.write", path: "/tmp/demo.txt" }],
      },
      reasonText: "Need permission.",
      expiresAt: null,
    });

    expect(result).toBeNull();
    expect(submitMessage).not.toHaveBeenCalled();
  });
});
