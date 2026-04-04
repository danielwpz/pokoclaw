import { describe, expect, test } from "vitest";

import { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";
import { RuntimeControlService } from "@/src/runtime/control.js";

describe("RuntimeControlService", () => {
  test("stops a specific active run", () => {
    const cancel = new SessionRunAbortRegistry();
    const control = new RuntimeControlService(cancel);
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
    });

    expect(result).toEqual({
      accepted: true,
      runId: "run_1",
      sessionId: "sess_1",
      conversationId: "conv_1",
    });
    expect(handle.signal.aborted).toBe(true);
    expect(cancel.isActive("sess_1")).toBe(false);
  });

  test("stops all active runs for a conversation", () => {
    const cancel = new SessionRunAbortRegistry();
    const control = new RuntimeControlService(cancel);
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
  });

  test("releases finished runs so stop ignores them", () => {
    const cancel = new SessionRunAbortRegistry();
    const control = new RuntimeControlService(cancel);
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
    });

    expect(result).toEqual({
      accepted: false,
      runId: "run_1",
      sessionId: null,
      conversationId: null,
    });
  });

  test("stops only runs for the requested session", () => {
    const cancel = new SessionRunAbortRegistry();
    const control = new RuntimeControlService(cancel);
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
