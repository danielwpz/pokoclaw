import { afterEach, describe, expect, test, vi } from "vitest";

import { createLarkOutboundRuntime } from "@/src/channels/lark/outbound.js";
import type { OrchestratedOutboundEventEnvelope } from "@/src/orchestration/outbound-events.js";
import { RuntimeEventBus } from "@/src/runtime/event-bus.js";
import { ChannelSurfacesRepo } from "@/src/storage/repos/channel-surfaces.repo.js";
import { ChannelThreadsRepo } from "@/src/storage/repos/channel-threads.repo.js";
import { LarkObjectBindingsRepo } from "@/src/storage/repos/lark-object-bindings.repo.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

function makeThinkTankEnvelope(
  event: Extract<OrchestratedOutboundEventEnvelope, { kind: "think_tank_event" }>["event"],
): Extract<OrchestratedOutboundEventEnvelope, { kind: "think_tank_event" }> {
  const episodeId = "episodeId" in event ? event.episodeId : null;
  return {
    kind: "think_tank_event",
    consultationId: "tt_1",
    episodeId,
    target: {
      conversationId: "conv_1",
      branchId: "branch_1",
    },
    session: {
      sessionId: "sess_chat",
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

describe("lark outbound runtime think tank cards", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("creates a main think tank card, a thread placeholder card, and thread step cards", async () => {
    vi.useFakeTimers();
    handle = await createTestDatabase(import.meta.url);
    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_lark_default', 'lark', 'default', '2026-04-21T00:00:00.000Z', '2026-04-21T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES ('conv_1', 'ci_lark_default', 'oc_chat_1', 'dm', '2026-04-21T00:00:00.000Z', '2026-04-21T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-04-21T00:00:00.000Z', '2026-04-21T00:00:00.000Z');

      INSERT INTO agents (id, conversation_id, main_agent_id, kind, created_at)
      VALUES ('agent_1', 'conv_1', NULL, 'main', '2026-04-21T00:00:00.000Z');

      INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at)
      VALUES ('sess_chat', 'conv_1', 'branch_1', 'agent_1', 'chat', 'active', '2026-04-21T00:00:00.000Z', '2026-04-21T00:00:00.000Z');

      INSERT INTO think_tank_consultations (
        id, source_session_id, source_conversation_id, source_branch_id, owner_agent_id,
        moderator_session_id, moderator_model_id, status, topic, context_text, created_at, updated_at
      )
      VALUES (
        'tt_1', 'sess_chat', 'conv_1', 'branch_1', 'agent_1',
        'sess_chat', 'codex-gpt5.4', 'running', '如何提升 Agent 的长期运行能力？',
        'Need stable long-running execution.', '2026-04-21T00:00:00.000Z', '2026-04-21T00:00:00.000Z'
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
      .mockResolvedValueOnce({ data: { card_id: "card_tt_main_1" } })
      .mockResolvedValueOnce({ data: { card_id: "card_tt_episode_1" } })
      .mockResolvedValueOnce({ data: { card_id: "card_tt_step_1" } });
    const createMessage = vi.fn(async () => ({
      data: {
        message_id: "om_tt_main_1",
        open_message_id: "omt_tt_main_1",
      },
    }));
    const reply = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          message_id: "om_tt_episode_1",
          open_message_id: "omt_tt_episode_1",
        },
      })
      .mockResolvedValueOnce({
        data: {
          message_id: "om_tt_step_1",
          open_message_id: "omt_tt_step_1",
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

    bus.publish(
      makeThinkTankEnvelope({
        type: "consultation_upserted",
        status: "running",
        topic: "如何提升 Agent 的长期运行能力？",
        participants: [
          {
            id: "product",
            title: "产品经理",
            model: "openrouter-claude-sonnet-4",
          },
          {
            id: "engineering",
            title: "高级 Agent 研发工程师",
            model: "openrouter-gemini-3.1-flash",
          },
        ],
        latestSummary: null,
        firstCompleted: false,
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledTimes(1);
    expect(createMessage).toHaveBeenCalledTimes(1);

    const channelThread = new ChannelThreadsRepo(handle.storage.db).getByRootThinkTankConsultation({
      channelType: "lark",
      channelInstallationId: "default",
      rootThinkTankConsultationId: "tt_1",
    });
    expect(channelThread?.externalThreadId).toBe("omt_tt_main_1");
    expect(channelThread?.openedFromMessageId).toBe("om_tt_main_1");

    bus.publish(
      makeThinkTankEnvelope({
        type: "episode_started",
        episodeId: "ep_1",
        episodeSequence: 1,
        prompt: "请先讨论最关键的长期运行能力。",
        plannedSteps: [
          {
            key: "round_1",
            kind: "participant_round",
            title: "Round 1 · 独立观点",
            order: 10,
          },
        ],
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledTimes(2);
    expect(reply).toHaveBeenCalledTimes(1);

    const episodeBinding = new LarkObjectBindingsRepo(handle.storage.db).getByInternalObject({
      channelInstallationId: "default",
      internalObjectKind: "think_tank_episode_card",
      internalObjectId: "think_tank:tt_1:episode:ep_1",
    });
    expect(episodeBinding?.larkMessageId).toBe("om_tt_episode_1");
    expect(episodeBinding?.threadRootMessageId).toBe("omt_tt_main_1");

    bus.publish(
      makeThinkTankEnvelope({
        type: "episode_step_upserted",
        episodeId: "ep_1",
        episodeSequence: 1,
        step: {
          key: "round_1",
          kind: "participant_round",
          title: "Round 1 · 独立观点",
          order: 10,
          status: "completed",
          participantRound: {
            roundIndex: 1,
            entries: [
              {
                participantId: "product",
                title: "产品经理",
                model: "openrouter-claude-sonnet-4",
                preview: "应该先解决用户信任",
                content: "应该先解决用户信任和过程可见性。",
              },
              {
                participantId: "engineering",
                title: "高级 Agent 研发工程师",
                model: "openrouter-gemini-3.1-flash",
                preview: "应该先解决恢复能力",
                content: "应该先解决恢复能力和失败回退。",
              },
            ],
          },
        },
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard).toHaveBeenCalledTimes(3);
    expect(reply).toHaveBeenCalledTimes(2);

    const stepBinding = new LarkObjectBindingsRepo(handle.storage.db).getByInternalObject({
      channelInstallationId: "default",
      internalObjectKind: "think_tank_step_card",
      internalObjectId: "think_tank:tt_1:episode:ep_1:step:round_1",
    });
    expect(stepBinding?.larkMessageId).toBe("om_tt_step_1");

    bus.publish(
      makeThinkTankEnvelope({
        type: "consultation_upserted",
        status: "idle",
        topic: "如何提升 Agent 的长期运行能力？",
        participants: [
          {
            id: "product",
            title: "产品经理",
            model: "openrouter-claude-sonnet-4",
          },
          {
            id: "engineering",
            title: "高级 Agent 研发工程师",
            model: "openrouter-gemini-3.1-flash",
          },
        ],
        latestSummary: {
          agreements: ["长期运行首先要稳定。"],
          keyDifferences: ["产品更关注托付感，研发更关注恢复能力。"],
          currentConclusion: "应该先把恢复与可见性同时做起来。",
          openQuestions: ["关键时刻由谁确认？"],
        },
        firstCompleted: true,
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(updateCard).toHaveBeenCalled();

    await runtime.shutdown();
  });
});
