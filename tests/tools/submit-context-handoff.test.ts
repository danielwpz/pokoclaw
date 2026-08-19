import { afterEach, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import { createSubmitContextHandoffTool } from "@/src/tools/submit-context-handoff.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";
import { seedConversationAndAgentFixture } from "@/tests/tools/helpers.js";

describe("submit_context_handoff tool", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("returns the kickoff message without semantic validation in a handoff session", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    seedSession(handle, "handoff", "context_handoff");
    const registry = new ToolRegistry([createSubmitContextHandoffTool()]);

    const result = await registry.execute(
      "submit_context_handoff",
      {
        sessionId: "handoff",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
      },
      { kickoffMessage: "  Continue from plan.md.  " },
    );

    expect(result.details).toEqual({
      contextHandoff: { kickoffMessage: "Continue from plan.md." },
    });
  });

  test("rejects use outside a handoff session", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    seedSession(handle, "chat", "chat");
    const registry = new ToolRegistry([createSubmitContextHandoffTool()]);

    await expect(
      registry.execute(
        "submit_context_handoff",
        {
          sessionId: "chat",
          conversationId: "conv_1",
          ownerAgentId: "agent_1",
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
        },
        { kickoffMessage: "continue" },
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      details: { code: "context_handoff_wrong_session_purpose" },
    });
  });
});

function seedSession(handle: TestDatabaseHandle, id: string, purpose: string): void {
  handle.storage.sqlite
    .prepare(
      `INSERT INTO sessions (
        id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at
      ) VALUES (?, 'conv_1', 'branch_1', 'agent_1', ?, 'active',
        '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z')`,
    )
    .run(id, purpose);
}
