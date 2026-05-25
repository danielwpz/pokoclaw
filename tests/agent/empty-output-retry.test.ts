import { afterEach, describe, expect, test } from "vitest";
import type { AgentRuntimeEvent } from "@/src/agent/events.js";
import { AgentLlmError } from "@/src/agent/llm/errors.js";
import type { AgentAssistantContentBlock } from "@/src/agent/llm/messages.js";
import { ProviderRegistry } from "@/src/agent/llm/provider-registry.js";
import { AgentLoop, type AgentModelRunner } from "@/src/agent/loop.js";
import { AgentSessionService } from "@/src/agent/session.js";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import type { AppConfig } from "@/src/config/schema.js";
import { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
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
        meditationBucket: [],
        meditationConsolidation: [],
      },
    },
  };
}

function makeAssistantResult(content: AgentAssistantContentBlock[]) {
  return {
    provider: "anthropic_main",
    model: "claude-sonnet-4-5",
    modelApi: "anthropic-messages",
    stopReason: "stop" as const,
    content,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
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

function seedChatSession(handle: TestDatabaseHandle): {
  sessionsRepo: SessionsRepo;
  messagesRepo: MessagesRepo;
} {
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
  return { sessionsRepo, messagesRepo };
}

function createLoop(input: {
  handle: TestDatabaseHandle;
  sessionsRepo: SessionsRepo;
  messagesRepo: MessagesRepo;
  runner: AgentModelRunner;
  emittedEvents: AgentRuntimeEvent[];
  maxEmptyOutputLlmAttempts?: number;
}): AgentLoop {
  return new AgentLoop({
    sessions: new AgentSessionService(input.sessionsRepo, input.messagesRepo),
    messages: input.messagesRepo,
    models: new ProviderRegistry(createModelConfig()),
    tools: new ToolRegistry(),
    cancel: new SessionRunAbortRegistry(),
    modelRunner: input.runner,
    storage: input.handle.storage.db,
    securityConfig: DEFAULT_CONFIG.security,
    compaction: DEFAULT_CONFIG.compaction,
    ...(input.maxEmptyOutputLlmAttempts == null
      ? {}
      : {
          runtime: {
            ...DEFAULT_CONFIG.runtime,
            maxEmptyOutputLlmAttempts: input.maxEmptyOutputLlmAttempts,
          },
        }),
    emitEvent(event) {
      input.emittedEvents.push(event);
    },
  });
}

describe("AgentLoop empty-output LLM retry", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("defaults to five total attempts and emits retry progress", async () => {
    handle = await createTestDatabase(import.meta.url);
    const { sessionsRepo, messagesRepo } = seedChatSession(handle);

    let runTurnCount = 0;
    const emittedEvents: AgentRuntimeEvent[] = [];
    const runner: AgentModelRunner = {
      async runTurn() {
        runTurnCount += 1;
        if (runTurnCount < 5) {
          throw new AgentLlmError({
            kind: "timeout",
            message: "LLM first response timed out after 45000ms",
            retryable: true,
            provider: "anthropic_main",
            model: "anthropic_main/claude-sonnet-4-5",
          });
        }

        return makeAssistantResult([{ type: "text", text: "recovered on fifth attempt" }]);
      },
    };

    const loop = createLoop({
      handle,
      sessionsRepo,
      messagesRepo,
      runner,
      emittedEvents,
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    expect(runTurnCount).toBe(5);
    expect(result.events.some((event) => event.type === "run_failed")).toBe(false);
    expect(
      emittedEvents
        .filter((event) => event.type === "assistant_response_retrying")
        .map((event) => ({
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          reason: event.reason,
          errorKind: event.errorKind,
        })),
    ).toEqual([
      {
        attempt: 2,
        maxAttempts: 5,
        reason: "llm_failure_without_visible_output",
        errorKind: "timeout",
      },
      {
        attempt: 3,
        maxAttempts: 5,
        reason: "llm_failure_without_visible_output",
        errorKind: "timeout",
      },
      {
        attempt: 4,
        maxAttempts: 5,
        reason: "llm_failure_without_visible_output",
        errorKind: "timeout",
      },
      {
        attempt: 5,
        maxAttempts: 5,
        reason: "llm_failure_without_visible_output",
        errorKind: "timeout",
      },
    ]);
  });

  test("respects configured max attempts", async () => {
    handle = await createTestDatabase(import.meta.url);
    const { sessionsRepo, messagesRepo } = seedChatSession(handle);

    let runTurnCount = 0;
    const emittedEvents: AgentRuntimeEvent[] = [];
    const runner: AgentModelRunner = {
      async runTurn() {
        runTurnCount += 1;
        throw new AgentLlmError({
          kind: "timeout",
          message: "LLM first response timed out after 45000ms",
          retryable: true,
          provider: "anthropic_main",
          model: "anthropic_main/claude-sonnet-4-5",
        });
      },
    };

    const loop = createLoop({
      handle,
      sessionsRepo,
      messagesRepo,
      runner,
      emittedEvents,
      maxEmptyOutputLlmAttempts: 2,
    });

    await expect(loop.run({ sessionId: "sess_1", scenario: "chat" })).rejects.toThrow(
      "LLM first response timed out",
    );

    expect(runTurnCount).toBe(2);
    expect(
      emittedEvents
        .filter((event) => event.type === "assistant_response_retrying")
        .map((event) => ({
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
        })),
    ).toEqual([{ attempt: 2, maxAttempts: 2 }]);
  });

  test("applies the same attempt budget to successful empty assistant outputs", async () => {
    handle = await createTestDatabase(import.meta.url);
    const { sessionsRepo, messagesRepo } = seedChatSession(handle);

    let runTurnCount = 0;
    const emittedEvents: AgentRuntimeEvent[] = [];
    const runner: AgentModelRunner = {
      async runTurn() {
        runTurnCount += 1;
        if (runTurnCount < 3) {
          return makeAssistantResult([]);
        }
        return makeAssistantResult([{ type: "text", text: "recovered after empty outputs" }]);
      },
    };

    const loop = createLoop({
      handle,
      sessionsRepo,
      messagesRepo,
      runner,
      emittedEvents,
      maxEmptyOutputLlmAttempts: 3,
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    expect(runTurnCount).toBe(3);
    expect(result.events.some((event) => event.type === "run_failed")).toBe(false);
    expect(
      emittedEvents
        .filter((event) => event.type === "assistant_response_retrying")
        .map((event) => ({
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          reason: event.reason,
        })),
    ).toEqual([
      {
        attempt: 2,
        maxAttempts: 3,
        reason: "successful_empty_output",
      },
      {
        attempt: 3,
        maxAttempts: 3,
        reason: "successful_empty_output",
      },
    ]);
  });
});
