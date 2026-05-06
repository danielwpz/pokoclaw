import { afterEach, describe, expect, test } from "vitest";

import { A2uiSurfacePublicationsRepo } from "@/src/storage/repos/a2ui-surface-publications.repo.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

function seedFixture(handle: TestDatabaseHandle): void {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_1', 'lark', 'acct_a', '2026-05-06T00:00:00.000Z', '2026-05-06T00:00:00.000Z');

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES ('conv_1', 'ci_1', 'chat_1', 'dm', '2026-05-06T00:00:00.000Z', '2026-05-06T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-05-06T00:00:00.000Z', '2026-05-06T00:00:00.000Z');

    INSERT INTO agents (id, conversation_id, kind, created_at)
    VALUES ('agent_1', 'conv_1', 'main', '2026-05-06T00:00:00.000Z');

    INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, created_at, updated_at)
    VALUES ('sess_1', 'conv_1', 'branch_1', 'agent_1', 'chat', '2026-05-06T00:00:00.000Z', '2026-05-06T00:00:00.000Z');
  `);
}

describe("a2ui surface publications repo", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("upserts, patches, and resolves active publication state", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    const repo = new A2uiSurfacePublicationsRepo(handle.storage.db);

    const created = repo.upsert({
      id: "a2ui_pub_1",
      surfaceId: "quiz",
      sessionId: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      channelType: "lark",
      channelInstallationId: "default",
      channelArtifactId: "card_1",
      channelMessageId: "msg_1",
      surfaceStateJson: '{"surfaceId":"quiz","components":[]}',
      consumedActionKeysJson: "[]",
      createdAt: new Date("2026-05-06T00:00:00.000Z"),
      updatedAt: new Date("2026-05-06T00:00:00.000Z"),
    });

    expect(created).toMatchObject({
      id: "a2ui_pub_1",
      surfaceId: "quiz",
      sessionId: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      channelType: "lark",
      channelInstallationId: "default",
      channelArtifactId: "card_1",
      channelMessageId: "msg_1",
      channelSequence: 1,
      status: "active",
      consumedActionKeysJson: "[]",
    });

    expect(repo.getById("a2ui_pub_1")).toMatchObject({
      surfaceId: "quiz",
      channelArtifactId: "card_1",
    });

    const sameSurface = repo.upsert({
      id: "a2ui_pub_2",
      surfaceId: "quiz",
      sessionId: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      channelType: "lark",
      channelInstallationId: "default",
      channelArtifactId: "card_2",
      channelMessageId: "msg_2",
      surfaceStateJson: '{"surfaceId":"quiz","components":[]}',
      consumedActionKeysJson: "[]",
      createdAt: new Date("2026-05-06T00:00:30.000Z"),
      updatedAt: new Date("2026-05-06T00:00:30.000Z"),
    });

    expect(sameSurface).toMatchObject({
      id: "a2ui_pub_2",
      surfaceId: "quiz",
      channelArtifactId: "card_2",
    });
    expect(repo.getById("a2ui_pub_1")).toMatchObject({
      surfaceId: "quiz",
      channelArtifactId: "card_1",
    });

    const patched = repo.patch({
      id: "a2ui_pub_1",
      channelSequence: 2,
      surfaceStateJson: '{"surfaceId":"quiz","components":["submit"]}',
      consumedActionKeysJson: '["submit\\u0000submit_answer"]',
      updatedAt: new Date("2026-05-06T00:01:00.000Z"),
    });

    expect(patched).toMatchObject({
      surfaceId: "quiz",
      channelSequence: 2,
      surfaceStateJson: '{"surfaceId":"quiz","components":["submit"]}',
      consumedActionKeysJson: '["submit\\u0000submit_answer"]',
      updatedAt: "2026-05-06T00:01:00.000Z",
    });

    repo.markStale("a2ui_pub_1", new Date("2026-05-06T00:02:00.000Z"));
    expect(repo.getById("a2ui_pub_1")).toMatchObject({
      surfaceId: "quiz",
      status: "stale",
      updatedAt: "2026-05-06T00:02:00.000Z",
    });
  });
});
