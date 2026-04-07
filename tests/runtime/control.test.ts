import { describe, expect, test } from "vitest";
import { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";
import { RuntimeControlService } from "@/src/runtime/control.js";
import { HarnessEventsRepo } from "@/src/storage/repos/harness-events.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { TaskRunsRepo } from "@/src/storage/repos/task-runs.repo.js";
import { createTestDatabase, destroyTestDatabase } from "@/tests/storage/helpers/test-db.js";

async function withStorageFixture<T>(
  run: (deps: {
    cancel: SessionRunAbortRegistry;
    control: RuntimeControlService;
    harnessEvents: HarnessEventsRepo;
    taskRuns: TaskRunsRepo;
  }) => T | Promise<T>,
): Promise<T> {
  const handle = await createTestDatabase(import.meta.url);
  try {
    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_1', 'lark', 'acct_a', '2026-04-05T00:00:00.000Z', '2026-04-05T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES ('conv_1', 'ci_1', 'chat_1', 'dm', '2026-04-05T00:00:00.000Z', '2026-04-05T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-04-05T00:00:00.000Z', '2026-04-05T00:00:00.000Z');

      INSERT INTO agents (id, conversation_id, kind, created_at)
      VALUES ('agent_1', 'conv_1', 'main', '2026-04-05T00:00:00.000Z');

      INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at)
      VALUES ('sess_1', 'conv_1', 'branch_1', 'agent_1', 'chat', 'active', '2026-04-05T00:00:00.000Z', '2026-04-05T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_2', 'conv_1', 'dm_thread', 'thread:2', '2026-04-05T00:00:00.000Z', '2026-04-05T00:00:00.000Z');
      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES ('conv_2', 'ci_1', 'chat_2', 'dm', '2026-04-05T00:00:00.000Z', '2026-04-05T00:00:00.000Z');
      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_3', 'conv_2', 'dm_main', 'main', '2026-04-05T00:00:00.000Z', '2026-04-05T00:00:00.000Z');
      INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at)
      VALUES ('sess_2', 'conv_1', 'branch_2', 'agent_1', 'chat', 'active', '2026-04-05T00:00:00.000Z', '2026-04-05T00:00:00.000Z');
      INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at)
      VALUES ('sess_3', 'conv_2', 'branch_3', 'agent_1', 'chat', 'active', '2026-04-05T00:00:00.000Z', '2026-04-05T00:00:00.000Z');

      INSERT INTO cron_jobs (id, owner_agent_id, target_conversation_id, target_branch_id, schedule_kind, schedule_value, payload_json, created_at, updated_at)
      VALUES ('cron_1', 'agent_1', 'conv_1', 'branch_1', 'cron', '0 * * * *', '{}', '2026-04-05T00:00:00.000Z', '2026-04-05T00:00:00.000Z');
    `);

    const cancel = new SessionRunAbortRegistry();
    const harnessEvents = new HarnessEventsRepo(handle.storage.db);
    const taskRuns = new TaskRunsRepo(handle.storage.db);
    const control = new RuntimeControlService(cancel, {
      harnessEvents,
      sessions: new SessionsRepo(handle.storage.db),
      taskRuns,
    });
    return await run({ cancel, control, harnessEvents, taskRuns });
  } finally {
    await destroyTestDatabase(handle);
  }
}

describe("RuntimeControlService", () => {
  test("stops a specific active run", async () => {
    await withStorageFixture(async ({ cancel, control, harnessEvents }) => {
      const handle = cancel.begin("sess_1");

      control.beginRun({
        runId: "run_1",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        scenario: "chat",
      });

      const result = control.stopRun({
        runId: "run_1",
        actor: "test",
        sourceKind: "button",
        requestScope: "run",
      });

      expect(result).toEqual({
        accepted: true,
        runId: "run_1",
        sessionId: "sess_1",
        conversationId: "conv_1",
      });
      expect(handle.signal.aborted).toBe(true);
      expect(cancel.isActive("sess_1")).toBe(false);
      expect(harnessEvents.listByRunId("run_1")).toMatchObject([
        {
          eventType: "user_stop",
          runId: "run_1",
          sessionId: "sess_1",
          conversationId: "conv_1",
          branchId: "branch_1",
          actor: "test",
          sourceKind: "button",
          requestScope: "run",
        },
      ]);
    });
  });

  test("stops all active runs for a conversation", async () => {
    await withStorageFixture(async ({ cancel, control, harnessEvents }) => {
      const handle1 = cancel.begin("sess_1");
      const handle2 = cancel.begin("sess_2");
      const handle3 = cancel.begin("sess_3");

      control.beginRun({
        runId: "run_1",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        scenario: "chat",
      });
      control.beginRun({
        runId: "run_2",
        sessionId: "sess_2",
        conversationId: "conv_1",
        branchId: "branch_1",
        scenario: "chat",
      });
      control.beginRun({
        runId: "run_3",
        sessionId: "sess_3",
        conversationId: "conv_2",
        branchId: "branch_2",
        scenario: "chat",
      });

      const result = control.stopConversation({
        conversationId: "conv_1",
        actor: "test",
        sourceKind: "command",
        requestScope: "conversation",
      });

      expect(result).toEqual({
        acceptedCount: 2,
        conversationId: "conv_1",
        runIds: ["run_1", "run_2"],
        sessionIds: ["sess_1", "sess_2"],
      });
      expect(handle1.signal.aborted).toBe(true);
      expect(handle2.signal.aborted).toBe(true);
      expect(handle3.signal.aborted).toBe(false);
      expect(cancel.isActive("sess_1")).toBe(false);
      expect(cancel.isActive("sess_2")).toBe(false);
      expect(cancel.isActive("sess_3")).toBe(true);
      expect(harnessEvents.listByRunId("run_1")[0]).toMatchObject({
        sourceKind: "command",
        requestScope: "conversation",
      });
      expect(harnessEvents.listByRunId("run_2")[0]).toMatchObject({
        sourceKind: "command",
        requestScope: "conversation",
      });
      expect(harnessEvents.listByRunId("run_3")).toEqual([]);
    });
  });

  test("releases finished runs so stop ignores them", async () => {
    await withStorageFixture(async ({ cancel, control, harnessEvents }) => {
      cancel.begin("sess_1");

      control.beginRun({
        runId: "run_1",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        scenario: "chat",
      });
      control.finishRun("run_1");

      const result = control.stopRun({
        runId: "run_1",
        actor: "test",
        sourceKind: "button",
        requestScope: "run",
      });

      expect(result).toEqual({
        accepted: false,
        runId: "run_1",
        sessionId: null,
        conversationId: null,
      });
      expect(harnessEvents.listByRunId("run_1")).toEqual([]);
    });
  });

  test("stops only runs for the requested session", async () => {
    await withStorageFixture(async ({ cancel, control, harnessEvents }) => {
      const handle1 = cancel.begin("sess_1");
      const handle2 = cancel.begin("sess_2");

      control.beginRun({
        runId: "run_1",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        scenario: "chat",
      });
      control.beginRun({
        runId: "run_2",
        sessionId: "sess_2",
        conversationId: "conv_1",
        branchId: "branch_2",
        scenario: "chat",
      });

      const result = control.stopSession({
        sessionId: "sess_2",
        actor: "test",
        sourceKind: "command",
        requestScope: "session",
      });

      expect(result).toEqual({
        accepted: true,
        sessionId: "sess_2",
        runIds: ["run_2"],
        conversationId: "conv_1",
      });
      expect(handle1.signal.aborted).toBe(false);
      expect(handle2.signal.aborted).toBe(true);
      expect(cancel.isActive("sess_1")).toBe(true);
      expect(cancel.isActive("sess_2")).toBe(false);
      expect(harnessEvents.listByRunId("run_1")).toEqual([]);
      expect(harnessEvents.listByRunId("run_2")[0]).toMatchObject({
        sourceKind: "command",
        requestScope: "session",
      });
    });
  });

  test("records task and cron context on explicit stop events", async () => {
    await withStorageFixture(async ({ cancel, control, harnessEvents, taskRuns }) => {
      taskRuns.create({
        id: "task_1",
        runType: "cron",
        ownerAgentId: "agent_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        cronJobId: "cron_1",
        executionSessionId: "sess_1",
        status: "running",
        startedAt: new Date("2026-04-05T00:00:01.000Z"),
      });

      const handle = cancel.begin("sess_1");
      control.beginRun({
        runId: "run_1",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        scenario: "cron",
      });

      control.stopRun({
        runId: "run_1",
        actor: "test",
        sourceKind: "button",
        requestScope: "run",
      });

      expect(handle.signal.aborted).toBe(true);
      expect(harnessEvents.listByRunId("run_1")[0]).toMatchObject({
        agentId: "agent_1",
        taskRunId: "task_1",
        cronJobId: "cron_1",
      });
    });
  });
  test("tracks request-level TTFT without resetting run-level timing", () => {
    const control = new RuntimeControlService(new SessionRunAbortRegistry());
    control.beginRun({
      runId: "run_1",
      sessionId: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      scenario: "chat",
    });

    control.markLlmRequestStarted({
      runId: "run_1",
      assistantMessageId: "msg_1",
      at: new Date("2026-04-04T00:00:00.000Z"),
    });
    control.recordStreamDelta({
      runId: "run_1",
      kind: "reasoning",
      at: new Date("2026-04-04T00:00:01.000Z"),
    });
    control.recordStreamDelta({
      runId: "run_1",
      kind: "text",
      deltaText: "hello world",
      at: new Date("2026-04-04T00:00:03.000Z"),
    });
    control.setFinalOutputTokens({
      runId: "run_1",
      outputTokens: 12,
    });

    let snapshot = control.getRunObservability("run_1", new Date("2026-04-04T00:00:05.000Z"));

    expect(snapshot).toMatchObject({
      runId: "run_1",
      phase: "running",
      runStartedAt: "2026-04-04T00:00:00.000Z",
      timeSinceStartMs: 5000,
      latestRequest: {
        sequence: 1,
        status: "streaming",
        startedAt: "2026-04-04T00:00:00.000Z",
        firstTokenAt: "2026-04-04T00:00:01.000Z",
        lastTokenAt: "2026-04-04T00:00:03.000Z",
        ttftMs: 1000,
        timeSinceLastTokenMs: 2000,
        outputChars: 11,
        estimatedOutputTokens: 3,
        finalOutputTokens: 12,
        activeAssistantMessageId: "msg_1",
      },
      responseSummary: {
        requestCount: 1,
        respondedRequestCount: 1,
        hasAnyResponse: true,
        lastRespondedRequestSequence: 1,
        lastRespondedRequestTtftMs: 1000,
        firstResponseAt: "2026-04-04T00:00:01.000Z",
        lastResponseAt: "2026-04-04T00:00:03.000Z",
      },
    });
    expect(snapshot?.latestRequest?.avgCharsPerSecond).toBeCloseTo(5.5, 5);

    control.markToolStarted({
      runId: "run_1",
      toolCallId: "tool_1",
      toolName: "grep",
    });
    control.markToolFinished({
      runId: "run_1",
      toolCallId: "tool_1",
    });
    control.markLlmRequestStarted({
      runId: "run_1",
      assistantMessageId: "msg_2",
      at: new Date("2026-04-04T00:00:10.000Z"),
    });

    snapshot = control.getRunObservability("run_1", new Date("2026-04-04T00:00:12.000Z"));
    expect(snapshot).toMatchObject({
      phase: "running",
      runStartedAt: "2026-04-04T00:00:00.000Z",
      timeSinceStartMs: 12000,
      latestRequest: {
        sequence: 2,
        status: "waiting_first_token",
        startedAt: "2026-04-04T00:00:10.000Z",
        firstTokenAt: null,
        lastTokenAt: null,
        ttftMs: null,
        timeSinceLastTokenMs: null,
        outputChars: 0,
        estimatedOutputTokens: 0,
        finalOutputTokens: null,
        activeAssistantMessageId: "msg_2",
      },
      responseSummary: {
        requestCount: 2,
        respondedRequestCount: 1,
        hasAnyResponse: true,
        lastRespondedRequestSequence: 1,
        lastRespondedRequestTtftMs: 1000,
        firstResponseAt: "2026-04-04T00:00:01.000Z",
        lastResponseAt: "2026-04-04T00:00:03.000Z",
      },
    });

    control.recordStreamDelta({
      runId: "run_1",
      kind: "text",
      deltaText: "done",
      at: new Date("2026-04-04T00:00:14.000Z"),
    });
    snapshot = control.getRunObservability("run_1", new Date("2026-04-04T00:00:15.000Z"));
    expect(snapshot).toMatchObject({
      runStartedAt: "2026-04-04T00:00:00.000Z",
      timeSinceStartMs: 15000,
      latestRequest: {
        sequence: 2,
        status: "streaming",
        startedAt: "2026-04-04T00:00:10.000Z",
        firstTokenAt: "2026-04-04T00:00:14.000Z",
        lastTokenAt: "2026-04-04T00:00:14.000Z",
        ttftMs: 4000,
        timeSinceLastTokenMs: 1000,
        outputChars: 4,
        estimatedOutputTokens: 1,
      },
      responseSummary: {
        requestCount: 2,
        respondedRequestCount: 2,
        hasAnyResponse: true,
        lastRespondedRequestSequence: 2,
        lastRespondedRequestTtftMs: 4000,
        firstResponseAt: "2026-04-04T00:00:01.000Z",
        lastResponseAt: "2026-04-04T00:00:14.000Z",
      },
    });
  });

  test("tracks tool and approval phases separately from streaming", () => {
    const control = new RuntimeControlService(new SessionRunAbortRegistry());
    control.beginRun({
      runId: "run_1",
      sessionId: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      scenario: "chat",
    });

    control.markLlmRequestStarted({
      runId: "run_1",
      assistantMessageId: "msg_1",
      at: new Date("2026-04-04T00:00:00.000Z"),
    });
    control.markToolStarted({
      runId: "run_1",
      toolCallId: "tool_1",
      toolName: "grep",
    });
    expect(control.getRunObservability("run_1")).toMatchObject({
      phase: "tool_running",
      activeToolName: "grep",
      latestRequest: {
        status: "finished",
      },
    });

    control.markWaitingApproval({
      runId: "run_1",
      approvalId: "42",
    });
    expect(control.getRunObservability("run_1")).toMatchObject({
      phase: "waiting_approval",
      waitingApprovalId: "42",
      latestRequest: {
        status: "finished",
      },
    });

    control.recordStreamDelta({
      runId: "run_1",
      kind: "text",
      deltaText: "late token",
      at: new Date("2026-04-04T00:00:01.000Z"),
    });
    expect(control.getRunObservability("run_1")).toMatchObject({
      phase: "waiting_approval",
      waitingApprovalId: "42",
      latestRequest: {
        status: "finished",
        outputChars: 0,
      },
    });

    control.clearWaitingApproval("run_1");
    control.markToolStarted({
      runId: "run_1",
      toolCallId: "tool_1",
      toolName: "grep",
    });
    control.markToolFinished({
      runId: "run_1",
      toolCallId: "tool_1",
    });

    const snapshot = control.getRunObservability("run_1");
    expect(snapshot?.phase).toBe("running");
    expect(snapshot?.waitingApprovalId).toBeNull();
    expect(snapshot?.activeToolName).toBeNull();
    expect(snapshot?.latestRequest?.status).toBe("finished");
  });

  test("clearWaitingApproval does not overwrite a terminal phase", () => {
    const control = new RuntimeControlService(new SessionRunAbortRegistry());
    control.beginRun({
      runId: "run_1",
      sessionId: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      scenario: "chat",
    });
    control.markLlmRequestStarted({
      runId: "run_1",
      assistantMessageId: "msg_1",
      at: new Date("2026-04-04T00:00:00.000Z"),
    });
    control.markWaitingApproval({
      runId: "run_1",
      approvalId: "42",
    });
    control.markCancelled({
      runId: "run_1",
      at: new Date("2026-04-04T00:00:01.000Z"),
    });

    control.clearWaitingApproval("run_1");

    expect(control.getRunObservability("run_1")).toMatchObject({
      phase: "cancelled",
      waitingApprovalId: null,
      latestRequest: {
        status: "finished",
      },
    });
  });

  test("preserves a finished latestRequest when the run later fails during tool execution", () => {
    const control = new RuntimeControlService(new SessionRunAbortRegistry());
    control.beginRun({
      runId: "run_1",
      sessionId: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      scenario: "chat",
    });
    control.markLlmRequestStarted({
      runId: "run_1",
      assistantMessageId: "msg_1",
      at: new Date("2026-04-04T00:00:00.000Z"),
    });
    control.recordStreamDelta({
      runId: "run_1",
      kind: "text",
      deltaText: "hello",
      at: new Date("2026-04-04T00:00:02.000Z"),
    });
    control.markToolStarted({
      runId: "run_1",
      toolCallId: "tool_1",
      toolName: "grep",
      at: new Date("2026-04-04T00:00:03.000Z"),
    });
    control.markFailed({
      runId: "run_1",
      at: new Date("2026-04-04T00:00:04.000Z"),
    });

    expect(
      control.getRunObservability("run_1", new Date("2026-04-04T00:00:05.000Z")),
    ).toMatchObject({
      phase: "failed",
      latestRequest: {
        sequence: 1,
        status: "finished",
        finishedAt: "2026-04-04T00:00:03.000Z",
        ttftMs: 2000,
      },
    });
  });

  test("preserves a finished latestRequest when the run is later cancelled during tool execution", () => {
    const control = new RuntimeControlService(new SessionRunAbortRegistry());
    control.beginRun({
      runId: "run_1",
      sessionId: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      scenario: "chat",
    });
    control.markLlmRequestStarted({
      runId: "run_1",
      assistantMessageId: "msg_1",
      at: new Date("2026-04-04T00:00:00.000Z"),
    });
    control.recordStreamDelta({
      runId: "run_1",
      kind: "text",
      deltaText: "hello",
      at: new Date("2026-04-04T00:00:02.000Z"),
    });
    control.markToolStarted({
      runId: "run_1",
      toolCallId: "tool_1",
      toolName: "grep",
      at: new Date("2026-04-04T00:00:03.000Z"),
    });
    control.markCancelled({
      runId: "run_1",
      at: new Date("2026-04-04T00:00:04.000Z"),
    });

    expect(
      control.getRunObservability("run_1", new Date("2026-04-04T00:00:05.000Z")),
    ).toMatchObject({
      phase: "cancelled",
      latestRequest: {
        sequence: 1,
        status: "finished",
        finishedAt: "2026-04-04T00:00:03.000Z",
        ttftMs: 2000,
      },
    });
  });

  test("keeps finished run observability for direct lookup but removes it from active listings", () => {
    const control = new RuntimeControlService(new SessionRunAbortRegistry());
    control.beginRun({
      runId: "run_1",
      sessionId: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      scenario: "chat",
    });
    control.markLlmRequestStarted({
      runId: "run_1",
      assistantMessageId: "msg_1",
      at: new Date("2026-04-04T00:00:00.000Z"),
    });
    control.recordStreamDelta({
      runId: "run_1",
      kind: "text",
      deltaText: "hello",
      at: new Date("2026-04-04T00:00:02.000Z"),
    });
    control.markCompleted({
      runId: "run_1",
      at: new Date("2026-04-04T00:00:10.000Z"),
    });
    control.finishRun("run_1");

    expect(control.listActiveRunObservability(new Date("2026-04-04T00:00:12.000Z"))).toEqual([]);
    expect(
      control.getRunObservability("run_1", new Date("2026-04-04T00:00:12.000Z")),
    ).toMatchObject({
      runId: "run_1",
      phase: "completed",
      runStartedAt: "2026-04-04T00:00:00.000Z",
      latestRequest: {
        sequence: 1,
        status: "finished",
        startedAt: "2026-04-04T00:00:00.000Z",
        firstTokenAt: "2026-04-04T00:00:02.000Z",
        lastTokenAt: "2026-04-04T00:00:02.000Z",
        ttftMs: 2000,
      },
      responseSummary: {
        requestCount: 1,
        respondedRequestCount: 1,
        hasAnyResponse: true,
        lastRespondedRequestSequence: 1,
        lastRespondedRequestTtftMs: 2000,
        firstResponseAt: "2026-04-04T00:00:02.000Z",
        lastResponseAt: "2026-04-04T00:00:02.000Z",
      },
    });
  });
});
