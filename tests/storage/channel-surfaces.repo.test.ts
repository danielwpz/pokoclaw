import { afterEach, describe, expect, test } from "vitest";

import { ChannelSurfacesRepo } from "@/src/storage/repos/channel-surfaces.repo.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

function seedFixture(handle: TestDatabaseHandle): void {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_1', 'lark', 'acct_a', '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z');

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES ('conv_1', 'ci_1', 'chat_1', 'dm', '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z');
  `);
}

describe("channel surfaces repo", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("upserts and resolves a surface by conversation branch", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);

    const repo = new ChannelSurfacesRepo(handle.storage.db);
    const binding = repo.upsert({
      id: "surface_1",
      channelType: "lark",
      channelInstallationId: "lark_install_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      surfaceKey: "chat:oc_123",
      surfaceObjectJson: '{"chat_id":"oc_123"}',
      createdAt: new Date("2026-03-27T00:00:00.000Z"),
      updatedAt: new Date("2026-03-27T00:00:00.000Z"),
    });

    expect(binding).toMatchObject({
      id: "surface_1",
      channelType: "lark",
      channelInstallationId: "lark_install_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      surfaceKey: "chat:oc_123",
      surfaceObjectJson: '{"chat_id":"oc_123"}',
    });

    expect(
      repo.getByConversationBranch({
        channelType: "lark",
        channelInstallationId: "lark_install_1",
        conversationId: "conv_1",
        branchId: "branch_1",
      }),
    ).toMatchObject({
      id: "surface_1",
      surfaceKey: "chat:oc_123",
    });
  });

  test("resolves a surface by channel-defined surface key and updates in place", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);

    const repo = new ChannelSurfacesRepo(handle.storage.db);
    repo.upsert({
      id: "surface_1",
      channelType: "lark",
      channelInstallationId: "lark_install_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      surfaceKey: "chat:oc_123",
      surfaceObjectJson: '{"chat_id":"oc_123"}',
    });

    const updated = repo.upsert({
      id: "surface_2",
      channelType: "lark",
      channelInstallationId: "lark_install_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      surfaceKey: "chat:oc_456",
      surfaceObjectJson: '{"chat_id":"oc_456","root_message_id":"om_root"}',
      updatedAt: new Date("2026-03-27T01:00:00.000Z"),
    });

    expect(updated.id).toBe("surface_1");
    expect(
      repo.getBySurfaceKey({
        channelType: "lark",
        channelInstallationId: "lark_install_1",
        surfaceKey: "chat:oc_456",
      }),
    ).toMatchObject({
      id: "surface_1",
      surfaceObjectJson: '{"chat_id":"oc_456","root_message_id":"om_root"}',
    });
  });
});
