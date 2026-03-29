import { afterEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import { createCreateSubagentTool } from "@/src/tools/create-subagent.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

describe("create_subagent tool", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  function seedFixture(): void {
    if (handle == null) {
      throw new Error("test database handle is missing");
    }

    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_1', 'lark', 'acct_a', '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES
        ('conv_main', 'ci_1', 'chat_main', 'dm', '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z'),
        ('conv_sub', 'ci_1', 'chat_sub', 'group', '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES
        ('branch_main', 'conv_main', 'dm_main', 'main', '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z'),
        ('branch_sub', 'conv_sub', 'group_main', 'main', '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z');

      INSERT INTO agents (id, conversation_id, main_agent_id, kind, created_at)
      VALUES
        ('agent_main', 'conv_main', NULL, 'main', '2026-03-26T00:00:00.000Z'),
        ('agent_sub', 'conv_sub', 'agent_main', 'sub', '2026-03-26T00:00:00.000Z');

      INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, created_at, updated_at)
      VALUES
        ('sess_main', 'conv_main', 'branch_main', 'agent_main', 'chat', '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z'),
        ('sess_sub', 'conv_sub', 'branch_sub', 'agent_sub', 'chat', '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z');
    `);
  }

  test("submits a pending subagent creation request through runtime control", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture();
    const registry = new ToolRegistry([createCreateSubagentTool()]);
    const requestSubagentCreation = vi.fn(async () => ({
      requestId: "req_new",
      title: "PR Review",
      workdir: "/Users/daniel/Programs/ai/openclaw/pokeclaw",
      privateWorkspaceDir: "/Users/daniel/.pokeclaw/workspace/subagents/reqnew00",
      status: "pending_confirmation" as const,
      expiresAt: "2026-03-26T01:00:00.000Z",
    }));

    const result = await registry.execute(
      "create_subagent",
      {
        sessionId: "sess_main",
        conversationId: "conv_main",
        ownerAgentId: "agent_main",
        agentKind: "main",
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
        runtimeControl: {
          submitApprovalDecision: vi.fn(),
          requestSubagentCreation,
        },
      },
      {
        title: "PR Review",
        description: "Review pull requests and summarize findings.",
        initialTask: "Review the current PR and report concrete issues.",
        cwd: "/Users/daniel/Programs/ai/openclaw/pokeclaw",
        initialExtraScopes: [{ kind: "db.read", database: "system" }],
      },
    );

    expect(requestSubagentCreation).toHaveBeenCalledExactlyOnceWith({
      sourceSessionId: "sess_main",
      title: "PR Review",
      description: "Review pull requests and summarize findings.",
      initialTask: "Review the current PR and report concrete issues.",
      cwd: "/Users/daniel/Programs/ai/openclaw/pokeclaw",
      initialExtraScopes: [{ kind: "db.read", database: "system" }],
    });
    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining(
        'Submitted a pending SubAgent creation request for "PR Review"',
      ),
    });
    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining(
        "Private workspace: /Users/daniel/.pokeclaw/workspace/subagents/reqnew00",
      ),
    });
  });

  test("rejects create_subagent from a non-main-agent session", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture();
    const registry = new ToolRegistry([createCreateSubagentTool()]);

    await expect(
      registry.execute(
        "create_subagent",
        {
          sessionId: "sess_sub",
          conversationId: "conv_sub",
          ownerAgentId: "agent_sub",
          agentKind: "sub",
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
          runtimeControl: {
            submitApprovalDecision: vi.fn(),
            requestSubagentCreation: vi.fn(),
          },
        },
        {
          title: "Nested",
          description: "Should be rejected.",
          initialTask: "Do not start.",
        },
      ),
    ).rejects.toThrow("create_subagent is only available to the main agent.");
  });
});
