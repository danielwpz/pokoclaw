import { afterEach, describe, expect, test, vi } from "vitest";

import {
  type BackOnlineRuntimeClients,
  performBackOnlineRecovery,
} from "@/src/runtime/back-online.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

describe("back-online recovery", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("skips recovery when there is no previous runtime log timestamp", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedMainChatFixture(handle);

    const messageCreate = vi.fn(async () => ({}));
    const result = await performBackOnlineRecovery({
      storage: handle.storage.db,
      clients: createFakeClients(messageCreate),
      previousLastSeenAt: null,
      now: () => new Date("2026-04-04T00:40:00.000Z"),
    });

    expect(result).toMatchObject({
      status: "skipped",
      reason: "missing_previous_last_seen",
    });
    expect(messageCreate).not.toHaveBeenCalled();
    expect(new MessagesRepo(handle.storage.db).listBySession("sess_main")).toHaveLength(0);
  });

  test("sends a concise back-online card and stores a hidden system message", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedMainChatFixture(handle);
    handle.storage.sqlite.exec(`
      INSERT INTO cron_jobs (
        id, owner_agent_id, target_conversation_id, target_branch_id,
        name, schedule_kind, schedule_value, payload_json, next_run_at, created_at, updated_at
      ) VALUES (
        'cron_1', 'agent_main', 'conv_main', 'branch_main',
        'Daily Brief', 'at', '2026-04-04T00:10:00.000Z', '{}', '2026-04-04T00:10:00.000Z',
        '2026-04-03T00:00:00.000Z', '2026-04-03T00:00:00.000Z'
      );
    `);

    const messageCreate = vi.fn(async () => ({
      data: {
        message_id: "om_back_online_1",
      },
    }));
    const result = await performBackOnlineRecovery({
      storage: handle.storage.db,
      clients: createFakeClients(messageCreate),
      previousLastSeenAt: new Date("2026-04-04T00:00:00.000Z"),
      now: () => new Date("2026-04-04T00:40:00.000Z"),
    });

    expect(result).toMatchObject({
      status: "completed",
      notifiedInstallations: 1,
    });
    expect(messageCreate).toHaveBeenCalledOnce();
    const firstCall = (
      messageCreate.mock.calls as unknown as Array<
        [
          {
            data?: {
              content?: string;
            };
          },
        ]
      >
    )[0]?.[0];
    const sentCard = JSON.parse(firstCall?.data?.content ?? "{}");
    expect(sentCard.header?.title?.content).toBe("🟢 Back online");
    expect(sentCard.body?.elements?.[0]?.content).toContain("Offline for");
    expect(sentCard.body?.elements?.[2]?.content ?? "").toContain("Daily Brief");

    const rows = new MessagesRepo(handle.storage.db).listBySession("sess_main");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: "user",
      messageType: "back_online",
      visibility: "hidden_system",
    });
    expect(JSON.parse(rows[0]?.payloadJson ?? "{}")).toEqual({
      content: expect.stringContaining('<system_event type="back_online">'),
    });
    expect(JSON.parse(rows[0]?.payloadJson ?? "{}").content).toContain("Daily Brief");
    expect(JSON.parse(rows[0]?.payloadJson ?? "{}").content).toContain(
      "Do not assume any missed task was rerun automatically.",
    );
  });
});

function seedMainChatFixture(handle: TestDatabaseHandle) {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_lark', 'lark', 'install_1', '2026-04-03T00:00:00.000Z', '2026-04-03T00:00:00.000Z');

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, title, created_at, updated_at)
    VALUES ('conv_main', 'ci_lark', 'chat_main', 'group', 'Main Chat', '2026-04-03T00:00:00.000Z', '2026-04-03T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES ('branch_main', 'conv_main', 'group_main', 'main', '2026-04-03T00:00:00.000Z', '2026-04-03T00:00:00.000Z');

    INSERT INTO agents (id, conversation_id, main_agent_id, kind, display_name, created_at)
    VALUES ('agent_main', 'conv_main', NULL, 'main', 'Main', '2026-04-03T00:00:00.000Z');

    INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at)
    VALUES ('sess_main', 'conv_main', 'branch_main', 'agent_main', 'chat', 'active', '2026-04-03T00:00:00.000Z', '2026-04-03T00:00:00.000Z');

    INSERT INTO channel_surfaces (
      id, channel_type, channel_installation_id, conversation_id, branch_id,
      surface_key, surface_object_json, created_at, updated_at
    ) VALUES (
      'surface_main', 'lark', 'install_1', 'conv_main', 'branch_main',
      'chat:chat_main', '{"chat_id":"chat_main"}', '2026-04-03T00:00:00.000Z', '2026-04-03T00:00:00.000Z'
    );
  `);
}

function createFakeClients(messageCreate: ReturnType<typeof vi.fn>): BackOnlineRuntimeClients {
  return {
    listInstallations() {
      return [{ installationId: "install_1" }];
    },
    getOrCreate() {
      return {
        sdk: {
          im: {
            message: {
              create: messageCreate as (input: unknown) => Promise<unknown>,
              reply: vi.fn(async () => ({})) as (input: unknown) => Promise<unknown>,
            },
          },
        },
      };
    },
  };
}
