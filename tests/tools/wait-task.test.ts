import { afterEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import { createWaitTaskTool } from "@/src/tools/wait-task.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

describe("wait_task tool", () => {
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
      VALUES ('ci_1', 'lark', 'acct_a', '2026-04-02T00:00:00.000Z', '2026-04-02T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES
        ('conv_main', 'ci_1', 'chat_main', 'dm', '2026-04-02T00:00:00.000Z', '2026-04-02T00:00:00.000Z'),
        ('conv_sub', 'ci_1', 'chat_sub', 'group', '2026-04-02T00:00:00.000Z', '2026-04-02T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES
        ('branch_main', 'conv_main', 'dm_main', 'main', '2026-04-02T00:00:00.000Z', '2026-04-02T00:00:00.000Z'),
        ('branch_sub', 'conv_sub', 'group_main', 'main', '2026-04-02T00:00:00.000Z', '2026-04-02T00:00:00.000Z');

      INSERT INTO agents (id, conversation_id, main_agent_id, kind, created_at)
      VALUES
        ('agent_main', 'conv_main', NULL, 'main', '2026-04-02T00:00:00.000Z'),
        ('agent_sub', 'conv_sub', 'agent_main', 'sub', '2026-04-02T00:00:00.000Z');

      INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, created_at, updated_at)
      VALUES
        ('sess_main', 'conv_main', 'branch_main', 'agent_main', 'chat', '2026-04-02T00:00:00.000Z', '2026-04-02T00:00:00.000Z'),
        ('sess_sub', 'conv_sub', 'branch_sub', 'agent_sub', 'chat', '2026-04-02T00:00:00.000Z', '2026-04-02T00:00:00.000Z');

      INSERT INTO task_runs (
        id, run_type, owner_agent_id, conversation_id, branch_id,
        initiator_session_id, execution_session_id, status, result_summary,
        started_at, finished_at, duration_ms
      ) VALUES (
        'task_done_1', 'delegate', 'agent_sub', 'conv_sub', 'branch_sub',
        'sess_sub', NULL, 'completed', 'Background scan done.',
        '2026-04-02T00:05:00.000Z', '2026-04-02T00:06:30.000Z', 90000
      );
    `);
  }

  test("returns terminal task status and suppresses completion notice", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture();
    const suppressBackgroundTaskCompletionNotice = vi.fn();
    const registry = new ToolRegistry([createWaitTaskTool()]);

    const result = await registry.execute(
      "wait_task",
      {
        sessionId: "sess_sub",
        conversationId: "conv_sub",
        ownerAgentId: "agent_sub",
        agentKind: "sub",
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
        runtimeControl: {
          submitApprovalDecision: vi.fn(),
          suppressBackgroundTaskCompletionNotice,
        },
      },
      {
        taskRunId: "task_done_1",
      },
    );

    expect(suppressBackgroundTaskCompletionNotice).toHaveBeenCalledExactlyOnceWith({
      taskRunId: "task_done_1",
    });
    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("status=completed"),
    });
  });

  test("rejects wait_task for main-agent sessions", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture();
    const registry = new ToolRegistry([createWaitTaskTool()]);

    await expect(
      registry.execute(
        "wait_task",
        {
          sessionId: "sess_main",
          conversationId: "conv_main",
          ownerAgentId: "agent_main",
          agentKind: "main",
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
          runtimeControl: {
            submitApprovalDecision: vi.fn(),
          },
        },
        {
          taskRunId: "task_done_1",
        },
      ),
    ).rejects.toThrow("wait_task is only available to subagents.");
  });
});
