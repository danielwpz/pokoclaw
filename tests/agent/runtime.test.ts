import { setTimeout as delay } from "node:timers/promises";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentAssistantContentBlock } from "@/src/agent/llm/messages.js";
import { ProviderRegistry } from "@/src/agent/llm/provider-registry.js";
import { AgentLoop, type AgentModelRunner } from "@/src/agent/loop.js";
import { AgentSessionService } from "@/src/agent/session.js";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import type { AppConfig } from "@/src/config/schema.js";
import { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";
import { SessionRuntimeIngress } from "@/src/runtime/ingress.js";
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
const RUNTIME_PROTECTED_FILE = "/tmp/pokeclaw-runtime-protected.txt";

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

function seedConversationAndAgentFixture(handle: TestDatabaseHandle): void {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_1', 'lark', 'acct_a', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES ('conv_1', 'ci_1', 'chat_1', 'dm', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');

    INSERT INTO agents (id, conversation_id, kind, created_at)
    VALUES ('agent_1', 'conv_1', 'sub', '2026-03-22T00:00:00.000Z');
  `);
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

describe("session runtime ingress", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("starts a new run when the session is idle", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    const cancel = new SessionRunAbortRegistry();
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      ownerAgentId: "agent_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });

    const runner: AgentModelRunner = {
      async runTurn() {
        return makeAssistantResult({
          content: [{ type: "text", text: "hi there" }],
        });
      },
    };

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry(),
      cancel,
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    const ingress = new SessionRuntimeIngress({
      loop,
      messages: messagesRepo,
    });

    const result = await ingress.submitMessage({
      sessionId: "sess_1",
      scenario: "chat",
      content: "hello",
      channelMessageId: "om_msg_runtime_1",
      channelParentMessageId: "om_parent_runtime_1",
      channelThreadId: "omt_runtime_1",
    });

    expect(result.status).toBe("started");
    const rows = messagesRepo.listBySession("sess_1");
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0]?.payloadJson ?? "{}")).toEqual({ content: "hello" });
    expect(rows[0]?.channelMessageId).toBe("om_msg_runtime_1");
    expect(rows[0]?.channelParentMessageId).toBe("om_parent_runtime_1");
    expect(rows[0]?.channelThreadId).toBe("omt_runtime_1");
    expect(JSON.parse(rows[1]?.payloadJson ?? "{}")).toEqual({
      content: [{ type: "text", text: "hi there" }],
    });
  });

  test("includes the newest user message even when session history exceeds 500 messages", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    const cancel = new SessionRunAbortRegistry();
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      ownerAgentId: "agent_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });

    for (let seq = 1; seq <= 505; seq += 1) {
      messagesRepo.append({
        id: `msg_${seq}`,
        sessionId: "sess_1",
        seq,
        role: seq % 2 === 0 ? "assistant" : "user",
        ...(seq % 2 === 0
          ? {
              provider: "anthropic_main",
              model: "claude-sonnet-4-5",
              modelApi: "anthropic-messages",
              stopReason: "stop" as const,
              usage: {
                input: 10,
                output: 5,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 15,
              },
              payloadJson: JSON.stringify({
                content: [{ type: "text", text: `assistant-${seq}` }],
              }),
            }
          : {
              payloadJson: JSON.stringify({
                content: `user-${seq}`,
              }),
            }),
        createdAt: new Date(`2026-03-22T00:00:${String((seq - 1) % 60).padStart(2, "0")}.000Z`),
      });
    }

    let lastUserContent: string | null = null;
    let messageCount = 0;
    const runner: AgentModelRunner = {
      async runTurn({ messages }) {
        messageCount = messages.length;
        lastUserContent = JSON.parse(messages.at(-1)?.payloadJson ?? "{}").content ?? null;
        return makeAssistantResult({
          content: [{ type: "text", text: "ok" }],
        });
      },
    };

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry(),
      cancel,
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    const ingress = new SessionRuntimeIngress({
      loop,
      messages: messagesRepo,
    });

    const result = await ingress.submitMessage({
      sessionId: "sess_1",
      scenario: "chat",
      content: "latest-user-message",
    });

    expect(result.status).toBe("started");
    expect(messageCount).toBe(506);
    expect(lastUserContent).toBe("latest-user-message");
  });

  test("steers new user input into an active run instead of starting a second run", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    const cancel = new SessionRunAbortRegistry();
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      ownerAgentId: "agent_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });

    let turnCount = 0;
    let secondTurnLastUserContent: string | null = null;
    const runner: AgentModelRunner = {
      async runTurn({ onTextDelta, messages }) {
        turnCount += 1;
        if (turnCount === 1) {
          onTextDelta?.({ delta: "Thinking", accumulatedText: "Thinking" });
          await delay(25);
          return makeAssistantResult({
            content: [{ type: "text", text: "Thinking" }],
          });
        }

        secondTurnLastUserContent =
          JSON.parse(messages.at(-1)?.payloadJson ?? "{}").content ?? null;
        return makeAssistantResult({
          content: [{ type: "text", text: "done" }],
        });
      },
    };

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry(),
      cancel,
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    const ingress = new SessionRuntimeIngress({
      loop,
      messages: messagesRepo,
    });

    const runPromise = ingress.submitMessage({
      sessionId: "sess_1",
      scenario: "chat",
      content: "start",
    });
    await delay(5);

    const steerResult = await ingress.submitMessage({
      sessionId: "sess_1",
      scenario: "chat",
      content: "Use a short answer.",
    });

    expect(steerResult).toEqual({ status: "steered" });

    const firstResult = await runPromise;
    expect(firstResult.status).toBe("started");
    expect(turnCount).toBe(2);
    expect(secondTurnLastUserContent).toBe("Use a short answer.");

    const rows = messagesRepo.listBySession("sess_1");
    expect(rows).toHaveLength(4);
    expect(JSON.parse(rows[2]?.payloadJson ?? "{}")).toEqual({
      content: "Use a short answer.",
    });
  });

  test("serializes concurrent inbound messages for the same idle session", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    const cancel = new SessionRunAbortRegistry();
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      ownerAgentId: "agent_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });

    let turnCount = 0;
    const runner: AgentModelRunner = {
      async runTurn({ onTextDelta, messages }) {
        turnCount += 1;
        if (turnCount === 1) {
          onTextDelta?.({ delta: "Thinking", accumulatedText: "Thinking" });
          await delay(25);
        }

        const lastUserContent = JSON.parse(messages.at(-1)?.payloadJson ?? "{}").content ?? null;
        return makeAssistantResult({
          content: [{ type: "text", text: String(lastUserContent ?? "done") }],
        });
      },
    };

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry(),
      cancel,
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    const ingress = new SessionRuntimeIngress({
      loop,
      messages: messagesRepo,
    });

    const [firstResult, secondResult] = await Promise.all([
      ingress.submitMessage({
        sessionId: "sess_1",
        scenario: "chat",
        content: "first",
      }),
      ingress.submitMessage({
        sessionId: "sess_1",
        scenario: "chat",
        content: "second",
      }),
    ]);

    expect(firstResult.status).toBe("started");
    expect(secondResult).toEqual({ status: "steered" });
    expect(turnCount).toBe(2);

    const rows = messagesRepo.listBySession("sess_1");
    expect(rows).toHaveLength(4);
    expect(JSON.parse(rows[0]?.payloadJson ?? "{}")).toEqual({ content: "first" });
    expect(JSON.parse(rows[2]?.payloadJson ?? "{}")).toEqual({ content: "second" });
  });

  test("forwards approval decisions through the ingress and resumes the blocked tool call", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    const cancel = new SessionRunAbortRegistry();
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      ownerAgentId: "agent_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });

    let turnCount = 0;
    let toolExecuteCount = 0;
    const runner: AgentModelRunner = {
      async runTurn() {
        turnCount += 1;
        if (turnCount === 1) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [{ type: "toolCall", id: "tool_1", name: "gated", arguments: {} }],
          });
        }

        if (turnCount === 2) {
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
                      path: RUNTIME_PROTECTED_FILE,
                      scope: "exact",
                      access: "write",
                    },
                  ],
                  justification: "Need to write the requested file.",
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

    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "gated",
        description: "Needs approval first",
        inputSchema: NO_ARGS_TOOL_SCHEMA,
        execute() {
          toolExecuteCount += 1;
          if (toolExecuteCount === 1) {
            throw toolRecoverableError("Write access is missing for the workspace file.", {
              code: "permission_denied",
              requestable: true,
              failedToolCallId: "tool_1",
              summary: "Write access is missing for the workspace file.",
              entries: [
                {
                  resource: "filesystem",
                  path: RUNTIME_PROTECTED_FILE,
                  scope: "exact",
                  access: "write",
                },
              ],
            });
          }

          return textToolResult("ok");
        },
      }),
    );
    tools.register(createRequestPermissionsTool());

    const emittedEvents: Array<{ type: string; approvalId?: string }> = [];
    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools,
      cancel,
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
      emitEvent(event) {
        emittedEvents.push(event);
      },
    });

    const ingress = new SessionRuntimeIngress({
      loop,
      messages: messagesRepo,
    });

    const runPromise = ingress.submitMessage({
      sessionId: "sess_1",
      scenario: "chat",
      content: "do the gated action",
    });

    let approvalId: number | null = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      approvalId = Number(
        emittedEvents.find((event) => event.type === "approval_requested")?.approvalId ?? NaN,
      );
      if (Number.isFinite(approvalId)) {
        break;
      }
      await delay(5);
    }

    expect(approvalId).not.toBeNull();
    expect(
      ingress.submitApprovalDecision({
        approvalId: approvalId ?? -1,
        decision: "approve",
        actor: "user",
        rawInput: "approve",
        grantedBy: "user",
        expiresAt: null,
      }),
    ).toBe(true);

    const result = await runPromise;
    expect(result.status).toBe("started");
    expect(toolExecuteCount).toBe(2);
    expect(turnCount).toBe(3);

    const rows = messagesRepo.listBySession("sess_1");
    expect(rows).toHaveLength(6);
    expect(JSON.parse(rows[2]?.payloadJson ?? "{}")).toMatchObject({
      toolCallId: "tool_1",
      toolName: "gated",
      isError: true,
      details: {
        code: "permission_denied",
      },
    });
    expect(JSON.parse(rows[4]?.payloadJson ?? "{}")).toMatchObject({
      toolCallId: "tool_2",
      toolName: "request_permissions",
      isError: false,
    });
  });
});
