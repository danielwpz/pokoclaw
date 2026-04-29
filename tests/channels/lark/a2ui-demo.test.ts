import { afterEach, describe, expect, test, vi } from "vitest";

import { LarkA2uiDemoService } from "@/src/channels/lark/a2ui-demo.js";
import type { LarkSdkClient } from "@/src/channels/lark/client.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

describe("lark a2ui demo service", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("publishes through CardKit without creating lark object bindings", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedLarkSurface(handle);
    const create = vi.fn(async () => ({ code: 0, data: { card_id: "card_a2ui_1" } }));
    const update = vi.fn(async (_input: unknown) => ({ code: 0 }));
    const messageCreate = vi.fn(async () => ({ data: { message_id: "msg_a2ui_1" } }));
    const submitMessage = vi.fn(async (_input: unknown) => ({ status: "started" as const }));
    const service = new LarkA2uiDemoService({
      storage: handle.storage.db,
      clients: {
        getOrCreate: () =>
          ({
            sdk: {
              cardkit: {
                v1: {
                  card: {
                    create,
                    update,
                  },
                },
              },
              im: {
                message: {
                  create: messageCreate,
                },
              },
            },
          }) as unknown as LarkSdkClient,
      },
      ingress: {
        submitMessage,
        submitApprovalDecision: vi.fn(() => false),
      },
    });

    const result = await service.publish({
      sessionId: "sess_1",
      conversationId: "conv_1",
      messages: buildQuizMessages(),
    });

    expect(result).toMatchObject({
      surfaceId: "quiz",
      cardId: "card_a2ui_1",
      messageId: "msg_a2ui_1",
      sequence: 1,
      dynamic: false,
    });
    expect(create).toHaveBeenCalledOnce();
    expect(messageCreate).toHaveBeenCalledOnce();
    expect(
      handle.storage.sqlite.prepare("SELECT COUNT(*) AS count FROM lark_object_bindings").get(),
    ).toEqual({ count: 0 });

    const callbackResult = await service.handleCardAction({
      installationId: "default",
      payload: {
        action: {
          value: {
            __a2ui_lark: "v0_8",
            surfaceId: "quiz",
            sourceComponentId: "submit",
            actionName: "submit_answer",
          },
          form_value: {
            answer: ["b"],
          },
        },
      },
    });

    expect(callbackResult).toEqual({
      toast: {
        type: "success",
        content: "已收到",
      },
    });
    expect(submitMessage).toHaveBeenCalledOnce();
    const submitted = submitMessage.mock.calls[0]?.[0] as { content: string };
    expect(submitted).toMatchObject({
      sessionId: "sess_1",
      scenario: "chat",
      messageType: "a2ui_user_action",
    });
    expect(submitted.content).toContain('"name": "submit_answer"');

    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    const updatePayload = update.mock.calls[0]?.[0] as {
      data: { card: { data: string }; sequence: number };
    };
    expect(updatePayload.data.sequence).toBe(2);
    const updatedCardJson = updatePayload.data.card.data;
    expect(updatedCardJson).toContain("已提交");
    expect(updatedCardJson).not.toContain("submit_answer");

    const duplicateCallbackResult = await service.handleCardAction({
      installationId: "default",
      payload: {
        action: {
          value: {
            __a2ui_lark: "v0_8",
            surfaceId: "quiz",
            sourceComponentId: "submit",
            actionName: "submit_answer",
          },
          form_value: {
            answer: ["b"],
          },
        },
      },
    });

    expect(duplicateCallbackResult).toEqual({
      toast: {
        type: "success",
        content: "已收到",
      },
    });
    expect(submitMessage).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
    service.shutdown();
  });

  test("acks a2ui callbacks before runtime submission completes", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedLarkSurface(handle);
    const create = vi.fn(async () => ({ code: 0, data: { card_id: "card_a2ui_1" } }));
    const update = vi.fn(async (_input: unknown) => ({ code: 0 }));
    const messageCreate = vi.fn(async () => ({ data: { message_id: "msg_a2ui_1" } }));
    const submission = createDeferred<unknown>();
    const submitMessage = vi.fn(() => submission.promise);
    const service = new LarkA2uiDemoService({
      storage: handle.storage.db,
      clients: {
        getOrCreate: () =>
          ({
            sdk: {
              cardkit: {
                v1: {
                  card: {
                    create,
                    update,
                  },
                },
              },
              im: {
                message: {
                  create: messageCreate,
                },
              },
            },
          }) as unknown as LarkSdkClient,
      },
      ingress: {
        submitMessage,
        submitApprovalDecision: vi.fn(() => false),
      },
    });

    await service.publish({
      sessionId: "sess_1",
      conversationId: "conv_1",
      messages: buildQuizMessages(),
    });

    const callbackResult = await service.handleCardAction({
      installationId: "default",
      payload: {
        action: {
          value: {
            __a2ui_lark: "v0_8",
            surfaceId: "quiz",
            sourceComponentId: "submit",
            actionName: "submit_answer",
          },
          form_value: {
            answer: ["b"],
          },
        },
      },
    });

    expect(callbackResult).toEqual({
      toast: {
        type: "success",
        content: "已收到",
      },
    });
    expect(submitMessage).toHaveBeenCalledOnce();
    submission.resolve({ status: "started" });
    service.shutdown();
  });

  test("updates dynamic grid cards from bash data sources", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedLarkSurface(handle);
    const create = vi.fn(async () => ({ code: 0, data: { card_id: "card_clock_1" } }));
    const update = vi.fn(async () => ({ code: 0 }));
    const messageCreate = vi.fn(async () => ({ data: { message_id: "msg_clock_1" } }));
    const service = new LarkA2uiDemoService({
      storage: handle.storage.db,
      clients: {
        getOrCreate: () =>
          ({
            sdk: {
              cardkit: {
                v1: {
                  card: {
                    create,
                    update,
                  },
                },
              },
              im: {
                message: {
                  create: messageCreate,
                },
              },
            },
          }) as unknown as LarkSdkClient,
      },
      ingress: {
        submitMessage: vi.fn(async (_input: unknown) => ({ status: "started" as const })),
        submitApprovalDecision: vi.fn(() => false),
      },
    });

    const result = await service.publish({
      sessionId: "sess_1",
      conversationId: "conv_1",
      messages: buildDynamicGridMessages(),
      ttlMs: 1000,
    });

    expect(result.dynamic).toBe(true);
    await vi.waitFor(() => expect(update).toHaveBeenCalled(), { timeout: 1000 });
    const firstUpdateCall = update.mock.calls.at(0);
    expect(firstUpdateCall).toBeDefined();
    expect(firstUpdateCall?.at(0)).toMatchObject({
      path: { card_id: "card_clock_1" },
      data: {
        sequence: 2,
      },
    });
    service.shutdown();
  });
});

function seedLarkSurface(handle: TestDatabaseHandle): void {
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
    VALUES ('sess_1', 'conv_1', 'branch_1', 'agent_1', 'chat', '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z');

    INSERT INTO channel_surfaces (id, channel_type, channel_installation_id, conversation_id, branch_id, surface_key, surface_object_json, created_at, updated_at)
    VALUES ('surf_1', 'lark', 'default', 'conv_1', 'branch_1', 'chat:chat_1', '{"chat_id":"chat_1"}', '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z');
  `);
}

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

function buildDynamicGridMessages() {
  return [
    {
      dataSourceUpdate: {
        surfaceId: "clock",
        extensionId: "urn:a2ui:extension:dynamic-data:v0_1",
        sources: [
          {
            id: "clock_pixels",
            driver: "bash",
            trigger: { type: "interval", everyMs: 20 },
            program: {
              script: 'printf \'{"cells":[["#ff0000"]]}\'',
            },
            output: { format: "json", target: "/clock" },
            policy: { timeoutMs: 500, maxOutputBytes: 4096 },
          },
        ],
      },
    },
    {
      surfaceUpdate: {
        surfaceId: "clock",
        components: [
          {
            id: "root",
            component: {
              Grid: {
                rows: 1,
                cols: 1,
                cellSize: 8,
                gap: 0,
                backgroundColor: "#ffffff",
                cellBackgrounds: { path: "/clock/cells" },
              },
            },
          },
        ],
      },
    },
    {
      beginRendering: {
        surfaceId: "clock",
        catalogId: "urn:a2ui:catalog:lark-card-live:v0_1",
        root: "root",
      },
    },
  ];
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
