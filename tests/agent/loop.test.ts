import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, test } from "vitest";
import { SessionRunAbortRegistry } from "@/src/agent/cancel.js";
import type { AgentAssistantContentBlock } from "@/src/agent/llm/messages.js";
import { ProviderRegistry } from "@/src/agent/llm/provider-registry.js";
import { AgentLoop, type AgentModelRunner } from "@/src/agent/loop.js";
import { AgentSessionService } from "@/src/agent/session.js";
import { ToolRegistry } from "@/src/agent/tools/registry.js";
import { textToolResult } from "@/src/agent/tools/types.js";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import type { AppConfig } from "@/src/config/schema.js";
import { createTestLogger } from "@/src/shared/logger.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
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
      logger: createTestLogger(
        { level: "debug", useColors: false },
        { subsystem: "agent-loop-test" },
      ),
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
    tools.register({
      name: "bash",
      description: "Run a shell command",
      validateArgs(input) {
        if (
          typeof input !== "object" ||
          input == null ||
          !("command" in input) ||
          typeof input.command !== "string"
        ) {
          throw new Error("invalid args");
        }

        const normalized: { command: string; workdir?: string; timeoutMs?: number } = {
          command: input.command,
        };

        if ("workdir" in input && typeof input.workdir === "string") {
          normalized.workdir = input.workdir;
        }

        if ("timeoutMs" in input && typeof input.timeoutMs === "number") {
          normalized.timeoutMs = input.timeoutMs;
        }

        return normalized;
      },
      execute(_context, args: { command: string; workdir?: string; timeoutMs?: number }) {
        return textToolResult("README.md\nsrc\ntests", {
          command: args.command,
          workdir: args.workdir ?? null,
          timeoutMs: args.timeoutMs ?? null,
          exitCode: 0,
        });
      },
    });

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools,
      cancel: new SessionRunAbortRegistry(),
      modelRunner: runner,
      storage: handle.storage.db,
      logger: createTestLogger(
        { level: "debug", useColors: false },
        { subsystem: "agent-loop-test" },
      ),
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
    tools.register({
      name: "slow",
      description: "Slow tool",
      async execute(context) {
        await delay(1000, undefined, { signal: context.abortSignal });
        return textToolResult("done");
      },
    });

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools,
      cancel,
      modelRunner: runner,
      storage: handle.storage.db,
      logger: createTestLogger(
        { level: "debug", useColors: false },
        { subsystem: "agent-loop-test" },
      ),
      compaction: DEFAULT_CONFIG.compaction,
    });

    const runPromise = loop.run({ sessionId: "sess_1", scenario: "chat" });
    await delay(20);
    expect(cancel.cancel("sess_1", "stop requested")).toBe(true);

    await expect(runPromise).rejects.toThrow();
    expect(cancel.isActive("sess_1")).toBe(false);
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
            input: 1_000,
            output: 1_000,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2_000,
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
      logger: createTestLogger(
        { level: "debug", useColors: false },
        { subsystem: "agent-loop-test" },
      ),
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
});
