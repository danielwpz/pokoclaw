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

  test("allows background_task only in main or sub chat sessions", () => {
    expect(
      isToolAllowedForSession({
        purpose: "chat",
        agentKind: "main",
        toolName: "background_task",
      }),
    ).toBe(true);

    expect(
      isToolAllowedForSession({
        purpose: "chat",
        agentKind: "sub",
        toolName: "background_task",
      }),
    ).toBe(true);

    expect(
      isToolAllowedForSession({
        purpose: "task",
        agentKind: "sub",
        toolName: "background_task",
      }),
    ).toBe(false);
  });

  test("allows wait_task only in sub chat sessions", () => {
    expect(
      isToolAllowedForSession({
        purpose: "chat",
        agentKind: "sub",
        toolName: "wait_task",
      }),
    ).toBe(true);

    expect(
      isToolAllowedForSession({
        purpose: "chat",
        agentKind: "main",
        toolName: "wait_task",
      }),
    ).toBe(false);

    expect(
      isToolAllowedForSession({
        purpose: "task",
        agentKind: "sub",
        toolName: "wait_task",
      }),
    ).toBe(false);
  });

  test("allows list_background_tasks only in main or sub chat sessions", () => {
    expect(
      isToolAllowedForSession({
        purpose: "chat",
        agentKind: "main",
        toolName: "list_background_tasks",
      }),
    ).toBe(true);

    expect(
      isToolAllowedForSession({
        purpose: "chat",
        agentKind: "sub",
        toolName: "list_background_tasks",
      }),
    ).toBe(true);

    expect(
      isToolAllowedForSession({
        purpose: "task",
        agentKind: "sub",
        toolName: "list_background_tasks",
      }),
    ).toBe(false);
  });
});
