import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

export async function withHandle(fn: (handle: TestDatabaseHandle) => Promise<void>): Promise<void> {
  const handle = await createTestDatabase(import.meta.url);
  try {
    await fn(handle);
  } finally {
    await destroyTestDatabase(handle);
  }
}

export function seedFixture(handle: TestDatabaseHandle): void {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_lark_default', 'lark', 'default', '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z');

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES ('conv_main', 'ci_lark_default', 'oc_chat_1', 'dm', '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES ('branch_main', 'conv_main', 'dm_main', 'main', '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z');

    INSERT INTO agents (id, conversation_id, main_agent_id, kind, created_at)
    VALUES ('agent_main', 'conv_main', NULL, 'main', '2026-03-27T00:00:00.000Z');

    INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at)
    VALUES ('sess_chat_1', 'conv_main', 'branch_main', 'agent_main', 'chat', 'active', '2026-03-27T00:00:01.000Z', '2026-03-27T00:00:02.000Z');
  `);
}

export function makeMessageEvent(messageType: string, content: unknown) {
  return {
    sender: {
      sender_id: { open_id: "ou_sender" },
      sender_type: "user",
    },
    message: {
      message_id: "om_msg_1",
      chat_id: "oc_chat_1",
      chat_type: "p2p",
      message_type: messageType,
      create_time: "1774569600000",
      content: JSON.stringify(content),
    },
  };
}

export function makeTextEvent(text: string) {
  return makeMessageEvent("text", { text });
}

export function makeRawMessage(messageType: string, content: unknown) {
  return {
    sender: {
      id: "ou_sender_raw",
      id_type: "open_id",
      sender_type: "user",
    },
    message_id: "om_msg_raw_1",
    chat_id: "oc_chat_1",
    chat_type: "p2p",
    msg_type: messageType,
    create_time: "1774569600000",
    body: {
      content: JSON.stringify(content),
    },
  };
}
