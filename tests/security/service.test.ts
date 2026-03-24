import { afterEach, describe, expect, test } from "vitest";

import { SecurityService } from "@/src/security/service.js";
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
    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES ('conv_2', 'ci_1', 'chat_2', 'group', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES ('branch_2', 'conv_2', 'group_main', 'main', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
    INSERT INTO agents (id, conversation_id, kind, created_at)
    VALUES ('agent_2', 'conv_2', 'sub', '2026-03-22T00:00:00.000Z');
    INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, created_at, updated_at)
    VALUES ('sess_1', 'conv_1', 'branch_1', 'agent_1', 'chat', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
  `);
}

describe("security service", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("creates approval requests and lists them by session", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    const service = new SecurityService(handle.storage.db);

    const approvalId = service.createApprovalRequest({
      ownerAgentId: "agent_1",
      requestedBySessionId: "sess_1",
      request: {
        scopes: [{ kind: "db.read", database: "system" }],
      },
      approvalTarget: "main_agent",
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    expect(service.getApprovalById(approvalId)).toMatchObject({
      id: approvalId,
      status: "pending",
      approvalTarget: "main_agent",
    });
    expect(service.listApprovalsBySession("sess_1").map((row) => row.id)).toEqual([approvalId]);
  });

  test("approveRequestAndGrantScopes writes approval decision and grants", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    const service = new SecurityService(handle.storage.db);

    const approvalId = service.createApprovalRequest({
      ownerAgentId: "agent_1",
      requestedBySessionId: "sess_1",
      request: {
        scopes: [
          { kind: "fs.read", path: "/Users/daniel/project/**" },
          { kind: "db.read", database: "system" },
        ],
      },
      approvalTarget: "user",
    });

    const grantIds = service.approveRequestAndGrantScopes({
      approvalId,
      grantedBy: "user",
      decidedAt: new Date("2026-03-22T00:00:02.000Z"),
      expiresAt: new Date("2026-03-29T00:00:02.000Z"),
    });

    expect(grantIds).toHaveLength(3);
    expect(service.getApprovalById(approvalId)).toMatchObject({
      status: "approved",
      decidedAt: "2026-03-22T00:00:02.000Z",
    });
    expect(service.listActiveGrants("agent_1", new Date("2026-03-22T12:00:00.000Z"))).toHaveLength(
      3,
    );
  });

  test("main agent gets home read access from its baseline role", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    const service = new SecurityService(handle.storage.db);

    expect(
      service.checkFilesystemAccess({
        ownerAgentId: "agent_1",
        kind: "fs.read",
        targetPath: `${process.env.HOME ?? "/Users/daniel"}/Documents/summary.md`,
      }),
    ).toMatchObject({ result: "allow" });
  });

  test("subagent only gets workspace access from its baseline role", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    const service = new SecurityService(handle.storage.db);

    expect(
      service.checkFilesystemAccess({
        ownerAgentId: "agent_2",
        kind: "fs.read",
        targetPath: `${process.env.HOME ?? "/Users/daniel"}/Documents/summary.md`,
      }),
    ).toMatchObject({ result: "deny", reason: "not_granted" });
  });

  test("expired grants do not contribute to effective permissions", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    const service = new SecurityService(handle.storage.db);

    service.grantScopes({
      ownerAgentId: "agent_1",
      scopes: [{ kind: "db.read", database: "system" }],
      grantedBy: "user",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
      expiresAt: new Date("2026-03-22T00:10:00.000Z"),
    });

    expect(
      service.checkDatabaseAccess({
        ownerAgentId: "agent_1",
        kind: "db.read",
        activeAt: new Date("2026-03-22T12:00:00.000Z"),
      }),
    ).toEqual({
      result: "deny",
      reason: "not_granted",
      summary: "db.read requires approval for the system database",
    });
  });

  test("getAgentRole normalizes persisted agent kinds", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    const service = new SecurityService(handle.storage.db);

    expect(service.getAgentRole("agent_1")).toBe("main");
    expect(service.getAgentRole("agent_2")).toBe("subagent");
  });
});
