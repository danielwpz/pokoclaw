import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentAssistantContentBlock } from "@/src/agent/llm/messages.js";
import { ProviderRegistry } from "@/src/agent/llm/provider-registry.js";
import { AgentLoop, type AgentModelRunner } from "@/src/agent/loop.js";
import { AgentSessionService } from "@/src/agent/session.js";
import { createLarkOutboundRuntime } from "@/src/channels/lark/outbound.js";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import type { AppConfig } from "@/src/config/schema.js";
import {
  type OrchestratedOutboundEventEnvelope,
  projectRuntimeEvent,
} from "@/src/orchestration/outbound-events.js";
import { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";
import { RuntimeEventBus } from "@/src/runtime/event-bus.js";
import { RuntimeModeService } from "@/src/runtime/runtime-modes.js";
import { ChannelSurfacesRepo } from "@/src/storage/repos/channel-surfaces.repo.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { toolRecoverableError } from "@/src/tools/core/errors.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import { defineTool, textToolResult } from "@/src/tools/core/types.js";
import { createRequestPermissionsTool } from "@/src/tools/request-permissions.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

const NO_ARGS_TOOL_SCHEMA = Type.Object({}, { additionalProperties: false });
const PROTECTED_FILE = "/tmp/pokoclaw-yolo-outbound-regression.txt";

function createModelConfig(): Pick<AppConfig, "providers" | "models"> {
  return {
    providers: {
      anthropic_main: {
        api: "anthropic-messages",
      },
    },
    models: {
      catalog: [
        {
          id: "anthropic_main/claude-sonnet-4-5",
          provider: "anthropic_main",
          upstreamId: "claude-sonnet-4-5-20250929",
          contextWindow: 200_000,
          maxOutputTokens: 16_384,
          supportsTools: true,
          supportsVision: true,
          reasoning: { enabled: true },
        },
      ],
      scenarios: {
        chat: ["anthropic_main/claude-sonnet-4-5"],
        compaction: ["anthropic_main/claude-sonnet-4-5"],
        task: ["anthropic_main/claude-sonnet-4-5"],
        meditationBucket: [],
        meditationConsolidation: [],
      },
    },
  };
}

function seedFixture(handle: TestDatabaseHandle): {
  sessionsRepo: SessionsRepo;
  messagesRepo: MessagesRepo;
} {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_lark_default', 'lark', 'default', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES ('conv_1', 'ci_lark_default', 'oc_chat_1', 'dm', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-28T00:00:00.000Z', '2026-03-28T00:00:00.000Z');

    INSERT INTO agents (id, conversation_id, kind, created_at)
    VALUES ('agent_1', 'conv_1', 'main', '2026-03-28T00:00:00.000Z');
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

  const sessionsRepo = new SessionsRepo(handle.storage.db);
  const messagesRepo = new MessagesRepo(handle.storage.db);
  sessionsRepo.create({
    id: "sess_1",
    conversationId: "conv_1",
    branchId: "branch_1",
    ownerAgentId: "agent_1",
    purpose: "chat",
    createdAt: new Date("2026-03-28T00:00:01.000Z"),
  });
  messagesRepo.append({
    id: "msg_user",
    sessionId: "sess_1",
    seq: 1,
    role: "user",
    payloadJson: JSON.stringify({ content: "update the protected file" }),
    createdAt: new Date("2026-03-28T00:00:02.000Z"),
  });

  return { sessionsRepo, messagesRepo };
}

function makeAssistantResult(params: {
  content: AgentAssistantContentBlock[];
  stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
}) {
  return {
    provider: "anthropic_main",
    model: "claude-sonnet-4-5",
    modelApi: "anthropic-messages",
    stopReason: params.stopReason ?? "stop",
    content: params.content,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
    },
  } as const;
}

function countBindings(handle: TestDatabaseHandle, kind: string): number {
  const row = handle.storage.sqlite
    .prepare("SELECT COUNT(*) AS count FROM lark_object_bindings WHERE internal_object_kind = ?")
    .get(kind) as { count: number } | undefined;
  return row?.count ?? 0;
}

describe("lark outbound yolo autopilot regression", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("does not create approval cards for yolo auto-approved request_permissions", async () => {
    handle = await createTestDatabase(import.meta.url);
    const { sessionsRepo, messagesRepo } = seedFixture(handle);
    const runtimeModes = new RuntimeModeService({
      storage: handle.storage.db,
      autopilotEnabled: false,
    });
    runtimeModes.toggleYolo({
      ownerAgentId: "agent_1",
      updatedAt: new Date("2026-03-28T00:00:03.000Z"),
    });

    let modelTurnCount = 0;
    const runner: AgentModelRunner = {
      async runTurn() {
        modelTurnCount += 1;
        if (modelTurnCount === 1) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [{ type: "toolCall", id: "tool_1", name: "gated_write", arguments: {} }],
          });
        }
        if (modelTurnCount === 2) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "tool_2",
                name: "request_permissions",
                arguments: {
                  entries: [
                    {
                      resource: "filesystem",
                      path: PROTECTED_FILE,
                      scope: "exact",
                      access: "write",
                    },
                  ],
                  justification: "Need to write the requested output file.",
                  retryToolCallId: "tool_1",
                },
              },
            ],
          });
        }
        return makeAssistantResult({
          content: [{ type: "text", text: "done" }],
        });
      },
    };

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry([
        defineTool({
          name: "gated_write",
          description: "Needs a write grant",
          inputSchema: NO_ARGS_TOOL_SCHEMA,
          execute(context) {
            const hasWrite = context.approvalState?.ephemeralPermissionScopes?.some(
              (scope) =>
                scope.kind === "fs.write" && "path" in scope && scope.path === PROTECTED_FILE,
            );
            if (hasWrite !== true) {
              throw toolRecoverableError("Write access is missing.", {
                code: "permission_denied",
                requestable: true,
                failedToolCallId: "tool_1",
                summary: "Write access is missing.",
                entries: [
                  {
                    resource: "filesystem",
                    path: PROTECTED_FILE,
                    scope: "exact",
                    access: "write",
                  },
                ],
              });
            }
            return textToolResult("ok");
          },
        }),
        createRequestPermissionsTool(),
      ]),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
      runtimeModes,
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });
    expect(result.events.some((event) => event.type === "approval_requested")).toBe(false);
    expect(countBindings(handle, "approval_card")).toBe(0);

    vi.useFakeTimers();
    let cardCounter = 0;
    const createCard = vi.fn(async () => {
      cardCounter += 1;
      return {
        data: {
          card_id: `card_${cardCounter}`,
        },
      };
    });
    const createMessage = vi.fn(async () => ({
      data: {
        message_id: "om_card_1",
        open_message_id: "om_open_1",
      },
    }));
    const bus = new RuntimeEventBus<OrchestratedOutboundEventEnvelope>();
    const outbound = createLarkOutboundRuntime({
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
                },
              },
            },
          }) as never,
      },
    });

    outbound.start();
    for (const event of result.events) {
      bus.publish(projectRuntimeEvent({ db: handle.storage.db, event }));
    }
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(countBindings(handle, "run_card")).toBeGreaterThan(0);
    expect(countBindings(handle, "approval_card")).toBe(0);
    await outbound.shutdown();
  });
});
