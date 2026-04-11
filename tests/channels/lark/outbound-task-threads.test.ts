import { afterEach, describe, expect, test, vi } from "vitest";

import { createLarkOutboundRuntime } from "@/src/channels/lark/outbound.js";
import type {
  OrchestratedOutboundEventEnvelope,
  OrchestratedRuntimeEventEnvelope,
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
      runType: event.runType,
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

describe("lark outbound runtime task threads", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("creates a task status card in main chat and sends transcript cards into its thread", async () => {
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
      .mockResolvedValueOnce({
        data: {
          card_id: "card_task_status_1",
        },
      })
      .mockResolvedValueOnce({
        data: {
          card_id: "card_task_thread_1",
        },
      });
    const createMessage = vi.fn(async (_input: unknown) => ({
      data: {
        message_id: "om_task_card_1",
        open_message_id: "om_task_open_1",
      },
    }));
    const reply = vi.fn(async (_input: unknown) => ({
      data: {
        message_id: "om_task_thread_card_1",
        open_message_id: "om_task_thread_open_1",
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

    expect(createCard).toHaveBeenCalledOnce();
    expect(createMessage).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
    const createdTaskCard = JSON.parse(
      (createCard.mock.calls.at(0)?.[0] as { data?: { data?: string } } | undefined)?.data?.data ??
        "{}",
    ) as {
      header?: { title?: { content?: string }; subtitle?: { content?: string }; template?: string };
    };
    expect(createdTaskCard.header?.title?.content).toBe("日报汇总");
    expect(createdTaskCard.header?.subtitle?.content).toBe("定时任务运行中");
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

    expect(createCard).toHaveBeenCalledTimes(2);
    expect(createMessage).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledOnce();
    expect(
      (reply.mock.calls.at(0)?.[0] as { path?: { message_id?: string } } | undefined)?.path,
    ).toMatchObject({
      message_id: "om_task_card_1",
    });

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
    expect(binding?.larkCardId).toBe("card_task_status_1");
    expect(
      new LarkObjectBindingsRepo(handle.storage.db).getByInternalObject({
        channelInstallationId: "default",
        internalObjectKind: "run_card",
        internalObjectId: "run_task_1:seg:1",
      }),
    ).toMatchObject({
      larkMessageId: "om_task_thread_card_1",
      larkCardId: "card_task_thread_1",
    });
    expect(updateCard).toHaveBeenCalled();
    const updatedTaskCard = JSON.parse(
      (updateCard.mock.calls.at(-1)?.[0] as { data?: { card?: { data?: string } } } | undefined)
        ?.data?.card?.data ?? "{}",
    ) as {
      header?: { title?: { content?: string }; subtitle?: { content?: string }; template?: string };
    };
    expect(updatedTaskCard.header?.title?.content).toBe("日报汇总");
    expect(updatedTaskCard.header?.subtitle?.content).toBe("定时任务已完成");
    expect(updatedTaskCard.header?.template).toBe("green");
  });

  test("does not reuse an older task thread for a fresh cron run from the same workstream", async () => {
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

      INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at, ended_at)
      VALUES ('sess_task_1', 'conv_1', 'branch_1', 'agent_1', 'task', 'completed', '2026-03-28T00:00:00.000Z', '2026-03-28T00:05:00.000Z', '2026-03-28T00:05:00.000Z');

      INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at)
      VALUES ('sess_task_2', 'conv_1', 'branch_1', 'agent_1', 'task', 'active', '2026-03-28T00:10:00.000Z', '2026-03-28T00:10:00.000Z');

      INSERT INTO task_workstreams (id, owner_agent_id, conversation_id, branch_id, created_at, updated_at)
      VALUES ('ws_1', 'agent_1', 'conv_1', 'branch_1', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO cron_jobs (
        id, owner_agent_id, target_conversation_id, target_branch_id, workstream_id, name, schedule_kind, schedule_value,
        payload_json, created_at, updated_at
      ) VALUES (
        'cron_1', 'agent_1', 'conv_1', 'branch_1', 'ws_1', '日报汇总', 'cron', '0 9 * * *',
        '{}', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z'
      );

      INSERT INTO task_runs (
        id, run_type, owner_agent_id, conversation_id, branch_id, workstream_id, cron_job_id, thread_root_run_id, execution_session_id,
        status, priority, attempt, description, started_at, finished_at
      ) VALUES (
        'task_1', 'cron', 'agent_1', 'conv_1', 'branch_1', 'ws_1', 'cron_1', 'task_1', 'sess_task_1',
        'completed', 0, 1, 'Older cron run', '2026-03-28T00:00:00.000Z', '2026-03-28T00:05:00.000Z'
      );

      INSERT INTO channel_threads (
        id, channel_type, channel_installation_id, home_conversation_id, external_chat_id, external_thread_id,
        subject_kind, root_task_run_id, opened_from_message_id, created_at, updated_at
      ) VALUES (
        'thread_1', 'lark', 'default', 'conv_1', 'oc_chat_1', 'omt_task_1',
        'task', 'task_1', 'om_task_root_1', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z'
      );

      INSERT INTO task_runs (
        id, run_type, owner_agent_id, conversation_id, branch_id, workstream_id, cron_job_id, thread_root_run_id, execution_session_id,
        status, priority, attempt, description, started_at
      ) VALUES (
        'task_2', 'cron', 'agent_1', 'conv_1', 'branch_1', 'ws_1', 'cron_1', 'task_2', 'sess_task_2',
        'running', 0, 2, 'Fresh cron run', '2026-03-28T00:10:00.000Z'
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
      .mockResolvedValueOnce({
        data: {
          card_id: "card_task_status_2",
        },
      })
      .mockResolvedValueOnce({
        data: {
          card_id: "card_task_transcript_2",
        },
      });
    const createMessage = vi.fn(async () => ({
      data: {
        message_id: "om_task_card_2",
        open_message_id: "om_task_open_2",
      },
    }));
    const reply = vi.fn(async () => ({
      data: {
        message_id: "om_task_thread_card_unexpected",
        open_message_id: "om_task_thread_open_unexpected",
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
                  create: createMessage,
                  reply,
                },
              },
            },
          }) as never,
      },
    });

    runtime.start();

    bus.publish({
      kind: "task_run_event",
      target: {
        conversationId: "conv_1",
        branchId: "branch_1",
      },
      session: {
        sessionId: "sess_task_2",
        purpose: "task",
      },
      agent: {
        ownerAgentId: "agent_1",
        ownerRole: "main",
        mainAgentId: "agent_1",
      },
      taskRun: {
        taskRunId: "task_2",
        runType: "cron",
        status: "running",
        executionSessionId: "sess_task_2",
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
      event: {
        type: "task_run_started",
        taskRunId: "task_2",
        runType: "cron",
        status: "running",
        startedAt: "2026-03-28T00:10:00.000Z",
        initiatorSessionId: null,
        parentRunId: null,
        cronJobId: "cron_1",
        executionSessionId: "sess_task_2",
      },
    } satisfies OrchestratedTaskRunEventEnvelope);

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledOnce();
    expect(createMessage).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();

    bus.publish({
      kind: "runtime_event",
      target: {
        conversationId: "conv_1",
        branchId: "branch_1",
      },
      session: {
        sessionId: "sess_task_2",
        purpose: "task",
      },
      agent: {
        ownerAgentId: "agent_1",
        ownerRole: "main",
        mainAgentId: "agent_1",
      },
      taskRun: {
        taskRunId: "task_2",
        runType: "cron",
        status: "running",
        executionSessionId: "sess_task_2",
      },
      run: {
        runId: "run_task_2",
      },
      object: {
        messageId: null,
        toolCallId: null,
        toolName: null,
        approvalId: null,
      },
      event: {
        type: "assistant_message_delta",
        eventId: "evt_task_2_delta",
        createdAt: "2026-03-28T00:10:01.000Z",
        sessionId: "sess_task_2",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_task_2",
        turn: 1,
        messageId: "msg_task_2",
        delta: "fresh output",
        accumulatedText: "fresh output",
      },
    } satisfies OrchestratedRuntimeEventEnvelope);

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledTimes(2);
    expect(createMessage).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledOnce();
    expect(
      (
        (reply.mock.calls as unknown[][]).at(0)?.[0] as
          | { path?: { message_id?: string } }
          | undefined
      )?.path,
    ).toMatchObject({
      message_id: "om_task_card_2",
    });

    await runtime.shutdown();
  });

  test("does not create a standalone task status card for thread follow-up runs", async () => {
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

      INSERT INTO task_workstreams (id, owner_agent_id, conversation_id, branch_id, created_at, updated_at)
      VALUES ('ws_1', 'agent_1', 'conv_1', 'branch_1', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO task_runs (
        id, run_type, owner_agent_id, conversation_id, branch_id, workstream_id, thread_root_run_id, execution_session_id,
        status, priority, attempt, description, started_at
      ) VALUES (
        'task_1', 'thread', 'agent_1', 'conv_1', 'branch_1', 'ws_1', 'task_1', 'sess_task',
        'running', 0, 1, 'Thread follow-up task', '2026-03-28T00:00:00.000Z'
      );

      INSERT INTO channel_threads (
        id, channel_type, channel_installation_id, home_conversation_id, external_chat_id, external_thread_id,
        subject_kind, root_task_run_id, opened_from_message_id, created_at, updated_at
      ) VALUES (
        'thread_1', 'lark', 'default', 'conv_1', 'oc_chat_1', 'omt_task_1',
        'task', 'task_1', 'om_task_root_1', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z'
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
        card_id: "card_task_status_1",
      },
    }));
    const createMessage = vi.fn(async (_input: unknown) => ({
      data: {
        message_id: "om_card_1",
        open_message_id: "om_open_1",
      },
    }));
    const reply = vi.fn(async (_input: unknown) => ({
      data: {
        message_id: "om_task_thread_status_1",
        open_message_id: "om_task_thread_status_open_1",
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
                  create: createMessage,
                  reply,
                },
              },
            },
          }) as never,
      },
    });

    runtime.start();

    const event: OrchestratedTaskRunEventEnvelope = {
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
        runType: "thread",
        status: "running",
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
      event: {
        type: "task_run_started",
        taskRunId: "task_1",
        runType: "thread",
        status: "running",
        startedAt: "2026-03-28T00:00:00.000Z",
        initiatorSessionId: null,
        parentRunId: null,
        cronJobId: null,
        executionSessionId: "sess_task",
      },
    };
    bus.publish(event);

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).not.toHaveBeenCalled();
    expect(createMessage).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(
      new LarkObjectBindingsRepo(handle.storage.db).getByInternalObject({
        channelInstallationId: "default",
        internalObjectKind: "run_card",
        internalObjectId: "task:task_1",
      }),
    ).toBeNull();
  });

  test("delivers thread follow-up transcript cards in the bound task thread and removes the stop button after completion", async () => {
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

      INSERT INTO task_workstreams (id, owner_agent_id, conversation_id, branch_id, created_at, updated_at)
      VALUES ('ws_1', 'agent_1', 'conv_1', 'branch_1', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO task_runs (
        id, run_type, owner_agent_id, conversation_id, branch_id, workstream_id, thread_root_run_id, execution_session_id,
        status, priority, attempt, description, started_at
      ) VALUES (
        'task_1', 'thread', 'agent_1', 'conv_1', 'branch_1', 'ws_1', 'task_1', 'sess_task',
        'running', 0, 1, 'Thread follow-up task', '2026-03-28T00:00:00.000Z'
      );

      INSERT INTO channel_threads (
        id, channel_type, channel_installation_id, home_conversation_id, external_chat_id, external_thread_id,
        subject_kind, root_task_run_id, opened_from_message_id, created_at, updated_at
      ) VALUES (
        'thread_1', 'lark', 'default', 'conv_1', 'oc_chat_1', 'omt_task_1',
        'task', 'task_1', 'om_task_root_1', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z'
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
        card_id: "card_task_run_1",
      },
    }));
    const createMessage = vi.fn(async (_input: unknown) => ({
      data: {
        message_id: "om_task_run_1",
        open_message_id: "om_task_run_open_1",
      },
    }));
    const reply = vi.fn(async (_input: unknown) => ({
      data: {
        message_id: "om_task_thread_run_1",
        open_message_id: "om_task_thread_run_open_1",
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
                  card: {
                    create: createCard,
                    update: updateCard,
                  },
                  cardElement: {
                    content: vi.fn(async () => ({})),
                  },
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

    bus.publish({
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
        runType: "thread",
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
      event: {
        type: "assistant_message_delta",
        eventId: "evt_task_delta",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_task",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_task_1",
        turn: 1,
        messageId: "msg_task_1",
        delta: "doing work",
        accumulatedText: "doing work",
      },
    } satisfies OrchestratedRuntimeEventEnvelope);

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledOnce();
    expect(createMessage).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce();
    const approvalReplyCall = (reply.mock.calls as unknown[][]).at(0)?.[0] as
      | { path?: { message_id?: string } }
      | undefined;
    expect(approvalReplyCall?.path).toMatchObject({
      message_id: "om_task_root_1",
    });
    expect(
      JSON.parse(
        (createCard.mock.calls.at(0)?.[0] as { data?: { data?: string } } | undefined)?.data
          ?.data ?? "{}",
      ),
    ).toMatchObject({
      body: {
        elements: expect.any(Array),
      },
    });
    expect(
      JSON.stringify(
        JSON.parse(
          (createCard.mock.calls.at(0)?.[0] as { data?: { data?: string } } | undefined)?.data
            ?.data ?? "{}",
        ),
      ),
    ).toContain("stop_run");

    bus.publish({
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
        runType: "thread",
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
      event: {
        type: "run_completed",
        eventId: "evt_task_done",
        createdAt: "2026-03-28T00:00:01.000Z",
        sessionId: "sess_task",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_task_1",
        scenario: "task",
        modelId: "model_task_1",
        appendedMessageIds: ["msg_task_1"],
        toolExecutions: 0,
        compactionRequested: false,
      },
    } satisfies OrchestratedRuntimeEventEnvelope);

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(updateCard).toHaveBeenCalledOnce();
    const updatePayload = updateCard.mock.calls.at(0)?.[0] as
      | { data?: { card?: { data?: string } } }
      | undefined;
    expect(updatePayload?.data?.card?.data ?? "").not.toContain("stop_run");
    expect(updatePayload?.data?.card?.data ?? "").toContain("已完成");

    await runtime.shutdown();
  });

  test("delivers thread-run approval cards into the bound task thread", async () => {
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

      INSERT INTO task_workstreams (id, owner_agent_id, conversation_id, branch_id, created_at, updated_at)
      VALUES ('ws_1', 'agent_1', 'conv_1', 'branch_1', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO task_runs (
        id, run_type, owner_agent_id, conversation_id, branch_id, workstream_id, thread_root_run_id, execution_session_id,
        status, priority, attempt, description, started_at
      ) VALUES (
        'task_1', 'thread', 'agent_1', 'conv_1', 'branch_1', 'ws_1', 'task_1', 'sess_task',
        'running', 0, 1, 'Thread follow-up task', '2026-03-28T00:00:00.000Z'
      );

      INSERT INTO channel_threads (
        id, channel_type, channel_installation_id, home_conversation_id, external_chat_id, external_thread_id,
        subject_kind, root_task_run_id, opened_from_message_id, created_at, updated_at
      ) VALUES (
        'thread_1', 'lark', 'default', 'conv_1', 'oc_chat_1', 'omt_task_1',
        'task', 'task_1', 'om_task_root_1', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z'
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
    const reply = vi.fn(async () => ({
      data: { message_id: "om_thread_approval_1", open_message_id: "oom_thread_approval_1" },
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
                  card: { create: createCard, update: vi.fn(async () => ({})) },
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

    bus.publish({
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
        runType: "thread",
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
      event: {
        type: "approval_requested",
        eventId: "evt_task_perm_2",
        createdAt: "2026-03-28T00:00:02.000Z",
        sessionId: "sess_task",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_task_1",
        approvalId: "approval_1",
        approvalTarget: "user",
        title: "需要授权",
        request: {
          scopes: [{ kind: "fs.write", path: "/tmp/secret.txt" }],
        },
        reasonText: "需要执行危险操作。",
        expiresAt: null,
      },
    } satisfies OrchestratedRuntimeEventEnvelope);

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledOnce();
    expect(createMessage).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce();
    const approvalReplyCall = (reply.mock.calls as unknown[][]).at(0)?.[0] as
      | { path?: { message_id?: string } }
      | undefined;
    expect(approvalReplyCall?.path).toMatchObject({
      message_id: "om_task_root_1",
    });
    expect(
      new LarkObjectBindingsRepo(handle.storage.db).getByInternalObject({
        channelInstallationId: "default",
        internalObjectKind: "approval_card",
        internalObjectId: "approval_1",
      }),
    ).toMatchObject({
      threadRootMessageId: "omt_task_1",
      larkMessageId: "om_thread_approval_1",
    });

    await runtime.shutdown();
  });
});
