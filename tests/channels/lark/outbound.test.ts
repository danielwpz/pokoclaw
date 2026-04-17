import { afterEach, describe, expect, test, vi } from "vitest";

import { createLarkOutboundRuntime } from "@/src/channels/lark/outbound.js";
import { buildLarkAssistantElementId } from "@/src/channels/lark/run-state.js";
import { LarkSteerReactionState } from "@/src/channels/lark/steer-reaction-state.js";
import type {
  OrchestratedOutboundEventEnvelope,
  OrchestratedRuntimeEventEnvelope,
  OrchestratedSubagentCreationEventEnvelope,
  OrchestratedTaskRunEventEnvelope,
} from "@/src/orchestration/outbound-events.js";
import { RuntimeEventBus } from "@/src/runtime/event-bus.js";
import { ChannelSurfacesRepo } from "@/src/storage/repos/channel-surfaces.repo.js";
import { LarkObjectBindingsRepo } from "@/src/storage/repos/lark-object-bindings.repo.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

function makeEnvelope(
  event: OrchestratedRuntimeEventEnvelope["event"],
): OrchestratedRuntimeEventEnvelope {
  return {
    kind: "runtime_event",
    target: {
      conversationId: "conv_1",
      branchId: "branch_1",
    },
    session: {
      sessionId: "sess_1",
      purpose: "chat",
    },
    agent: {
      ownerAgentId: "agent_1",
      ownerRole: "main",
      mainAgentId: "agent_1",
    },
    taskRun: {
      taskRunId: null,
      runType: null,
      status: null,
      executionSessionId: null,
    },
    run: {
      runId: "run_1",
    },
    object: {
      messageId: null,
      toolCallId: null,
      toolName: null,
      approvalId: null,
    },
    event,
  };
}

function makeSubagentEnvelope(
  event: OrchestratedSubagentCreationEventEnvelope["event"],
): OrchestratedSubagentCreationEventEnvelope {
  return {
    kind: "subagent_creation_event",
    target: {
      conversationId: "conv_1",
      branchId: "branch_1",
    },
    session: {
      sessionId: "sess_1",
      purpose: "chat",
    },
    agent: {
      ownerAgentId: "agent_1",
      ownerRole: "main",
      mainAgentId: "agent_1",
    },
    taskRun: {
      taskRunId: null,
      runType: null,
      status: null,
      executionSessionId: null,
    },
    run: {
      runId: null,
    },
    object: {
      messageId: null,
      toolCallId: null,
      toolName: null,
      approvalId: null,
    },
    event,
  };
}

function makeTaskRuntimeEnvelope(
  event: OrchestratedRuntimeEventEnvelope["event"],
): OrchestratedRuntimeEventEnvelope {
  return {
    kind: "runtime_event",
    target: {
      conversationId: "conv_1",
      branchId: "branch_1",
    },
    session: {
      sessionId: "sess_task",
      purpose: "task",
    },
    agent: {
      ownerAgentId: "agent_1",
      ownerRole: "main",
      mainAgentId: "agent_1",
    },
    taskRun: {
      taskRunId: "task_1",
      runType: "cron",
      status: "running",
      executionSessionId: "sess_task",
    },
    run: {
      runId: "run_task_1",
    },
    object: {
      messageId: null,
      toolCallId: null,
      toolName: null,
      approvalId: null,
    },
    event,
  };
}

function makeTaskEnvelope(
  event: OrchestratedTaskRunEventEnvelope["event"],
): OrchestratedTaskRunEventEnvelope {
  return {
    kind: "task_run_event",
    target: {
      conversationId: "conv_1",
      branchId: "branch_1",
    },
    session: {
      sessionId: "sess_task",
      purpose: "task",
    },
    agent: {
      ownerAgentId: "agent_1",
      ownerRole: "main",
      mainAgentId: "agent_1",
    },
    taskRun: {
      taskRunId: "task_1",
      runType: "cron",
      status: event.status,
      executionSessionId: "sess_task",
    },
    run: {
      runId: null,
    },
    object: {
      messageId: null,
      toolCallId: null,
      toolName: null,
      approvalId: null,
    },
    event,
  };
}

function makeApprovalRuntimeEnvelope(
  event: OrchestratedRuntimeEventEnvelope["event"],
): OrchestratedRuntimeEventEnvelope {
  return {
    kind: "runtime_event",
    target: {
      conversationId: "conv_1",
      branchId: "branch_1",
    },
    session: {
      sessionId: "sess_approval",
      purpose: "approval",
    },
    agent: {
      ownerAgentId: "agent_1",
      ownerRole: "main",
      mainAgentId: "agent_1",
    },
    taskRun: {
      taskRunId: null,
      runType: null,
      status: null,
      executionSessionId: null,
    },
    run: {
      runId: "run_approval_1",
    },
    object: {
      messageId: null,
      toolCallId: null,
      toolName: null,
      approvalId: null,
    },
    event,
  };
}

describe("lark outbound runtime", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("creates then patches the same run card for subsequent events", async () => {
    vi.useFakeTimers();
    handle = await createTestDatabase(import.meta.url);
    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_lark_default', 'lark', 'default', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES ('conv_1', 'ci_lark_default', 'oc_chat_1', 'dm', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

    `);

    new ChannelSurfacesRepo(handle.storage.db).upsert({
      id: "surface_1",
      channelType: "lark",
      channelInstallationId: "default",
      conversationId: "conv_1",
      branchId: "branch_1",
      surfaceKey: "chat:oc_chat_1",
      surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
    });

    const createCard = vi.fn(async (_input: unknown) => ({
      data: {
        card_id: "card_1",
      },
    }));
    const createMessage = vi.fn(async (_input: unknown) => ({
      data: {
        message_id: "om_card_1",
        open_message_id: "om_open_1",
      },
    }));
    const updateCard = vi.fn(async (_input: unknown) => ({}));
    const streamContent = vi.fn(async (_input: unknown) => ({}));
    const bus = new RuntimeEventBus<OrchestratedOutboundEventEnvelope>();
    const runtime = createLarkOutboundRuntime({
      storage: handle.storage.db,
      outboundEventBus: bus,
      clients: {
        getOrCreate: () =>
          ({
            sdk: {
              cardkit: {
                v1: {
                  card: {
                    create: createCard,
                    update: updateCard,
                  },
                  cardElement: {
                    content: streamContent,
                  },
                },
              },
              im: {
                message: {
                  create: createMessage,
                },
              },
            },
          }) as never,
      },
    });

    runtime.start();

    bus.publish(
      makeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
      }),
    );
    bus.publish(
      makeEnvelope({
        type: "assistant_message_delta",
        eventId: "evt_2",
        createdAt: "2026-03-28T00:00:01.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
        delta: "hello",
        accumulatedText: "hello",
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledOnce();
    expect(createMessage).toHaveBeenCalledOnce();
    expect(updateCard).not.toHaveBeenCalled();
    expect(streamContent).not.toHaveBeenCalled();
    expect(createMessage.mock.calls.at(0)?.[0]).toMatchObject({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc_chat_1",
        msg_type: "interactive",
      },
    });

    const binding = new LarkObjectBindingsRepo(handle.storage.db).getByInternalObject({
      channelInstallationId: "default",
      internalObjectKind: "run_card",
      internalObjectId: "run_1:seg:1",
    });
    expect(binding?.larkMessageUuid).toBeTruthy();
    expect(binding?.larkMessageId).toBe("om_card_1");
    expect(binding?.larkCardId).toBe("card_1");

    bus.publish(
      makeEnvelope({
        type: "assistant_message_delta",
        eventId: "evt_2b",
        createdAt: "2026-03-28T00:00:01.500Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
        delta: " world",
        accumulatedText: "hello world",
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(streamContent).toHaveBeenCalledOnce();
    expect(streamContent.mock.calls.at(0)?.[0]).toMatchObject({
      path: {
        card_id: "card_1",
        element_id: buildLarkAssistantElementId("msg_1"),
      },
      data: {
        content: "hello world",
        sequence: 1,
      },
    });

    bus.publish(
      makeEnvelope({
        type: "assistant_message_completed",
        eventId: "evt_3",
        createdAt: "2026-03-28T00:00:02.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
        text: "hello",
        reasoningText: null,
        toolCalls: [],
        usage: null,
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledOnce();
    expect(createMessage).toHaveBeenCalledOnce();
    expect(streamContent).toHaveBeenCalledOnce();
    expect(updateCard).toHaveBeenCalledOnce();
    expect(updateCard.mock.calls.at(0)?.[0]).toMatchObject({
      path: { card_id: "card_1" },
    });

    await runtime.shutdown();
  });

  test("retries card.create once when card.create returns a non-zero code", async () => {
    vi.useFakeTimers();
    handle = await createTestDatabase(import.meta.url);
    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_lark_default', 'lark', 'default', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES ('conv_1', 'ci_lark_default', 'oc_chat_1', 'dm', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');
    `);

    new ChannelSurfacesRepo(handle.storage.db).upsert({
      id: "surface_1",
      channelType: "lark",
      channelInstallationId: "default",
      conversationId: "conv_1",
      branchId: "branch_1",
      surfaceKey: "chat:oc_chat_1",
      surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
    });

    const createCard = vi
      .fn()
      .mockResolvedValueOnce({ code: 999, msg: "busy" })
      .mockResolvedValueOnce({ data: { card_id: "card_1" } });
    const createMessage = vi.fn(async (_input: unknown) => ({
      data: { message_id: "om_card_1", open_message_id: "om_open_1" },
    }));
    const updateCard = vi.fn(async (_input: unknown) => ({}));
    const streamContent = vi.fn(async (_input: unknown) => ({}));
    const bus = new RuntimeEventBus<OrchestratedOutboundEventEnvelope>();
    const runtime = createLarkOutboundRuntime({
      storage: handle.storage.db,
      outboundEventBus: bus,
      clients: {
        getOrCreate: () =>
          ({
            sdk: {
              cardkit: {
                v1: {
                  card: {
                    create: createCard,
                    update: updateCard,
                  },
                  cardElement: {
                    content: streamContent,
                  },
                },
              },
              im: {
                message: {
                  create: createMessage,
                },
              },
            },
          }) as never,
      },
    });

    runtime.start();

    bus.publish(
      makeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_create_retry_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
      }),
    );
    bus.publish(
      makeEnvelope({
        type: "assistant_message_delta",
        eventId: "evt_create_retry_2",
        createdAt: "2026-03-28T00:00:01.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
        delta: "hello",
        accumulatedText: "hello",
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledTimes(2);
    expect(createMessage).toHaveBeenCalledTimes(1);

    const binding = new LarkObjectBindingsRepo(handle.storage.db).getByInternalObject({
      channelInstallationId: "default",
      internalObjectKind: "run_card",
      internalObjectId: "run_1:seg:1",
    });
    expect(binding?.larkCardId).toBe("card_1");
    expect(binding?.larkMessageId).toBe("om_card_1");

    await runtime.shutdown();
  });

  test("retries run card stream content once when cardElement.content returns a non-zero code", async () => {
    vi.useFakeTimers();
    handle = await createTestDatabase(import.meta.url);
    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_lark_default', 'lark', 'default', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES ('conv_1', 'ci_lark_default', 'oc_chat_1', 'dm', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');
    `);

    new ChannelSurfacesRepo(handle.storage.db).upsert({
      id: "surface_1",
      channelType: "lark",
      channelInstallationId: "default",
      conversationId: "conv_1",
      branchId: "branch_1",
      surfaceKey: "chat:oc_chat_1",
      surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
    });

    const createCard = vi.fn(async (_input: unknown) => ({
      data: { card_id: "card_1" },
    }));
    const createMessage = vi.fn(async (_input: unknown) => ({
      data: { message_id: "om_card_1", open_message_id: "om_open_1" },
    }));
    const updateCard = vi.fn(async (_input: unknown) => ({}));
    const streamContent = vi
      .fn()
      .mockResolvedValueOnce({ code: 999, msg: "busy" })
      .mockResolvedValueOnce({});
    const bus = new RuntimeEventBus<OrchestratedOutboundEventEnvelope>();
    const runtime = createLarkOutboundRuntime({
      storage: handle.storage.db,
      outboundEventBus: bus,
      clients: {
        getOrCreate: () =>
          ({
            sdk: {
              cardkit: {
                v1: {
                  card: {
                    create: createCard,
                    update: updateCard,
                  },
                  cardElement: {
                    content: streamContent,
                  },
                },
              },
              im: {
                message: {
                  create: createMessage,
                },
              },
            },
          }) as never,
      },
    });

    runtime.start();

    bus.publish(
      makeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_stream_retry_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
      }),
    );
    bus.publish(
      makeEnvelope({
        type: "assistant_message_delta",
        eventId: "evt_stream_retry_2",
        createdAt: "2026-03-28T00:00:01.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
        delta: "hello",
        accumulatedText: "hello",
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    bus.publish(
      makeEnvelope({
        type: "assistant_message_delta",
        eventId: "evt_stream_retry_3",
        createdAt: "2026-03-28T00:00:01.500Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
        delta: " world",
        accumulatedText: "hello world",
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(streamContent).toHaveBeenCalledTimes(2);
    expect(streamContent.mock.calls.at(0)?.[0]).toMatchObject({
      path: {
        card_id: "card_1",
        element_id: buildLarkAssistantElementId("msg_1"),
      },
      data: {
        content: "hello world",
        sequence: 1,
      },
    });
    expect(streamContent.mock.calls.at(1)?.[0]).toMatchObject({
      path: {
        card_id: "card_1",
        element_id: buildLarkAssistantElementId("msg_1"),
      },
      data: {
        content: "hello world",
        sequence: 1,
      },
    });

    await runtime.shutdown();
  });

  test("retries run card full update once when card.update returns a non-zero code", async () => {
    vi.useFakeTimers();
    handle = await createTestDatabase(import.meta.url);
    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_lark_default', 'lark', 'default', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES ('conv_1', 'ci_lark_default', 'oc_chat_1', 'dm', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');
    `);

    new ChannelSurfacesRepo(handle.storage.db).upsert({
      id: "surface_1",
      channelType: "lark",
      channelInstallationId: "default",
      conversationId: "conv_1",
      branchId: "branch_1",
      surfaceKey: "chat:oc_chat_1",
      surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
    });

    const createCard = vi.fn(async (_input: unknown) => ({
      data: { card_id: "card_1" },
    }));
    const createMessage = vi.fn(async (_input: unknown) => ({
      data: { message_id: "om_card_1", open_message_id: "om_open_1" },
    }));
    const updateCard = vi
      .fn()
      .mockResolvedValueOnce({ code: 999, msg: "busy" })
      .mockResolvedValueOnce({});
    const streamContent = vi.fn(async (_input: unknown) => ({}));
    const bus = new RuntimeEventBus<OrchestratedOutboundEventEnvelope>();
    const runtime = createLarkOutboundRuntime({
      storage: handle.storage.db,
      outboundEventBus: bus,
      clients: {
        getOrCreate: () =>
          ({
            sdk: {
              cardkit: {
                v1: {
                  card: {
                    create: createCard,
                    update: updateCard,
                  },
                  cardElement: {
                    content: streamContent,
                  },
                },
              },
              im: {
                message: {
                  create: createMessage,
                },
              },
            },
          }) as never,
      },
    });

    runtime.start();

    bus.publish(
      makeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_update_retry_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
      }),
    );
    bus.publish(
      makeEnvelope({
        type: "assistant_message_delta",
        eventId: "evt_update_retry_2",
        createdAt: "2026-03-28T00:00:01.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
        delta: "hello",
        accumulatedText: "hello",
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    bus.publish(
      makeEnvelope({
        type: "assistant_message_completed",
        eventId: "evt_update_retry_3",
        createdAt: "2026-03-28T00:00:02.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
        text: "hello",
        reasoningText: null,
        toolCalls: [],
        usage: null,
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(updateCard).toHaveBeenCalledTimes(2);
    expect(updateCard.mock.calls.at(0)?.[0]).toMatchObject({
      path: { card_id: "card_1" },
      data: { sequence: 1 },
    });
    expect(updateCard.mock.calls.at(1)?.[0]).toMatchObject({
      path: { card_id: "card_1" },
      data: { sequence: 1 },
    });

    await runtime.shutdown();
  });

  test("reconciles run card with a higher sequence after an ambiguous 504 update failure", async () => {
    vi.useFakeTimers();
    handle = await createTestDatabase(import.meta.url);
    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_lark_default', 'lark', 'default', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES ('conv_1', 'ci_lark_default', 'oc_chat_1', 'dm', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');
    `);

    new ChannelSurfacesRepo(handle.storage.db).upsert({
      id: "surface_1",
      channelType: "lark",
      channelInstallationId: "default",
      conversationId: "conv_1",
      branchId: "branch_1",
      surfaceKey: "chat:oc_chat_1",
      surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
    });

    const createCard = vi.fn(async (_input: unknown) => ({
      data: { card_id: "card_1" },
    }));
    const createMessage = vi.fn(async (_input: unknown) => ({
      data: { message_id: "om_card_1", open_message_id: "om_open_1" },
    }));
    const streamContent = vi.fn(async (_input: unknown) => ({}));
    const ambiguous504 = new Error("Request failed with status code 504") as Error & {
      response?: { status: number };
    };
    ambiguous504.response = { status: 504 };
    const updateCard = vi.fn().mockRejectedValueOnce(ambiguous504).mockResolvedValueOnce({});
    const bus = new RuntimeEventBus<OrchestratedOutboundEventEnvelope>();
    const runtime = createLarkOutboundRuntime({
      storage: handle.storage.db,
      outboundEventBus: bus,
      clients: {
        getOrCreate: () =>
          ({
            sdk: {
              cardkit: {
                v1: {
                  card: {
                    create: createCard,
                    update: updateCard,
                  },
                  cardElement: {
                    content: streamContent,
                  },
                },
              },
              im: {
                message: {
                  create: createMessage,
                },
              },
            },
          }) as never,
      },
    });

    runtime.start();

    bus.publish(
      makeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_504_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
      }),
    );
    bus.publish(
      makeEnvelope({
        type: "assistant_message_delta",
        eventId: "evt_504_2",
        createdAt: "2026-03-28T00:00:01.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
        delta: "hello",
        accumulatedText: "hello",
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    bus.publish(
      makeEnvelope({
        type: "assistant_message_completed",
        eventId: "evt_504_3",
        createdAt: "2026-03-28T00:00:02.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
        text: "hello",
        reasoningText: null,
        toolCalls: [],
        usage: null,
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(1000);

    expect(updateCard).toHaveBeenCalledTimes(2);
    expect(updateCard.mock.calls.at(0)?.[0]).toMatchObject({
      path: { card_id: "card_1" },
      data: { sequence: 1 },
    });
    expect(updateCard.mock.calls.at(1)?.[0]).toMatchObject({
      path: { card_id: "card_1" },
      data: { sequence: 2 },
    });

    const binding = new LarkObjectBindingsRepo(handle.storage.db).getByInternalObject({
      channelInstallationId: "default",
      internalObjectKind: "run_card",
      internalObjectId: "run_1:seg:1",
    });
    expect(binding?.lastSequence).toBe(2);

    await runtime.shutdown();
  });

  test("reconciles run card with a higher sequence after a sequence-compare failure", async () => {
    vi.useFakeTimers();
    handle = await createTestDatabase(import.meta.url);
    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_lark_default', 'lark', 'default', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES ('conv_1', 'ci_lark_default', 'oc_chat_1', 'dm', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');
    `);

    new ChannelSurfacesRepo(handle.storage.db).upsert({
      id: "surface_1",
      channelType: "lark",
      channelInstallationId: "default",
      conversationId: "conv_1",
      branchId: "branch_1",
      surfaceKey: "chat:oc_chat_1",
      surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
    });

    const createCard = vi.fn(async (_input: unknown) => ({
      data: { card_id: "card_1" },
    }));
    const createMessage = vi.fn(async (_input: unknown) => ({
      data: { message_id: "om_card_1", open_message_id: "om_open_1" },
    }));
    const streamContent = vi.fn(async (_input: unknown) => ({}));
    const updateCard = vi
      .fn()
      .mockResolvedValueOnce({ code: 300317, msg: "ErrMsg: sequence number compare failed;" })
      .mockResolvedValueOnce({});
    const bus = new RuntimeEventBus<OrchestratedOutboundEventEnvelope>();
    const runtime = createLarkOutboundRuntime({
      storage: handle.storage.db,
      outboundEventBus: bus,
      clients: {
        getOrCreate: () =>
          ({
            sdk: {
              cardkit: {
                v1: {
                  card: {
                    create: createCard,
                    update: updateCard,
                  },
                  cardElement: {
                    content: streamContent,
                  },
                },
              },
              im: {
                message: {
                  create: createMessage,
                },
              },
            },
          }) as never,
      },
    });

    runtime.start();

    bus.publish(
      makeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_300317_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
      }),
    );
    bus.publish(
      makeEnvelope({
        type: "assistant_message_delta",
        eventId: "evt_300317_2",
        createdAt: "2026-03-28T00:00:01.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
        delta: "hello",
        accumulatedText: "hello",
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    bus.publish(
      makeEnvelope({
        type: "assistant_message_completed",
        eventId: "evt_300317_3",
        createdAt: "2026-03-28T00:00:02.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
        text: "hello",
        reasoningText: null,
        toolCalls: [],
        usage: null,
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(1000);

    expect(updateCard).toHaveBeenCalledTimes(2);
    expect(updateCard.mock.calls.at(0)?.[0]).toMatchObject({
      path: { card_id: "card_1" },
      data: { sequence: 1 },
    });
    expect(updateCard.mock.calls.at(1)?.[0]).toMatchObject({
      path: { card_id: "card_1" },
      data: { sequence: 2 },
    });

    const binding = new LarkObjectBindingsRepo(handle.storage.db).getByInternalObject({
      channelInstallationId: "default",
      internalObjectKind: "run_card",
      internalObjectId: "run_1:seg:1",
    });
    expect(binding?.lastSequence).toBe(2);

    await runtime.shutdown();
  });

  test("updates steer reactions when a queued steer message is consumed", async () => {
    handle = await createTestDatabase(import.meta.url);
    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_1', 'lark', 'default', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES ('conv_1', 'ci_1', 'oc_chat_1', 'dm', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');
    `);
    new ChannelSurfacesRepo(handle.storage.db).upsert({
      id: "surface_1",
      channelType: "lark",
      channelInstallationId: "default",
      conversationId: "conv_1",
      branchId: "branch_1",
      surfaceKey: "chat:oc_chat_1",
      surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
    });

    const reactionCreate = vi.fn(async () => ({ data: { reaction_id: "react_ok_1" } }));
    const reactionDelete = vi.fn(async () => ({}));
    const bus = new RuntimeEventBus<OrchestratedOutboundEventEnvelope>();
    const steerReactionState = new LarkSteerReactionState();
    steerReactionState.rememberPendingReaction({
      installationId: "default",
      messageId: "om_source_1",
      reactionId: "react_typing_1",
      emojiType: "Typing",
    });
    const runtime = createLarkOutboundRuntime({
      storage: handle.storage.db,
      outboundEventBus: bus,
      clients: {
        getOrCreate: () =>
          ({
            sdk: {
              im: {
                messageReaction: {
                  create: reactionCreate,
                  delete: reactionDelete,
                },
              },
            },
          }) as never,
      },
      steerReactionState,
    });

    runtime.start();

    bus.publish(
      makeEnvelope({
        type: "steer_message_consumed",
        eventId: "evt_steer_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 2,
        messageId: "msg_steer_1",
        channelMessageId: "om_source_1",
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reactionCreate).toHaveBeenCalledExactlyOnceWith({
      path: {
        message_id: "om_source_1",
      },
      data: {
        reaction_type: {
          emoji_type: "OK",
        },
      },
    });
    expect(reactionDelete).toHaveBeenCalledExactlyOnceWith({
      path: {
        message_id: "om_source_1",
        reaction_id: "react_typing_1",
      },
    });

    await runtime.shutdown();
  });

  test("retries run-card visible message send with the same uuid after local finalize failure", async () => {
    vi.useFakeTimers();
    handle = await createTestDatabase(import.meta.url);
    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_lark_default', 'lark', 'default', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES ('conv_1', 'ci_lark_default', 'oc_chat_1', 'dm', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO agents (id, conversation_id, main_agent_id, kind, created_at)
      VALUES ('agent_1', 'conv_1', NULL, 'main', '2026-03-28T00:00:00.000Z');

      INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at)
      VALUES ('sess_task', 'conv_1', 'branch_1', 'agent_1', 'task', 'active', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO cron_jobs (
        id, owner_agent_id, target_conversation_id, target_branch_id, name, schedule_kind, schedule_value,
        payload_json, created_at, updated_at
      )
      VALUES (
        'cron_1', 'agent_1', 'conv_1', 'branch_1', '日报汇总', 'cron', '0 9 * * *',
        '{}', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z'
      );

      INSERT INTO task_runs (
        id, run_type, owner_agent_id, conversation_id, branch_id, cron_job_id, execution_session_id,
        status, priority, attempt, description, started_at
      )
      VALUES (
        'task_1', 'cron', 'agent_1', 'conv_1', 'branch_1', 'cron_1', 'sess_task',
        'running', 0, 1, '日报汇总执行', '2026-03-28T00:00:00.000Z'
      );
    `);

    new ChannelSurfacesRepo(handle.storage.db).upsert({
      id: "surface_1",
      channelType: "lark",
      channelInstallationId: "default",
      conversationId: "conv_1",
      branchId: "branch_1",
      surfaceKey: "chat:oc_chat_1",
      surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
    });

    const createCard = vi.fn(async () => ({ data: { card_id: "card_retry_1" } }));
    let sendCount = 0;
    const createMessage = vi.fn(async (_input: unknown) => {
      sendCount += 1;
      return {
        data: {
          message_id: "om_retry_1",
          open_message_id: "open_retry_1",
        },
      };
    });
    const updateCard = vi.fn(async () => ({}));
    const streamContent = vi.fn(async () => ({}));
    const originalAttachMessageAnchor = LarkObjectBindingsRepo.prototype.attachMessageAnchor;
    const attachMessageAnchor = vi
      .spyOn(LarkObjectBindingsRepo.prototype, "attachMessageAnchor")
      .mockImplementation(function (this: LarkObjectBindingsRepo, input) {
        if (sendCount === 1) {
          return null;
        }
        return originalAttachMessageAnchor.call(this, input);
      });

    const bus = new RuntimeEventBus<OrchestratedOutboundEventEnvelope>();
    const runtime = createLarkOutboundRuntime({
      storage: handle.storage.db,
      outboundEventBus: bus,
      clients: {
        getOrCreate: () =>
          ({
            sdk: {
              cardkit: {
                v1: {
                  card: {
                    create: createCard,
                    update: updateCard,
                  },
                  cardElement: {
                    content: streamContent,
                  },
                },
              },
              im: {
                message: {
                  create: createMessage,
                },
              },
            },
          }) as never,
      },
    });

    runtime.start();
    bus.publish(
      makeEnvelope({
        type: "assistant_message_completed",
        eventId: "evt_retry_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_retry_1",
        turn: 1,
        messageId: "msg_retry_1",
        text: "retry me",
        reasoningText: null,
        toolCalls: [],
        usage: null,
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledOnce();
    expect(createMessage).toHaveBeenCalledOnce();

    const firstUuid = (createMessage.mock.calls[0]?.[0] as { data?: { uuid?: string } } | undefined)
      ?.data?.uuid;
    expect(firstUuid).toBeTruthy();

    bus.publish(
      makeEnvelope({
        type: "assistant_message_completed",
        eventId: "evt_retry_2",
        createdAt: "2026-03-28T00:00:01.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_retry_1",
        turn: 2,
        messageId: "msg_retry_2",
        text: "retry me again",
        reasoningText: null,
        toolCalls: [],
        usage: null,
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledOnce();
    expect(createMessage).toHaveBeenCalledTimes(2);
    const secondUuid = (
      createMessage.mock.calls[1]?.[0] as { data?: { uuid?: string } } | undefined
    )?.data?.uuid;
    expect(secondUuid).toBe(firstUuid);

    const binding = new LarkObjectBindingsRepo(handle.storage.db).getByInternalObject({
      channelInstallationId: "default",
      internalObjectKind: "run_card",
      internalObjectId: "run_1:seg:1",
    });
    expect(binding).toMatchObject({
      larkMessageUuid: firstUuid,
      larkMessageId: "om_retry_1",
      larkCardId: "card_retry_1",
    });

    attachMessageAnchor.mockRestore();
    await runtime.shutdown();
  });

  test("delivers thread branch run cards with message.reply(reply_in_thread=true)", async () => {
    vi.useFakeTimers();
    handle = await createTestDatabase(import.meta.url);
    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_lark_default', 'lark', 'default', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES ('conv_1', 'ci_lark_default', 'oc_chat_1', 'dm', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, external_branch_id, parent_branch_id, created_at, updated_at)
      VALUES
        ('branch_1', 'conv_1', 'dm_main', 'main', NULL, NULL, '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z'),
        ('branch_thread_1', 'conv_1', 'dm_thread', 'thread:omt_thread_1', 'omt_thread_1', 'branch_1', '2026-03-28T00:00:01.000Z', '2026-03-28T00:00:01.000Z');
    `);

    new ChannelSurfacesRepo(handle.storage.db).upsert({
      id: "surface_thread_1",
      channelType: "lark",
      channelInstallationId: "default",
      conversationId: "conv_1",
      branchId: "branch_thread_1",
      surfaceKey: "chat:oc_chat_1:thread:omt_thread_1",
      surfaceObjectJson: JSON.stringify({
        chat_id: "oc_chat_1",
        thread_id: "omt_thread_1",
        reply_to_message_id: "om_parent_1",
      }),
    });

    const createCard = vi.fn(async () => ({
      data: {
        card_id: "card_thread_1",
      },
    }));
    const reply = vi.fn(async () => ({
      data: {
        message_id: "om_thread_card_1",
        open_message_id: "om_thread_open_1",
      },
    }));
    const bus = new RuntimeEventBus<OrchestratedOutboundEventEnvelope>();
    const runtime = createLarkOutboundRuntime({
      storage: handle.storage.db,
      outboundEventBus: bus,
      clients: {
        getOrCreate: () =>
          ({
            sdk: {
              cardkit: {
                v1: {
                  card: {
                    create: createCard,
                    update: vi.fn(async () => ({})),
                  },
                  cardElement: {
                    content: vi.fn(async () => ({})),
                  },
                },
              },
              im: {
                message: {
                  create: vi.fn(async () => {
                    throw new Error("should not use chat create for thread delivery");
                  }),
                  reply,
                },
              },
            },
          }) as never,
      },
    });

    runtime.start();
    bus.publish({
      ...makeEnvelope({
        type: "assistant_message_completed",
        eventId: "evt_thread_1",
        createdAt: "2026-03-28T00:00:02.000Z",
        sessionId: "sess_thread_1",
        conversationId: "conv_1",
        branchId: "branch_thread_1",
        runId: "run_thread_1",
        messageId: "msg_thread_1",
        turn: 1,
        text: "thread reply",
        reasoningText: null,
        toolCalls: [],
        usage: null,
      }),
      target: {
        conversationId: "conv_1",
        branchId: "branch_thread_1",
      },
      session: {
        sessionId: "sess_thread_1",
        purpose: "chat",
      },
      run: {
        runId: "run_thread_1",
      },
    });

    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledOnce();
    expect((reply as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]).toMatchObject(
      {
        path: { message_id: "om_parent_1" },
        data: {
          msg_type: "interactive",
          reply_in_thread: true,
          uuid: expect.any(String),
        },
      },
    );

    expect(
      new LarkObjectBindingsRepo(handle.storage.db).getByInternalObject({
        channelInstallationId: "default",
        internalObjectKind: "run_card",
        internalObjectId: "run_thread_1:seg:1",
      }),
    ).toMatchObject({
      larkMessageId: "om_thread_card_1",
      threadRootMessageId: "omt_thread_1",
    });
  });

  test("creates a placeholder card before first delta, then streams text and finalizes", async () => {
    vi.useFakeTimers();
    handle = await createTestDatabase(import.meta.url);
    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_lark_default', 'lark', 'default', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES ('conv_1', 'ci_lark_default', 'oc_chat_1', 'dm', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

    `);

    new ChannelSurfacesRepo(handle.storage.db).upsert({
      id: "surface_1",
      channelType: "lark",
      channelInstallationId: "default",
      conversationId: "conv_1",
      branchId: "branch_1",
      surfaceKey: "chat:oc_chat_1",
      surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
    });

    const createCard = vi.fn(async (_input: unknown) => ({
      data: {
        card_id: "card_1",
      },
    }));
    const createMessage = vi.fn(async (_input: unknown) => ({
      data: {
        message_id: "om_card_1",
        open_message_id: "om_open_1",
      },
    }));
    const updateCard = vi.fn(async (_input: unknown) => ({}));
    const streamContent = vi.fn(async (_input: unknown) => ({}));
    const bus = new RuntimeEventBus<OrchestratedOutboundEventEnvelope>();
    const runtime = createLarkOutboundRuntime({
      storage: handle.storage.db,
      outboundEventBus: bus,
      clients: {
        getOrCreate: () =>
          ({
            sdk: {
              cardkit: {
                v1: {
                  card: {
                    create: createCard,
                    update: updateCard,
                  },
                  cardElement: {
                    content: streamContent,
                  },
                },
              },
              im: {
                message: {
                  create: createMessage,
                },
              },
            },
          }) as never,
      },
    });

    runtime.start();

    bus.publish(
      makeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_p1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledOnce();
    expect(JSON.stringify(createCard.mock.calls.at(0)?.[0])).toContain("_正在思考..._");
    expect(streamContent).not.toHaveBeenCalled();

    bus.publish(
      makeEnvelope({
        type: "assistant_message_delta",
        eventId: "evt_p2",
        createdAt: "2026-03-28T00:00:01.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
        delta: "h",
        accumulatedText: "hello",
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(updateCard).toHaveBeenCalledOnce();
    expect(streamContent).not.toHaveBeenCalled();

    bus.publish(
      makeEnvelope({
        type: "assistant_message_delta",
        eventId: "evt_p3",
        createdAt: "2026-03-28T00:00:02.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
        delta: " world",
        accumulatedText: "hello world",
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(streamContent).toHaveBeenCalledOnce();

    await runtime.shutdown();
  });

  test("prefers a full update over streaming when tool-group structure changes before assistant text resumes", async () => {
    vi.useFakeTimers();
    handle = await createTestDatabase(import.meta.url);
    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_lark_default', 'lark', 'default', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES ('conv_1', 'ci_lark_default', 'oc_chat_1', 'dm', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO agents (id, conversation_id, main_agent_id, kind, created_at)
      VALUES ('agent_1', 'conv_1', NULL, 'main', '2026-03-28T00:00:00.000Z');

      INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at)
      VALUES ('sess_task', 'conv_1', 'branch_1', 'agent_1', 'task', 'active', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO cron_jobs (
        id, owner_agent_id, target_conversation_id, target_branch_id, name, schedule_kind, schedule_value,
        payload_json, created_at, updated_at
      )
      VALUES (
        'cron_1', 'agent_1', 'conv_1', 'branch_1', '日报汇总', 'cron', '0 9 * * *',
        '{}', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z'
      );

      INSERT INTO task_runs (
        id, run_type, owner_agent_id, conversation_id, branch_id, cron_job_id, execution_session_id,
        status, priority, attempt, description, started_at
      )
      VALUES (
        'task_1', 'cron', 'agent_1', 'conv_1', 'branch_1', 'cron_1', 'sess_task',
        'running', 0, 1, '日报汇总执行', '2026-03-28T00:00:00.000Z'
      );
    `);

    new ChannelSurfacesRepo(handle.storage.db).upsert({
      id: "surface_1",
      channelType: "lark",
      channelInstallationId: "default",
      conversationId: "conv_1",
      branchId: "branch_1",
      surfaceKey: "chat:oc_chat_1",
      surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
    });

    const createCard = vi.fn(async (_input: unknown) => ({
      data: { card_id: "card_1" },
    }));
    const createMessage = vi.fn(async (_input: unknown) => ({
      data: { message_id: "om_card_1", open_message_id: "om_open_1" },
    }));
    const updateCard = vi.fn(async (_input: unknown) => ({}));
    const streamContent = vi.fn(async (_input: unknown) => ({}));
    const bus = new RuntimeEventBus<OrchestratedOutboundEventEnvelope>();
    const runtime = createLarkOutboundRuntime({
      storage: handle.storage.db,
      outboundEventBus: bus,
      clients: {
        getOrCreate: () =>
          ({
            sdk: {
              cardkit: {
                v1: {
                  card: { create: createCard, update: updateCard },
                  cardElement: { content: streamContent },
                },
              },
              im: {
                message: {
                  create: createMessage,
                },
              },
            },
          }) as never,
      },
    });

    runtime.start();

    for (const index of [1, 2, 3]) {
      bus.publish(
        makeEnvelope({
          type: "tool_call_started",
          eventId: `evt_ts_${index}`,
          createdAt: "2026-03-28T00:00:00.000Z",
          sessionId: "sess_1",
          conversationId: "conv_1",
          branchId: "branch_1",
          runId: "run_1",
          turn: 1,
          toolCallId: `tool_${index}`,
          toolName: index === 3 ? "bash" : "read_file",
          args: index === 3 ? { command: "pwd" } : { path: `file_${index}` },
        }),
      );
      bus.publish(
        makeEnvelope({
          type: "tool_call_completed",
          eventId: `evt_tc_${index}`,
          createdAt: "2026-03-28T00:00:01.000Z",
          sessionId: "sess_1",
          conversationId: "conv_1",
          branchId: "branch_1",
          runId: "run_1",
          turn: 1,
          toolCallId: `tool_${index}`,
          toolName: index === 3 ? "bash" : "read_file",
          messageId: `tool_msg_${index}`,
          result: { ok: true },
        } as never),
      );
    }

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledOnce();

    bus.publish(
      makeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_as_1",
        createdAt: "2026-03-28T00:00:02.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 2,
        messageId: "msg_1",
      }),
    );
    bus.publish(
      makeEnvelope({
        type: "assistant_message_delta",
        eventId: "evt_ad_1",
        createdAt: "2026-03-28T00:00:03.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 2,
        messageId: "msg_1",
        delta: "h",
        accumulatedText: "hello",
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(updateCard).toHaveBeenCalledOnce();
    expect(streamContent).not.toHaveBeenCalled();

    bus.publish(
      makeEnvelope({
        type: "assistant_message_delta",
        eventId: "evt_ad_2",
        createdAt: "2026-03-28T00:00:04.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 2,
        messageId: "msg_1",
        delta: " world",
        accumulatedText: "hello world",
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(streamContent).toHaveBeenCalledOnce();

    await runtime.shutdown();
  });

  test("replies with a full markdown card in the task thread when the final summary is truncated", async () => {
    vi.useFakeTimers();
    handle = await createTestDatabase(import.meta.url);
    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_lark_default', 'lark', 'default', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES ('conv_1', 'ci_lark_default', 'oc_chat_1', 'dm', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO agents (id, conversation_id, main_agent_id, kind, created_at)
      VALUES ('agent_1', 'conv_1', NULL, 'main', '2026-03-28T00:00:00.000Z');

      INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at)
      VALUES ('sess_task', 'conv_1', 'branch_1', 'agent_1', 'task', 'active', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO cron_jobs (
        id, owner_agent_id, target_conversation_id, target_branch_id, name, schedule_kind, schedule_value,
        payload_json, created_at, updated_at
      )
      VALUES (
        'cron_1', 'agent_1', 'conv_1', 'branch_1', '日报汇总', 'cron', '0 9 * * *',
        '{}', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z'
      );

      INSERT INTO task_runs (
        id, run_type, owner_agent_id, conversation_id, branch_id, cron_job_id, execution_session_id,
        status, priority, attempt, description, started_at
      )
      VALUES (
        'task_1', 'cron', 'agent_1', 'conv_1', 'branch_1', 'cron_1', 'sess_task',
        'running', 0, 1, '日报汇总执行', '2026-03-28T00:00:00.000Z'
      );
    `);

    new ChannelSurfacesRepo(handle.storage.db).upsert({
      id: "surface_1",
      channelType: "lark",
      channelInstallationId: "default",
      conversationId: "conv_1",
      branchId: "branch_1",
      surfaceKey: "chat:oc_chat_1",
      surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
    });

    const createCard = vi.fn(async () => ({
      data: {
        card_id: "card_task_status_1",
      },
    }));
    const createMessage = vi.fn(async () => ({
      data: {
        message_id: "om_task_card_1",
        open_message_id: "om_task_open_1",
      },
    }));
    const reply = vi.fn(async () => ({
      data: {
        message_id: "om_task_thread_full_1",
        open_message_id: "om_task_thread_full_open_1",
      },
    }));
    const updateCard = vi.fn(async (_input: unknown) => ({}));
    const bus = new RuntimeEventBus<OrchestratedOutboundEventEnvelope>();
    const runtime = createLarkOutboundRuntime({
      storage: handle.storage.db,
      outboundEventBus: bus,
      clients: {
        getOrCreate: () =>
          ({
            sdk: {
              cardkit: {
                v1: {
                  card: { create: createCard, update: updateCard },
                  cardElement: { content: vi.fn(async () => ({})) },
                },
              },
              im: {
                message: {
                  create: createMessage,
                  reply,
                },
              },
            },
          }) as never,
      },
    });

    runtime.start();

    bus.publish(
      makeTaskEnvelope({
        type: "task_run_started",
        taskRunId: "task_1",
        runType: "cron",
        status: "running",
        startedAt: "2026-03-28T00:00:00.000Z",
        initiatorSessionId: null,
        parentRunId: null,
        cronJobId: "cron_1",
        executionSessionId: "sess_task",
      }),
    );

    const longSummary = `${"完整结果".repeat(450)} tail-end-marker`;
    bus.publish(
      makeTaskEnvelope({
        type: "task_run_completed",
        taskRunId: "task_1",
        runType: "cron",
        status: "completed",
        startedAt: "2026-03-28T00:00:00.000Z",
        finishedAt: "2026-03-28T00:01:00.000Z",
        durationMs: 60_000,
        resultSummary: longSummary,
        executionSessionId: "sess_task",
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledOnce();
    expect(createMessage).toHaveBeenCalledOnce();
    expect(updateCard).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce();

    const createCardCalls = createCard.mock.calls as unknown[][];
    const replyCalls = reply.mock.calls as unknown[][];

    const taskCardCreate = JSON.stringify(createCardCalls.at(0)?.[0] ?? {});
    expect(taskCardCreate).toContain("...");
    expect(taskCardCreate).not.toContain("tail-end-marker");

    const fullReplyPayload = replyCalls.at(0)?.[0] as
      | { data?: { msg_type?: string; content?: string }; path?: { message_id?: string } }
      | undefined;
    expect(fullReplyPayload?.path?.message_id).toBe("om_task_card_1");
    expect(fullReplyPayload?.data?.msg_type).toBe("interactive");
    expect(fullReplyPayload?.data?.content ?? "").toContain("日报汇总 · 完整结果");
    expect(fullReplyPayload?.data?.content ?? "").toContain("tail-end-marker");

    await runtime.shutdown();
  });

  test("does not render approval-session runtime transcript into the visible lark chat", async () => {
    vi.useFakeTimers();
    handle = await createTestDatabase(import.meta.url);
    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_lark_default', 'lark', 'default', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES ('conv_1', 'ci_lark_default', 'oc_chat_1', 'dm', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO agents (id, conversation_id, main_agent_id, kind, created_at)
      VALUES ('agent_1', 'conv_1', NULL, 'main', '2026-03-28T00:00:00.000Z');

      INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at)
      VALUES ('sess_task', 'conv_1', 'branch_1', 'agent_1', 'task', 'active', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO cron_jobs (
        id, owner_agent_id, target_conversation_id, target_branch_id, name, schedule_kind, schedule_value,
        payload_json, created_at, updated_at
      )
      VALUES (
        'cron_1', 'agent_1', 'conv_1', 'branch_1', '日报汇总', 'cron', '0 9 * * *',
        '{}', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z'
      );

      INSERT INTO task_runs (
        id, run_type, owner_agent_id, conversation_id, branch_id, cron_job_id, execution_session_id,
        status, priority, attempt, description, started_at
      )
      VALUES (
        'task_1', 'cron', 'agent_1', 'conv_1', 'branch_1', 'cron_1', 'sess_task',
        'running', 0, 1, '日报汇总执行', '2026-03-28T00:00:00.000Z'
      );
    `);

    new ChannelSurfacesRepo(handle.storage.db).upsert({
      id: "surface_1",
      channelType: "lark",
      channelInstallationId: "default",
      conversationId: "conv_1",
      branchId: "branch_1",
      surfaceKey: "chat:oc_chat_1",
      surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
    });

    const createCard = vi.fn(async (_input: unknown) => ({
      data: {
        card_id: "card_approval_runtime_1",
      },
    }));
    const createMessage = vi.fn(async (_input: unknown) => ({
      data: {
        message_id: "om_card_approval_runtime_1",
        open_message_id: "om_open_approval_runtime_1",
      },
    }));
    const updateCard = vi.fn(async (_input: unknown) => ({}));
    const streamContent = vi.fn(async (_input: unknown) => ({}));
    const bus = new RuntimeEventBus<OrchestratedOutboundEventEnvelope>();
    const runtime = createLarkOutboundRuntime({
      storage: handle.storage.db,
      outboundEventBus: bus,
      clients: {
        getOrCreate: () =>
          ({
            sdk: {
              cardkit: {
                v1: {
                  card: { create: createCard, update: updateCard },
                  cardElement: { content: streamContent },
                },
              },
              im: {
                message: {
                  create: createMessage,
                },
              },
            },
          }) as never,
      },
    });

    runtime.start();

    bus.publish(
      makeApprovalRuntimeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_approval_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_approval",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_approval_1",
        turn: 1,
        messageId: "msg_approval_1",
      }),
    );
    bus.publish(
      makeApprovalRuntimeEnvelope({
        type: "assistant_message_delta",
        eventId: "evt_approval_2",
        createdAt: "2026-03-28T00:00:01.000Z",
        sessionId: "sess_approval",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_approval_1",
        turn: 1,
        messageId: "msg_approval_1",
        delta: "approval review",
        accumulatedText: "approval review",
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).not.toHaveBeenCalled();
    expect(createMessage).not.toHaveBeenCalled();
    expect(updateCard).not.toHaveBeenCalled();
    expect(streamContent).not.toHaveBeenCalled();

    await runtime.shutdown();
  });

  test("creates a standalone approval card and resumes in a new run card segment after approval", async () => {
    vi.useFakeTimers();
    handle = await createTestDatabase(import.meta.url);
    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_lark_default', 'lark', 'default', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES ('conv_1', 'ci_lark_default', 'oc_chat_1', 'dm', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO agents (id, conversation_id, main_agent_id, kind, created_at)
      VALUES ('agent_1', 'conv_1', NULL, 'main', '2026-03-28T00:00:00.000Z');

      INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at)
      VALUES ('sess_task', 'conv_1', 'branch_1', 'agent_1', 'task', 'active', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO cron_jobs (
        id, owner_agent_id, target_conversation_id, target_branch_id, name, schedule_kind, schedule_value,
        payload_json, created_at, updated_at
      )
      VALUES (
        'cron_1', 'agent_1', 'conv_1', 'branch_1', '日报汇总', 'cron', '0 9 * * *',
        '{}', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z'
      );

      INSERT INTO task_runs (
        id, run_type, owner_agent_id, conversation_id, branch_id, cron_job_id, execution_session_id,
        status, priority, attempt, description, started_at
      )
      VALUES (
        'task_1', 'cron', 'agent_1', 'conv_1', 'branch_1', 'cron_1', 'sess_task',
        'running', 0, 1, '日报汇总执行', '2026-03-28T00:00:00.000Z'
      );
    `);

    new ChannelSurfacesRepo(handle.storage.db).upsert({
      id: "surface_1",
      channelType: "lark",
      channelInstallationId: "default",
      conversationId: "conv_1",
      branchId: "branch_1",
      surfaceKey: "chat:oc_chat_1",
      surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
    });

    const createCard = vi
      .fn()
      .mockResolvedValueOnce({ data: { card_id: "card_run_1" } })
      .mockResolvedValueOnce({ data: { card_id: "card_approval_1" } })
      .mockResolvedValueOnce({ data: { card_id: "card_run_2" } });
    const createMessage = vi
      .fn()
      .mockResolvedValueOnce({ data: { message_id: "om_run_1", open_message_id: "oom_run_1" } })
      .mockResolvedValueOnce({
        data: { message_id: "om_approval_1", open_message_id: "oom_approval_1" },
      })
      .mockResolvedValueOnce({ data: { message_id: "om_run_2", open_message_id: "oom_run_2" } });
    const updateCard = vi.fn(async (_input: unknown) => ({}));
    const streamContent = vi.fn(async (_input: unknown) => ({}));
    const bus = new RuntimeEventBus<OrchestratedOutboundEventEnvelope>();
    const runtime = createLarkOutboundRuntime({
      storage: handle.storage.db,
      outboundEventBus: bus,
      clients: {
        getOrCreate: () =>
          ({
            sdk: {
              cardkit: {
                v1: {
                  card: { create: createCard, update: updateCard },
                  cardElement: { content: streamContent },
                },
              },
              im: {
                message: {
                  create: createMessage,
                },
              },
            },
          }) as never,
      },
    });

    runtime.start();

    bus.publish(
      makeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_appr_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
      }),
    );
    bus.publish(
      makeEnvelope({
        type: "assistant_message_delta",
        eventId: "evt_appr_2",
        createdAt: "2026-03-28T00:00:01.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
        delta: "hi",
        accumulatedText: "hi",
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    bus.publish(
      makeEnvelope({
        type: "tool_call_started",
        eventId: "evt_appr_tool_1",
        createdAt: "2026-03-28T00:00:01.500Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        toolCallId: "tool_request_1",
        toolName: "request_permissions",
        args: {
          entries: [
            {
              resource: "filesystem",
              path: "/tmp/secret.txt",
              access: "write",
              scope: "exact",
            },
          ],
          justification: "Need to write the output file.",
        },
      }),
    );

    bus.publish(
      makeEnvelope({
        type: "approval_requested",
        eventId: "evt_appr_3",
        createdAt: "2026-03-28T00:00:02.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        approvalId: "approval_1",
        approvalTarget: "user",
        title: "需要授权",
        request: {
          scopes: [{ kind: "fs.write", path: "/tmp/secret.txt" }],
        },
        reasonText: "需要执行危险操作。",
        expiresAt: null,
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(createCard.mock.calls.at(1)?.[0])).toContain("授权请求");
    expect(updateCard).toHaveBeenCalledOnce();
    const oldRunCardTextAfterApproval = JSON.stringify(updateCard.mock.calls.at(0)?.[0]);
    expect(oldRunCardTextAfterApproval).toContain("request_permissions");
    expect(oldRunCardTextAfterApproval).toContain("等待授权");
    expect(oldRunCardTextAfterApproval).toContain("等待授权处理");
    expect(oldRunCardTextAfterApproval).toContain("Need to write the output file.");

    const firstRunBinding = new LarkObjectBindingsRepo(handle.storage.db).getByInternalObject({
      channelInstallationId: "default",
      internalObjectKind: "run_card",
      internalObjectId: "run_1:seg:1",
    });
    const approvalBinding = new LarkObjectBindingsRepo(handle.storage.db).getByInternalObject({
      channelInstallationId: "default",
      internalObjectKind: "approval_card",
      internalObjectId: "approval_1",
    });
    expect(firstRunBinding?.larkCardId).toBe("card_run_1");
    expect(approvalBinding?.larkCardId).toBe("card_approval_1");

    bus.publish(
      makeEnvelope({
        type: "approval_resolved",
        eventId: "evt_appr_4",
        createdAt: "2026-03-28T00:00:03.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        approvalId: "approval_1",
        decision: "approve",
        actor: "user:demo",
        rawInput: "approve_1d",
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(updateCard).toHaveBeenCalledTimes(3);

    bus.publish(
      makeEnvelope({
        type: "tool_call_completed",
        eventId: "evt_appr_4b",
        createdAt: "2026-03-28T00:00:03.500Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        toolCallId: "tool_request_1",
        toolName: "request_permissions",
        messageId: "tool_msg_request_1",
        result: { status: "approved" },
      } as never),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledTimes(2);
    expect(
      new LarkObjectBindingsRepo(handle.storage.db).getByInternalObject({
        channelInstallationId: "default",
        internalObjectKind: "run_card",
        internalObjectId: "run_1:seg:2",
      }),
    ).toBeNull();

    bus.publish(
      makeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_appr_5",
        createdAt: "2026-03-28T00:00:04.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 2,
        messageId: "msg_2",
      }),
    );
    bus.publish(
      makeEnvelope({
        type: "assistant_message_delta",
        eventId: "evt_appr_6",
        createdAt: "2026-03-28T00:00:05.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 2,
        messageId: "msg_2",
        delta: "done",
        accumulatedText: "done",
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledTimes(3);
    const secondRunBinding = new LarkObjectBindingsRepo(handle.storage.db).getByInternalObject({
      channelInstallationId: "default",
      internalObjectKind: "run_card",
      internalObjectId: "run_1:seg:2",
    });
    expect(secondRunBinding?.larkCardId).toBe("card_run_2");

    await runtime.shutdown();
  });

  test("renders reusable bash prefixes on standalone approval cards", async () => {
    vi.useFakeTimers();
    handle = await createTestDatabase(import.meta.url);
    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_lark_default', 'lark', 'default', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES ('conv_1', 'ci_lark_default', 'oc_chat_1', 'dm', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO agents (id, conversation_id, kind, created_at)
      VALUES ('agent_1', 'conv_1', 'main', '2026-03-28T00:00:00.000Z');

      INSERT INTO approval_ledger (
        id, owner_agent_id, requested_scope_json, approval_target, status, reason_text, created_at
      ) VALUES (
        1,
        'agent_1',
        '{"scopes":[{"kind":"bash.full_access","prefix":["git","status"]}]}',
        'user',
        'pending',
        'Need git status.',
        '2026-03-28T00:00:00.000Z'
      );
    `);

    new ChannelSurfacesRepo(handle.storage.db).upsert({
      id: "surface_1",
      channelType: "lark",
      channelInstallationId: "default",
      conversationId: "conv_1",
      branchId: "branch_1",
      surfaceKey: "chat:oc_chat_1",
      surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
    });

    const createCard = vi.fn(async () => ({ data: { card_id: "card_approval_1" } }));
    const createMessage = vi.fn(async () => ({
      data: { message_id: "om_approval_1", open_message_id: "oom_approval_1" },
    }));
    const updateCard = vi.fn(async () => ({}));
    const bus = new RuntimeEventBus<OrchestratedOutboundEventEnvelope>();
    const runtime = createLarkOutboundRuntime({
      storage: handle.storage.db,
      outboundEventBus: bus,
      clients: {
        getOrCreate: () =>
          ({
            sdk: {
              cardkit: {
                v1: {
                  card: { create: createCard, update: updateCard },
                  cardElement: { content: vi.fn(async () => ({})) },
                },
              },
              im: {
                message: {
                  create: createMessage,
                },
              },
            },
          }) as never,
      },
    });

    runtime.start();

    bus.publish(
      makeEnvelope({
        type: "approval_requested",
        eventId: "evt_appr_prefix_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        approvalId: "1",
        approvalTarget: "user",
        title: "Approval required: run bash with full access for prefix git status",
        request: {
          scopes: [{ kind: "bash.full_access", prefix: ["git", "status"] }],
        },
        reasonText: "Need git status.",
        expiresAt: null,
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledOnce();
    const approvalCardInput = (createCard.mock.calls as unknown as Array<[unknown]>)[0]?.[0];
    const approvalCardText = JSON.stringify(approvalCardInput);
    expect(approvalCardText).not.toContain("Prefix");
    expect(approvalCardText).not.toContain("**权限**");
    expect(approvalCardText).toContain("**命令**");
    expect(approvalCardText).toContain("git status");
    expect(updateCard).not.toHaveBeenCalled();

    await runtime.shutdown();
  });

  test("renders every requested permission on standalone approval cards", async () => {
    vi.useFakeTimers();
    handle = await createTestDatabase(import.meta.url);
    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_lark_default', 'lark', 'default', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES ('conv_1', 'ci_lark_default', 'oc_chat_1', 'dm', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO agents (id, conversation_id, kind, created_at)
      VALUES ('agent_1', 'conv_1', 'main', '2026-03-28T00:00:00.000Z');

      INSERT INTO approval_ledger (
        id, owner_agent_id, requested_scope_json, approval_target, status, reason_text, created_at
      ) VALUES (
        1,
        'agent_1',
        '{"scopes":[{"kind":"fs.read","path":"/Users/example/project/README.md"},{"kind":"fs.write","path":"/Users/example/project/output.txt"}]}',
        'user',
        'pending',
        'Need to inspect and update project files.',
        '2026-03-28T00:00:00.000Z'
      );
    `);

    new ChannelSurfacesRepo(handle.storage.db).upsert({
      id: "surface_1",
      channelType: "lark",
      channelInstallationId: "default",
      conversationId: "conv_1",
      branchId: "branch_1",
      surfaceKey: "chat:oc_chat_1",
      surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
    });

    const createCard = vi.fn(async () => ({ data: { card_id: "card_approval_1" } }));
    const createMessage = vi.fn(async () => ({
      data: { message_id: "om_approval_1", open_message_id: "oom_approval_1" },
    }));
    const updateCard = vi.fn(async () => ({}));
    const bus = new RuntimeEventBus<OrchestratedOutboundEventEnvelope>();
    const runtime = createLarkOutboundRuntime({
      storage: handle.storage.db,
      outboundEventBus: bus,
      clients: {
        getOrCreate: () =>
          ({
            sdk: {
              cardkit: {
                v1: {
                  card: { create: createCard, update: updateCard },
                  cardElement: { content: vi.fn(async () => ({})) },
                },
              },
              im: {
                message: {
                  create: createMessage,
                },
              },
            },
          }) as never,
      },
    });

    runtime.start();

    bus.publish(
      makeEnvelope({
        type: "approval_requested",
        eventId: "evt_appr_multi_scope_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        approvalId: "1",
        approvalTarget: "user",
        title: "Approval required",
        request: {
          scopes: [
            { kind: "fs.read", path: "/Users/example/project/README.md" },
            { kind: "fs.write", path: "/Users/example/project/output.txt" },
          ],
        },
        reasonText: "Need to inspect and update project files.",
        expiresAt: null,
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledOnce();
    const approvalCardInput = (createCard.mock.calls as unknown as Array<[unknown]>)[0]?.[0];
    const approvalCardText = JSON.stringify(approvalCardInput);
    expect(approvalCardText).toContain("**权限**");
    expect(approvalCardText).toContain("**Read** `/Users/example/project/README.md`");
    expect(approvalCardText).toContain("**Write** `/Users/example/project/output.txt`");
    expect(approvalCardText).not.toContain("2 permissions");
    expect(approvalCardText).not.toContain("**操作**：Approval required");
    expect(approvalCardText).toContain("### 授权运行命令");

    await runtime.shutdown();
  });

  test("delivers one task-thread approval card across timeout fallback and delegated approval", async () => {
    vi.useFakeTimers();
    handle = await createTestDatabase(import.meta.url);
    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_lark_default', 'lark', 'default', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES ('conv_1', 'ci_lark_default', 'oc_chat_1', 'dm', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO agents (id, conversation_id, main_agent_id, kind, created_at)
      VALUES ('agent_1', 'conv_1', NULL, 'main', '2026-03-28T00:00:00.000Z');

      INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at)
      VALUES ('sess_task', 'conv_1', 'branch_1', 'agent_1', 'task', 'active', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO cron_jobs (
        id, owner_agent_id, target_conversation_id, target_branch_id, name, schedule_kind, schedule_value,
        payload_json, created_at, updated_at
      )
      VALUES (
        'cron_1', 'agent_1', 'conv_1', 'branch_1', '日报汇总', 'cron', '0 9 * * *',
        '{}', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z'
      );

      INSERT INTO task_runs (
        id, run_type, owner_agent_id, conversation_id, branch_id, cron_job_id, execution_session_id,
        status, priority, attempt, description, started_at
      )
      VALUES (
        'task_1', 'cron', 'agent_1', 'conv_1', 'branch_1', 'cron_1', 'sess_task',
        'running', 0, 1, '日报汇总执行', '2026-03-28T00:00:00.000Z'
      );
    `);

    new ChannelSurfacesRepo(handle.storage.db).upsert({
      id: "surface_1",
      channelType: "lark",
      channelInstallationId: "default",
      conversationId: "conv_1",
      branchId: "branch_1",
      surfaceKey: "chat:oc_chat_1",
      surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
    });

    const createCard = vi
      .fn()
      .mockResolvedValueOnce({ data: { card_id: "card_task_status_1" } })
      .mockResolvedValueOnce({ data: { card_id: "card_approval_flow_1" } });
    const createMessage = vi
      .fn()
      .mockResolvedValueOnce({ data: { message_id: "om_task_1", open_message_id: "oom_task_1" } });
    const reply = vi.fn().mockResolvedValueOnce({
      data: {
        message_id: "om_task_thread_approval_1",
        open_message_id: "oom_task_thread_approval_1",
      },
    });
    const updateCard = vi.fn(async () => ({}));
    const bus = new RuntimeEventBus<OrchestratedOutboundEventEnvelope>();
    const runtime = createLarkOutboundRuntime({
      storage: handle.storage.db,
      outboundEventBus: bus,
      clients: {
        getOrCreate: () =>
          ({
            sdk: {
              cardkit: {
                v1: {
                  card: { create: createCard, update: updateCard },
                  cardElement: { content: vi.fn(async () => ({})) },
                },
              },
              im: {
                message: {
                  create: createMessage,
                  reply,
                },
              },
            },
          }) as never,
      },
    });

    runtime.start();

    bus.publish(
      makeTaskEnvelope({
        type: "task_run_started",
        taskRunId: "task_1",
        runType: "cron",
        status: "running",
        startedAt: "2026-03-28T00:00:00.000Z",
        initiatorSessionId: null,
        parentRunId: null,
        cronJobId: "cron_1",
        executionSessionId: "sess_task",
      }),
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    bus.publish(
      makeTaskRuntimeEnvelope({
        type: "approval_requested",
        eventId: "evt_task_perm_1",
        createdAt: "2026-03-28T00:00:01.000Z",
        sessionId: "sess_task",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_task_1",
        approvalId: "approval_1",
        approvalFlowId: "flow_1",
        approvalAttemptIndex: 1,
        approvalTarget: "user",
        title: "需要授权",
        request: {
          scopes: [{ kind: "fs.write", path: "/tmp/secret.txt" }],
        },
        reasonText: "需要执行危险操作。",
        expiresAt: null,
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledTimes(2);
    expect(createMessage).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledOnce();
    expect(
      new LarkObjectBindingsRepo(handle.storage.db).getByInternalObject({
        channelInstallationId: "default",
        internalObjectKind: "approval_card",
        internalObjectId: "flow_1",
      }),
    ).toMatchObject({
      larkCardId: "card_approval_flow_1",
      larkMessageId: "om_task_thread_approval_1",
    });

    const replyInput = (reply.mock.calls as unknown[][]).at(0)?.[0] as
      | { path?: { message_id?: string } }
      | undefined;
    expect(replyInput?.path?.message_id).toBe("om_task_1");

    bus.publish(
      makeTaskRuntimeEnvelope({
        type: "approval_resolved",
        eventId: "evt_task_perm_2",
        createdAt: "2026-03-28T00:00:20.000Z",
        sessionId: "sess_task",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_task_1",
        approvalId: "approval_1",
        approvalFlowId: "flow_1",
        approvalAttemptIndex: 1,
        decision: "deny",
        actor: "system:timeout",
        rawInput: null,
        flowContinues: true,
      }),
    );
    bus.publish(
      makeTaskRuntimeEnvelope({
        type: "approval_requested",
        eventId: "evt_task_perm_3",
        createdAt: "2026-03-28T00:00:20.100Z",
        sessionId: "sess_task",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_task_1",
        approvalId: "approval_2",
        approvalFlowId: "flow_1",
        approvalAttemptIndex: 2,
        approvalTarget: "main_agent",
        title: "需要授权",
        request: {
          scopes: [{ kind: "fs.write", path: "/tmp/secret.txt" }],
        },
        reasonText: "需要执行危险操作。",
        expiresAt: null,
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledTimes(2);
    expect(createMessage).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledOnce();
    expect(JSON.stringify(updateCard.mock.calls)).toContain("已转交主 Agent 代批");

    bus.publish(
      makeTaskRuntimeEnvelope({
        type: "approval_resolved",
        eventId: "evt_task_perm_4",
        createdAt: "2026-03-28T00:00:23.000Z",
        sessionId: "sess_task",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_task_1",
        approvalId: "approval_2",
        approvalFlowId: "flow_1",
        approvalAttemptIndex: 2,
        decision: "approve",
        actor: "main_agent:delegate",
        rawInput: "approve",
        flowContinues: false,
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    const latestUpdateCardInput = (updateCard.mock.calls as unknown[][]).at(-1)?.[0];
    expect(JSON.stringify(latestUpdateCardInput)).toContain("主 Agent 已批准");
    expect(JSON.stringify(latestUpdateCardInput)).toContain("任务将继续执行");

    await runtime.shutdown();
  });

  test("updates the original run card when an approved bash tool finishes", async () => {
    vi.useFakeTimers();
    handle = await createTestDatabase(import.meta.url);
    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_lark_default', 'lark', 'default', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES ('conv_1', 'ci_lark_default', 'oc_chat_1', 'dm', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');
    `);

    new ChannelSurfacesRepo(handle.storage.db).upsert({
      id: "surface_1",
      channelType: "lark",
      channelInstallationId: "default",
      conversationId: "conv_1",
      branchId: "branch_1",
      surfaceKey: "chat:oc_chat_1",
      surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
    });

    const createCard = vi
      .fn()
      .mockResolvedValueOnce({ data: { card_id: "card_run_1" } })
      .mockResolvedValueOnce({ data: { card_id: "card_approval_1" } });
    const createMessage = vi
      .fn()
      .mockResolvedValueOnce({ data: { message_id: "om_run_1", open_message_id: "oom_run_1" } })
      .mockResolvedValueOnce({
        data: { message_id: "om_approval_1", open_message_id: "oom_approval_1" },
      });
    const updateCard = vi.fn(async (_input: unknown) => ({}));
    const bus = new RuntimeEventBus<OrchestratedOutboundEventEnvelope>();
    const runtime = createLarkOutboundRuntime({
      storage: handle.storage.db,
      outboundEventBus: bus,
      clients: {
        getOrCreate: () =>
          ({
            sdk: {
              cardkit: {
                v1: {
                  card: { create: createCard, update: updateCard },
                  cardElement: { content: vi.fn(async () => ({})) },
                },
              },
              im: {
                message: {
                  create: createMessage,
                },
              },
            },
          }) as never,
      },
    });

    runtime.start();

    bus.publish(
      makeEnvelope({
        type: "tool_call_started",
        eventId: "evt_bash_appr_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        toolCallId: "tool_bash_1",
        toolName: "bash",
        args: {
          command: "git status",
          sandboxMode: "full_access",
          justification: "Need to inspect the repo state.",
          prefix: ["git", "status"],
        },
      }),
    );
    bus.publish(
      makeEnvelope({
        type: "approval_requested",
        eventId: "evt_bash_appr_2",
        createdAt: "2026-03-28T00:00:01.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        approvalId: "2",
        approvalTarget: "user",
        title: "Approval required: run bash with full access for prefix git status",
        request: {
          scopes: [{ kind: "bash.full_access", prefix: ["git", "status"] }],
        },
        reasonText: "Need to inspect the repo state.",
        expiresAt: null,
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledTimes(2);
    expect(updateCard).not.toHaveBeenCalled();

    bus.publish(
      makeEnvelope({
        type: "approval_resolved",
        eventId: "evt_bash_appr_3",
        createdAt: "2026-03-28T00:00:02.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        approvalId: "2",
        decision: "approve",
        actor: "user:demo",
        rawInput: "approve",
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    bus.publish(
      makeEnvelope({
        type: "tool_call_completed",
        eventId: "evt_bash_appr_4",
        createdAt: "2026-03-28T00:00:03.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        toolCallId: "tool_bash_1",
        toolName: "bash",
        messageId: "tool_result_bash_1",
        result: {
          content: [
            {
              type: "text",
              text: "<bash_result><stdout>On branch main</stdout><stderr></stderr></bash_result>",
            },
          ],
          details: {
            command: "git status",
            cwd: "/tmp/repo",
            timeoutMs: 10000,
            exitCode: 0,
            signal: null,
            stdoutChars: 13,
            stderrChars: 0,
            outputTruncated: false,
          },
        },
      } as never),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledTimes(2);
    expect(
      new LarkObjectBindingsRepo(handle.storage.db).getByInternalObject({
        channelInstallationId: "default",
        internalObjectKind: "run_card",
        internalObjectId: "run_1:seg:2",
      }),
    ).toBeNull();

    const latestRunCardText = JSON.stringify(updateCard.mock.calls.at(-1)?.[0]);
    expect(latestRunCardText).toContain("git status");
    expect(latestRunCardText).toContain("exit_code");
    expect(latestRunCardText).toContain("On branch main");
    expect(latestRunCardText).not.toContain("等待授权");

    await runtime.shutdown();
  });

  test("creates and updates a standalone subagent creation request card", async () => {
    vi.useFakeTimers();
    handle = await createTestDatabase(import.meta.url);
    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_lark_default', 'lark', 'default', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES ('conv_1', 'ci_lark_default', 'oc_chat_1', 'dm', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');
    `);

    new ChannelSurfacesRepo(handle.storage.db).upsert({
      id: "surface_1",
      channelType: "lark",
      channelInstallationId: "default",
      conversationId: "conv_1",
      branchId: "branch_1",
      surfaceKey: "chat:oc_chat_1",
      surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
    });

    const createCard = vi.fn(async () => ({ data: { card_id: "card_subagent_1" } }));
    const createMessage = vi.fn(async () => ({
      data: { message_id: "om_subagent_1", open_message_id: "oom_subagent_1" },
    }));
    const updateCard = vi.fn(async () => ({}));
    const bus = new RuntimeEventBus<OrchestratedOutboundEventEnvelope>();
    const runtime = createLarkOutboundRuntime({
      storage: handle.storage.db,
      outboundEventBus: bus,
      clients: {
        getOrCreate: () =>
          ({
            sdk: {
              cardkit: {
                v1: {
                  card: { create: createCard, update: updateCard },
                  cardElement: { content: vi.fn(async () => ({})) },
                },
              },
              im: {
                message: {
                  create: createMessage,
                },
              },
            },
          }) as never,
      },
    });

    runtime.start();

    bus.publish(
      makeSubagentEnvelope({
        type: "subagent_creation_requested",
        requestId: "req_sub_1",
        title: "PR Review",
        description: "Review pull requests and summarize findings.",
        workdir: "/workspace",
        expiresAt: "2026-03-28T00:30:00.000Z",
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledOnce();
    const createdSubagentCardInput = (createCard.mock.calls as unknown as Array<[unknown]>)[0]?.[0];
    expect(JSON.stringify(createdSubagentCardInput)).toContain("SubAgent 创建请求");
    expect(JSON.stringify(createdSubagentCardInput)).toContain("PR Review");

    bus.publish(
      makeSubagentEnvelope({
        type: "subagent_creation_resolved",
        requestId: "req_sub_1",
        title: "PR Review",
        status: "created",
        decidedAt: "2026-03-28T00:05:00.000Z",
        failureReason: null,
        createdSubagentAgentId: "agent_sub_1",
        externalChatId: "chat_sub_1",
        shareLink: "https://example.com/subagent-1",
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(updateCard).toHaveBeenCalledOnce();
    const updatedSubagentCardInput = (updateCard.mock.calls as unknown as Array<[unknown]>)[0]?.[0];
    expect(JSON.stringify(updatedSubagentCardInput)).toContain("SubAgent 已创建");
    expect(JSON.stringify(updatedSubagentCardInput)).toContain("chat_sub_1");
    expect(JSON.stringify(updatedSubagentCardInput)).toContain("打开 SubAgent 群聊");
    expect(JSON.stringify(updatedSubagentCardInput)).toContain("https://example.com/subagent-1");

    const binding = new LarkObjectBindingsRepo(handle.storage.db).getByInternalObject({
      channelInstallationId: "default",
      internalObjectKind: "subagent_creation_request_card",
      internalObjectId: "req_sub_1",
    });
    expect(binding?.larkCardId).toBe("card_subagent_1");

    await runtime.shutdown();
  });

  test("does not create a continuation run card after denied approval", async () => {
    vi.useFakeTimers();
    handle = await createTestDatabase(import.meta.url);
    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_lark_default', 'lark', 'default', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES ('conv_1', 'ci_lark_default', 'oc_chat_1', 'dm', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');
    `);

    new ChannelSurfacesRepo(handle.storage.db).upsert({
      id: "surface_1",
      channelType: "lark",
      channelInstallationId: "default",
      conversationId: "conv_1",
      branchId: "branch_1",
      surfaceKey: "chat:oc_chat_1",
      surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
    });

    const createCard = vi
      .fn()
      .mockResolvedValueOnce({ data: { card_id: "card_run_1" } })
      .mockResolvedValueOnce({ data: { card_id: "card_approval_1" } });
    const createMessage = vi
      .fn()
      .mockResolvedValueOnce({ data: { message_id: "om_run_1", open_message_id: "oom_run_1" } })
      .mockResolvedValueOnce({
        data: { message_id: "om_approval_1", open_message_id: "oom_approval_1" },
      });
    const updateCard = vi.fn(async (_input: unknown) => ({}));
    const streamContent = vi.fn(async (_input: unknown) => ({}));
    const bus = new RuntimeEventBus<OrchestratedOutboundEventEnvelope>();
    const runtime = createLarkOutboundRuntime({
      storage: handle.storage.db,
      outboundEventBus: bus,
      clients: {
        getOrCreate: () =>
          ({
            sdk: {
              cardkit: {
                v1: {
                  card: { create: createCard, update: updateCard },
                  cardElement: { content: streamContent },
                },
              },
              im: {
                message: {
                  create: createMessage,
                },
              },
            },
          }) as never,
      },
    });

    runtime.start();

    bus.publish(
      makeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_deny_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
      }),
    );
    bus.publish(
      makeEnvelope({
        type: "tool_call_started",
        eventId: "evt_deny_2",
        createdAt: "2026-03-28T00:00:01.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        toolCallId: "tool_request_1",
        toolName: "request_permissions",
        args: {
          entries: [
            {
              resource: "filesystem",
              path: "/tmp/secret.txt",
              access: "write",
              scope: "exact",
            },
          ],
          justification: "Need to write the output file.",
        },
      }),
    );
    bus.publish(
      makeEnvelope({
        type: "approval_requested",
        eventId: "evt_deny_3",
        createdAt: "2026-03-28T00:00:02.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        approvalId: "approval_1",
        approvalTarget: "user",
        title: "需要授权",
        request: {
          scopes: [{ kind: "fs.write", path: "/tmp/secret.txt" }],
        },
        reasonText: "需要执行危险操作。",
        expiresAt: null,
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledTimes(2);

    bus.publish(
      makeEnvelope({
        type: "approval_resolved",
        eventId: "evt_deny_4",
        createdAt: "2026-03-28T00:00:03.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        approvalId: "approval_1",
        decision: "deny",
        actor: "user:demo",
        rawInput: "deny",
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(updateCard).toHaveBeenCalledTimes(2);

    bus.publish(
      makeEnvelope({
        type: "tool_call_failed",
        eventId: "evt_deny_5",
        createdAt: "2026-03-28T00:00:04.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        toolCallId: "tool_request_1",
        toolName: "request_permissions",
        errorKind: "recoverable_error",
        retryable: false,
        errorMessage: "denied",
        rawErrorMessage: "用户拒绝了这次授权请求。",
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledTimes(2);
    expect(
      new LarkObjectBindingsRepo(handle.storage.db).getByInternalObject({
        channelInstallationId: "default",
        internalObjectKind: "run_card",
        internalObjectId: "run_1:seg:2",
      }),
    ).toBeNull();

    await runtime.shutdown();
  });

  test("keeps a placeholder-only run card when the segment is cancelled so the terminal state stays visible", async () => {
    vi.useFakeTimers();
    handle = await createTestDatabase(import.meta.url);
    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_lark_default', 'lark', 'default', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES ('conv_1', 'ci_lark_default', 'oc_chat_1', 'dm', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');
    `);

    new ChannelSurfacesRepo(handle.storage.db).upsert({
      id: "surface_1",
      channelType: "lark",
      channelInstallationId: "default",
      conversationId: "conv_1",
      branchId: "branch_1",
      surfaceKey: "chat:oc_chat_1",
      surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
    });

    const createCard = vi.fn(async (_input: unknown) => ({
      data: { card_id: "card_1" },
    }));
    const createMessage = vi.fn(async (_input: unknown) => ({
      data: { message_id: "om_card_1", open_message_id: "om_open_1" },
    }));
    const updateCard = vi.fn(async (_input: unknown) => ({}));
    const streamContent = vi.fn(async (_input: unknown) => ({}));
    const bus = new RuntimeEventBus<OrchestratedOutboundEventEnvelope>();
    const runtime = createLarkOutboundRuntime({
      storage: handle.storage.db,
      outboundEventBus: bus,
      clients: {
        getOrCreate: () =>
          ({
            sdk: {
              cardkit: {
                v1: {
                  card: { create: createCard, update: updateCard },
                  cardElement: { content: streamContent },
                },
              },
              im: {
                message: {
                  create: createMessage,
                },
              },
            },
          }) as never,
      },
    });

    runtime.start();

    bus.publish(
      makeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_del_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledOnce();

    bus.publish(
      makeEnvelope({
        type: "run_cancelled",
        eventId: "evt_del_2",
        createdAt: "2026-03-28T00:00:01.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        scenario: "chat",
        modelId: "model_1",
        reason: "stop requested",
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(updateCard).toHaveBeenCalledOnce();
    const updatePayload = updateCard.mock.calls.at(0)?.[0] as
      | { data?: { card?: { data?: string } } }
      | undefined;
    expect(updatePayload?.data?.card?.data ?? "").toContain("已停止");
    expect(updatePayload?.data?.card?.data ?? "").toContain("stop requested");
    expect(
      new LarkObjectBindingsRepo(handle.storage.db).getByInternalObject({
        channelInstallationId: "default",
        internalObjectKind: "run_card",
        internalObjectId: "run_1:seg:1",
      }),
    ).not.toBeNull();

    await runtime.shutdown();
  });

  test("creates a failed terminal placeholder when a run errors before any visible transcript arrives", async () => {
    vi.useFakeTimers();
    handle = await createTestDatabase(import.meta.url);
    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_lark_default', 'lark', 'default', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES ('conv_1', 'ci_lark_default', 'oc_chat_1', 'dm', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');
    `);

    new ChannelSurfacesRepo(handle.storage.db).upsert({
      id: "surface_1",
      channelType: "lark",
      channelInstallationId: "default",
      conversationId: "conv_1",
      branchId: "branch_1",
      surfaceKey: "chat:oc_chat_1",
      surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
    });

    const createCard = vi.fn(async (_input: unknown) => ({
      data: { card_id: "card_1" },
    }));
    const createMessage = vi.fn(async (_input: unknown) => ({
      data: { message_id: "om_card_1", open_message_id: "om_open_1" },
    }));
    const updateCard = vi.fn(async (_input: unknown) => ({}));
    const streamContent = vi.fn(async (_input: unknown) => ({}));
    const bus = new RuntimeEventBus<OrchestratedOutboundEventEnvelope>();
    const runtime = createLarkOutboundRuntime({
      storage: handle.storage.db,
      outboundEventBus: bus,
      clients: {
        getOrCreate: () =>
          ({
            sdk: {
              cardkit: {
                v1: {
                  card: { create: createCard, update: updateCard },
                  cardElement: { content: streamContent },
                },
              },
              im: {
                message: {
                  create: createMessage,
                },
              },
            },
          }) as never,
      },
    });

    runtime.start();

    bus.publish(
      makeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_fail_keep_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);
    expect(createCard).toHaveBeenCalledOnce();

    bus.publish(
      makeEnvelope({
        type: "run_failed",
        eventId: "evt_fail_keep_2",
        createdAt: "2026-03-28T00:00:01.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        scenario: "chat",
        modelId: "model_1",
        errorKind: "upstream",
        errorMessage: "403 Key limit exceeded (daily limit).",
        retryable: false,
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(updateCard).toHaveBeenCalledOnce();
    const updatePayload = updateCard.mock.calls.at(0)?.[0] as
      | { data?: { card?: { data?: string } } }
      | undefined;
    expect(updatePayload?.data?.card?.data ?? "").toContain("执行失败");
    expect(updatePayload?.data?.card?.data ?? "").toContain("403 Key limit exceeded");
    expect(
      new LarkObjectBindingsRepo(handle.storage.db).getByInternalObject({
        channelInstallationId: "default",
        internalObjectKind: "run_card",
        internalObjectId: "run_1:seg:1",
      }),
    ).not.toBeNull();

    await runtime.shutdown();
  });

  test("flushes a terminal run failure immediately so the stop button does not linger", async () => {
    vi.useFakeTimers();
    handle = await createTestDatabase(import.meta.url);
    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_lark_default', 'lark', 'default', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES ('conv_1', 'ci_lark_default', 'oc_chat_1', 'dm', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');
    `);

    new ChannelSurfacesRepo(handle.storage.db).upsert({
      id: "surface_1",
      channelType: "lark",
      channelInstallationId: "default",
      conversationId: "conv_1",
      branchId: "branch_1",
      surfaceKey: "chat:oc_chat_1",
      surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
    });

    const createCard = vi.fn(async (_input: unknown) => ({
      data: { card_id: "card_1" },
    }));
    const createMessage = vi.fn(async (_input: unknown) => ({
      data: { message_id: "om_card_1", open_message_id: "om_open_1" },
    }));
    const updateCard = vi.fn(async (_input: unknown) => ({}));
    const streamContent = vi.fn(async (_input: unknown) => ({}));
    const bus = new RuntimeEventBus<OrchestratedOutboundEventEnvelope>();
    const runtime = createLarkOutboundRuntime({
      storage: handle.storage.db,
      outboundEventBus: bus,
      clients: {
        getOrCreate: () =>
          ({
            sdk: {
              cardkit: {
                v1: {
                  card: { create: createCard, update: updateCard },
                  cardElement: { content: streamContent },
                },
              },
              im: {
                message: {
                  create: createMessage,
                },
              },
            },
          }) as never,
      },
    });

    runtime.start();

    bus.publish(
      makeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_fail_fast_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);
    expect(createCard).toHaveBeenCalledOnce();

    bus.publish(
      makeEnvelope({
        type: "run_failed",
        eventId: "evt_fail_fast_2",
        createdAt: "2026-03-28T00:00:01.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        scenario: "chat",
        modelId: "model_1",
        errorKind: "unknown",
        errorMessage:
          "Run hit the configured max turn limit (60) before producing a final response.",
        retryable: false,
      }),
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(updateCard).toHaveBeenCalledOnce();
    const updatePayload = updateCard.mock.calls.at(0)?.[0] as
      | { data?: { card?: { data?: string } } }
      | undefined;
    expect(updatePayload?.data?.card?.data ?? "").toContain("执行失败");
    expect(updatePayload?.data?.card?.data ?? "").toContain("max turn limit (60)");

    await runtime.shutdown();
  });

  test("adds an explicit terminal failure summary when a run fails after visible transcript exists", async () => {
    vi.useFakeTimers();
    handle = await createTestDatabase(import.meta.url);
    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_lark_default', 'lark', 'default', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES ('conv_1', 'ci_lark_default', 'oc_chat_1', 'dm', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');
    `);

    new ChannelSurfacesRepo(handle.storage.db).upsert({
      id: "surface_1",
      channelType: "lark",
      channelInstallationId: "default",
      conversationId: "conv_1",
      branchId: "branch_1",
      surfaceKey: "chat:oc_chat_1",
      surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
    });

    const createCard = vi.fn(async (_input: unknown) => ({
      data: { card_id: "card_1" },
    }));
    const createMessage = vi.fn(async (_input: unknown) => ({
      data: { message_id: "om_card_1", open_message_id: "om_open_1" },
    }));
    const updateCard = vi.fn(async (_input: unknown) => ({}));
    const streamContent = vi.fn(async (_input: unknown) => ({}));
    const bus = new RuntimeEventBus<OrchestratedOutboundEventEnvelope>();
    const runtime = createLarkOutboundRuntime({
      storage: handle.storage.db,
      outboundEventBus: bus,
      clients: {
        getOrCreate: () =>
          ({
            sdk: {
              cardkit: {
                v1: {
                  card: { create: createCard, update: updateCard },
                  cardElement: { content: streamContent },
                },
              },
              im: {
                message: {
                  create: createMessage,
                },
              },
            },
          }) as never,
      },
    });

    runtime.start();

    bus.publish(
      makeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_fail_visible_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
      }),
    );
    bus.publish(
      makeEnvelope({
        type: "assistant_message_completed",
        eventId: "evt_fail_visible_2",
        createdAt: "2026-03-28T00:00:01.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
        text: "Trying the requested operation now.",
        reasoningText: null,
        toolCalls: [],
        usage: null,
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);
    expect(createCard).toHaveBeenCalledOnce();

    bus.publish(
      makeEnvelope({
        type: "run_failed",
        eventId: "evt_fail_visible_3",
        createdAt: "2026-03-28T00:00:02.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        scenario: "chat",
        modelId: "model_1",
        errorKind: "internal_error",
        errorMessage: "Tool execution failed due to an internal runtime error.",
        retryable: false,
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(updateCard).toHaveBeenCalledOnce();
    const updatePayload = updateCard.mock.calls.at(0)?.[0] as
      | { data?: { card?: { data?: string } } }
      | undefined;
    expect(updatePayload?.data?.card?.data ?? "").toContain("Trying the requested operation now.");
    expect(updatePayload?.data?.card?.data ?? "").toContain("执行失败");
    expect(updatePayload?.data?.card?.data ?? "").toContain(
      "Tool execution failed due to an internal runtime error.",
    );

    await runtime.shutdown();
  });
});
