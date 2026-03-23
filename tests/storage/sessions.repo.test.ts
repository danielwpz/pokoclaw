import { afterEach, describe, expect, test } from "vitest";

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

describe("sessions repo", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("create + getById persists session defaults and compaction state", async () => {
    handle = await createTestDatabase(import.meta.url);
    const repo = new SessionsRepo(handle.storage.db);
    seedConversationFixture(handle);

    repo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      compactCursor: 12,
      compactSummary: "summary text",
      compactSummaryTokenTotal: 321,
      compactSummaryUsageJson:
        '{"input":111,"output":321,"cacheRead":0,"cacheWrite":0,"totalTokens":432}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    const session = repo.getById("sess_1");
    expect(session).not.toBeNull();
    expect(session?.contextMode).toBe("isolated");
    expect(session?.status).toBe("active");
    expect(session?.compactCursor).toBe(12);
    expect(session?.compactSummary).toBe("summary text");
    expect(session?.compactSummaryTokenTotal).toBe(321);
    expect(session?.compactSummaryUsageJson).toBe(
      '{"input":111,"output":321,"cacheRead":0,"cacheWrite":0,"totalTokens":432}',
    );
    expect(session?.createdAt).toBe("2026-03-22T00:00:01.000Z");
    expect(session?.updatedAt).toBe("2026-03-22T00:00:01.000Z");
  });

  test("updateCompaction advances cursor and updates updatedAt", async () => {
    handle = await createTestDatabase(import.meta.url);
    const repo = new SessionsRepo(handle.storage.db);
    seedConversationFixture(handle);

    repo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    repo.updateCompaction({
      id: "sess_1",
      compactCursor: 20,
      compactSummary: "new summary",
      compactSummaryTokenTotal: 456,
      compactSummaryUsageJson:
        '{"input":222,"output":456,"cacheRead":0,"cacheWrite":0,"totalTokens":678}',
      updatedAt: new Date("2026-03-22T00:00:05.000Z"),
    });

    const session = repo.getById("sess_1");
    expect(session?.compactCursor).toBe(20);
    expect(session?.compactSummary).toBe("new summary");
    expect(session?.compactSummaryTokenTotal).toBe(456);
    expect(session?.compactSummaryUsageJson).toBe(
      '{"input":222,"output":456,"cacheRead":0,"cacheWrite":0,"totalTokens":678}',
    );
    expect(session?.updatedAt).toBe("2026-03-22T00:00:05.000Z");
  });

  test("listByConversation filters by status and orders by createdAt", async () => {
    handle = await createTestDatabase(import.meta.url);
    const repo = new SessionsRepo(handle.storage.db);
    seedConversationFixture(handle);

    repo.create({
      id: "sess_2",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "task",
      status: "completed",
      createdAt: new Date("2026-03-22T00:00:02.000Z"),
    });
    repo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    const rows = repo.listByConversation("conv_1", { statuses: ["active"] });
    expect(rows.map((row) => row.id)).toEqual(["sess_1"]);
  });

  test("rejects invalid compaction cursor values", async () => {
    handle = await createTestDatabase(import.meta.url);
    const repo = new SessionsRepo(handle.storage.db);
    seedConversationFixture(handle);

    expect(() =>
      repo.create({
        id: "sess_bad",
        conversationId: "conv_1",
        branchId: "branch_1",
        purpose: "chat",
        compactCursor: -1,
      }),
    ).toThrow("compactCursor must be a non-negative integer");

    expect(() =>
      repo.create({
        id: "sess_bad_2",
        conversationId: "conv_1",
        branchId: "branch_1",
        purpose: "chat",
        compactSummaryTokenTotal: -1,
      }),
    ).toThrow("compactSummaryTokenTotal must be a non-negative integer");
  });
});
