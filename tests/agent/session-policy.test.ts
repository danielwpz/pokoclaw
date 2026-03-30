import { describe, expect, test } from "vitest";

import { isToolAllowedForSession } from "@/src/agent/session-policy.js";

describe("session policy", () => {
  test("allows schedule_task only in main or sub chat sessions", () => {
    expect(
      isToolAllowedForSession({
        purpose: "chat",
        agentKind: "main",
        toolName: "schedule_task",
      }),
    ).toBe(true);

    expect(
      isToolAllowedForSession({
        purpose: "chat",
        agentKind: "sub",
        toolName: "schedule_task",
      }),
    ).toBe(true);

    expect(
      isToolAllowedForSession({
        purpose: "task",
        agentKind: "sub",
        toolName: "schedule_task",
      }),
    ).toBe(false);

    expect(
      isToolAllowedForSession({
        purpose: "approval",
        agentKind: "main",
        toolName: "schedule_task",
      }),
    ).toBe(false);
  });
});
