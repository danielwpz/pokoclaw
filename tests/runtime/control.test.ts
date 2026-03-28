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
});
