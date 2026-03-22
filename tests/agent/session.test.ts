import { afterEach, describe, expect, test } from "vitest";

import { AgentSessionService } from "@/src/agent/session.js";
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
    VALUES ('ci_1', 'lark', 'acct_a', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES ('conv_1', 'ci_1', 'chat_1', 'dm', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
  `);
}

describe("agent session service", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("returns compact summary and only messages after compact cursor", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    const service = new AgentSessionService(sessionsRepo, messagesRepo);

    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      compactCursor: 1,
      compactSummary: "summary up to seq 1",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });

    messagesRepo.append({
      id: "msg_1",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: '{"content":"old"}',
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
      payloadJson: '{"content":[{"type":"text","text":"new"}]}',
      createdAt: new Date("2026-03-22T00:00:02.000Z"),
    });

    const context = service.getContext("sess_1");
    expect(context.compactSummary).toBe("summary up to seq 1");
    expect(context.messages.map((message) => message.id)).toEqual(["msg_2"]);
  });

  test("fails clearly for unknown sessions", async () => {
    handle = await createTestDatabase(import.meta.url);

    const service = new AgentSessionService(
      new SessionsRepo(handle.storage.db),
      new MessagesRepo(handle.storage.db),
    );

    expect(() => service.getContext("missing")).toThrow("Session not found: missing");
  });
});
