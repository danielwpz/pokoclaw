import { describe, expect, test, vi } from "vitest";
import {
  buildLarkChatSurfaceKey,
  createLarkMessageReceiveHandler,
} from "@/src/channels/lark/inbound.js";
import { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";
import { RuntimeControlService } from "@/src/runtime/control.js";
import { ChannelSurfacesRepo } from "@/src/storage/repos/channel-surfaces.repo.js";
import { makeTextEvent, seedFixture, withHandle } from "./fixtures.js";

describe("lark inbound surface routing", () => {
  test("backfills a surface from legacy conversation mapping before routing", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);

      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
      });

      await handler(makeTextEvent("hello again"));

      expect(submitMessage).toHaveBeenCalledExactlyOnceWith({
        sessionId: "sess_chat_1",
        scenario: "chat",
        content: "hello again",
        channelMessageId: "om_msg_1",
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
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
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
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
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
});
