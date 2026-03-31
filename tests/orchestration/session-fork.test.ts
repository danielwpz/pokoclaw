import { afterEach, describe, expect, test } from "vitest";

import { AgentSessionService } from "@/src/agent/session.js";
import { materializeForkedSessionSnapshot } from "@/src/orchestration/session-fork.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

function seedConversationFixture(handle: TestDatabaseHandle): void {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_1', 'lark', 'acct_a', '2026-03-31T00:00:00.000Z', '2026-03-31T00:00:00.000Z');

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES ('conv_1', 'ci_1', 'chat_1', 'dm', '2026-03-31T00:00:00.000Z', '2026-03-31T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES
      ('branch_main', 'conv_1', 'dm_main', 'main', '2026-03-31T00:00:00.000Z', '2026-03-31T00:00:00.000Z'),
      ('branch_thread', 'conv_1', 'dm_thread', 'thread:123', '2026-03-31T00:00:00.000Z', '2026-03-31T00:00:00.000Z');
  `);
}

describe("session fork materialization", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("copies the source effective context snapshot into the target session", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    const service = new AgentSessionService(sessionsRepo, messagesRepo);

    sessionsRepo.create({
      id: "sess_main",
      conversationId: "conv_1",
      branchId: "branch_main",
      purpose: "chat",
      compactCursor: 1,
      compactSummary: "summary through seq 1",
      compactSummaryTokenTotal: 123,
      compactSummaryUsageJson:
        '{"input":100,"output":23,"cacheRead":0,"cacheWrite":0,"totalTokens":123}',
      createdAt: new Date("2026-03-31T00:00:00.000Z"),
      updatedAt: new Date("2026-03-31T00:00:00.000Z"),
    });

    messagesRepo.append({
      id: "msg_1",
      sessionId: "sess_main",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"old"}',
      createdAt: new Date("2026-03-31T00:00:01.000Z"),
    });
    messagesRepo.append({
      id: "msg_2",
      sessionId: "sess_main",
      seq: 2,
      role: "assistant",
      provider: "anthropic_main",
      model: "claude-sonnet-4-5",
      modelApi: "anthropic-messages",
      stopReason: "stop",
      payloadJson: '{"content":[{"type":"text","text":"latest visible answer"}]}',
      usage: {
        input: 80,
        output: 20,
        cacheRead: 5,
        cacheWrite: 0,
        totalTokens: 105,
        cost: {
          input: 1,
          output: 2,
          cacheRead: 0.1,
          cacheWrite: 0,
          total: 3.1,
        },
      },
      createdAt: new Date("2026-03-31T00:00:02.000Z"),
    });
    messagesRepo.append({
      id: "msg_3",
      sessionId: "sess_main",
      seq: 3,
      role: "user",
      payloadJson: '{"content":"newest user message"}',
      createdAt: new Date("2026-03-31T00:00:03.000Z"),
    });

    const forked = materializeForkedSessionSnapshot({
      db: handle.storage.db,
      targetSession: {
        id: "sess_thread",
        conversationId: "conv_1",
        branchId: "branch_thread",
        purpose: "chat",
        contextMode: "isolated",
        createdAt: new Date("2026-03-31T00:00:10.000Z"),
        updatedAt: new Date("2026-03-31T00:00:10.000Z"),
      },
      sourceSessionId: "sess_main",
      forkSourceSeq: 2,
    });

    expect(forked).toMatchObject({
      id: "sess_thread",
      forkedFromSessionId: "sess_main",
      forkSourceSeq: 2,
      compactCursor: 0,
      compactSummary: "summary through seq 1",
      compactSummaryTokenTotal: 123,
    });

    const context = service.getContext("sess_thread");
    expect(context.compactSummary).toBe("summary through seq 1");
    expect(context.compactSummaryTokenTotal).toBe(123);
    expect(context.compactSummaryUsageJson).toBe(
      '{"input":100,"output":23,"cacheRead":0,"cacheWrite":0,"totalTokens":123}',
    );
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0]).toMatchObject({
      seq: 1,
      role: "assistant",
      payloadJson: '{"content":[{"type":"text","text":"latest visible answer"}]}',
      provider: "anthropic_main",
      model: "claude-sonnet-4-5",
      modelApi: "anthropic-messages",
      stopReason: "stop",
    });
    expect(context.messages[0]?.usageJson).toBe(
      '{"input":80,"output":20,"cacheRead":5,"cacheWrite":0,"totalTokens":105,"cost":{"input":1,"output":2,"cacheRead":0.1,"cacheWrite":0,"total":3.1}}',
    );
  });
});
