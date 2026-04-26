import { describe, expect, test, vi } from "vitest";
import type { LarkSdkClient } from "@/src/channels/lark/client.js";
import {
  buildLarkChatSurfaceKey,
  createLarkMessageReceiveHandler,
} from "@/src/channels/lark/inbound.js";
import { LarkSteerReactionState } from "@/src/channels/lark/steer-reaction-state.js";
import { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";
import { RuntimeControlService } from "@/src/runtime/control.js";
import { ChannelSurfacesRepo } from "@/src/storage/repos/channel-surfaces.repo.js";
import { makeMessageEvent, makeTextEvent, seedFixture, withHandle } from "./fixtures.js";

describe("lark inbound message handling", () => {
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
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
      });

      await handler(makeTextEvent("hello from lark"));

      expect(submitMessage).toHaveBeenCalledExactlyOnceWith({
        sessionId: "sess_chat_1",
        scenario: "chat",
        content: "hello from lark",
        channelMessageId: "om_msg_1",
        createdAt: new Date("2026-03-27T00:00:00.000Z"),
      });
    });
  });

  test("adds a pending reaction when ingress reports a steered message", async () => {
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

      const submitMessage = vi.fn(async () => ({ status: "steered" as const }));
      const reactionCreate = vi.fn(async () => ({ data: { reaction_id: "react_pending_1" } }));
      const clients = {
        getOrCreate: () =>
          ({
            sdk: {
              im: {
                messageReaction: {
                  create: reactionCreate,
                },
              },
            },
          }) as never,
      };
      const steerReactionState = new LarkSteerReactionState();
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
        clients,
        steerReactionState,
      });

      await handler(makeTextEvent("queue this message"));

      expect(reactionCreate).toHaveBeenCalledExactlyOnceWith({
        path: {
          message_id: "om_msg_1",
        },
        data: {
          reaction_type: {
            emoji_type: "Typing",
          },
        },
      });
      expect(
        steerReactionState.takePendingReaction({
          installationId: "default",
          messageId: "om_msg_1",
        }),
      ).toMatchObject({
        reactionId: "react_pending_1",
        emojiType: "Typing",
      });
    });
  });

  test("replies with a failure card when runtime ingress rejects a lark message", async () => {
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

      const submitMessage = vi.fn(async () => {
        throw new Error(
          "Run hit the configured max turn limit (60) before producing a final response.",
        );
      });
      const create = vi.fn(async () => ({ data: { message_id: "om_fail_1" } }));
      const clients = {
        getOrCreate: vi.fn(() => ({
          sdk: {
            im: {
              message: {
                create,
              },
            },
          },
        })),
      } as unknown as { getOrCreate(installationId: string): LarkSdkClient };

      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
        clients,
      });

      await expect(handler(makeTextEvent("hello from lark"))).rejects.toThrow(
        "configured max turn limit (60)",
      );
      expect(create).toHaveBeenCalledOnce();
      const createCall = (create as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0]?.[0] as { params?: unknown; data?: { content?: string } } | undefined;
      expect(createCall).toMatchObject({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: "oc_chat_1",
          msg_type: "interactive",
        },
      });
      expect(createCall?.data?.content ?? "").toContain("执行失败");
      expect(createCall?.data?.content ?? "").toContain("max turn limit (60)");
    });
  });

  test("routes a post message through surface binding into runtime ingress", async () => {
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
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
      });

      await handler(
        makeMessageEvent("post", {
          zh_cn: {
            content: [[{ tag: "md", text: "- First item\n- Second item" }]],
          },
        }),
      );

      expect(submitMessage).toHaveBeenCalledExactlyOnceWith({
        sessionId: "sess_chat_1",
        scenario: "chat",
        content: "- First item\n- Second item",
        channelMessageId: "om_msg_1",
        createdAt: new Date("2026-03-27T00:00:00.000Z"),
      });
    });
  });

  test("hydrates interactive inbound messages through message.get raw card content", async () => {
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
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
        quoteMessageFetcher: vi.fn(async () => ({
          messageType: "interactive",
          text: "- First item\n- Second item",
        })),
      });

      await handler(
        makeMessageEvent("interactive", {
          card_id: "card_xxx",
        }),
      );

      expect(submitMessage).toHaveBeenCalledExactlyOnceWith({
        sessionId: "sess_chat_1",
        scenario: "chat",
        content: "- First item\n- Second item",
        channelMessageId: "om_msg_1",
        createdAt: new Date("2026-03-27T00:00:00.000Z"),
      });
    });
  });
});
