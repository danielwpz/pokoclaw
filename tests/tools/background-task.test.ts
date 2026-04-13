import { afterEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { createBackgroundTaskTool } from "@/src/tools/background-task.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

describe("background_task tool", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  function seedFixture() {
    if (handle == null) {
      throw new Error("test database handle is missing");
    }

    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_1', 'lark', 'acct_a', '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES
        ('conv_main', 'ci_1', 'chat_main', 'dm', '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'),
        ('conv_sub', 'ci_1', 'chat_sub', 'group', '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES
        ('branch_main', 'conv_main', 'dm_main', 'main', '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'),
        ('branch_sub', 'conv_sub', 'group_main', 'main', '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z');

      INSERT INTO agents (id, conversation_id, main_agent_id, kind, created_at)
      VALUES
        ('agent_main', 'conv_main', NULL, 'main', '2026-04-01T00:00:00.000Z'),
        ('agent_sub', 'conv_sub', 'agent_main', 'sub', '2026-04-01T00:00:00.000Z');

      INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, created_at, updated_at)
      VALUES
        ('sess_main', 'conv_main', 'branch_main', 'agent_main', 'chat', '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'),
        ('sess_sub_chat', 'conv_sub', 'branch_sub', 'agent_sub', 'chat', '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'),
        ('sess_sub_task', 'conv_sub', 'branch_sub', 'agent_sub', 'task', '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z');
    `);
  }

  test("starts a background task via runtime control", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture();
    const registry = new ToolRegistry([createBackgroundTaskTool()]);
    const startBackgroundTask = vi.fn(async () => ({
      accepted: true,
      taskRunId: "task_bg_1",
    }));

    const result = await registry.execute(
      "background_task",
      {
        sessionId: "sess_sub_chat",
        conversationId: "conv_sub",
        ownerAgentId: "agent_sub",
        agentKind: "sub",
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
        runtimeControl: {
          submitApprovalDecision: vi.fn(),
          startBackgroundTask,
        },
      },
      {
        description: "Run long repository scan",
        task: "Scan repo and summarize architecture risks.",
        contextMode: "isolated",
      },
    );

    expect(startBackgroundTask).toHaveBeenCalledExactlyOnceWith({
      sourceSessionId: "sess_sub_chat",
      description: "Run long repository scan",
      task: "Scan repo and summarize architecture risks.",
      contextMode: "isolated",
    });
    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("Task run id: task_bg_1"),
    });
  });

  test("rejects calls from non-chat sessions", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture();
    const registry = new ToolRegistry([createBackgroundTaskTool()]);

    await expect(
      registry.execute(
        "background_task",
        {
          sessionId: "sess_sub_task",
          conversationId: "conv_sub",
          ownerAgentId: "agent_sub",
          agentKind: "sub",
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
          runtimeControl: {
            submitApprovalDecision: vi.fn(),
            startBackgroundTask: vi.fn(),
          },
        },
        {
          description: "Invalid",
          task: "Should fail.",
        },
      ),
    ).rejects.toThrow("background_task is only available in chat sessions.");
  });
});
