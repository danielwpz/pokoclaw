import { describe, expect, test } from "vitest";

import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { createConsultThinkTankTool } from "@/src/tools/consult-think-tank.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import { createGetThinkTankCapabilitiesTool } from "@/src/tools/get-think-tank-capabilities.js";
import { createGetThinkTankStatusTool } from "@/src/tools/get-think-tank-status.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

function seedChatFixture(handle: TestDatabaseHandle): void {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_1', 'lark', 'acct_a', '2026-04-21T00:00:00.000Z', '2026-04-21T00:00:00.000Z');

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES ('conv_1', 'ci_1', 'chat_1', 'dm', '2026-04-21T00:00:00.000Z', '2026-04-21T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-04-21T00:00:00.000Z', '2026-04-21T00:00:00.000Z');

    INSERT INTO agents (id, conversation_id, kind, created_at)
    VALUES ('agent_1', 'conv_1', 'main', '2026-04-21T00:00:00.000Z');

    INSERT INTO sessions (
      id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at
    ) VALUES (
      'sess_1', 'conv_1', 'branch_1', 'agent_1', 'chat', 'active',
      '2026-04-21T00:00:00.000Z', '2026-04-21T00:00:00.000Z'
    );
  `);
}

describe("think tank tools", () => {
  test("get_think_tank_capabilities bridges through runtime control", async () => {
    const handle = await createTestDatabase(import.meta.url);

    try {
      seedChatFixture(handle);
      const registry = new ToolRegistry([createGetThinkTankCapabilitiesTool()]);
      const result = await registry.execute(
        "get_think_tank_capabilities",
        {
          sessionId: "sess_1",
          conversationId: "conv_1",
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
          runtimeControl: {
            submitApprovalDecision: () => true,
            getThinkTankCapabilities: () => ({
              availableModels: ["openrouter-claude-sonnet-4", "openrouter-gemini-3.1-flash"],
              recommendedParticipantCount: 2,
              maxParticipantCount: 4,
            }),
          },
        },
        {},
      );

      expect(result.details).toEqual({
        availableModels: ["openrouter-claude-sonnet-4", "openrouter-gemini-3.1-flash"],
        recommendedParticipantCount: 2,
        maxParticipantCount: 4,
      });
    } finally {
      await destroyTestDatabase(handle);
    }
  });

  test("consult_think_tank forwards normalized participants and current model id", async () => {
    const handle = await createTestDatabase(import.meta.url);

    try {
      seedChatFixture(handle);
      const registry = new ToolRegistry([createConsultThinkTankTool()]);
      const result = await registry.execute(
        "consult_think_tank",
        {
          sessionId: "sess_1",
          conversationId: "conv_1",
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
          currentModelId: "codex-gpt5.4",
          runtimeControl: {
            submitApprovalDecision: () => true,
            startThinkTankConsultation: async (input) => {
              expect(input.sourceSessionId).toBe("sess_1");
              expect(input.sourceConversationId).toBe("conv_1");
              expect(input.sourceBranchId).toBe("branch_1");
              expect(input.moderatorModelId).toBe("codex-gpt5.4");
              expect(input.participants).toEqual([
                {
                  id: "product_lead",
                  model: "openrouter-claude-sonnet-4",
                  persona: "Focus on adoption and product clarity.",
                  title: "Product Lead",
                },
                {
                  id: "infra_engineer",
                  model: "openrouter-gemini-3.1-flash",
                  persona: "Focus on system reliability and operational load.",
                  title: null,
                },
              ]);
              return {
                accepted: true as const,
                consultationId: "tt_1",
                status: "running" as const,
                participants: [
                  {
                    id: "product_lead",
                    model: "openrouter-claude-sonnet-4",
                    title: "Product Lead",
                    continuationSessionId: "sess_tt_1",
                  },
                  {
                    id: "infra_engineer",
                    model: "openrouter-gemini-3.1-flash",
                    title: null,
                    continuationSessionId: "sess_tt_2",
                  },
                ],
              };
            },
          },
        },
        {
          topic: "How should we expose think tank events?",
          context: "We need a thin runtime/channel boundary.",
          participants: [
            {
              id: "product_lead",
              model: "openrouter-claude-sonnet-4",
              persona: "Focus on adoption and product clarity.",
              title: "Product Lead",
            },
            {
              id: "infra_engineer",
              model: "openrouter-gemini-3.1-flash",
              persona: "Focus on system reliability and operational load.",
            },
          ],
        },
      );

      expect(result.details).toMatchObject({
        consultationId: "tt_1",
        status: "running",
      });
    } finally {
      await destroyTestDatabase(handle);
    }
  });

  test("consult_think_tank rejects duplicate participant ids", async () => {
    const handle = await createTestDatabase(import.meta.url);

    try {
      seedChatFixture(handle);
      const registry = new ToolRegistry([createConsultThinkTankTool()]);

      await expect(
        registry.execute(
          "consult_think_tank",
          {
            sessionId: "sess_1",
            conversationId: "conv_1",
            securityConfig: DEFAULT_CONFIG.security,
            storage: handle.storage.db,
            currentModelId: "codex-gpt5.4",
            runtimeControl: {
              submitApprovalDecision: () => true,
              startThinkTankConsultation: async () => {
                throw new Error("should not be called");
              },
            },
          },
          {
            topic: "Topic",
            context: "Context",
            participants: [
              {
                id: "dup",
                model: "openrouter-claude-sonnet-4",
                persona: "A",
              },
              {
                id: "dup",
                model: "openrouter-gemini-3.1-flash",
                persona: "B",
              },
            ],
          },
        ),
      ).rejects.toMatchObject({
        kind: "recoverable_error",
      });
    } finally {
      await destroyTestDatabase(handle);
    }
  });

  test("get_think_tank_status returns recoverable not-found when consultation is missing", async () => {
    const handle = await createTestDatabase(import.meta.url);

    try {
      seedChatFixture(handle);
      const registry = new ToolRegistry([createGetThinkTankStatusTool()]);

      await expect(
        registry.execute(
          "get_think_tank_status",
          {
            sessionId: "sess_1",
            conversationId: "conv_1",
            securityConfig: DEFAULT_CONFIG.security,
            storage: handle.storage.db,
            runtimeControl: {
              submitApprovalDecision: () => true,
              getThinkTankStatus: async () => null,
            },
          },
          {
            consultationId: "missing_tt",
          },
        ),
      ).rejects.toMatchObject({
        kind: "recoverable_error",
      });
    } finally {
      await destroyTestDatabase(handle);
    }
  });
});
