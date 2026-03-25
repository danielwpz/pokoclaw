import type { AssistantMessage, AssistantMessageEvent } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PiAgentModelRunner, PiBridge } from "@/src/agent/llm/pi-bridge.js";
import { ProviderRegistry } from "@/src/agent/llm/provider-registry.js";
import { AgentLoop } from "@/src/agent/loop.js";
import { AgentSessionService } from "@/src/agent/session.js";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import type { AppConfig } from "@/src/config/schema.js";
import { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import type { Message } from "@/src/storage/schema/types.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

const { streamSimpleMock } = vi.hoisted(() => ({
  streamSimpleMock: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
  return {
    ...actual,
    streamSimple: streamSimpleMock,
  };
});

function createModelConfig(): Pick<AppConfig, "providers" | "models"> {
  return {
    providers: {
      anthropic_main: {
        api: "anthropic-messages",
        apiKey: "secret",
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

function createStoredUserMessage(): Omit<Message, "sessionId"> {
  return {
    id: "msg_user",
    seq: 1,
    role: "user",
    messageType: "text",
    visibility: "user_visible",
    channelMessageId: null,
    provider: null,
    model: null,
    modelApi: null,
    stopReason: null,
    errorMessage: null,
    payloadJson: JSON.stringify({ content: "hello" }),
    tokenInput: null,
    tokenOutput: null,
    tokenCacheRead: null,
    tokenCacheWrite: null,
    tokenTotal: null,
    usageJson: null,
    createdAt: "2026-03-22T00:00:01.000Z",
  };
}

function createAssistantEventStream(events: AssistantMessageEvent[], result: AssistantMessage) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
    async result() {
      return result;
    },
  };
}

describe("pi agent model runner", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    streamSimpleMock.mockReset();
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("drives the loop through pi streaming and persists the final assistant payload", async () => {
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

    const storedUserMessage = createStoredUserMessage();
    messagesRepo.append({
      ...storedUserMessage,
      sessionId: "sess_1",
      createdAt: new Date(storedUserMessage.createdAt),
    });

    const finalMessage = {
      role: "assistant" as const,
      api: "anthropic-messages" as const,
      provider: "anthropic_main",
      model: "claude-sonnet-4-5-20250929",
      stopReason: "stop" as const,
      content: [{ type: "text" as const, text: "hello world" }],
      usage: {
        input: 10,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 13,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      timestamp: Date.now(),
    };

    streamSimpleMock.mockReturnValue(
      createAssistantEventStream(
        [
          {
            type: "text_delta",
            contentIndex: 0,
            delta: "hello ",
            partial: finalMessage,
          },
          {
            type: "text_delta",
            contentIndex: 0,
            delta: "world",
            partial: finalMessage,
          },
          {
            type: "done",
            reason: "stop",
            message: finalMessage,
          },
        ],
        finalMessage,
      ),
    );

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools: new ToolRegistry(),
      cancel: new SessionRunAbortRegistry(),
      modelRunner: new PiAgentModelRunner(new PiBridge(), new ToolRegistry()),
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    const rows = messagesRepo.listBySession("sess_1");
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[1]?.payloadJson ?? "{}")).toEqual({
      content: [{ type: "text", text: "hello world" }],
    });

    const deltaEvents = result.events.filter((event) => event.type === "assistant_message_delta");
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
});
