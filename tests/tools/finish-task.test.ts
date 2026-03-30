import { afterEach, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import type { ToolFailure } from "@/src/tools/core/errors.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import { createFinishTaskTool } from "@/src/tools/finish-task.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";
import { seedConversationAndAgentFixture } from "@/tests/tools/helpers.js";

describe("finish_task tool", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("records explicit task completion details for unattended task sessions", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    handle.storage.sqlite.exec(`
      INSERT INTO sessions (
        id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at
      ) VALUES (
        'sess_task', 'conv_1', 'branch_1', 'agent_1', 'task', 'active',
        '2026-03-30T00:00:00.000Z', '2026-03-30T00:00:00.000Z'
      );
    `);

    const registry = new ToolRegistry([createFinishTaskTool()]);
    const result = await registry.execute(
      "finish_task",
      {
        sessionId: "sess_task",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
      },
      {
        status: "blocked",
        summary: "Waiting for an external deployment window.",
        finalMessage: "Task is blocked until the external deployment window opens.",
      },
    );

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "Recorded task completion with status=blocked.",
        },
      ],
      details: {
        taskCompletion: {
          status: "blocked",
          summary: "Waiting for an external deployment window.",
          finalMessage: "Task is blocked until the external deployment window opens.",
        },
      },
    });
  });

  test("rejects finish_task outside unattended task sessions", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    handle.storage.sqlite.exec(`
      INSERT INTO sessions (
        id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at
      ) VALUES (
        'sess_chat', 'conv_1', 'branch_1', 'agent_1', 'chat', 'active',
        '2026-03-30T00:00:00.000Z', '2026-03-30T00:00:00.000Z'
      );
    `);

    const registry = new ToolRegistry([createFinishTaskTool()]);

    await expect(
      registry.execute(
        "finish_task",
        {
          sessionId: "sess_chat",
          conversationId: "conv_1",
          ownerAgentId: "agent_1",
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
        },
        {
          status: "completed",
          summary: "Done.",
          finalMessage: "Done.",
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      details: {
        code: "finish_task_wrong_session_purpose",
        sessionId: "sess_chat",
        sessionPurpose: "chat",
      },
    } satisfies Partial<ToolFailure>);
  });
});
