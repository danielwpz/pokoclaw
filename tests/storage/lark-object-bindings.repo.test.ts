import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, test } from "vitest";

import { LarkObjectBindingsRepo } from "@/src/storage/repos/lark-object-bindings.repo.js";
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
    VALUES ('conv_1', 'ci_1', 'chat_1', 'group', '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES ('branch_1', 'conv_1', 'group_main', 'main', '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z');
  `);
}

describe("lark object bindings repo", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("upserts and resolves bindings by internal object and lark message id", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);

    const repo = new LarkObjectBindingsRepo(handle.storage.db);
    const binding = repo.upsert({
      id: "lark_binding_1",
      channelInstallationId: "lark_install_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      internalObjectKind: "task_run",
      internalObjectId: "run_1",
      larkMessageId: "om_message_1",
      larkOpenMessageId: "open_message_1",
      larkCardId: "card_1",
      threadRootMessageId: "om_root_1",
      cardElementId: "streaming_body",
      lastSequence: 3,
      metadataJson: '{"mode":"card_stream"}',
    });

    expect(binding).toMatchObject({
      channelInstallationId: "lark_install_1",
      internalObjectKind: "task_run",
      internalObjectId: "run_1",
      larkMessageUuid: null,
      larkMessageId: "om_message_1",
      larkCardId: "card_1",
      threadRootMessageId: "om_root_1",
      lastSequence: 3,
    });

    expect(
      repo.getByInternalObject({
        channelInstallationId: "lark_install_1",
        internalObjectKind: "task_run",
        internalObjectId: "run_1",
      }),
    ).toMatchObject({
      id: "lark_binding_1",
      larkMessageId: "om_message_1",
    });

    expect(
      repo.getByLarkMessageId({
        channelInstallationId: "lark_install_1",
        larkMessageId: "om_message_1",
      }),
    ).toMatchObject({
      id: "lark_binding_1",
      internalObjectId: "run_1",
    });

    expect(
      repo.getByThreadRootMessageId({
        channelInstallationId: "lark_install_1",
        threadRootMessageId: "om_root_1",
      }),
    ).toMatchObject({
      id: "lark_binding_1",
      internalObjectId: "run_1",
    });
  });

  test("reserves a stable message uuid and preserves anchors across partial delivery updates", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);

    const repo = new LarkObjectBindingsRepo(handle.storage.db);
    const reserved = repo.reserveBinding({
      id: "lark_binding_reserved_1",
      channelInstallationId: "lark_install_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      internalObjectKind: "run_card",
      internalObjectId: "run_retry_1",
      larkMessageUuid: randomUUID(),
      status: "active",
      metadataJson: '{"phase":"reserved"}',
    });

    expect(reserved.larkMessageUuid).toBeTruthy();
    expect(reserved.larkCardId).toBeNull();
    expect(reserved.larkMessageId).toBeNull();

    const reservedAgain = repo.reserveBinding({
      id: "lark_binding_reserved_2",
      channelInstallationId: "lark_install_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      internalObjectKind: "run_card",
      internalObjectId: "run_retry_1",
      larkMessageUuid: randomUUID(),
      status: "active",
      metadataJson: '{"phase":"reserved-again"}',
    });

    expect(reservedAgain.id).toBe(reserved.id);
    expect(reservedAgain.larkMessageUuid).toBe(reserved.larkMessageUuid);

    const withCard = repo.attachCardAnchor({
      channelInstallationId: "lark_install_1",
      internalObjectKind: "run_card",
      internalObjectId: "run_retry_1",
      larkCardId: "card_retry_1",
      status: "active",
      metadataJson: '{"phase":"card"}',
    });
    expect(withCard).toMatchObject({
      id: reserved.id,
      larkMessageUuid: reserved.larkMessageUuid,
      larkCardId: "card_retry_1",
      larkMessageId: null,
    });

    const withMessage = repo.attachMessageAnchor({
      channelInstallationId: "lark_install_1",
      internalObjectKind: "run_card",
      internalObjectId: "run_retry_1",
      larkMessageId: "om_retry_1",
      larkOpenMessageId: "open_retry_1",
      larkCardId: "card_retry_2",
      status: "finalized",
      metadataJson: '{"phase":"message"}',
    });
    expect(withMessage).toMatchObject({
      id: reserved.id,
      larkMessageUuid: reserved.larkMessageUuid,
      larkCardId: "card_retry_1",
      larkMessageId: "om_retry_1",
      larkOpenMessageId: "open_retry_1",
      status: "finalized",
    });

    const repeatedMessageAttach = repo.attachMessageAnchor({
      channelInstallationId: "lark_install_1",
      internalObjectKind: "run_card",
      internalObjectId: "run_retry_1",
      larkMessageId: "om_retry_2",
      larkOpenMessageId: "open_retry_2",
      status: "finalized",
      metadataJson: '{"phase":"message-repeat"}',
    });
    expect(repeatedMessageAttach).toMatchObject({
      id: reserved.id,
      larkMessageUuid: reserved.larkMessageUuid,
      larkCardId: "card_retry_1",
      larkMessageId: "om_retry_1",
      larkOpenMessageId: "open_retry_1",
    });
  });

  test("updates delivery state and overwrites current durable anchors in place", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);

    const repo = new LarkObjectBindingsRepo(handle.storage.db);
    repo.upsert({
      id: "lark_binding_1",
      channelInstallationId: "lark_install_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      internalObjectKind: "message",
      internalObjectId: "msg_1",
      larkMessageId: "om_message_1",
      larkCardId: "card_1",
    });

    const rebound = repo.upsert({
      id: "lark_binding_2",
      channelInstallationId: "lark_install_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      internalObjectKind: "message",
      internalObjectId: "msg_1",
      larkMessageId: "om_message_2",
      larkCardId: "card_2",
      threadRootMessageId: "om_root_2",
      status: "finalized",
      updatedAt: new Date("2026-03-27T02:00:00.000Z"),
    });

    expect(rebound.id).toBe("lark_binding_1");
    expect(rebound.larkMessageId).toBe("om_message_2");
    expect(rebound.status).toBe("finalized");

    const updated = repo.updateDeliveryState({
      channelInstallationId: "lark_install_1",
      internalObjectKind: "message",
      internalObjectId: "msg_1",
      lastSequence: 8,
      status: "stale",
      metadataJson: '{"reason":"replaced"}',
      updatedAt: new Date("2026-03-27T03:00:00.000Z"),
    });

    expect(updated).toMatchObject({
      id: "lark_binding_1",
      lastSequence: 8,
      status: "stale",
      metadataJson: '{"reason":"replaced"}',
    });

    expect(
      repo.getByLarkCardId({
        channelInstallationId: "lark_install_1",
        larkCardId: "card_2",
      }),
    ).toMatchObject({
      id: "lark_binding_1",
      threadRootMessageId: "om_root_2",
    });
  });
});
