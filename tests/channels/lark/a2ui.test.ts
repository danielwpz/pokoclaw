import { afterEach, describe, expect, test, vi } from "vitest";

import { LarkA2uiService } from "@/src/channels/lark/a2ui.js";
import type { LarkSdkClient } from "@/src/channels/lark/client.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

describe("lark a2ui service", () => {
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
    const create = vi.fn(async (_input: unknown) => ({
      code: 0,
      data: { card_id: "card_a2ui_1" },
    }));
    const update = vi.fn(async (_input: unknown) => ({ code: 0 }));
    const messageCreate = vi.fn(async () => ({ data: { message_id: "msg_a2ui_1" } }));
    const submitMessage = vi.fn(async (_input: unknown) => ({ status: "started" as const }));
    const service = new LarkA2uiService({
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
    });
    expect(create).toHaveBeenCalledOnce();
    expect(messageCreate).toHaveBeenCalledOnce();
    expect(
      handle.storage.sqlite.prepare("SELECT COUNT(*) AS count FROM lark_object_bindings").get(),
    ).toEqual({ count: 0 });
    expect(
      handle.storage.sqlite
        .prepare("SELECT COUNT(*) AS count FROM a2ui_surface_publications")
        .get(),
    ).toEqual({ count: 1 });
    const publicationId = readPublicationIdFromCardCreateInput(create.mock.calls[0]?.[0]);

    const restartedService = new LarkA2uiService({
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

    const callbackResult = await restartedService.handleCardAction({
      installationId: "default",
      payload: {
        action: {
          value: {
            __a2ui_lark: "v0_8",
            surfaceId: "quiz",
            sourceComponentId: "submit",
            actionName: "submit_answer",
            publicationId,
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
    const submittedEvent = JSON.parse(
      submitted.content.replace(/^A2UI user action:\n/, ""),
    ) as unknown;
    expect(submittedEvent).toMatchObject({
      userAction: {
        name: "submit_answer",
        surfaceId: "quiz",
        sourceComponentId: "submit",
        context: {
          source: "quiz",
        },
        submittedValues: {
          answer: ["b"],
        },
      },
    });
    expect(submitted.content).not.toContain("/form/answer");

    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    const updatePayload = update.mock.calls[0]?.[0] as {
      data: { card: { data: string }; sequence: number };
    };
    expect(updatePayload.data.sequence).toBe(2);
    const updatedCardJson = updatePayload.data.card.data;
    expect(updatedCardJson).toContain("已提交");
    expect(updatedCardJson).not.toContain("submit_answer");

    const duplicateService = new LarkA2uiService({
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

    const duplicateCallbackResult = await duplicateService.handleCardAction({
      installationId: "default",
      payload: {
        action: {
          value: {
            __a2ui_lark: "v0_8",
            surfaceId: "quiz",
            sourceComponentId: "submit",
            actionName: "submit_answer",
            publicationId,
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
    restartedService.shutdown();
    duplicateService.shutdown();
  });

  test("acks a2ui callbacks before runtime submission completes", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedLarkSurface(handle);
    const create = vi.fn(async (_input: unknown) => ({
      code: 0,
      data: { card_id: "card_a2ui_1" },
    }));
    const update = vi.fn(async (_input: unknown) => ({ code: 0 }));
    const messageCreate = vi.fn(async () => ({ data: { message_id: "msg_a2ui_1" } }));
    const submission = createDeferred<unknown>();
    const submitMessage = vi.fn(() => submission.promise);
    const service = new LarkA2uiService({
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
    const publicationId = readPublicationIdFromCardCreateInput(create.mock.calls[0]?.[0]);

    const callbackResult = await service.handleCardAction({
      installationId: "default",
      payload: {
        action: {
          value: {
            __a2ui_lark: "v0_8",
            surfaceId: "quiz",
            sourceComponentId: "submit",
            actionName: "submit_answer",
            publicationId,
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

  test("restores consumed action when runtime submission fails", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedLarkSurface(handle);
    const create = vi.fn(async (_input: unknown) => ({
      code: 0,
      data: { card_id: "card_a2ui_1" },
    }));
    const update = vi.fn(async (_input: unknown) => ({ code: 0 }));
    const messageCreate = vi.fn(async () => ({ data: { message_id: "msg_a2ui_1" } }));
    const submitMessage = vi.fn(async (_input: unknown) => {
      throw new Error("ingress unavailable");
    });
    const service = new LarkA2uiService({
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
    const publicationId = readPublicationIdFromCardCreateInput(create.mock.calls[0]?.[0]);

    const callbackResult = await service.handleCardAction({
      installationId: "default",
      payload: {
        action: {
          value: {
            __a2ui_lark: "v0_8",
            surfaceId: "quiz",
            sourceComponentId: "submit",
            actionName: "submit_answer",
            publicationId,
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
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(
      handle.storage.sqlite
        .prepare("SELECT consumed_action_keys_json FROM a2ui_surface_publications WHERE id = ?")
        .get(publicationId),
    ).toEqual({ consumed_action_keys_json: "[]" });
    const restoredUpdate = update.mock.calls[1]?.[0] as {
      data: { card: { data: string } };
    };
    expect(restoredUpdate.data.card.data).toContain("Submit");
    expect(restoredUpdate.data.card.data).not.toContain("已提交");
    service.shutdown();
  });

  test("routes repeated surface ids by publication id", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedLarkSurface(handle);
    const cardIds = ["card_a2ui_1", "card_a2ui_2"];
    let nextCardIndex = 0;
    const create = vi.fn(async (_input: unknown) => ({
      code: 0,
      data: { card_id: cardIds[nextCardIndex++] },
    }));
    const update = vi.fn(async (_input: unknown) => ({ code: 0 }));
    const messageCreate = vi.fn(async () => ({ data: { message_id: "msg_a2ui" } }));
    const submitMessage = vi.fn(async (_input: unknown) => ({ status: "started" as const }));
    const service = new LarkA2uiService({
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
    const firstPublicationId = readPublicationIdFromCardCreateInput(create.mock.calls[0]?.[0]);
    await service.publish({
      sessionId: "sess_1",
      conversationId: "conv_1",
      messages: buildQuizMessages(),
    });
    const secondPublicationId = readPublicationIdFromCardCreateInput(create.mock.calls[1]?.[0]);

    expect(firstPublicationId).not.toBe(secondPublicationId);
    expect(
      handle.storage.sqlite
        .prepare("SELECT COUNT(*) AS count FROM a2ui_surface_publications")
        .get(),
    ).toEqual({ count: 2 });

    await service.handleCardAction({
      installationId: "default",
      payload: {
        action: {
          value: {
            __a2ui_lark: "v0_8",
            surfaceId: "quiz",
            sourceComponentId: "submit",
            actionName: "submit_answer",
            publicationId: firstPublicationId,
          },
          form_value: {
            answer: ["b"],
          },
        },
      },
    });

    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    const updatePayload = update.mock.calls[0]?.[0] as { path: { card_id: string } };
    expect(updatePayload.path.card_id).toBe("card_a2ui_1");
    expect(submitMessage).toHaveBeenCalledOnce();
    service.shutdown();
  });

  test("rejects dynamic data sources before creating a card", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedLarkSurface(handle);
    const create = vi.fn(async (_input: unknown) => ({
      code: 0,
      data: { card_id: "card_clock_1" },
    }));
    const update = vi.fn(async () => ({ code: 0 }));
    const messageCreate = vi.fn(async () => ({ data: { message_id: "msg_clock_1" } }));
    const service = new LarkA2uiService({
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

    await expect(
      service.publish({
        sessionId: "sess_1",
        conversationId: "conv_1",
        messages: buildDynamicGridMessages(),
      }),
    ).rejects.toThrow("A2UI dynamic data sources are not supported in Pokoclaw A2UI 1.0.");
    expect(create).not.toHaveBeenCalled();
    expect(messageCreate).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    service.shutdown();
  });

  test("rejects callback path context before creating a card", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedLarkSurface(handle);
    const create = vi.fn(async (_input: unknown) => ({
      code: 0,
      data: { card_id: "card_a2ui_1" },
    }));
    const update = vi.fn(async () => ({ code: 0 }));
    const messageCreate = vi.fn(async () => ({ data: { message_id: "msg_a2ui_1" } }));
    const service = new LarkA2uiService({
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

    await expect(
      service.publish({
        sessionId: "sess_1",
        conversationId: "conv_1",
        messages: buildQuizMessages({ pathContext: true }),
      }),
    ).rejects.toThrow(
      "A2UI callback context cannot reference dataModel paths in Pokoclaw A2UI 1.0.",
    );
    expect(create).not.toHaveBeenCalled();
    expect(messageCreate).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    service.shutdown();
  });
});

function readPublicationIdFromCardCreateInput(input: unknown): string {
  const card = readCardJsonFromCreateInput(input);
  const value = findA2uiCallbackValue(card);
  const publicationId = value?.publicationId;
  if (typeof publicationId !== "string" || publicationId.length === 0) {
    throw new Error("Published A2UI card does not include publicationId in callback value.");
  }
  return publicationId;
}

function readCardJsonFromCreateInput(input: unknown): unknown {
  if (!isRecord(input) || !isRecord(input.data) || typeof input.data.data !== "string") {
    throw new Error("Invalid Lark CardKit create input.");
  }
  return JSON.parse(input.data.data) as unknown;
}

function findA2uiCallbackValue(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findA2uiCallbackValue(entry);
      if (found != null) {
        return found;
      }
    }
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  if (isRecord(value.value) && value.value.__a2ui_lark === "v0_8") {
    return value.value;
  }
  for (const child of Object.values(value)) {
    const found = findA2uiCallbackValue(child);
    if (found != null) {
      return found;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

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

function buildQuizMessages(input: { pathContext?: boolean } = {}) {
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
                  context:
                    input.pathContext === true
                      ? [{ key: "answer", value: { path: "/form/answer" } }]
                      : [{ key: "source", value: { literalString: "quiz" } }],
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
