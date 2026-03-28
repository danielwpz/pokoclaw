import { setTimeout as delay } from "node:timers/promises";
import { Type } from "@sinclair/typebox";

import { afterEach, describe, expect, test } from "vitest";
import { AgentLlmError } from "@/src/agent/llm/errors.js";
import type { AgentAssistantContentBlock } from "@/src/agent/llm/messages.js";
import { ProviderRegistry } from "@/src/agent/llm/provider-registry.js";
import { AgentLoop, type AgentModelRunner } from "@/src/agent/loop.js";
import { AgentSessionService } from "@/src/agent/session.js";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import type { AppConfig } from "@/src/config/schema.js";
import { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";
import { POKECLAW_WORKSPACE_DIR } from "@/src/shared/paths.js";
import { ApprovalsRepo } from "@/src/storage/repos/approvals.repo.js";
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

const TEST_BASH_TOOL_SCHEMA = Type.Object(
  {
    command: Type.String(),
    workdir: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

const NO_ARGS_TOOL_SCHEMA = Type.Object({}, { additionalProperties: false });

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
          supportsReasoning: true,
        },
      ],
      scenarios: {
        chat: ["anthropic_main/claude-sonnet-4-5"],
        compaction: ["anthropic_main/claude-sonnet-4-5"],
        subagent: ["anthropic_main/claude-sonnet-4-5"],
        cron: ["anthropic_main/claude-sonnet-4-5"],
      },
    },
  };
}

function seedConversationFixture(handle: TestDatabaseHandle): void {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_1', 'lark', 'acct_a', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES ('conv_1', 'ci_1', 'chat_1', 'dm', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
  `);
}

function seedConversationAndAgentFixture(handle: TestDatabaseHandle): void {
  seedConversationFixture(handle);
  handle.storage.sqlite.exec(`
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

async function waitForSessionCompaction(
  sessionsRepo: SessionsRepo,
  sessionId: string,
): Promise<ReturnType<SessionsRepo["getById"]>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const session = sessionsRepo.getById(sessionId);
    if (session?.compactCursor === 2) {
      return session;
    }

    await delay(5);
  }

  return sessionsRepo.getById(sessionId);
}

async function waitForApprovalRequested(
  events: Array<{ type: string; approvalId?: string }>,
): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const approvalId = events.find((event) => event.type === "approval_requested")?.approvalId;
    if (approvalId != null) {
      return approvalId;
    }

    await delay(5);
  }

  throw new Error("Approval request was not emitted");
}

const LOOP_PROTECTED_FILE = "/tmp/pokeclaw-loop-protected.txt";

describe("agent loop", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("persists a plain assistant reply for a single session turn", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"hello"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
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
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    const rows = messagesRepo.listBySession("sess_1");
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[1]?.payloadJson ?? "{}")).toEqual({
      content: [{ type: "text", text: "hi there" }],
    });
    expect(rows[1]?.provider).toBe("anthropic_main");
    expect(rows[1]?.model).toBe("claude-sonnet-4-5");
    expect(rows[1]?.modelApi).toBe("anthropic-messages");
    expect(rows[1]?.stopReason).toBe("stop");
    expect(result.toolExecutions).toBe(0);
    expect(result.events.map((event) => event.type)).toEqual([
      "run_started",
      "turn_started",
      "assistant_message_started",
      "assistant_message_delta",
      "assistant_message_completed",
      "turn_completed",
      "run_completed",
    ]);
  });

  test("passes owner agent and workspace cwd into tool execution context", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      ownerAgentId: "agent_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"inspect tool context"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    let turnCount = 0;
    const runner: AgentModelRunner = {
      async runTurn() {
        turnCount += 1;
        if (turnCount === 1) {
          return makeAssistantResult({
            content: [{ type: "toolCall", id: "tool_1", name: "inspect_context", arguments: {} }],
            stopReason: "toolUse",
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
        name: "inspect_context",
        description: "Inspect tool context",
        inputSchema: NO_ARGS_TOOL_SCHEMA,
        execute(context) {
          expect(context.ownerAgentId).toBe("agent_1");
          expect(context.cwd).toBe(POKECLAW_WORKSPACE_DIR);
          return textToolResult("ok");
        },
      }),
    );

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools,
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    expect(result.events.some((event) => event.type === "tool_call_completed")).toBe(true);
    expect(result.events.some((event) => event.type === "tool_call_failed")).toBe(false);
  });

  test("blocks disallowed tools inside approval sessions", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_approval",
      conversationId: "conv_1",
      branchId: "branch_1",
      ownerAgentId: "agent_1",
      purpose: "approval",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_system",
      sessionId: "sess_approval",
      seq: 1,
      role: "user",
      messageType: "approval_request",
      visibility: "hidden_system",
      payloadJson: '{"content":"review this delegated approval"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    let turnCount = 0;
    const runner: AgentModelRunner = {
      async runTurn() {
        turnCount += 1;
        if (turnCount === 1) {
          return makeAssistantResult({
            content: [
              { type: "toolCall", id: "tool_1", name: "bash", arguments: { command: "pwd" } },
            ],
            stopReason: "toolUse",
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
      tools: new ToolRegistry(),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    await loop.run({ sessionId: "sess_approval", scenario: "chat" });

    const rows = messagesRepo.listBySession("sess_approval");
    const toolRow = rows.find((row) => row.role === "tool");
    expect(toolRow).toBeDefined();
    const payload = JSON.parse(toolRow?.payloadJson ?? "{}");
    expect(payload.isError).toBe(true);
    expect(payload.details).toMatchObject({
      code: "tool_not_allowed_for_session_purpose",
      toolName: "bash",
      sessionPurpose: "approval",
    });
  });

  test("continues after bash tool calls and persists tool results", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"run ls on the current directory"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    let callCount = 0;
    const runner: AgentModelRunner = {
      async runTurn() {
        callCount += 1;
        if (callCount === 1) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [
              { type: "text", text: "I will inspect the directory." },
              {
                type: "toolCall",
                id: "tool_1",
                name: "bash",
                arguments: {
                  command: "ls -1",
                  workdir: "/workspace",
                  timeoutMs: 10_000,
                },
              },
            ],
          });
        }

        return makeAssistantResult({
          content: [{ type: "text", text: "I found the directory entries." }],
        });
      },
    };

    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "bash",
        description: "Run a shell command",
        inputSchema: TEST_BASH_TOOL_SCHEMA,
        execute(_context, args) {
          return textToolResult("README.md\nsrc\ntests", {
            command: args.command,
            workdir: args.workdir ?? null,
            timeoutMs: args.timeoutMs ?? null,
            exitCode: 0,
          });
        },
      }),
    );

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools,
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    const rows = messagesRepo.listBySession("sess_1");
    expect(rows).toHaveLength(4);
    expect(JSON.parse(rows[1]?.payloadJson ?? "{}")).toEqual({
      content: [
        { type: "text", text: "I will inspect the directory." },
        {
          type: "toolCall",
          id: "tool_1",
          name: "bash",
          arguments: {
            command: "ls -1",
            workdir: "/workspace",
            timeoutMs: 10_000,
          },
        },
      ],
    });
    expect(rows[1]?.stopReason).toBe("toolUse");
    expect(JSON.parse(rows[2]?.payloadJson ?? "{}")).toEqual({
      toolCallId: "tool_1",
      toolName: "bash",
      content: [{ type: "text", text: "README.md\nsrc\ntests" }],
      isError: false,
      details: {
        command: "ls -1",
        workdir: "/workspace",
        timeoutMs: 10_000,
        exitCode: 0,
      },
    });
    expect(JSON.parse(rows[3]?.payloadJson ?? "{}")).toEqual({
      content: [{ type: "text", text: "I found the directory entries." }],
    });
    expect(result.toolExecutions).toBe(1);
    expect(result.events.map((event) => event.type)).toEqual([
      "run_started",
      "turn_started",
      "assistant_message_started",
      "assistant_message_delta",
      "assistant_message_completed",
      "tool_call_started",
      "tool_call_completed",
      "turn_completed",
      "turn_started",
      "assistant_message_started",
      "assistant_message_delta",
      "assistant_message_completed",
      "turn_completed",
      "run_completed",
    ]);
  });

  test("emits streamed assistant deltas without falling back to a single full-text delta", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"hello"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    const runner: AgentModelRunner = {
      async runTurn(input) {
        input.onTextDelta?.({
          delta: "hello ",
          accumulatedText: "hello ",
        });
        input.onTextDelta?.({
          delta: "world",
          accumulatedText: "hello world",
        });

        return makeAssistantResult({
          content: [{ type: "text", text: "hello world" }],
        });
      },
    };

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry(),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    const deltaEvents = result.events.filter((event) => event.type === "assistant_message_delta");
    expect(deltaEvents).toHaveLength(2);
    expect(deltaEvents).toMatchObject([
      {
        type: "assistant_message_delta",
        delta: "hello ",
        accumulatedText: "hello ",
      },
      {
        type: "assistant_message_delta",
        delta: "world",
        accumulatedText: "hello world",
      },
    ]);
  });

  test("propagates cancellation through the active session run", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"run slow tool"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    const cancel = new SessionRunAbortRegistry();
    const runner: AgentModelRunner = {
      async runTurn() {
        return makeAssistantResult({
          stopReason: "toolUse",
          content: [
            { type: "text", text: "Working on it." },
            { type: "toolCall", id: "tool_1", name: "slow", arguments: {} },
          ],
        });
      },
    };

    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "slow",
        description: "Slow tool",
        inputSchema: NO_ARGS_TOOL_SCHEMA,
        async execute(context) {
          await delay(1000, undefined, { signal: context.abortSignal });
          return textToolResult("done");
        },
      }),
    );

    const emittedEvents: Array<{ type: string; reason?: string }> = [];
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

    const runPromise = loop.run({ sessionId: "sess_1", scenario: "chat" });
    await delay(20);
    expect(cancel.cancel("sess_1", "stop requested")).toBe(true);

    await expect(runPromise).rejects.toThrow();
    expect(cancel.isActive("sess_1")).toBe(false);
    expect(emittedEvents.at(-1)).toMatchObject({
      type: "run_cancelled",
      reason: "stop requested",
    });
    expect(emittedEvents.some((event) => event.type === "run_failed")).toBe(false);
  });

  test("request_permissions pauses for approval, retries the blocked tool, and inserts queued steer input", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      ownerAgentId: "agent_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"update the file"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    let modelTurnCount = 0;
    let toolExecuteCount = 0;
    let secondTurnLastUserContent: string | null = null;
    const runner: AgentModelRunner = {
      async runTurn({ messages }) {
        modelTurnCount += 1;
        if (modelTurnCount === 1) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [{ type: "toolCall", id: "tool_1", name: "gated", arguments: {} }],
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
                      path: LOOP_PROTECTED_FILE,
                      scope: "exact",
                      access: "write",
                    },
                  ],
                  justification: "Need to write the requested note.",
                  retryToolCallId: "tool_1",
                },
              },
            ],
          });
        }

        secondTurnLastUserContent =
          JSON.parse(messages.at(-1)?.payloadJson ?? "{}").content ?? null;
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
            throw toolRecoverableError("Write access is missing for workspace notes.", {
              code: "permission_denied",
              requestable: true,
              failedToolCallId: "tool_1",
              summary: "Write access is missing for workspace notes.",
              entries: [
                {
                  resource: "filesystem",
                  path: LOOP_PROTECTED_FILE,
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

    const emittedEvents: Array<{ type: string; approvalId?: string; decision?: string }> = [];
    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools,
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
      emitEvent(event) {
        emittedEvents.push(event);
      },
    });

    const runPromise = loop.run({ sessionId: "sess_1", scenario: "chat" });
    const approvalId = Number(await waitForApprovalRequested(emittedEvents));

    expect(loop.enqueueSteerInput({ sessionId: "sess_1", content: "Please keep it short." })).toBe(
      true,
    );
    expect(
      loop.submitApprovalResponse({
        approvalId,
        decision: "approve",
        actor: "user",
        rawInput: "approve",
        grantedBy: "user",
        expiresAt: null,
      }),
    ).toBe(true);

    const result = await runPromise;

    expect(toolExecuteCount).toBe(2);
    expect(secondTurnLastUserContent).toBe("Please keep it short.");
    expect(result.events.some((event) => event.type === "approval_requested")).toBe(true);
    expect(
      result.events.some(
        (event) => event.type === "approval_resolved" && event.decision === "approve",
      ),
    ).toBe(true);
    expect(sessionsRepo.getById("sess_1")?.status).toBe("active");

    const rows = messagesRepo.listBySession("sess_1");
    expect(rows).toHaveLength(7);
    expect(JSON.parse(rows[2]?.payloadJson ?? "{}")).toMatchObject({
      toolCallId: "tool_1",
      toolName: "gated",
      isError: true,
      details: {
        code: "permission_denied",
      },
    });
    expect(JSON.parse(rows[3]?.payloadJson ?? "{}")).toMatchObject({
      content: [
        {
          type: "toolCall",
          id: "tool_2",
          name: "request_permissions",
        },
      ],
    });
    expect(JSON.parse(rows[4]?.payloadJson ?? "{}")).toMatchObject({
      toolCallId: "tool_2",
      toolName: "request_permissions",
      isError: false,
    });
    expect(JSON.parse(rows[5]?.payloadJson ?? "{}")).toEqual({
      content: "Please keep it short.",
    });
  });

  test("writes an error request_permissions tool result when approval is denied", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      ownerAgentId: "agent_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"try the protected action"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    let modelTurnCount = 0;
    const runner: AgentModelRunner = {
      async runTurn() {
        modelTurnCount += 1;
        if (modelTurnCount === 1) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [{ type: "toolCall", id: "tool_1", name: "gated", arguments: {} }],
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
                      path: LOOP_PROTECTED_FILE,
                      scope: "exact",
                      access: "read",
                    },
                  ],
                  justification: "Need to read the protected file.",
                  retryToolCallId: "tool_1",
                },
              },
            ],
          });
        }

        return makeAssistantResult({
          content: [{ type: "text", text: "The user denied the request." }],
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
          throw toolRecoverableError("Read access is missing for the protected file.", {
            code: "permission_denied",
            requestable: true,
            failedToolCallId: "tool_1",
            summary: "Read access is missing for the protected file.",
            entries: [
              {
                resource: "filesystem",
                path: LOOP_PROTECTED_FILE,
                scope: "exact",
                access: "read",
              },
            ],
          });
        },
      }),
    );
    tools.register(createRequestPermissionsTool());

    const emittedEvents: Array<{ type: string; approvalId?: string; decision?: string }> = [];
    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools,
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
      emitEvent(event) {
        emittedEvents.push(event);
      },
    });

    const runPromise = loop.run({ sessionId: "sess_1", scenario: "chat" });
    const approvalId = Number(await waitForApprovalRequested(emittedEvents));

    expect(
      loop.submitApprovalResponse({
        approvalId,
        decision: "deny",
        actor: "user",
        rawInput: "deny",
        reasonText: "The user denied this permission request.",
      }),
    ).toBe(true);

    const result = await runPromise;

    expect(
      result.events.some(
        (event) => event.type === "approval_resolved" && event.decision === "deny",
      ),
    ).toBe(true);
    expect(result.events.some((event) => event.type === "tool_call_failed")).toBe(true);

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
    expect(JSON.parse(rows[3]?.payloadJson ?? "{}")).toMatchObject({
      content: [
        {
          type: "toolCall",
          id: "tool_2",
          name: "request_permissions",
        },
      ],
    });
    expect(JSON.parse(rows[4]?.payloadJson ?? "{}")).toMatchObject({
      toolCallId: "tool_2",
      toolName: "request_permissions",
      isError: true,
      content: [
        {
          type: "text",
          text: expect.stringContaining("<permission_request_result>"),
        },
      ],
    });
  });

  test("routes task-session approval requests to the main agent target", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    const approvalsRepo = new ApprovalsRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_task",
      conversationId: "conv_1",
      branchId: "branch_1",
      ownerAgentId: "agent_1",
      purpose: "task",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_task",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"perform the task"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    let modelTurnCount = 0;
    const runner: AgentModelRunner = {
      async runTurn() {
        modelTurnCount += 1;
        if (modelTurnCount === 1) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "tool_task_perm",
                name: "request_permissions",
                arguments: {
                  entries: [
                    {
                      resource: "filesystem",
                      path: LOOP_PROTECTED_FILE,
                      scope: "exact",
                      access: "write",
                    },
                  ],
                  justification: "Need to write the requested note.",
                },
              },
            ],
          });
        }

        return makeAssistantResult({
          content: [{ type: "text", text: "approved" }],
        });
      },
    };

    const tools = new ToolRegistry();
    tools.register(createRequestPermissionsTool());

    const emittedEvents: Array<{
      type: string;
      approvalId?: string;
      approvalTarget?: "user" | "main_agent";
    }> = [];
    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools,
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
      emitEvent(event) {
        emittedEvents.push(event);
      },
    });

    const runPromise = loop.run({ sessionId: "sess_task", scenario: "chat" });
    const approvalId = Number(await waitForApprovalRequested(emittedEvents));
    const approvalRecord = approvalsRepo.getById(approvalId);

    expect(approvalRecord?.approvalTarget).toBe("main_agent");
    expect(emittedEvents.find((event) => event.type === "approval_requested")?.approvalTarget).toBe(
      "main_agent",
    );

    expect(
      loop.submitApprovalResponse({
        approvalId,
        decision: "approve",
        actor: "main_agent",
        rawInput: "approve",
        grantedBy: "main_agent",
      }),
    ).toBe(true);

    await runPromise;
  });

  test("queues steer input during a streaming text turn and handles it in the next turn", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"start"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    let turnCount = 0;
    let secondTurnLastUserContent: string | null = null;
    const runner: AgentModelRunner = {
      async runTurn({ onTextDelta, messages }) {
        turnCount += 1;
        if (turnCount === 1) {
          onTextDelta?.({
            delta: "Working",
            accumulatedText: "Working",
          });
          await delay(25);
          return makeAssistantResult({
            content: [{ type: "text", text: "Working" }],
          });
        }

        secondTurnLastUserContent =
          JSON.parse(messages.at(-1)?.payloadJson ?? "{}").content ?? null;
        return makeAssistantResult({
          content: [{ type: "text", text: "Done after steer" }],
        });
      },
    };

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry(),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    const runPromise = loop.run({ sessionId: "sess_1", scenario: "chat" });
    await delay(5);
    expect(
      loop.enqueueSteerInput({
        sessionId: "sess_1",
        content: "Use a short answer.",
        messageType: "approval_request",
        visibility: "hidden_system",
      }),
    ).toBe(true);

    const result = await runPromise;

    expect(turnCount).toBe(2);
    expect(secondTurnLastUserContent).toBe("Use a short answer.");
    const rows = messagesRepo.listBySession("sess_1");
    expect(rows).toHaveLength(4);
    expect(JSON.parse(rows[2]?.payloadJson ?? "{}")).toEqual({
      content: "Use a short answer.",
    });
    expect(rows[2]?.messageType).toBe("approval_request");
    expect(rows[2]?.visibility).toBe("hidden_system");
    expect(result.events.filter((event) => event.type === "turn_completed")).toHaveLength(2);
  });

  test("waits until the current assistant tool batch finishes before inserting steer input", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"do two tool steps"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    let turnCount = 0;
    let secondTurnLastUserContent: string | null = null;
    let toolCallsSeen = 0;
    const runner: AgentModelRunner = {
      async runTurn({ messages }) {
        turnCount += 1;
        if (turnCount === 1) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [
              { type: "toolCall", id: "tool_1", name: "step", arguments: { step: 1 } },
              { type: "toolCall", id: "tool_2", name: "step", arguments: { step: 2 } },
            ],
          });
        }

        secondTurnLastUserContent =
          JSON.parse(messages.at(-1)?.payloadJson ?? "{}").content ?? null;
        return makeAssistantResult({
          content: [{ type: "text", text: "Handled after both tools." }],
        });
      },
    };

    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "step",
        description: "Step tool",
        inputSchema: Type.Object(
          {
            step: Type.Integer(),
          },
          { additionalProperties: false },
        ),
        async execute(_context, args) {
          toolCallsSeen += 1;
          if (args.step === 1) {
            expect(
              loop.enqueueSteerInput({ sessionId: "sess_1", content: "Actually summarize it." }),
            ).toBe(true);
          }
          await delay(5);
          return textToolResult(`step ${args.step} done`);
        },
      }),
    );

    let loop: AgentLoop;
    loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools,
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    await loop.run({ sessionId: "sess_1", scenario: "chat" });

    expect(toolCallsSeen).toBe(2);
    expect(turnCount).toBe(2);
    expect(secondTurnLastUserContent).toBe("Actually summarize it.");

    const rows = messagesRepo.listBySession("sess_1");
    expect(rows).toHaveLength(6);
    expect(JSON.parse(rows[2]?.payloadJson ?? "{}")).toMatchObject({
      toolCallId: "tool_1",
      toolName: "step",
    });
    expect(JSON.parse(rows[3]?.payloadJson ?? "{}")).toMatchObject({
      toolCallId: "tool_2",
      toolName: "step",
    });
    expect(JSON.parse(rows[4]?.payloadJson ?? "{}")).toEqual({
      content: "Actually summarize it.",
    });
  });

  test("returns recoverable tool failures to the model as error tool results", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"run cat on a missing file"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    let callCount = 0;
    const runner: AgentModelRunner = {
      async runTurn() {
        callCount += 1;
        if (callCount === 1) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "tool_1",
                name: "bash",
                arguments: { command: "cat missing.txt" },
              },
            ],
          });
        }

        return makeAssistantResult({
          content: [{ type: "text", text: "The file was missing, so the command failed." }],
        });
      },
    };

    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "bash",
        description: "Run a shell command",
        inputSchema: TEST_BASH_TOOL_SCHEMA,
        execute() {
          throw toolRecoverableError("bash exited with code 1: cat: missing.txt: No such file");
        },
      }),
    );

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools,
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    const rows = messagesRepo.listBySession("sess_1");
    expect(rows).toHaveLength(4);
    expect(JSON.parse(rows[2]?.payloadJson ?? "{}")).toEqual({
      toolCallId: "tool_1",
      toolName: "bash",
      content: [{ type: "text", text: "bash exited with code 1: cat: missing.txt: No such file" }],
      isError: true,
    });
    expect(result.events.some((event) => event.type === "tool_call_failed")).toBe(true);
    expect(result.events.at(-1)?.type).toBe("run_completed");
  });

  test("treats bash non-zero exits as normal tool results when the tool returns them explicitly", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"try reading a missing file with bash"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    let callCount = 0;
    const runner: AgentModelRunner = {
      async runTurn() {
        callCount += 1;
        if (callCount === 1) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "tool_1",
                name: "bash",
                arguments: { command: "cat missing.txt" },
              },
            ],
          });
        }

        return makeAssistantResult({
          content: [{ type: "text", text: "The bash command failed with exit code 1." }],
        });
      },
    };

    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "bash",
        description: "Run a shell command",
        inputSchema: TEST_BASH_TOOL_SCHEMA,
        execute() {
          return textToolResult("cat: missing.txt: No such file or directory", {
            command: "cat missing.txt",
            exitCode: 1,
            stderr: "cat: missing.txt: No such file or directory",
          });
        },
      }),
    );

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools,
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    const rows = messagesRepo.listBySession("sess_1");
    expect(rows).toHaveLength(4);
    expect(JSON.parse(rows[2]?.payloadJson ?? "{}")).toEqual({
      toolCallId: "tool_1",
      toolName: "bash",
      content: [{ type: "text", text: "cat: missing.txt: No such file or directory" }],
      isError: false,
      details: {
        command: "cat missing.txt",
        exitCode: 1,
        stderr: "cat: missing.txt: No such file or directory",
      },
    });
    expect(result.events.some((event) => event.type === "tool_call_failed")).toBe(false);
    expect(result.events.at(-1)?.type).toBe("run_completed");
  });

  test("emits structured run_failed events for normalized llm errors", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"hello"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    const runner: AgentModelRunner = {
      async runTurn() {
        throw new AgentLlmError({
          kind: "rate_limit",
          message: "API rate limit reached",
          retryable: true,
          provider: "anthropic_main",
          model: "anthropic_main/claude-sonnet-4-5",
        });
      },
    };

    const emittedEvents: Array<{ type: string; errorKind?: string; retryable?: boolean }> = [];
    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry(),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
      emitEvent(event) {
        emittedEvents.push(event);
      },
    });

    await expect(loop.run({ sessionId: "sess_1", scenario: "chat" })).rejects.toThrow(
      "API rate limit reached",
    );

    expect(emittedEvents.at(-1)).toMatchObject({
      type: "run_failed",
      errorKind: "rate_limit",
      retryable: true,
    });
  });

  test("fails the run on internal tool errors instead of returning them to the model", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"run fragile tool"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    const emittedEvents: Array<{ type: string; errorKind?: string }> = [];
    const runner: AgentModelRunner = {
      async runTurn() {
        return makeAssistantResult({
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: "tool_1", name: "fragile", arguments: {} }],
        });
      },
    };

    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "fragile",
        description: "Explodes internally",
        inputSchema: NO_ARGS_TOOL_SCHEMA,
        execute() {
          throw new Error("cannot read properties of undefined");
        },
      }),
    );

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools,
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
      emitEvent(event) {
        emittedEvents.push(event);
      },
    });

    await expect(loop.run({ sessionId: "sess_1", scenario: "chat" })).rejects.toThrow(
      "Tool execution failed due to an internal runtime error.",
    );

    const rows = messagesRepo.listBySession("sess_1");
    expect(rows).toHaveLength(2);
    expect(emittedEvents.some((event) => event.type === "tool_call_failed")).toBe(true);
    expect(emittedEvents.find((event) => event.type === "tool_call_failed")).toMatchObject({
      type: "tool_call_failed",
      errorKind: "internal_error",
      errorMessage: "Tool execution failed due to an internal runtime error.",
      rawErrorMessage: "cannot read properties of undefined",
    });
    expect(emittedEvents.at(-1)).toMatchObject({
      type: "run_failed",
      errorKind: "internal_error",
    });
  });

  test("returns invalid tool args to the model instead of failing the run", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"run read_file with a bad path first, then recover"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    let turn = 0;
    const runner: AgentModelRunner = {
      async runTurn(input) {
        turn += 1;
        if (turn === 1) {
          return makeAssistantResult({
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "tool_1",
                name: "read_file",
                arguments: { path: 123 },
              },
            ],
          });
        }

        const toolMessages = input.messages.filter((message) => message.role === "tool");
        expect(toolMessages).toHaveLength(1);
        expect(toolMessages[0]?.payloadJson ?? "").toContain("read_file args are invalid");

        return makeAssistantResult({
          stopReason: "stop",
          content: [{ type: "text", text: "recovered" }],
        });
      },
    };

    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "read_file",
        description: "Reads a file",
        inputSchema: Type.Object(
          {
            path: Type.String(),
          },
          { additionalProperties: false },
        ),
        execute() {
          return textToolResult("ok");
        },
      }),
    );

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools,
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    expect(result.events.some((event) => event.type === "run_failed")).toBe(false);

    const rows = messagesRepo.listBySession("sess_1");
    expect(rows).toHaveLength(4);
    expect(rows[2]?.role).toBe("tool");
    expect(rows[2]?.payloadJson ?? "").toContain("read_file args are invalid");
    expect(rows[2]?.payloadJson ?? "").toContain('"isError":true');
    expect(rows[3]?.role).toBe("assistant");
    expect(rows[3]?.payloadJson ?? "").toContain("recovered");
  });

  test("requests compaction when the session context crosses the threshold", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"huge context"}',
      tokenTotal: 150_000,
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    const runner: AgentModelRunner = {
      async runTurn() {
        return {
          provider: "anthropic_main",
          model: "claude-sonnet-4-5",
          modelApi: "anthropic-messages",
          stopReason: "stop" as const,
          content: [{ type: "text", text: "reply" }],
          usage: {
            input: 150_000,
            output: 1_000,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 151_000,
          },
        };
      },
    };

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry(),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    expect(result.compaction.shouldCompact).toBe(true);
    expect(result.compaction.reason).toBe("threshold");
    const compactionEvent = result.events.find((event) => event.type === "compaction_requested");
    expect(compactionEvent).toMatchObject({
      type: "compaction_requested",
      sessionId: "sess_1",
      reason: "threshold",
      thresholdTokens: 140_000,
      effectiveWindow: 200_000,
    });
    expect(result.events.at(-1)?.type).toBe("run_completed");
  });

  test("runs threshold compaction asynchronously and persists session compaction state", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user_1",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"older turn"}',
      tokenTotal: 80_000,
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });
    messagesRepo.append({
      id: "msg_assistant_1",
      sessionId: "sess_1",
      seq: 2,
      role: "assistant",
      provider: "anthropic_main",
      model: "claude-sonnet-4-5",
      modelApi: "anthropic-messages",
      stopReason: "stop",
      payloadJson: '{"content":[{"type":"text","text":"older reply"}]}',
      usage: {
        input: 80_000,
        output: 1_000,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 81_000,
      },
      createdAt: new Date("2026-03-22T00:00:02.000Z"),
    });
    messagesRepo.append({
      id: "msg_user_2",
      sessionId: "sess_1",
      seq: 3,
      role: "user",
      payloadJson: '{"content":"recent turn"}',
      tokenTotal: 70_000,
      createdAt: new Date("2026-03-22T00:00:03.000Z"),
    });

    const emittedEvents: string[] = [];
    const runner: AgentModelRunner & {
      runCompaction: NonNullable<
        import("@/src/agent/compaction.js").CompactionModelRunner["runCompaction"]
      >;
    } = {
      async runTurn() {
        return {
          provider: "anthropic_main",
          model: "claude-sonnet-4-5",
          modelApi: "anthropic-messages",
          stopReason: "stop" as const,
          content: [{ type: "text", text: "reply" }],
          usage: {
            input: 150_000,
            output: 1_000,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 151_000,
          },
        };
      },
      async runCompaction() {
        return {
          provider: "anthropic_main",
          model: "anthropic_main/claude-sonnet-4-5",
          modelApi: "anthropic-messages",
          text: "compact summary",
          usage: {
            input: 500,
            output: 123,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 623,
          },
        };
      },
    };

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry(),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: {
        reserveTokens: 60_000,
        keepRecentTokens: 15_000,
        reserveTokensFloor: 60_000,
        recentTurnsPreserve: 1,
      },
      emitEvent(event) {
        emittedEvents.push(event.type);
      },
    });

    await loop.run({ sessionId: "sess_1", scenario: "chat" });
    const session = await waitForSessionCompaction(sessionsRepo, "sess_1");
    expect(session?.compactCursor).toBe(2);
    expect(session?.compactSummary).toBe("compact summary");
    expect(session?.compactSummaryTokenTotal).toBe(123);
    expect(emittedEvents).toContain("compaction_started");
    expect(emittedEvents).toContain("compaction_completed");
  });

  test("recovers from context overflow by compacting and retrying the turn once", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user_1",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"huge request"}',
      tokenTotal: 55_000,
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });
    messagesRepo.append({
      id: "msg_assistant_1",
      sessionId: "sess_1",
      seq: 2,
      role: "assistant",
      provider: "anthropic_main",
      model: "claude-sonnet-4-5",
      modelApi: "anthropic-messages",
      stopReason: "stop",
      payloadJson: '{"content":[{"type":"text","text":"partial work"}]}',
      usage: {
        input: 55_000,
        output: 1_000,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 56_000,
      },
      createdAt: new Date("2026-03-22T00:00:02.000Z"),
    });

    let runTurnCount = 0;
    const runner: AgentModelRunner & {
      runCompaction: NonNullable<
        import("@/src/agent/compaction.js").CompactionModelRunner["runCompaction"]
      >;
    } = {
      async runTurn() {
        runTurnCount += 1;
        if (runTurnCount === 1) {
          throw new AgentLlmError({
            kind: "context_overflow",
            message: "context window exceeded",
            retryable: false,
          });
        }

        return makeAssistantResult({
          content: [{ type: "text", text: "recovered reply" }],
        });
      },
      async runCompaction() {
        return {
          provider: "anthropic_main",
          model: "anthropic_main/claude-sonnet-4-5",
          modelApi: "anthropic-messages",
          text: "overflow compact summary",
          usage: {
            input: 500,
            output: 111,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 611,
          },
        };
      },
    };

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry(),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    const session = sessionsRepo.getById("sess_1");
    expect(runTurnCount).toBe(2);
    expect(session?.compactCursor).toBe(1);
    expect(session?.compactSummary).toContain("overflow compact summary");
    expect(session?.compactSummaryTokenTotal).toBeGreaterThan(0);
    expect(result.compaction.reason).toBe("overflow");
    expect(result.events.some((event) => event.type === "compaction_started")).toBe(true);
    expect(result.events.some((event) => event.type === "compaction_completed")).toBe(true);
    expect(result.events.at(-1)?.type).toBe("run_completed");
  });
});
