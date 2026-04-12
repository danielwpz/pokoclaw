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

  test("creates a standalone task status card for a fresh cron run and does not reuse an older task thread", async () => {
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
        (createMessage.mock.calls as unknown[][]).at(0)?.[0] as
          | { params?: { receive_id_type?: string }; data?: { msg_type?: string } }
          | undefined
      )?.params,
    ).toMatchObject({
      receive_id_type: "chat_id",
    });
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

  test("does not change the standalone task status card terminal state when approval is denied", async () => {
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
        'cron_1', 'agent_1', 'conv_1', 'branch_1', '每日新闻摘要', 'cron', '0 9 * * *',
        '{}', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z'
      );

      INSERT INTO task_runs (
        id, run_type, owner_agent_id, conversation_id, branch_id, cron_job_id, execution_session_id,
        status, priority, attempt, description, started_at
      )
      VALUES (
        'task_1', 'cron', 'agent_1', 'conv_1', 'branch_1', 'cron_1', 'sess_task',
        'running', 0, 1, '每日新闻摘要', '2026-03-28T00:00:00.000Z'
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
          card_id: "card_task_approval_1",
        },
      });
    const createMessage = vi
      .fn(async () => ({
        data: {
          message_id: "om_task_card_1",
          open_message_id: "om_task_open_1",
        },
      }))
      .mockResolvedValueOnce({
        data: {
          message_id: "om_task_approval_1",
          open_message_id: "om_task_approval_open_1",
        },
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
                  reply: vi.fn(async () => ({
                    data: {
                      message_id: "om_unused_reply",
                      open_message_id: "om_unused_reply_open",
                    },
                  })),
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

    bus.publish({
      kind: "runtime_event",
      target: { conversationId: "conv_1", branchId: "branch_1" },
      session: { sessionId: "sess_task", purpose: "task" },
      agent: { ownerAgentId: "agent_1", ownerRole: "main", mainAgentId: "agent_1" },
      taskRun: {
        taskRunId: "task_1",
        runType: "cron",
        status: "running",
        executionSessionId: "sess_task",
      },
      run: { runId: "run_task_1" },
      object: { messageId: null, toolCallId: null, toolName: null, approvalId: null },
      event: {
        type: "approval_requested",
        eventId: "evt_task_perm_req",
        createdAt: "2026-03-28T00:00:02.000Z",
        sessionId: "sess_task",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_task_1",
        approvalId: "approval_1",
        approvalTarget: "user",
        title: "需要授权",
        request: { scopes: [{ kind: "fs.write", path: "/tmp/news.txt" }] },
        reasonText: "需要写入输出文件。",
        expiresAt: null,
      },
    } satisfies OrchestratedRuntimeEventEnvelope);

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    bus.publish({
      kind: "runtime_event",
      target: { conversationId: "conv_1", branchId: "branch_1" },
      session: { sessionId: "sess_task", purpose: "task" },
      agent: { ownerAgentId: "agent_1", ownerRole: "main", mainAgentId: "agent_1" },
      taskRun: {
        taskRunId: "task_1",
        runType: "cron",
        status: "running",
        executionSessionId: "sess_task",
      },
      run: { runId: "run_task_1" },
      object: { messageId: null, toolCallId: null, toolName: null, approvalId: null },
      event: {
        type: "approval_resolved",
        eventId: "evt_task_perm_deny",
        createdAt: "2026-03-28T00:00:03.000Z",
        sessionId: "sess_task",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_task_1",
        approvalId: "approval_1",
        decision: "deny",
        actor: "user:demo",
        rawInput: "deny",
      },
    } satisfies OrchestratedRuntimeEventEnvelope);

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    const createdStatusCard = JSON.parse(
      (createCard.mock.calls.at(0)?.[0] as { data?: { data?: string } } | undefined)?.data?.data ??
        "{}",
    ) as {
      header?: { subtitle?: { content?: string }; template?: string };
      body?: { elements?: Array<{ content?: string }> };
    };

    expect(createdStatusCard.header?.subtitle?.content).toBe("定时任务运行中");
    expect(createdStatusCard.header?.template).toBe("blue");
    expect(JSON.stringify(createdStatusCard.body ?? {})).not.toContain("授权被拒绝");
    expect(JSON.stringify(createdStatusCard.body ?? {})).not.toContain("等待授权");
    expect(
      updateCard.mock.calls.some(
        (call) =>
          (call[0] as { path?: { card_id?: string } } | undefined)?.path?.card_id ===
          "card_task_status_1",
      ),
    ).toBe(false);

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

  test("opens a new transcript card for a new follow-up run in the same task thread", async () => {
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
      VALUES
        ('sess_task_1', 'conv_1', 'branch_1', 'agent_1', 'task', 'completed', '2026-03-27T23:55:00.000Z', '2026-03-27T23:59:00.000Z'),
        ('sess_task_2', 'conv_1', 'branch_1', 'agent_1', 'task', 'active', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z'),
        ('sess_task_3', 'conv_1', 'branch_1', 'agent_1', 'task', 'active', '2026-03-28T00:05:00.000Z', '2026-03-28T00:05:00.000Z');

      INSERT INTO task_workstreams (id, owner_agent_id, conversation_id, branch_id, created_at, updated_at)
      VALUES ('ws_1', 'agent_1', 'conv_1', 'branch_1', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

      INSERT INTO task_runs (
        id, run_type, owner_agent_id, conversation_id, branch_id, workstream_id, thread_root_run_id, execution_session_id,
        status, priority, attempt, description, started_at
      ) VALUES
      (
        'task_1', 'thread', 'agent_1', 'conv_1', 'branch_1', 'ws_1', 'task_1', 'sess_task_1',
        'completed', 0, 0, 'Thread root run', '2026-03-27T23:55:00.000Z'
      ),
      (
        'task_2', 'thread', 'agent_1', 'conv_1', 'branch_1', 'ws_1', 'task_1', 'sess_task_2',
        'running', 0, 1, 'First follow-up run', '2026-03-28T00:00:00.000Z'
      ),
      (
        'task_3', 'thread', 'agent_1', 'conv_1', 'branch_1', 'ws_1', 'task_1', 'sess_task_3',
        'running', 0, 2, 'Second follow-up run', '2026-03-28T00:05:00.000Z'
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

    const createCard = vi
      .fn()
      .mockResolvedValueOnce({ data: { card_id: "card_task_thread_run_1" } })
      .mockResolvedValueOnce({ data: { card_id: "card_task_thread_run_2" } });
    const createMessage = vi.fn(async () => ({
      data: {
        message_id: "om_task_thread_run_1",
        open_message_id: "om_task_thread_run_open_1",
      },
    }));
    const reply = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          message_id: "om_task_thread_reply_1",
          open_message_id: "om_task_thread_reply_open_1",
        },
      })
      .mockResolvedValueOnce({
        data: {
          message_id: "om_task_thread_reply_2",
          open_message_id: "om_task_thread_reply_open_2",
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
        runType: "thread",
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
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_task_2",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_task_2",
        turn: 1,
        messageId: "msg_task_2",
        delta: "first follow-up output",
        accumulatedText: "first follow-up output",
      },
    } satisfies OrchestratedRuntimeEventEnvelope);

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledOnce();
    expect(updateCard).not.toHaveBeenCalled();

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
        runType: "thread",
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
        type: "run_completed",
        eventId: "evt_task_2_done",
        createdAt: "2026-03-28T00:00:01.000Z",
        sessionId: "sess_task_2",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_task_2",
        scenario: "task",
        modelId: "model_task_2",
        appendedMessageIds: ["msg_task_2"],
        toolExecutions: 0,
        compactionRequested: false,
      },
    } satisfies OrchestratedRuntimeEventEnvelope);

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    bus.publish({
      kind: "runtime_event",
      target: {
        conversationId: "conv_1",
        branchId: "branch_1",
      },
      session: {
        sessionId: "sess_task_3",
        purpose: "task",
      },
      agent: {
        ownerAgentId: "agent_1",
        ownerRole: "main",
        mainAgentId: "agent_1",
      },
      taskRun: {
        taskRunId: "task_3",
        runType: "thread",
        status: "running",
        executionSessionId: "sess_task_3",
      },
      run: {
        runId: "run_task_3",
      },
      object: {
        messageId: null,
        toolCallId: null,
        toolName: null,
        approvalId: null,
      },
      event: {
        type: "assistant_message_delta",
        eventId: "evt_task_3_delta",
        createdAt: "2026-03-28T00:05:01.000Z",
        sessionId: "sess_task_3",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_task_3",
        turn: 1,
        messageId: "msg_task_3",
        delta: "second follow-up output",
        accumulatedText: "second follow-up output",
      },
    } satisfies OrchestratedRuntimeEventEnvelope);

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledTimes(2);
    expect(createMessage).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(2);
    expect(updateCard).toHaveBeenCalled();
    expect(
      new LarkObjectBindingsRepo(handle.storage.db).getByInternalObject({
        channelInstallationId: "default",
        internalObjectKind: "run_card",
        internalObjectId: "run_task_2:seg:1",
      }),
    ).toMatchObject({
      larkMessageId: "om_task_thread_reply_1",
      larkCardId: "card_task_thread_run_1",
    });
    expect(
      new LarkObjectBindingsRepo(handle.storage.db).getByInternalObject({
        channelInstallationId: "default",
        internalObjectKind: "run_card",
        internalObjectId: "run_task_3:seg:1",
      }),
    ).toMatchObject({
      larkMessageId: "om_task_thread_reply_2",
      larkCardId: "card_task_thread_run_2",
    });

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

  test("creates a continuation transcript segment in the same task thread after approval", async () => {
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

    const createCard = vi
      .fn()
      .mockResolvedValueOnce({ data: { card_id: "card_run_1" } })
      .mockResolvedValueOnce({ data: { card_id: "card_approval_1" } })
      .mockResolvedValueOnce({ data: { card_id: "card_run_2" } });
    const reply = vi
      .fn()
      .mockResolvedValueOnce({
        data: { message_id: "om_run_1", open_message_id: "oom_run_1" },
      })
      .mockResolvedValueOnce({
        data: { message_id: "om_approval_1", open_message_id: "oom_approval_1" },
      })
      .mockResolvedValueOnce({
        data: { message_id: "om_run_2", open_message_id: "oom_run_2" },
      });
    const createMessage = vi.fn(async () => ({
      data: { message_id: "om_unused", open_message_id: "oom_unused" },
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
                message: { create: createMessage, reply },
              },
            },
          }) as never,
      },
    });

    runtime.start();

    bus.publish({
      kind: "runtime_event",
      target: { conversationId: "conv_1", branchId: "branch_1" },
      session: { sessionId: "sess_task", purpose: "task" },
      agent: { ownerAgentId: "agent_1", ownerRole: "main", mainAgentId: "agent_1" },
      taskRun: {
        taskRunId: "task_1",
        runType: "thread",
        status: "running",
        executionSessionId: "sess_task",
      },
      run: { runId: "run_task_1" },
      object: { messageId: null, toolCallId: null, toolName: null, approvalId: null },
      event: {
        type: "assistant_message_started",
        eventId: "evt_task_1_started",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_task",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_task_1",
        turn: 1,
        messageId: "msg_task_1",
      },
    } satisfies OrchestratedRuntimeEventEnvelope);
    bus.publish({
      kind: "runtime_event",
      target: { conversationId: "conv_1", branchId: "branch_1" },
      session: { sessionId: "sess_task", purpose: "task" },
      agent: { ownerAgentId: "agent_1", ownerRole: "main", mainAgentId: "agent_1" },
      taskRun: {
        taskRunId: "task_1",
        runType: "thread",
        status: "running",
        executionSessionId: "sess_task",
      },
      run: { runId: "run_task_1" },
      object: { messageId: null, toolCallId: null, toolName: null, approvalId: null },
      event: {
        type: "tool_call_started",
        eventId: "evt_task_perm_start",
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
            { resource: "filesystem", path: "/tmp/secret.txt", access: "write", scope: "exact" },
          ],
          justification: "Need to write the output file.",
        },
      },
    } satisfies OrchestratedRuntimeEventEnvelope);
    bus.publish({
      kind: "runtime_event",
      target: { conversationId: "conv_1", branchId: "branch_1" },
      session: { sessionId: "sess_task", purpose: "task" },
      agent: { ownerAgentId: "agent_1", ownerRole: "main", mainAgentId: "agent_1" },
      taskRun: {
        taskRunId: "task_1",
        runType: "thread",
        status: "running",
        executionSessionId: "sess_task",
      },
      run: { runId: "run_task_1" },
      object: { messageId: null, toolCallId: null, toolName: null, approvalId: null },
      event: {
        type: "approval_requested",
        eventId: "evt_task_perm_req",
        createdAt: "2026-03-28T00:00:02.000Z",
        sessionId: "sess_task",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_task_1",
        approvalId: "approval_1",
        approvalTarget: "user",
        title: "需要授权",
        request: { scopes: [{ kind: "fs.write", path: "/tmp/secret.txt" }] },
        reasonText: "需要执行危险操作。",
        expiresAt: null,
      },
    } satisfies OrchestratedRuntimeEventEnvelope);

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    bus.publish({
      kind: "runtime_event",
      target: { conversationId: "conv_1", branchId: "branch_1" },
      session: { sessionId: "sess_task", purpose: "task" },
      agent: { ownerAgentId: "agent_1", ownerRole: "main", mainAgentId: "agent_1" },
      taskRun: {
        taskRunId: "task_1",
        runType: "thread",
        status: "running",
        executionSessionId: "sess_task",
      },
      run: { runId: "run_task_1" },
      object: { messageId: null, toolCallId: null, toolName: null, approvalId: null },
      event: {
        type: "approval_resolved",
        eventId: "evt_task_perm_ok",
        createdAt: "2026-03-28T00:00:03.000Z",
        sessionId: "sess_task",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_task_1",
        approvalId: "approval_1",
        decision: "approve",
        actor: "user:demo",
        rawInput: "approve",
      },
    } satisfies OrchestratedRuntimeEventEnvelope);
    bus.publish({
      kind: "runtime_event",
      target: { conversationId: "conv_1", branchId: "branch_1" },
      session: { sessionId: "sess_task", purpose: "task" },
      agent: { ownerAgentId: "agent_1", ownerRole: "main", mainAgentId: "agent_1" },
      taskRun: {
        taskRunId: "task_1",
        runType: "thread",
        status: "running",
        executionSessionId: "sess_task",
      },
      run: { runId: "run_task_1" },
      object: { messageId: null, toolCallId: null, toolName: null, approvalId: null },
      event: {
        type: "tool_call_completed",
        eventId: "evt_task_perm_done",
        createdAt: "2026-03-28T00:00:04.000Z",
        sessionId: "sess_task",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_task_1",
        turn: 1,
        messageId: "msg_task_1",
        toolCallId: "tool_request_1",
        toolName: "request_permissions",
        result: [{ type: "text", text: "approved" }],
      },
    } satisfies OrchestratedRuntimeEventEnvelope);
    bus.publish({
      kind: "runtime_event",
      target: { conversationId: "conv_1", branchId: "branch_1" },
      session: { sessionId: "sess_task", purpose: "task" },
      agent: { ownerAgentId: "agent_1", ownerRole: "main", mainAgentId: "agent_1" },
      taskRun: {
        taskRunId: "task_1",
        runType: "thread",
        status: "running",
        executionSessionId: "sess_task",
      },
      run: { runId: "run_task_1" },
      object: { messageId: null, toolCallId: null, toolName: null, approvalId: null },
      event: {
        type: "assistant_message_started",
        eventId: "evt_task_resume_started",
        createdAt: "2026-03-28T00:00:05.000Z",
        sessionId: "sess_task",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_task_1",
        turn: 2,
        messageId: "msg_task_2",
      },
    } satisfies OrchestratedRuntimeEventEnvelope);

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledTimes(3);
    expect(reply).toHaveBeenCalledTimes(3);
    expect(
      new LarkObjectBindingsRepo(handle.storage.db).getByInternalObject({
        channelInstallationId: "default",
        internalObjectKind: "run_card",
        internalObjectId: "run_task_1:seg:2",
      }),
    ).toMatchObject({
      larkMessageId: "om_run_2",
      larkCardId: "card_run_2",
      threadRootMessageId: "omt_task_1",
    });

    await runtime.shutdown();
  });

  test("does not create a continuation transcript segment in the task thread after denied approval", async () => {
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

    const createCard = vi
      .fn()
      .mockResolvedValueOnce({ data: { card_id: "card_run_1" } })
      .mockResolvedValueOnce({ data: { card_id: "card_approval_1" } });
    const reply = vi
      .fn()
      .mockResolvedValueOnce({
        data: { message_id: "om_run_1", open_message_id: "oom_run_1" },
      })
      .mockResolvedValueOnce({
        data: { message_id: "om_approval_1", open_message_id: "oom_approval_1" },
      });
    const createMessage = vi.fn(async () => ({
      data: { message_id: "om_unused", open_message_id: "oom_unused" },
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
                message: { create: createMessage, reply },
              },
            },
          }) as never,
      },
    });

    runtime.start();

    bus.publish({
      kind: "runtime_event",
      target: { conversationId: "conv_1", branchId: "branch_1" },
      session: { sessionId: "sess_task", purpose: "task" },
      agent: { ownerAgentId: "agent_1", ownerRole: "main", mainAgentId: "agent_1" },
      taskRun: {
        taskRunId: "task_1",
        runType: "thread",
        status: "running",
        executionSessionId: "sess_task",
      },
      run: { runId: "run_task_1" },
      object: { messageId: null, toolCallId: null, toolName: null, approvalId: null },
      event: {
        type: "assistant_message_started",
        eventId: "evt_task_1_started",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_task",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_task_1",
        turn: 1,
        messageId: "msg_task_1",
      },
    } satisfies OrchestratedRuntimeEventEnvelope);
    bus.publish({
      kind: "runtime_event",
      target: { conversationId: "conv_1", branchId: "branch_1" },
      session: { sessionId: "sess_task", purpose: "task" },
      agent: { ownerAgentId: "agent_1", ownerRole: "main", mainAgentId: "agent_1" },
      taskRun: {
        taskRunId: "task_1",
        runType: "thread",
        status: "running",
        executionSessionId: "sess_task",
      },
      run: { runId: "run_task_1" },
      object: { messageId: null, toolCallId: null, toolName: null, approvalId: null },
      event: {
        type: "tool_call_started",
        eventId: "evt_task_perm_start",
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
            { resource: "filesystem", path: "/tmp/secret.txt", access: "write", scope: "exact" },
          ],
          justification: "Need to write the output file.",
        },
      },
    } satisfies OrchestratedRuntimeEventEnvelope);
    bus.publish({
      kind: "runtime_event",
      target: { conversationId: "conv_1", branchId: "branch_1" },
      session: { sessionId: "sess_task", purpose: "task" },
      agent: { ownerAgentId: "agent_1", ownerRole: "main", mainAgentId: "agent_1" },
      taskRun: {
        taskRunId: "task_1",
        runType: "thread",
        status: "running",
        executionSessionId: "sess_task",
      },
      run: { runId: "run_task_1" },
      object: { messageId: null, toolCallId: null, toolName: null, approvalId: null },
      event: {
        type: "approval_requested",
        eventId: "evt_task_perm_req",
        createdAt: "2026-03-28T00:00:02.000Z",
        sessionId: "sess_task",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_task_1",
        approvalId: "approval_1",
        approvalTarget: "user",
        title: "需要授权",
        request: { scopes: [{ kind: "fs.write", path: "/tmp/secret.txt" }] },
        reasonText: "需要执行危险操作。",
        expiresAt: null,
      },
    } satisfies OrchestratedRuntimeEventEnvelope);

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    bus.publish({
      kind: "runtime_event",
      target: { conversationId: "conv_1", branchId: "branch_1" },
      session: { sessionId: "sess_task", purpose: "task" },
      agent: { ownerAgentId: "agent_1", ownerRole: "main", mainAgentId: "agent_1" },
      taskRun: {
        taskRunId: "task_1",
        runType: "thread",
        status: "running",
        executionSessionId: "sess_task",
      },
      run: { runId: "run_task_1" },
      object: { messageId: null, toolCallId: null, toolName: null, approvalId: null },
      event: {
        type: "approval_resolved",
        eventId: "evt_task_perm_deny",
        createdAt: "2026-03-28T00:00:03.000Z",
        sessionId: "sess_task",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_task_1",
        approvalId: "approval_1",
        decision: "deny",
        actor: "user:demo",
        rawInput: "deny",
      },
    } satisfies OrchestratedRuntimeEventEnvelope);
    bus.publish({
      kind: "runtime_event",
      target: { conversationId: "conv_1", branchId: "branch_1" },
      session: { sessionId: "sess_task", purpose: "task" },
      agent: { ownerAgentId: "agent_1", ownerRole: "main", mainAgentId: "agent_1" },
      taskRun: {
        taskRunId: "task_1",
        runType: "thread",
        status: "running",
        executionSessionId: "sess_task",
      },
      run: { runId: "run_task_1" },
      object: { messageId: null, toolCallId: null, toolName: null, approvalId: null },
      event: {
        type: "tool_call_failed",
        eventId: "evt_task_perm_failed",
        createdAt: "2026-03-28T00:00:04.000Z",
        sessionId: "sess_task",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_task_1",
        turn: 1,
        toolCallId: "tool_request_1",
        toolName: "request_permissions",
        errorKind: "recoverable_error",
        retryable: false,
        errorMessage: "denied",
        rawErrorMessage: "用户拒绝了这次授权请求。",
      },
    } satisfies OrchestratedRuntimeEventEnvelope);

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledTimes(2);
    expect(reply).toHaveBeenCalledTimes(2);
    expect(
      new LarkObjectBindingsRepo(handle.storage.db).getByInternalObject({
        channelInstallationId: "default",
        internalObjectKind: "run_card",
        internalObjectId: "run_task_1:seg:2",
      }),
    ).toBeNull();

    await runtime.shutdown();
  });

  test("resumes the latest active transcript segment for the same task-thread run after runtime restart", async () => {
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

    const bindingsRepo = new LarkObjectBindingsRepo(handle.storage.db);
    bindingsRepo.upsert({
      id: "binding_seg_1",
      channelInstallationId: "default",
      conversationId: "conv_1",
      branchId: "branch_1",
      internalObjectKind: "run_card",
      internalObjectId: "run_task_1:seg:1",
      larkMessageUuid: "uuid_seg_1",
      larkMessageId: "om_old_seg_1",
      larkOpenMessageId: "oom_old_seg_1",
      larkCardId: "card_old_seg_1",
      threadRootMessageId: "omt_task_1",
      lastSequence: 3,
      status: "finalized",
      metadataJson: "{}",
    });
    bindingsRepo.upsert({
      id: "binding_seg_2",
      channelInstallationId: "default",
      conversationId: "conv_1",
      branchId: "branch_1",
      internalObjectKind: "run_card",
      internalObjectId: "run_task_1:seg:2",
      larkMessageUuid: "uuid_seg_2",
      larkMessageId: "om_old_seg_2",
      larkOpenMessageId: "oom_old_seg_2",
      larkCardId: "card_old_seg_2",
      threadRootMessageId: "omt_task_1",
      lastSequence: 7,
      status: "active",
      metadataJson: "{}",
    });

    const createCard = vi.fn(async () => ({ data: { card_id: "card_unexpected" } }));
    const createMessage = vi.fn(async () => ({
      data: { message_id: "om_unexpected", open_message_id: "oom_unexpected" },
    }));
    const reply = vi.fn(async () => ({
      data: { message_id: "om_reply_unexpected", open_message_id: "oom_reply_unexpected" },
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
                message: { create: createMessage, reply },
              },
            },
          }) as never,
      },
    });

    runtime.start();

    bus.publish({
      kind: "runtime_event",
      target: { conversationId: "conv_1", branchId: "branch_1" },
      session: { sessionId: "sess_task", purpose: "task" },
      agent: { ownerAgentId: "agent_1", ownerRole: "main", mainAgentId: "agent_1" },
      taskRun: {
        taskRunId: "task_1",
        runType: "thread",
        status: "running",
        executionSessionId: "sess_task",
      },
      run: { runId: "run_task_1" },
      object: { messageId: null, toolCallId: null, toolName: null, approvalId: null },
      event: {
        type: "assistant_message_delta",
        eventId: "evt_task_restart_delta",
        createdAt: "2026-03-28T00:10:01.000Z",
        sessionId: "sess_task",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_task_1",
        turn: 2,
        messageId: "msg_task_restart",
        delta: "continued output",
        accumulatedText: "continued output",
      },
    } satisfies OrchestratedRuntimeEventEnvelope);

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).not.toHaveBeenCalled();
    expect(createMessage).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(updateCard).toHaveBeenCalledOnce();
    const updateCall = (Array.from(updateCard.mock.calls)[0] as [unknown] | undefined)?.[0] as
      | { path?: { card_id?: string } }
      | undefined;
    expect(updateCall?.path).toMatchObject({
      card_id: "card_old_seg_2",
    });

    await runtime.shutdown();
  });
});
