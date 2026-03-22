import { afterEach, describe, expect, test } from "vitest";

import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

describe("messages repo", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("append + listBySession returns seq-ordered messages in same session", async () => {
    handle = await createTestDatabase(import.meta.url);
    const repo = new MessagesRepo(handle.storage.db);

    handle.storage.sqlite
      .prepare(
        "INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("ci_1", "lark", "acct_a", "2026-03-22T00:00:00.000Z", "2026-03-22T00:00:00.000Z");
    handle.storage.sqlite
      .prepare(
        "INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "conv_1",
        "ci_1",
        "chat_1",
        "dm",
        "2026-03-22T00:00:00.000Z",
        "2026-03-22T00:00:00.000Z",
      );
    handle.storage.sqlite
      .prepare(
        "INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "branch_1",
        "conv_1",
        "dm_main",
        "main",
        "2026-03-22T00:00:00.000Z",
        "2026-03-22T00:00:00.000Z",
      );
    handle.storage.sqlite
      .prepare(
        "INSERT INTO sessions (id, conversation_id, branch_id, purpose, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "sess_1",
        "conv_1",
        "branch_1",
        "chat",
        "2026-03-22T00:00:00.000Z",
        "2026-03-22T00:00:00.000Z",
      );

    repo.append({
      id: "msg_2",
      sessionId: "sess_1",
      seq: 2,
      role: "assistant",
      contentJson: '{"text":"world"}',
      createdAt: new Date("2026-03-22T00:00:02.000Z"),
    });
    repo.append({
      id: "msg_1",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      contentJson: '{"text":"hello"}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    const rows = repo.listBySession("sess_1");
    expect(rows.map((row) => row.id)).toEqual(["msg_1", "msg_2"]);
  });

  test("listBySession supports afterSeq + limit and isolates other sessions", async () => {
    handle = await createTestDatabase(import.meta.url);
    const repo = new MessagesRepo(handle.storage.db);

    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_1', 'lark', 'acct_a', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES ('conv_1', 'ci_1', 'chat_1', 'dm', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
      INSERT INTO sessions (id, conversation_id, branch_id, purpose, created_at, updated_at)
      VALUES ('sess_1', 'conv_1', 'branch_1', 'chat', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
      INSERT INTO sessions (id, conversation_id, branch_id, purpose, created_at, updated_at)
      VALUES ('sess_2', 'conv_1', 'branch_1', 'chat', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
    `);

    repo.append({
      id: "msg_1",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      contentJson: "{}",
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });
    repo.append({
      id: "msg_2",
      sessionId: "sess_1",
      seq: 2,
      role: "assistant",
      contentJson: "{}",
      createdAt: new Date("2026-03-22T00:00:02.000Z"),
    });
    repo.append({
      id: "msg_3",
      sessionId: "sess_1",
      seq: 3,
      role: "assistant",
      contentJson: "{}",
      createdAt: new Date("2026-03-22T00:00:03.000Z"),
    });
    repo.append({
      id: "msg_x",
      sessionId: "sess_2",
      seq: 1,
      role: "user",
      contentJson: "{}",
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    const rows = repo.listBySession("sess_1", { afterSeq: 1, limit: 1 });
    expect(rows.map((row) => row.id)).toEqual(["msg_2"]);
  });

  test("append persists structured usage and denormalized token columns", async () => {
    handle = await createTestDatabase(import.meta.url);
    const repo = new MessagesRepo(handle.storage.db);

    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_1', 'lark', 'acct_a', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES ('conv_1', 'ci_1', 'chat_1', 'dm', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
      INSERT INTO sessions (id, conversation_id, branch_id, purpose, created_at, updated_at)
      VALUES ('sess_1', 'conv_1', 'branch_1', 'chat', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
    `);

    repo.append({
      id: "msg_usage",
      sessionId: "sess_1",
      seq: 1,
      role: "assistant",
      contentJson: '{"text":"done"}',
      usage: {
        input: 120,
        output: 30,
        cacheRead: 10,
        cacheWrite: 5,
        totalTokens: 165,
        cost: {
          input: 1.2,
          output: 0.8,
          cacheRead: 0.1,
          cacheWrite: 0.2,
          total: 2.3,
        },
      },
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    const rows = repo.listBySession("sess_1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenInput).toBe(120);
    expect(rows[0]?.tokenOutput).toBe(30);
    expect(rows[0]?.tokenCacheRead).toBe(10);
    expect(rows[0]?.tokenCacheWrite).toBe(5);
    expect(rows[0]?.tokenTotal).toBe(165);
    expect(rows[0]?.usageJson).toBe(
      JSON.stringify({
        input: 120,
        output: 30,
        cacheRead: 10,
        cacheWrite: 5,
        totalTokens: 165,
        cost: {
          input: 1.2,
          output: 0.8,
          cacheRead: 0.1,
          cacheWrite: 0.2,
          total: 2.3,
        },
      }),
    );
  });

  test("rejects invalid structured usage at runtime", async () => {
    handle = await createTestDatabase(import.meta.url);
    const repo = new MessagesRepo(handle.storage.db);

    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_1', 'lark', 'acct_a', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES ('conv_1', 'ci_1', 'chat_1', 'dm', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
      INSERT INTO sessions (id, conversation_id, branch_id, purpose, created_at, updated_at)
      VALUES ('sess_1', 'conv_1', 'branch_1', 'chat', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
    `);

    expect(() =>
      repo.append({
        id: "msg_bad_usage",
        sessionId: "sess_1",
        seq: 1,
        role: "assistant",
        contentJson: "{}",
        usage: {
          input: 100,
          output: 20,
          cacheRead: -1,
          cacheWrite: 0,
          totalTokens: 119,
        },
      }),
    ).toThrow("usage.cacheRead must be a non-negative integer");
  });

  test("rejects non-Date createdAt value at runtime", async () => {
    handle = await createTestDatabase(import.meta.url);
    const repo = new MessagesRepo(handle.storage.db);

    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_1', 'lark', 'acct_a', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES ('conv_1', 'ci_1', 'chat_1', 'dm', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
      INSERT INTO sessions (id, conversation_id, branch_id, purpose, created_at, updated_at)
      VALUES ('sess_1', 'conv_1', 'branch_1', 'chat', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
    `);

    expect(() =>
      repo.append({
        id: "msg_1",
        sessionId: "sess_1",
        seq: 1,
        role: "user",
        contentJson: "{}",
        createdAt: "2026-03-22T00:00:01.000Z" as unknown as Date,
      }),
    ).toThrow("Timestamp must be a Date object");
  });

  test("rejects invalid Date object", async () => {
    handle = await createTestDatabase(import.meta.url);
    const repo = new MessagesRepo(handle.storage.db);

    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_1', 'lark', 'acct_a', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES ('conv_1', 'ci_1', 'chat_1', 'dm', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
      INSERT INTO sessions (id, conversation_id, branch_id, purpose, created_at, updated_at)
      VALUES ('sess_1', 'conv_1', 'branch_1', 'chat', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
    `);

    expect(() =>
      repo.append({
        id: "msg_1",
        sessionId: "sess_1",
        seq: 1,
        role: "user",
        contentJson: "{}",
        createdAt: new Date("invalid"),
      }),
    ).toThrow("Timestamp Date is invalid");
  });
});
