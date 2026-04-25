import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentAssistantContentBlock } from "@/src/agent/llm/messages.js";
import { ProviderRegistry } from "@/src/agent/llm/provider-registry.js";
import { AgentLoop, type AgentModelRunner } from "@/src/agent/loop.js";
import { AgentSessionService } from "@/src/agent/session.js";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import type { AppConfig } from "@/src/config/schema.js";
import { AgentManager } from "@/src/orchestration/agent-manager.js";
import { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";
import { SessionRuntimeIngress } from "@/src/runtime/ingress.js";
import { createRuntimeOrchestrationBridge } from "@/src/runtime/orchestration-bridge.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { SubagentCreationRequestsRepo } from "@/src/storage/repos/subagent-creation-requests.repo.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import { createCreateSubagentTool } from "@/src/tools/create-subagent.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

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
        thinkTankAdvisor: [],
        meditationBucket: [],
        meditationConsolidation: [],
      },
    },
  };
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

function seedFixture(handle: TestDatabaseHandle): void {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_1', 'lark', 'acct_a', '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z');

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, title, created_at, updated_at)
    VALUES ('conv_main', 'ci_1', 'chat_main', 'dm', 'Main Agent', '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES ('branch_main', 'conv_main', 'dm_main', 'main', '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z');

    INSERT INTO agents (id, conversation_id, kind, display_name, created_at)
    VALUES ('agent_main', 'conv_main', 'main', 'Main Agent', '2026-03-27T00:00:00.000Z');

    INSERT INTO sessions (
      id, conversation_id, branch_id, owner_agent_id, purpose, context_mode, status,
      compact_cursor, created_at, updated_at
    ) VALUES (
      'sess_main', 'conv_main', 'branch_main', 'agent_main', 'chat', 'isolated', 'active',
      0, '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z'
    );
  `);
}

async function waitFor(condition: () => boolean, attempts = 20): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (condition()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error("Timed out waiting for asynchronous runtime work.");
}

describe("RuntimeOrchestrationBridge", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("connects main-agent create_subagent tool calls to orchestration and subagent kickoff", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    const requestsRepo = new SubagentCreationRequestsRepo(handle.storage.db);

    const runner: AgentModelRunner = {
      async runTurn({ sessionId }) {
        if (sessionId === "sess_main") {
          const messages = messagesRepo.listBySession(sessionId);
          const hasToolResult = messages.some((message) => message.role === "tool");
          if (!hasToolResult) {
            return makeAssistantResult({
              stopReason: "toolUse",
              content: [
                {
                  type: "toolCall",
                  id: "tool_create_subagent_1",
                  name: "create_subagent",
                  arguments: {
                    title: "PR Review",
                    description: "Review pull requests and summarize findings.",
                    initialTask: "Review the current PR and report concrete issues.",
                  },
                },
              ],
            });
          }

          return makeAssistantResult({
            content: [{ type: "text", text: "SubAgent creation request submitted." }],
          });
        }

        return makeAssistantResult({
          content: [{ type: "text", text: "SubAgent kickoff acknowledged." }],
        });
      },
    };

    const bridge = createRuntimeOrchestrationBridge();
    const provisioner = {
      provisionSubagentSurface: vi.fn(async () => ({
        status: "provisioned" as const,
        externalChatId: "chat_sub_1",
        shareLink: "https://example.com/subagent-1",
        conversationKind: "group" as const,
        channelSurface: {
          channelType: "lark",
          channelInstallationId: "default",
          surfaceKey: "chat:chat_sub_1",
          surfaceObjectJson: JSON.stringify({ chat_id: "chat_sub_1" }),
        },
      })),
    };

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry([createCreateSubagentTool()]),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
      runtimeControl: bridge.runtimeControl,
      emitEvent: bridge.emitRuntimeEvent,
    });

    const ingress = new SessionRuntimeIngress({
      loop,
      messages: messagesRepo,
    });
    const manager = new AgentManager({
      storage: handle.storage.db,
      ingress,
      subagentProvisioner: provisioner,
      subagentPrivateWorkspace: {
        ensureDirectory: vi.fn(async () => {}),
      },
    });
    bridge.attachManager(manager);

    const result = await ingress.submitMessage({
      sessionId: "sess_main",
      scenario: "chat",
      content: "Create a PR review subagent.",
    });

    expect(result.status).toBe("started");

    const pendingRequest = requestsRepo.listBySourceSession("sess_main", 1)[0];
    expect(pendingRequest).toMatchObject({
      sourceSessionId: "sess_main",
      sourceAgentId: "agent_main",
      title: "PR Review",
      status: "pending",
    });
    if (pendingRequest == null) {
      throw new Error("Expected a pending SubAgent creation request.");
    }

    const created = await manager.approveSubagentCreationRequest({
      requestId: pendingRequest.id,
      decidedAt: new Date("2026-03-27T00:05:00.000Z"),
    });

    await waitFor(() => messagesRepo.listBySession(created.session.id).length >= 2);

    expect(provisioner.provisionSubagentSurface).toHaveBeenCalledOnce();
    expect(created.agent).toMatchObject({
      kind: "sub",
      mainAgentId: "agent_main",
      displayName: "PR Review",
    });

    const subagentMessages = messagesRepo.listBySession(created.session.id);
    expect(subagentMessages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(subagentMessages[0]?.messageType).toBe("subagent_kickoff");
    expect(subagentMessages[0]?.visibility).toBe("hidden_system");
    expect(JSON.parse(subagentMessages[1]?.payloadJson ?? "{}")).toEqual({
      content: [{ type: "text", text: "SubAgent kickoff acknowledged." }],
    });
  });

  test("forwards cron run requests to the attached manager", async () => {
    const bridge = createRuntimeOrchestrationBridge({
      manager: {
        emitRuntimeEvent: vi.fn(),
        submitSubagentCreationRequest: vi.fn(),
        runCronJobNow: vi.fn(async () => ({
          accepted: true,
          cronJobId: "cron_sub_1",
        })),
        startBackgroundTask: vi.fn(async () => ({
          accepted: true,
          taskRunId: "task_bg_1",
        })),
        suppressBackgroundTaskCompletionNotice: vi.fn(),
      },
    });

    await expect(
      bridge.runtimeControl.runCronJobNow?.({
        jobId: "cron_sub_1",
      }),
    ).resolves.toEqual({
      accepted: true,
      cronJobId: "cron_sub_1",
    });
  });

  test("forwards background task start and suppress requests to the attached manager", async () => {
    const startBackgroundTask = vi.fn(async () => ({
      accepted: true,
      taskRunId: "task_bg_1",
    }));
    const suppressBackgroundTaskCompletionNotice = vi.fn();
    const bridge = createRuntimeOrchestrationBridge({
      manager: {
        emitRuntimeEvent: vi.fn(),
        submitSubagentCreationRequest: vi.fn(),
        runCronJobNow: vi.fn(async () => ({
          accepted: true,
          cronJobId: "cron_sub_1",
        })),
        startBackgroundTask,
        suppressBackgroundTaskCompletionNotice,
      },
    });

    await expect(
      bridge.runtimeControl.startBackgroundTask?.({
        sourceSessionId: "sess_sub",
        description: "Run background checks",
        task: "Execute checks and summarize findings.",
        contextMode: "isolated",
      }),
    ).resolves.toEqual({
      accepted: true,
      taskRunId: "task_bg_1",
    });
    expect(startBackgroundTask).toHaveBeenCalledExactlyOnceWith({
      sourceSessionId: "sess_sub",
      description: "Run background checks",
      task: "Execute checks and summarize findings.",
      contextMode: "isolated",
    });

    bridge.runtimeControl.suppressBackgroundTaskCompletionNotice?.({
      taskRunId: "task_bg_1",
    });
    expect(suppressBackgroundTaskCompletionNotice).toHaveBeenCalledExactlyOnceWith({
      taskRunId: "task_bg_1",
    });
  });

  test("forwards think tank runtime control methods when attached", async () => {
    const bridge = createRuntimeOrchestrationBridge({
      manager: {
        emitRuntimeEvent: vi.fn(),
        submitSubagentCreationRequest: vi.fn(),
        runCronJobNow: vi.fn(),
        startBackgroundTask: vi.fn(),
        suppressBackgroundTaskCompletionNotice: vi.fn(),
        getThinkTankCapabilities: vi.fn(() => ({
          availableModels: ["openrouter-claude-sonnet-4", "openrouter-gemini-3.1-flash"],
          recommendedParticipantCount: 2,
          maxParticipantCount: 4,
        })),
        startThinkTankConsultation: vi.fn(async () => ({
          accepted: true as const,
          consultationId: "tt_1",
          status: "running" as const,
          participants: [
            {
              id: "product_lead",
              model: "openrouter-claude-sonnet-4",
              title: "Product Lead",
              continuationSessionId: "sess_tt_1",
            },
          ],
        })),
        getThinkTankStatus: vi.fn(async () => ({
          consultationId: "tt_1",
          topic: "Topic",
          status: "idle" as const,
          latestEpisodeStatus: "completed" as const,
          participants: [
            {
              id: "product_lead",
              model: "openrouter-claude-sonnet-4",
              title: "Product Lead",
              continuationSessionId: "sess_tt_1",
            },
          ],
          latestSummary: {
            agreements: ["A"],
            keyDifferences: ["B"],
            currentConclusion: "C",
            openQuestions: ["D"],
          },
          updatedAt: "2026-04-21T00:00:00.000Z",
        })),
      },
    });

    await expect(
      bridge.runtimeControl.getThinkTankCapabilities?.({
        sourceSessionId: "sess_main",
      }),
    ).resolves.toMatchObject({
      availableModels: ["openrouter-claude-sonnet-4", "openrouter-gemini-3.1-flash"],
    });

    await expect(
      bridge.runtimeControl.startThinkTankConsultation?.({
        sourceSessionId: "sess_main",
        sourceConversationId: "conv_main",
        sourceBranchId: "branch_main",
        ownerAgentId: "agent_main",
        moderatorModelId: "anthropic_main/claude-sonnet-4-5",
        topic: "Topic",
        context: "Context",
        participants: [
          {
            id: "product_lead",
            model: "openrouter-claude-sonnet-4",
            persona: "Persona",
            title: "Product Lead",
          },
          {
            id: "infra_engineer",
            model: "openrouter-gemini-3.1-flash",
            persona: "Persona 2",
            title: "Infra Engineer",
          },
        ],
      }),
    ).resolves.toMatchObject({
      consultationId: "tt_1",
    });

    await expect(
      bridge.runtimeControl.getThinkTankStatus?.({
        sourceSessionId: "sess_main",
        consultationId: "tt_1",
      }),
    ).resolves.toMatchObject({
      consultationId: "tt_1",
      status: "idle",
    });
  });
});
