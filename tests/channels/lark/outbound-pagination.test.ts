import { afterEach, describe, expect, test, vi } from "vitest";

import { createLarkOutboundRuntime } from "@/src/channels/lark/outbound.js";
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

function buildLongText(label: string, lines: number): string {
  return Array.from({ length: lines }, (_, index) => `${label}-${index} ${"x".repeat(48)}`).join(
    "\n",
  );
}

function parseCardPayload(call: unknown): Record<string, unknown> {
  const payload = call as { data?: { data?: string } };
  return JSON.parse(payload.data?.data ?? "{}") as Record<string, unknown>;
}

describe("lark outbound pagination", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("creates multiple run-card pages and removes the stop button after completion", async () => {
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

    let nextCardId = 0;
    let nextMessageId = 0;
    const createCard = vi.fn(async () => {
      nextCardId += 1;
      return {
        data: {
          card_id: `card_${nextCardId}`,
        },
      };
    });
    const createMessage = vi.fn(async () => {
      nextMessageId += 1;
      return {
        data: {
          message_id: `om_card_${nextMessageId}`,
          open_message_id: `om_open_${nextMessageId}`,
        },
      };
    });
    const updateCard = vi.fn(async () => ({}));
    const streamContent = vi.fn(async () => ({}));

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
        eventId: "evt_intro",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_intro",
        text: "Collecting diagnostics now.",
        reasoningText: null,
        toolCalls: [],
        usage: null,
      }),
    );

    for (let index = 0; index < 16; index += 1) {
      const longText = buildLongText(`tool-${index}`, 16);
      bus.publish(
        makeEnvelope({
          type: "tool_call_started",
          eventId: `evt_tool_start_${index}`,
          createdAt: `2026-03-28T00:00:${String(index + 1).padStart(2, "0")}.000Z`,
          sessionId: "sess_1",
          conversationId: "conv_1",
          branchId: "branch_1",
          runId: "run_1",
          turn: 1,
          toolCallId: `tool_${index}`,
          toolName: index % 2 === 0 ? "read" : "grep",
          args: {
            path: `/workspace/file_${index}.ts`,
            query: `needle-${index}`,
            options: {
              note: longText,
            },
          },
        }),
      );
      bus.publish(
        makeEnvelope({
          type: "tool_call_completed",
          eventId: `evt_tool_done_${index}`,
          createdAt: `2026-03-28T00:01:${String(index + 1).padStart(2, "0")}.000Z`,
          sessionId: "sess_1",
          conversationId: "conv_1",
          branchId: "branch_1",
          runId: "run_1",
          turn: 1,
          toolCallId: `tool_${index}`,
          toolName: index % 2 === 0 ? "read" : "grep",
          messageId: `tool_msg_${index}`,
          result: {
            content: [
              {
                type: "text",
                text: longText,
              },
            ],
            details: {
              stdout: longText,
              nested: {
                excerpt: longText,
              },
            },
          },
        }),
      );
    }

    bus.publish(
      makeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_final_start",
        createdAt: "2026-03-28T00:02:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 2,
        messageId: "msg_final",
      }),
    );
    bus.publish(
      makeEnvelope({
        type: "assistant_message_delta",
        eventId: "evt_final_delta",
        createdAt: "2026-03-28T00:02:01.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 2,
        messageId: "msg_final",
        delta: buildLongText("assistant", 20),
        accumulatedText: buildLongText("assistant", 20),
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(createCard.mock.calls.length).toBeGreaterThan(1);
    expect(createMessage).toHaveBeenCalledTimes(createCard.mock.calls.length);
    for (const call of createMessage.mock.calls as unknown[][]) {
      expect((call[0] as { data?: { uuid?: string } }).data?.uuid).toEqual(expect.any(String));
    }

    const createdCards = (createCard.mock.calls as unknown[][]).map((call) =>
      parseCardPayload(call[0]),
    );
    createdCards.slice(0, -1).forEach((card) => {
      expect(JSON.stringify(card)).not.toContain("stop_run");
    });
    expect(JSON.stringify(createdCards.at(-1) ?? {})).toContain("stop_run");

    expect(
      new LarkObjectBindingsRepo(handle.storage.db).getByInternalObject({
        channelInstallationId: "default",
        internalObjectKind: "run_card",
        internalObjectId: "run_1:seg:1:page:2",
      }),
    ).not.toBeNull();

    bus.publish(
      makeEnvelope({
        type: "assistant_message_completed",
        eventId: "evt_final_done",
        createdAt: "2026-03-28T00:02:02.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 2,
        messageId: "msg_final",
        text: buildLongText("assistant", 20),
        reasoningText: null,
        toolCalls: [],
        usage: null,
      }),
    );
    bus.publish(
      makeEnvelope({
        type: "run_completed",
        eventId: "evt_done",
        createdAt: "2026-03-28T00:02:03.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        scenario: "chat",
        modelId: "model_1",
        appendedMessageIds: ["msg_intro", "msg_final"],
        toolExecutions: 16,
        compactionRequested: false,
      }),
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    const latestCardPayloadById = new Map<string, Record<string, unknown>>();
    for (const call of updateCard.mock.calls as unknown[][]) {
      const payload = call[0] as {
        path: { card_id: string };
        data: { card: { data: string } };
      };
      latestCardPayloadById.set(
        payload.path.card_id,
        JSON.parse(payload.data.card.data) as Record<string, unknown>,
      );
    }

    expect(latestCardPayloadById.size).toBeGreaterThan(0);
    for (const card of latestCardPayloadById.values()) {
      expect(JSON.stringify(card)).not.toContain("stop_run");
    }

    await runtime.shutdown();
  });
});
