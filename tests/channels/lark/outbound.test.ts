import { afterEach, describe, expect, test, vi } from "vitest";

import { createLarkOutboundRuntime } from "@/src/channels/lark/outbound.js";
import { buildLarkAssistantElementId } from "@/src/channels/lark/run-state.js";
import type {
  OrchestratedOutboundEventEnvelope,
  OrchestratedRuntimeEventEnvelope,
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
    expect(oldRunCardTextAfterApproval).toContain("请求授权");
    expect(oldRunCardTextAfterApproval).toContain("等待授权");
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

  test("deletes a placeholder-only run card when the segment closes without visible content", async () => {
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
    const deleteMessage = vi.fn(async (_input: unknown) => ({}));
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
                  delete: deleteMessage,
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

    expect(deleteMessage).toHaveBeenCalledOnce();
    expect(deleteMessage.mock.calls.at(0)?.[0]).toMatchObject({
      path: { message_id: "om_card_1" },
    });
    expect(
      new LarkObjectBindingsRepo(handle.storage.db).getByInternalObject({
        channelInstallationId: "default",
        internalObjectKind: "run_card",
        internalObjectId: "run_1:seg:1",
      }),
    ).toBeNull();

    await runtime.shutdown();
  });
});
