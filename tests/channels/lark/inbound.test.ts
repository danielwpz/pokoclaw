import { describe, expect, test, vi } from "vitest";

import {
  buildLarkChatSurfaceKey,
  createLarkCardActionHandler,
  createLarkMessageReceiveHandler,
  normalizeLarkTextMessage,
} from "@/src/channels/lark/inbound.js";
import { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";
import { RuntimeControlService } from "@/src/runtime/control.js";
import { ChannelSurfacesRepo } from "@/src/storage/repos/channel-surfaces.repo.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

async function withHandle(fn: (handle: TestDatabaseHandle) => Promise<void>): Promise<void> {
  const handle = await createTestDatabase(import.meta.url);
  try {
    await fn(handle);
  } finally {
    await destroyTestDatabase(handle);
  }
}

function seedFixture(handle: TestDatabaseHandle): void {
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

function makeTextEvent(text: string) {
  return {
    sender: {
      sender_id: { open_id: "ou_sender" },
      sender_type: "user",
    },
    message: {
      message_id: "om_msg_1",
      chat_id: "oc_chat_1",
      chat_type: "p2p",
      message_type: "text",
      create_time: "1774569600000",
      content: JSON.stringify({ text }),
    },
  };
}

describe("lark inbound message handling", () => {
  test("normalizes a text event into plain text facts", () => {
    expect(normalizeLarkTextMessage(makeTextEvent(" hello "))).toMatchObject({
      chatId: "oc_chat_1",
      messageId: "om_msg_1",
      senderOpenId: "ou_sender",
      senderType: "user",
      text: "hello",
    });
  });

  test("routes a text message through surface binding into runtime ingress", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      const surfacesRepo = new ChannelSurfacesRepo(handle.storage.db);
      surfacesRepo.upsert({
        id: "surface_1",
        channelType: "lark",
        channelInstallationId: "default",
        conversationId: "conv_main",
        branchId: "branch_main",
        surfaceKey: buildLarkChatSurfaceKey("oc_chat_1"),
        surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
      });

      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
      });

      await handler(makeTextEvent("hello from lark"));

      expect(submitMessage).toHaveBeenCalledExactlyOnceWith({
        sessionId: "sess_chat_1",
        scenario: "chat",
        content: "hello from lark",
        createdAt: new Date("2026-03-27T00:00:00.000Z"),
      });
    });
  });

  test("backfills a surface from legacy conversation mapping before routing", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);

      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
      });

      await handler(makeTextEvent("hello again"));

      expect(submitMessage).toHaveBeenCalledExactlyOnceWith({
        sessionId: "sess_chat_1",
        scenario: "chat",
        content: "hello again",
        createdAt: new Date("2026-03-27T00:00:00.000Z"),
      });

      const surfacesRepo = new ChannelSurfacesRepo(handle.storage.db);
      expect(
        surfacesRepo.getBySurfaceKey({
          channelType: "lark",
          channelInstallationId: "default",
          surfaceKey: buildLarkChatSurfaceKey("oc_chat_1"),
        }),
      ).not.toBeNull();
    });
  });

  test("pairs an installation on the first inbound message when nothing exists yet", async () => {
    await withHandle(async (handle) => {
      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
      });

      await handler(makeTextEvent("hello first pair"));

      expect(submitMessage).toHaveBeenCalledOnce();
      const firstCall = (submitMessage.mock.calls as unknown[][]).at(0);
      expect(firstCall).toBeDefined();
      expect(firstCall?.[0]).toMatchObject({
        scenario: "chat",
        content: "hello first pair",
      });

      const surfacesRepo = new ChannelSurfacesRepo(handle.storage.db);
      const surface = surfacesRepo.getBySurfaceKey({
        channelType: "lark",
        channelInstallationId: "default",
        surfaceKey: buildLarkChatSurfaceKey("oc_chat_1"),
      });
      expect(surface).not.toBeNull();

      const rows = handle.storage.sqlite
        .prepare("SELECT provider, account_key FROM channel_instances")
        .all() as Array<{ provider: string; account_key: string }>;
      expect(rows).toEqual([{ provider: "lark", account_key: "default" }]);
    });
  });

  test("ignores a new chat when the installation is already paired elsewhere", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);

      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
      });

      await handler({
        sender: {
          sender_id: { open_id: "ou_sender" },
          sender_type: "user",
        },
        message: {
          message_id: "om_msg_unknown",
          chat_id: "oc_chat_2",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "hello unknown chat" }),
        },
      });

      expect(submitMessage).not.toHaveBeenCalled();

      const surfacesRepo = new ChannelSurfacesRepo(handle.storage.db);
      expect(
        surfacesRepo.getBySurfaceKey({
          channelType: "lark",
          channelInstallationId: "default",
          surfaceKey: buildLarkChatSurfaceKey("oc_chat_2"),
        }),
      ).toBeNull();
    });
  });

  test("ignores non-text events without calling runtime ingress", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);

      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
      });

      await handler({
        sender: {
          sender_id: { open_id: "ou_sender" },
          sender_type: "user",
        },
        message: {
          message_id: "om_msg_2",
          chat_id: "oc_chat_1",
          message_type: "image",
          content: JSON.stringify({ image_key: "img_1" }),
        },
      });

      expect(submitMessage).not.toHaveBeenCalled();
    });
  });

  test("routes /stop to control service instead of runtime ingress", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      const surfacesRepo = new ChannelSurfacesRepo(handle.storage.db);
      surfacesRepo.upsert({
        id: "surface_1",
        channelType: "lark",
        channelInstallationId: "default",
        conversationId: "conv_main",
        branchId: "branch_main",
        surfaceKey: buildLarkChatSurfaceKey("oc_chat_1"),
        surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
      });

      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const control = {
        stopConversation: vi.fn(() => ({
          acceptedCount: 1,
          conversationId: "conv_main",
          runIds: ["run_1"],
          sessionIds: ["sess_chat_1"],
        })),
      } as unknown as RuntimeControlService;
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage },
        control,
      });

      await handler(makeTextEvent("/stop"));

      expect(submitMessage).not.toHaveBeenCalled();
      expect(control.stopConversation).toHaveBeenCalledExactlyOnceWith({
        conversationId: "conv_main",
        actor: "lark:default:ou_sender",
        reasonText: "stop requested from lark command",
      });
    });
  });
});

describe("lark card actions", () => {
  test("routes stop button callbacks to control service", async () => {
    const control = {
      stopRun: vi.fn(() => ({
        accepted: true,
        runId: "run_123",
        sessionId: "sess_123",
        conversationId: "conv_123",
      })),
    } as unknown as RuntimeControlService;

    const handler = createLarkCardActionHandler({
      installationId: "default",
      control,
    });

    const result = await handler({
      action: {
        value: {
          action: "stop_run",
          runId: "run_123",
        },
      },
      operator: {
        open_id: "ou_sender",
      },
    });

    expect(control.stopRun).toHaveBeenCalledExactlyOnceWith({
      runId: "run_123",
      actor: "lark:default:ou_sender",
      reasonText: "stop requested from lark card action",
    });
    expect(result).toEqual({
      toast: {
        type: "success",
        content: "正在停止...",
      },
    });
  });
});
