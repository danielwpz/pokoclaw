import { afterEach, describe, expect, test, vi } from "vitest";

import { createLarkOutboundRuntime } from "@/src/channels/lark/outbound.js";
import { buildLarkAssistantElementId } from "@/src/channels/lark/run-state.js";
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

  test("creates a task card on task_run_started and keeps updating the same card through transcript and settle", async () => {
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
        card_id: "card_task_1",
      },
    }));
    const createMessage = vi.fn(async (_input: unknown) => ({
      data: {
        message_id: "om_task_card_1",
        open_message_id: "om_task_open_1",
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

    expect(createCard).toHaveBeenCalledOnce();
    expect(createMessage).toHaveBeenCalledOnce();
    const createdTaskCard = JSON.parse(
      (createCard.mock.calls.at(0)?.[0] as { data?: { data?: string } } | undefined)?.data?.data ??
        "{}",
    ) as { header?: { title?: { content?: string }; template?: string } };
    expect(createdTaskCard.header?.title?.content).toBe("定时任务运行中");
    expect(createdTaskCard.header?.template).toBe("blue");

    bus.publish(
      makeTaskRuntimeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_task_1",
        createdAt: "2026-03-28T00:00:01.000Z",
        sessionId: "sess_task",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_task_1",
        turn: 1,
        messageId: "msg_task_1",
      }),
    );
    bus.publish(
      makeTaskRuntimeEnvelope({
        type: "assistant_message_delta",
        eventId: "evt_task_2",
        createdAt: "2026-03-28T00:00:02.000Z",
        sessionId: "sess_task",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_task_1",
        turn: 1,
        messageId: "msg_task_1",
        delta: "Daily report ready",
        accumulatedText: "Daily report ready",
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledOnce();
    expect(createMessage).toHaveBeenCalledOnce();

    bus.publish(
      makeTaskEnvelope({
        type: "task_run_completed",
        taskRunId: "task_1",
        runType: "cron",
        status: "completed",
        startedAt: "2026-03-28T00:00:00.000Z",
        finishedAt: "2026-03-28T00:01:00.000Z",
        durationMs: 60_000,
        resultSummary: "Published the daily report successfully.",
        executionSessionId: "sess_task",
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    const binding = new LarkObjectBindingsRepo(handle.storage.db).getByInternalObject({
      channelInstallationId: "default",
      internalObjectKind: "run_card",
      internalObjectId: "task:task_1",
    });
    expect(binding?.larkMessageId).toBe("om_task_card_1");
    expect(binding?.larkCardId).toBe("card_task_1");
    expect(updateCard).toHaveBeenCalled();
    const updatedTaskCard = JSON.parse(
      (updateCard.mock.calls.at(-1)?.[0] as { data?: { card?: { data?: string } } } | undefined)
        ?.data?.card?.data ?? "{}",
    ) as { header?: { title?: { content?: string }; template?: string } };
    expect(updatedTaskCard.header?.title?.content).toBe("定时任务已完成");
    expect(updatedTaskCard.header?.template).toBe("green");
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
        reasonText: "Need git status.",
        expiresAt: null,
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledOnce();
    const approvalCardInput = (createCard.mock.calls as unknown as Array<[unknown]>)[0]?.[0];
    const approvalCardText = JSON.stringify(approvalCardInput);
    expect(approvalCardText).toContain("Prefix");
    expect(approvalCardText).toContain("git status");
    expect(updateCard).not.toHaveBeenCalled();

    await runtime.shutdown();
  });

  test("does not create a user-visible approval card for delegated task approvals", async () => {
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

    const createCard = vi.fn(async () => ({ data: { card_id: "card_task_1" } }));
    const createMessage = vi.fn(async () => ({
      data: { message_id: "om_task_1", open_message_id: "oom_task_1" },
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
        type: "tool_call_started",
        eventId: "evt_task_perm_1",
        createdAt: "2026-03-28T00:00:01.000Z",
        sessionId: "sess_task",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_task_1",
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
      makeTaskRuntimeEnvelope({
        type: "approval_requested",
        eventId: "evt_task_perm_2",
        createdAt: "2026-03-28T00:00:02.000Z",
        sessionId: "sess_task",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_task_1",
        approvalId: "approval_1",
        approvalTarget: "main_agent",
        title: "需要授权",
        reasonText: "需要执行危险操作。",
        expiresAt: null,
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledOnce();
    expect(createMessage).toHaveBeenCalledOnce();
    expect(updateCard).toHaveBeenCalled();
    expect(
      new LarkObjectBindingsRepo(handle.storage.db).getByInternalObject({
        channelInstallationId: "default",
        internalObjectKind: "approval_card",
        internalObjectId: "approval_1",
      }),
    ).toBeNull();

    const lastTaskCardUpdate = (updateCard.mock.calls.at(-1) as [unknown] | undefined)?.[0] ?? null;
    const taskCardUpdateText = JSON.stringify(lastTaskCardUpdate);
    expect(taskCardUpdateText).toContain("等待授权");
    expect(taskCardUpdateText).toContain("等待授权处理");
    expect(taskCardUpdateText).toContain("request_permissions");

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
