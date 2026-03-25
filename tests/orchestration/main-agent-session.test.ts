import { describe, expect, test } from "vitest";

import { resolveMainAgentChatSessionForAgent } from "@/src/orchestration/main-agent-session.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

async function withHandle(fn: (handle: TestDatabaseHandle) => Promise<void>): Promise<void> {
  const handle = await createTestDatabase(import.meta.url);
  try {
    await fn(handle);
  } finally {
    await destroyTestDatabase(handle);
  }
}

function seedFixture(handle: TestDatabaseHandle): void {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_1', 'lark', 'acct_a', '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:00.000Z');

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES
      ('conv_main', 'ci_1', 'chat_main', 'dm', '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:00.000Z'),
      ('conv_sub', 'ci_1', 'chat_sub', 'group', '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES
      ('branch_main', 'conv_main', 'dm_main', 'main', '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:00.000Z'),
      ('branch_sub', 'conv_sub', 'group_main', 'main', '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:00.000Z');

    INSERT INTO agents (id, conversation_id, main_agent_id, kind, created_at)
    VALUES
      ('agent_main', 'conv_main', NULL, 'main', '2026-03-25T00:00:00.000Z'),
      ('agent_sub', 'conv_sub', 'agent_main', 'sub', '2026-03-25T00:00:00.000Z');
  `);
}

describe("main agent session resolution", () => {
  test("resolves the latest main-agent chat session for a subagent", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      const sessionsRepo = new SessionsRepo(handle.storage.db);
      sessionsRepo.create({
        id: "sess_main_old",
        conversationId: "conv_main",
        branchId: "branch_main",
        ownerAgentId: "agent_main",
        purpose: "chat",
        createdAt: new Date("2026-03-25T00:00:01.000Z"),
        updatedAt: new Date("2026-03-25T00:00:01.000Z"),
      });
      sessionsRepo.create({
        id: "sess_main_new",
        conversationId: "conv_main",
        branchId: "branch_main",
        ownerAgentId: "agent_main",
        purpose: "chat",
        createdAt: new Date("2026-03-25T00:00:02.000Z"),
        updatedAt: new Date("2026-03-25T00:00:03.000Z"),
      });

      const resolved = resolveMainAgentChatSessionForAgent({
        db: handle.storage.db,
        ownerAgentId: "agent_sub",
      });

      expect(resolved).not.toBeNull();
      expect(resolved?.mainAgentId).toBe("agent_main");
      expect(resolved?.session.id).toBe("sess_main_new");
    });
  });

  test("returns null when the main agent has no active chat session", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);

      const resolved = resolveMainAgentChatSessionForAgent({
        db: handle.storage.db,
        ownerAgentId: "agent_sub",
      });

      expect(resolved).toBeNull();
    });
  });
});
