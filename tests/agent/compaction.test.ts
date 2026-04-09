import { afterEach, describe, expect, test } from "vitest";

import {
  AgentCompactionService,
  decideCompaction,
  estimateSessionContextTokens,
  getCompactionThresholdTokens,
  getEffectiveCompactionWindow,
  prepareCompaction,
} from "@/src/agent/compaction.js";
import { ProviderRegistry } from "@/src/agent/llm/provider-registry.js";
import { AgentSessionService } from "@/src/agent/session.js";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import type { AppConfig } from "@/src/config/schema.js";
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

describe("compaction helpers", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("uses the model context window directly", () => {
    expect(getEffectiveCompactionWindow(128_000)).toBe(128_000);
    expect(getEffectiveCompactionWindow(400_000)).toBe(400_000);
  });

  test("computes threshold from effective window minus reserve tokens", () => {
    expect(getCompactionThresholdTokens(200_000, DEFAULT_CONFIG.compaction)).toBe(140_000);
    expect(getCompactionThresholdTokens(400_000, DEFAULT_CONFIG.compaction)).toBe(340_000);
  });

  test("prefers overflow compaction over threshold checks", () => {
    expect(
      decideCompaction({
        contextTokens: 100_000,
        contextWindow: 200_000,
        config: DEFAULT_CONFIG.compaction,
        overflow: true,
      }),
    ).toEqual({
      shouldCompact: true,
      reason: "overflow",
      effectiveWindow: 200_000,
      thresholdTokens: 140_000,
    });
  });

  test("triggers threshold compaction only once the budget is crossed", () => {
    expect(
      decideCompaction({
        contextTokens: 139_999,
        contextWindow: 200_000,
        config: DEFAULT_CONFIG.compaction,
      }).shouldCompact,
    ).toBe(false);

    expect(
      decideCompaction({
        contextTokens: 140_000,
        contextWindow: 200_000,
        config: DEFAULT_CONFIG.compaction,
      }),
    ).toEqual({
      shouldCompact: true,
      reason: "threshold",
      effectiveWindow: 200_000,
      thresholdTokens: 140_000,
    });
  });

  test("prefers the latest assistant usage snapshot over re-summing older messages", () => {
    const estimate = estimateSessionContextTokens({
      compactSummary: "existing summary",
      compactSummaryTokenTotal: 120,
      messages: [
        {
          id: "msg_user_1",
          sessionId: "sess_1",
          seq: 1,
          role: "user",
          messageType: "text",
          visibility: "user_visible",
          channelMessageId: null,
          channelParentMessageId: null,
          channelThreadId: null,
          provider: null,
          model: null,
          modelApi: null,
          stopReason: null,
          errorMessage: null,
          payloadJson: '{"content":"old question"}',
          tokenInput: null,
          tokenOutput: null,
          tokenCacheRead: null,
          tokenCacheWrite: null,
          tokenTotal: 90,
          usageJson: null,
          createdAt: "2026-03-22T00:00:00.000Z",
        },
        {
          id: "msg_assistant_1",
          sessionId: "sess_1",
          seq: 2,
          role: "assistant",
          messageType: "text",
          visibility: "user_visible",
          channelMessageId: null,
          channelParentMessageId: null,
          channelThreadId: null,
          provider: "anthropic_main",
          model: "claude-sonnet-4-5",
          modelApi: "anthropic-messages",
          stopReason: "stop",
          errorMessage: null,
          payloadJson: '{"content":[{"type":"text","text":"reply"}]}',
          tokenInput: 1_000,
          tokenOutput: 300,
          tokenCacheRead: 0,
          tokenCacheWrite: 0,
          tokenTotal: 1_300,
          usageJson: '{"input":1000,"output":300,"cacheRead":0,"cacheWrite":0,"totalTokens":1300}',
          createdAt: "2026-03-22T00:00:01.000Z",
        },
        {
          id: "msg_user_2",
          sessionId: "sess_1",
          seq: 3,
          role: "user",
          messageType: "text",
          visibility: "user_visible",
          channelMessageId: null,
          channelParentMessageId: null,
          channelThreadId: null,
          provider: null,
          model: null,
          modelApi: null,
          stopReason: null,
          errorMessage: null,
          payloadJson: '{"content":"follow-up"}',
          tokenInput: null,
          tokenOutput: null,
          tokenCacheRead: null,
          tokenCacheWrite: null,
          tokenTotal: 40,
          usageJson: null,
          createdAt: "2026-03-22T00:00:02.000Z",
        },
      ],
    });

    expect(estimate.lastUsageIndex).toBe(1);
    expect(estimate.compactSummaryTokens).toBe(120);
    expect(estimate.trailingTokens).toBe(40);
    expect(estimate.tokens).toBe(1_340);
  });

  test("prefers keeping full recent turns and only splits turns as fallback", () => {
    const fullTurnCut = prepareCompaction({
      messages: [
        makeUserMessage("msg_1", 1, "older turn", 8_000),
        makeAssistantMessage("msg_2", 2, "older answer", 8_000),
        makeUserMessage("msg_3", 3, "recent turn", 8_000),
        makeAssistantMessage("msg_4", 4, "recent answer", 8_000),
      ],
      config: {
        reserveTokens: 60_000,
        keepRecentTokens: 12_000,
        reserveTokensFloor: 60_000,
        recentTurnsPreserve: 1,
      },
      contextTokens: 32_000,
    });

    expect(fullTurnCut).not.toBeNull();
    expect(fullTurnCut?.isSplitTurn).toBe(false);
    expect(fullTurnCut?.firstKeptIndex).toBe(2);
    expect(fullTurnCut?.compactCursor).toBe(2);

    const splitTurnCut = prepareCompaction({
      messages: [
        makeUserMessage("msg_1", 1, "one huge turn", 6_000),
        makeAssistantMessage("msg_2", 2, "step one", 6_000),
        makeAssistantMessage("msg_3", 3, "step two", 6_000),
      ],
      config: {
        reserveTokens: 60_000,
        keepRecentTokens: 8_000,
        reserveTokensFloor: 60_000,
        recentTurnsPreserve: 1,
      },
      contextTokens: 18_000,
    });

    expect(splitTurnCut).not.toBeNull();
    expect(splitTurnCut?.isSplitTurn).toBe(true);
    expect(splitTurnCut?.turnStartIndex).toBe(0);
    expect(splitTurnCut?.firstKeptIndex).toBe(1);
    expect(splitTurnCut?.compactCursor).toBe(1);
  });

  test("compaction service persists summary token count and usage json onto the session", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    const sessionService = new AgentSessionService(sessionsRepo, messagesRepo);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      compactSummary: "older summary",
      compactSummaryTokenTotal: 77,
      compactSummaryUsageJson:
        '{"input":55,"output":77,"cacheRead":0,"cacheWrite":0,"totalTokens":132}',
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_1",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"first request"}',
      tokenTotal: 9_000,
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });
    messagesRepo.append({
      id: "msg_2",
      sessionId: "sess_1",
      seq: 2,
      role: "assistant",
      provider: "anthropic_main",
      model: "claude-sonnet-4-5",
      modelApi: "anthropic-messages",
      stopReason: "stop",
      payloadJson: '{"content":[{"type":"text","text":"first answer"}]}',
      tokenTotal: 10_000,
      usage: {
        input: 9_000,
        output: 1_000,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 10_000,
      },
      createdAt: new Date("2026-03-22T00:00:02.000Z"),
    });
    messagesRepo.append({
      id: "msg_3",
      sessionId: "sess_1",
      seq: 3,
      role: "user",
      payloadJson: '{"content":"recent request"}',
      tokenTotal: 9_000,
      createdAt: new Date("2026-03-22T00:00:03.000Z"),
    });
    messagesRepo.append({
      id: "msg_4",
      sessionId: "sess_1",
      seq: 4,
      role: "assistant",
      provider: "anthropic_main",
      model: "claude-sonnet-4-5",
      modelApi: "anthropic-messages",
      stopReason: "stop",
      payloadJson: '{"content":[{"type":"text","text":"recent answer"}]}',
      tokenTotal: 20_000,
      usage: {
        input: 19_000,
        output: 1_000,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 20_000,
      },
      createdAt: new Date("2026-03-22T00:00:04.000Z"),
    });

    const prompts: string[] = [];
    const service = new AgentCompactionService({
      sessions: sessionService,
      models: new ProviderRegistry(createModelConfig()),
      runner: {
        async runCompaction(input) {
          prompts.push(input.prompt);
          return {
            provider: "anthropic_main",
            model: "anthropic_main/claude-sonnet-4-5",
            modelApi: "anthropic-messages",
            text: "updated compact summary",
            usage: {
              input: 500,
              output: 123,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 623,
            },
          };
        },
      },
      config: {
        reserveTokens: 60_000,
        keepRecentTokens: 15_000,
        reserveTokensFloor: 60_000,
        recentTurnsPreserve: 1,
      },
    });

    const emitted: string[] = [];
    const result = await service.compactNow({
      sessionId: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      runId: "run_1",
      reason: "threshold",
      emitEvent(event) {
        emitted.push(event.type);
      },
    });

    const session = sessionsRepo.getById("sess_1");
    expect(result).toEqual({
      compacted: true,
      compactCursor: 2,
      summaryTokenTotal: 123,
    });
    expect(session?.compactCursor).toBe(2);
    expect(session?.compactSummary).toBe("updated compact summary");
    expect(session?.compactSummaryTokenTotal).toBe(123);
    expect(session?.compactSummaryUsageJson).toBe(
      '{"input":500,"output":123,"cacheRead":0,"cacheWrite":0,"totalTokens":623}',
    );
    expect(prompts[0]).toContain("<previous-summary>");
    expect(emitted).toEqual(["compaction_started", "compaction_completed"]);
  });
});

function makeUserMessage(id: string, seq: number, content: string, tokenTotal: number) {
  return {
    id,
    sessionId: "sess_1",
    seq,
    role: "user",
    messageType: "text",
    visibility: "user_visible",
    channelMessageId: null,
    channelParentMessageId: null,
    channelThreadId: null,
    provider: null,
    model: null,
    modelApi: null,
    stopReason: null,
    errorMessage: null,
    payloadJson: JSON.stringify({ content }),
    tokenInput: null,
    tokenOutput: null,
    tokenCacheRead: null,
    tokenCacheWrite: null,
    tokenTotal,
    usageJson: null,
    createdAt: "2026-03-22T00:00:00.000Z",
  };
}

function makeAssistantMessage(id: string, seq: number, text: string, tokenTotal: number) {
  return {
    id,
    sessionId: "sess_1",
    seq,
    role: "assistant",
    messageType: "text",
    visibility: "user_visible",
    channelMessageId: null,
    channelParentMessageId: null,
    channelThreadId: null,
    provider: "anthropic_main",
    model: "claude-sonnet-4-5",
    modelApi: "anthropic-messages",
    stopReason: "stop",
    errorMessage: null,
    payloadJson: JSON.stringify({
      content: [{ type: "text", text }],
    }),
    tokenInput: null,
    tokenOutput: null,
    tokenCacheRead: null,
    tokenCacheWrite: null,
    tokenTotal,
    usageJson: JSON.stringify({
      input: Math.max(0, tokenTotal - 1_000),
      output: 1_000,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: tokenTotal,
    }),
    createdAt: "2026-03-22T00:00:00.000Z",
  };
}
