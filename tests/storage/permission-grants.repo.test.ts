import { afterEach, describe, expect, test } from "vitest";

import { PermissionGrantsRepo } from "@/src/storage/repos/permission-grants.repo.js";
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
    INSERT INTO agents (id, conversation_id, kind, created_at)
    VALUES ('agent_1', 'conv_1', 'main', '2026-03-22T00:00:00.000Z');
  `);
}

describe("permission grants repo", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("create + getById persists grants", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    const repo = new PermissionGrantsRepo(handle.storage.db);

    repo.create({
      id: "grant_1",
      ownerAgentId: "agent_1",
      scopeJson: '{"kind":"fs.read","path":"/Users/daniel/.pokeclaw/workspace/**"}',
      grantedBy: "main_agent",
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    expect(repo.getById("grant_1")).toMatchObject({
      id: "grant_1",
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      createdAt: "2026-03-22T00:00:01.000Z",
      expiresAt: null,
    });
  });

  test("listActiveByOwner excludes expired grants", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    const repo = new PermissionGrantsRepo(handle.storage.db);

    repo.create({
      id: "grant_expired",
      ownerAgentId: "agent_1",
      scopeJson: '{"kind":"fs.read","path":"/Users/daniel/project-a/**"}',
      grantedBy: "user",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
      expiresAt: new Date("2026-03-22T00:10:00.000Z"),
    });
    repo.create({
      id: "grant_active",
      ownerAgentId: "agent_1",
      scopeJson: '{"kind":"db.read","database":"system"}',
      grantedBy: "user",
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
      expiresAt: new Date("2026-03-23T00:00:00.000Z"),
    });

    expect(
      repo.listActiveByOwner("agent_1", new Date("2026-03-22T12:00:00.000Z")).map((row) => row.id),
    ).toEqual(["grant_active"]);
  });

  test("listByOwner returns newest grants first", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    const repo = new PermissionGrantsRepo(handle.storage.db);

    repo.create({
      id: "grant_1",
      ownerAgentId: "agent_1",
      scopeJson: '{"kind":"fs.read","path":"/Users/daniel/project-a/**"}',
      grantedBy: "user",
      createdAt: new Date("2026-03-22T00:00:00.000Z"),
    });
    repo.create({
      id: "grant_2",
      ownerAgentId: "agent_1",
      scopeJson: '{"kind":"db.read","database":"system"}',
      grantedBy: "main_agent",
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

    expect(repo.listByOwner("agent_1").map((row) => row.id)).toEqual(["grant_2", "grant_1"]);
  });
});
