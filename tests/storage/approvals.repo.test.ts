import { afterEach, describe, expect, test } from "vitest";

import { ApprovalsRepo } from "@/src/storage/repos/approvals.repo.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

function seedAgentFixture(handle: TestDatabaseHandle): void {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_1', 'lark', 'acct_a', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES ('conv_1', 'ci_1', 'chat_1', 'dm', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
    INSERT INTO agents (id, conversation_id, kind, created_at)
    VALUES ('agent_1', 'conv_1', 'main', '2026-03-22T00:00:00.000Z');
    INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, created_at, updated_at)
    VALUES ('sess_1', 'conv_1', 'branch_1', 'agent_1', 'chat', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
  `);
}

describe("approvals repo", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("create + getById persists approval requests", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    const repo = new ApprovalsRepo(handle.storage.db);

    const approvalId = repo.create({
      ownerAgentId: "agent_1",
      requestedBySessionId: "sess_1",
      requestedScopeJson:
        '{"scopes":[{"kind":"fs.read","path":"/Users/example/.pokoclaw/workspace/**"}]}',
      approvalTarget: "user",
      expiresAt: new Date("2026-03-22T00:03:01.000Z"),
      resumePayloadJson:
        '{"toolCallId":"tool_1","toolName":"read","toolArgs":{"path":"notes.txt"}}',
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    expect(repo.getById(approvalId)).toMatchObject({
      id: approvalId,
      ownerAgentId: "agent_1",
      requestedBySessionId: "sess_1",
      approvalTarget: "user",
      status: "pending",
      expiresAt: "2026-03-22T00:03:01.000Z",
      resumePayloadJson:
        '{"toolCallId":"tool_1","toolName":"read","toolArgs":{"path":"notes.txt"}}',
      createdAt: "2026-03-22T00:00:01.000Z",
      decidedAt: null,
    });
  });

  test("resolve updates status and decidedAt", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    const repo = new ApprovalsRepo(handle.storage.db);

    const approvalId = repo.create({
      ownerAgentId: "agent_1",
      requestedBySessionId: "sess_1",
      requestedScopeJson: '{"scopes":[{"kind":"db.read","database":"system"}]}',
      approvalTarget: "main_agent",
    });

    repo.resolve({
      id: approvalId,
      status: "approved",
      reasonText: "Allowed for diagnostics",
      decidedAt: new Date("2026-03-22T00:00:02.000Z"),
    });

    expect(repo.getById(approvalId)).toMatchObject({
      status: "approved",
      reasonText: "Allowed for diagnostics",
      decidedAt: "2026-03-22T00:00:02.000Z",
    });
  });

  test("listByOwner and listBySession return newest first and support status filters", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    const repo = new ApprovalsRepo(handle.storage.db);

    repo.create({
      ownerAgentId: "agent_1",
      requestedBySessionId: "sess_1",
      requestedScopeJson: '{"scopes":[{"kind":"db.read","database":"system"}]}',
      approvalTarget: "main_agent",
      status: "approved",
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
      decidedAt: new Date("2026-03-22T00:00:02.000Z"),
    });
    repo.create({
      ownerAgentId: "agent_1",
      requestedBySessionId: "sess_1",
      requestedScopeJson:
        '{"scopes":[{"kind":"fs.write","path":"/Users/example/.pokoclaw/workspace/**"}]}',
      approvalTarget: "user",
      createdAt: new Date("2026-03-22T00:00:03.000Z"),
    });

    expect(repo.listByOwner("agent_1").map((row) => row.status)).toEqual(["pending", "approved"]);
    expect(
      repo.listBySession("sess_1", { statuses: ["pending"] }).map((row) => row.status),
    ).toEqual(["pending"]);
  });
});
