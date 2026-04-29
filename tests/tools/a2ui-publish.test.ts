import { afterEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { createPublishA2uiTool } from "@/src/tools/a2ui-publish.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

describe("publish_a2ui tool", () => {
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
      VALUES ('ci_1', 'lark', 'default', '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES ('conv_1', 'ci_1', 'chat_1', 'dm', '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z');

      INSERT INTO agents (id, conversation_id, kind, created_at)
      VALUES ('agent_1', 'conv_1', 'main', '2026-04-01T00:00:00.000Z');

      INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, created_at, updated_at)
      VALUES
        ('sess_chat', 'conv_1', 'branch_1', 'agent_1', 'chat', '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'),
        ('sess_task', 'conv_1', 'branch_1', 'agent_1', 'task', '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z');
    `);
  }

  test("delegates validated runtime messages to the configured publisher", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture();
    const publish = vi.fn(async () => ({ surfaceId: "quiz", cardId: "card_1" }));
    const registry = new ToolRegistry([createPublishA2uiTool({ publisher: { publish } })]);
    const messages = buildQuizMessages();

    const result = await registry.execute(
      "publish_a2ui",
      {
        sessionId: "sess_chat",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        agentKind: "main",
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
      },
      {
        messages,
        ttlSeconds: 5,
      },
    );

    expect(publish).toHaveBeenCalledExactlyOnceWith({
      sessionId: "sess_chat",
      conversationId: "conv_1",
      messages,
      ttlMs: 5000,
    });
    expect(result.content[0]).toEqual({
      type: "json",
      json: { surfaceId: "quiz", cardId: "card_1" },
    });
  });

  test("rejects non-chat sessions before publishing", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture();
    const publish = vi.fn();
    const registry = new ToolRegistry([createPublishA2uiTool({ publisher: { publish } })]);

    await expect(
      registry.execute(
        "publish_a2ui",
        {
          sessionId: "sess_task",
          conversationId: "conv_1",
          ownerAgentId: "agent_1",
          agentKind: "main",
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
        },
        {
          messages: buildQuizMessages(),
        },
      ),
    ).rejects.toThrow("publish_a2ui is only available in chat sessions.");
    expect(publish).not.toHaveBeenCalled();
  });
});

function buildQuizMessages() {
  return [
    {
      dataModelUpdate: {
        surfaceId: "quiz",
        path: "/",
        contents: [
          {
            key: "form",
            valueMap: [{ key: "answer", valueMap: [{ key: "0", valueString: "a" }] }],
          },
        ],
      },
    },
    {
      surfaceUpdate: {
        surfaceId: "quiz",
        components: [
          {
            id: "root",
            component: {
              Form: {
                children: { explicitList: ["choice"] },
                submit: "submit",
              },
            },
          },
          {
            id: "choice",
            component: {
              MultipleChoice: {
                name: "answer",
                label: { literalString: "Choose one" },
                selections: { path: "/form/answer" },
                options: [
                  { label: { literalString: "A" }, value: "a" },
                  { label: { literalString: "B" }, value: "b" },
                ],
                maxAllowedSelections: 1,
                variant: "radio",
              },
            },
          },
          {
            id: "submit_label",
            component: {
              Text: { text: { literalString: "Submit" } },
            },
          },
          {
            id: "submit",
            component: {
              Button: {
                child: "submit_label",
                primary: true,
                action: {
                  name: "submit_answer",
                  context: [{ key: "answer", value: { path: "/form/answer" } }],
                },
              },
            },
          },
        ],
      },
    },
    {
      beginRendering: {
        surfaceId: "quiz",
        catalogId: "urn:a2ui:catalog:lark-card:v0_8",
        root: "root",
      },
    },
  ];
}
