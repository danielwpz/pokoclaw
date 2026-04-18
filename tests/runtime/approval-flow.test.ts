import { describe, expect, test } from "vitest";

import {
  isExplicitUserApprovalDecision,
  isUserApprovalTimeoutOutcome,
  SessionApprovalFlowRegistry,
} from "@/src/runtime/approval-flow.js";
import type { ResolvedApprovalRoute } from "@/src/runtime/approval-routing.js";

const TASK_ROUTE: ResolvedApprovalRoute = {
  target: "main_agent",
  runtimeKind: "delegate_run",
  ownerRole: "subagent",
  taskRunId: "run_task",
};

const USER_ROUTE: ResolvedApprovalRoute = {
  target: "user",
  runtimeKind: "main_chat",
  ownerRole: "main",
  taskRunId: null,
};

describe("session approval flow registry", () => {
  test("uses user-first delegated fallback before the timeout threshold", () => {
    const registry = new SessionApprovalFlowRegistry();

    expect(
      registry.resolvePlan({
        sessionId: "sess_task",
        route: TASK_ROUTE,
      }),
    ).toMatchObject({
      strategy: "user_then_delegate",
      initialTarget: "user",
      fallbackTarget: "main_agent",
      consecutiveUserTimeouts: 0,
    });

    registry.recordUserTimeout("sess_task");

    expect(
      registry.resolvePlan({
        sessionId: "sess_task",
        route: TASK_ROUTE,
      }),
    ).toMatchObject({
      strategy: "user_then_delegate",
      initialTarget: "user",
      fallbackTarget: "main_agent",
      consecutiveUserTimeouts: 1,
    });
  });

  test("switches task sessions to delegated approval after two consecutive user timeouts", () => {
    const registry = new SessionApprovalFlowRegistry();

    registry.recordUserTimeout("sess_task");
    registry.recordUserTimeout("sess_task");

    expect(
      registry.resolvePlan({
        sessionId: "sess_task",
        route: TASK_ROUTE,
      }),
    ).toMatchObject({
      strategy: "direct_delegate",
      initialTarget: "main_agent",
      fallbackTarget: null,
      consecutiveUserTimeouts: 2,
    });
  });

  test("tracks timeout streaks independently per task session", () => {
    const registry = new SessionApprovalFlowRegistry();

    registry.recordUserTimeout("sess_task_a");
    registry.recordUserTimeout("sess_task_a");
    registry.recordUserTimeout("sess_task_b");

    expect(
      registry.resolvePlan({
        sessionId: "sess_task_a",
        route: TASK_ROUTE,
      }).strategy,
    ).toBe("direct_delegate");
    expect(
      registry.resolvePlan({
        sessionId: "sess_task_b",
        route: TASK_ROUTE,
      }).strategy,
    ).toBe("user_then_delegate");
  });

  test("resets the timeout streak after an explicit user approval decision", () => {
    const registry = new SessionApprovalFlowRegistry();

    registry.recordUserTimeout("sess_task");
    registry.recordUserTimeout("sess_task");
    registry.resetUserTimeouts("sess_task");

    expect(
      registry.resolvePlan({
        sessionId: "sess_task",
        route: TASK_ROUTE,
      }),
    ).toMatchObject({
      strategy: "user_then_delegate",
      consecutiveUserTimeouts: 0,
    });
  });

  test("keeps ordinary user-routed sessions on direct user approval", () => {
    const registry = new SessionApprovalFlowRegistry();
    registry.recordUserTimeout("sess_chat");
    registry.recordUserTimeout("sess_chat");

    expect(
      registry.resolvePlan({
        sessionId: "sess_chat",
        route: USER_ROUTE,
      }),
    ).toMatchObject({
      strategy: "direct_user",
      initialTarget: "user",
      fallbackTarget: null,
      consecutiveUserTimeouts: 2,
    });
  });
});

describe("approval outcome classification", () => {
  test("detects user approval timeouts", () => {
    expect(
      isUserApprovalTimeoutOutcome({
        actor: "system:timeout",
        rawInput: null,
        grantedBy: null,
      }),
    ).toBe(true);
    expect(
      isUserApprovalTimeoutOutcome({
        actor: "lark:default:user_1",
        rawInput: "deny",
        grantedBy: null,
      }),
    ).toBe(false);
  });

  test("detects explicit user approval decisions without matching delegated actors", () => {
    expect(
      isExplicitUserApprovalDecision({
        actor: "lark:default:user_1",
        rawInput: "deny",
        grantedBy: null,
      }),
    ).toBe(true);
    expect(
      isExplicitUserApprovalDecision({
        actor: "main_agent:agent_main",
        rawInput: "approve",
        grantedBy: "main_agent",
      }),
    ).toBe(false);
    expect(
      isExplicitUserApprovalDecision({
        actor: "user:intervention",
        rawInput: null,
        grantedBy: null,
      }),
    ).toBe(false);
  });
});
