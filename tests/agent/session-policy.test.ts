import { describe, expect, test } from "vitest";

import { isToolAllowedForSession } from "@/src/agent/session-policy.js";

describe("session policy", () => {
  test("allows get_runtime_status only in main chat sessions", () => {
    expect(
      isToolAllowedForSession({
        purpose: "chat",
        agentKind: "main",
        toolName: "get_runtime_status",
      }),
    ).toBe(true);

    expect(
      isToolAllowedForSession({
        purpose: "chat",
        agentKind: "sub",
        toolName: "get_runtime_status",
      }),
    ).toBe(false);

    expect(
      isToolAllowedForSession({
        purpose: "task",
        agentKind: "main",
        toolName: "get_runtime_status",
      }),
    ).toBe(false);
  });

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

  test("allows process only in main or sub chat sessions", () => {
    expect(
      isToolAllowedForSession({ purpose: "chat", agentKind: "main", toolName: "process" }),
    ).toBe(true);
    expect(
      isToolAllowedForSession({ purpose: "chat", agentKind: "sub", toolName: "process" }),
    ).toBe(true);
    expect(
      isToolAllowedForSession({ purpose: "task", agentKind: "sub", toolName: "process" }),
    ).toBe(false);
    expect(
      isToolAllowedForSession({ purpose: "approval", agentKind: "main", toolName: "process" }),
    ).toBe(false);
  });

  test("limits context handoff sessions to continuity tools", () => {
    for (const toolName of [
      "read",
      "write",
      "edit",
      "ls",
      "list_dir",
      "grep",
      "query_system_db",
      "submit_context_handoff",
    ]) {
      expect(
        isToolAllowedForSession({ purpose: "context_handoff", agentKind: "sub", toolName }),
      ).toBe(true);
    }
    for (const toolName of ["bash", "background_task", "schedule_task", "send_attachment"]) {
      expect(
        isToolAllowedForSession({ purpose: "context_handoff", agentKind: "sub", toolName }),
      ).toBe(false);
    }
    expect(
      isToolAllowedForSession({
        purpose: "chat",
        agentKind: "main",
        toolName: "submit_context_handoff",
      }),
    ).toBe(false);
  });
});
