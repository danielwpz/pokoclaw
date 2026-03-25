import { describe, expect, test } from "vitest";

import {
  createMainAgentApprovalSessionId,
  MAIN_AGENT_APPROVAL_SESSION_MAX_AGE_MS,
  MAIN_AGENT_APPROVAL_SESSION_TOOL_ALLOWLIST,
  resolveOrCreateMainAgentApprovalSession,
} from "@/src/orchestration/approval-session.js";
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

    INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, context_mode, status, compact_cursor, created_at, updated_at)
    VALUES
      ('sess_task', 'conv_sub', 'branch_sub', 'agent_sub', 'task', 'isolated', 'active', 0, '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:00.000Z');
  `);
}

describe("approval session orchestration", () => {
  test("defines a fixed minimal tool allowlist for approval sessions", () => {
    expect(MAIN_AGENT_APPROVAL_SESSION_TOOL_ALLOWLIST).toEqual([
      "read",
      "ls",
      "find",
      "grep",
      "review_permission_request",
    ]);
  });

  test("creates a dedicated approval session from the latest main chat session", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      const sessionsRepo = new SessionsRepo(handle.storage.db);
      sessionsRepo.create({
        id: "sess_main",
        conversationId: "conv_main",
        branchId: "branch_main",
        ownerAgentId: "agent_main",
        purpose: "chat",
        createdAt: new Date("2026-03-25T00:00:01.000Z"),
        updatedAt: new Date("2026-03-25T00:00:02.000Z"),
      });

      const created = resolveOrCreateMainAgentApprovalSession({
        db: handle.storage.db,
        ownerAgentId: "agent_sub",
        sourceSessionId: "sess_task",
        approvalId: 12,
        createdAt: new Date("2026-03-25T00:00:03.000Z"),
      });

      expect(created).not.toBeNull();
      expect(created?.created).toBe(true);
      expect(created?.mainAgentId).toBe("agent_main");
      expect(created?.forkSourceSessionId).toBe("sess_main");
      expect(created?.session.id).toBe(
        createMainAgentApprovalSessionId({
          sourceSessionId: "sess_task",
          approvalId: 12,
        }),
      );
      expect(created?.session.purpose).toBe("approval");
      expect(created?.session.approvalForSessionId).toBe("sess_task");
      expect(created?.session.forkedFromSessionId).toBe("sess_main");
    });
  });

  test("reuses the same approval session within one source run", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      const sessionsRepo = new SessionsRepo(handle.storage.db);
      sessionsRepo.create({
        id: "sess_main",
        conversationId: "conv_main",
        branchId: "branch_main",
        ownerAgentId: "agent_main",
        purpose: "chat",
        createdAt: new Date("2026-03-25T00:00:01.000Z"),
        updatedAt: new Date("2026-03-25T00:00:02.000Z"),
      });

      const first = resolveOrCreateMainAgentApprovalSession({
        db: handle.storage.db,
        ownerAgentId: "agent_sub",
        sourceSessionId: "sess_task",
        approvalId: 12,
        createdAt: new Date("2026-03-25T00:00:03.000Z"),
      });
      const second = resolveOrCreateMainAgentApprovalSession({
        db: handle.storage.db,
        ownerAgentId: "agent_sub",
        sourceSessionId: "sess_task",
        approvalId: 13,
        createdAt: new Date("2026-03-25T00:10:00.000Z"),
      });

      expect(first?.created).toBe(true);
      expect(second?.created).toBe(false);
      expect(second?.session.id).toBe(first?.session.id);
    });
  });

  test("forces a new approval session after the max session age", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      const sessionsRepo = new SessionsRepo(handle.storage.db);
      sessionsRepo.create({
        id: "sess_main",
        conversationId: "conv_main",
        branchId: "branch_main",
        ownerAgentId: "agent_main",
        purpose: "chat",
        createdAt: new Date("2026-03-25T00:00:01.000Z"),
        updatedAt: new Date("2026-03-25T00:00:02.000Z"),
      });

      const first = resolveOrCreateMainAgentApprovalSession({
        db: handle.storage.db,
        ownerAgentId: "agent_sub",
        sourceSessionId: "sess_task",
        approvalId: 12,
        createdAt: new Date("2026-03-25T00:00:03.000Z"),
      });
      const second = resolveOrCreateMainAgentApprovalSession({
        db: handle.storage.db,
        ownerAgentId: "agent_sub",
        sourceSessionId: "sess_task",
        approvalId: 13,
        createdAt: new Date(
          new Date("2026-03-25T00:00:03.000Z").getTime() +
            MAIN_AGENT_APPROVAL_SESSION_MAX_AGE_MS +
            1,
        ),
      });

      expect(first?.created).toBe(true);
      expect(second?.created).toBe(true);
      expect(second?.session.id).not.toBe(first?.session.id);
    });
  });
});
