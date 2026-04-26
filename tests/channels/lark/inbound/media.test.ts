import { Readable } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import type { LarkSdkClient } from "@/src/channels/lark/client.js";
import {
  buildLarkChatSurfaceKey,
  createLarkMessageReceiveHandler,
} from "@/src/channels/lark/inbound.js";
import { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";
import { RuntimeControlService } from "@/src/runtime/control.js";
import { ChannelSurfacesRepo } from "@/src/storage/repos/channel-surfaces.repo.js";
import { makeMessageEvent, makeRawMessage, seedFixture, withHandle } from "./fixtures.js";

describe("lark inbound message media handling", () => {
  test("downloads inbound image messages and forwards them in userPayload", async () => {
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
      const messageResourceGet = vi.fn(async () => ({
        headers: { "content-type": "image/jpeg" },
        getReadableStream: () => Readable.from(Buffer.from("fake-image")),
      }));
      const clients = {
        getOrCreate: vi.fn(() => ({
          sdk: {
            im: {
              messageResource: {
                get: messageResourceGet,
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

      await handler(makeMessageEvent("image", { image_key: "img_v3_123" }));

      expect(messageResourceGet).toHaveBeenCalledOnce();
      expect(submitMessage).toHaveBeenCalledExactlyOnceWith({
        sessionId: "sess_chat_1",
        scenario: "chat",
        content: "[图片 img_v3_123]",
        userPayload: {
          content: "[图片 img_v3_123]",
          images: [
            {
              type: "image",
              id: "img_v3_123",
              messageId: "om_msg_1",
              mimeType: "image/jpeg",
            },
          ],
        },
        runtimeImages: [
          {
            type: "image",
            id: "img_v3_123",
            messageId: "om_msg_1",
            data: Buffer.from("fake-image").toString("base64"),
            mimeType: "image/jpeg",
          },
        ],
        channelMessageId: "om_msg_1",
        createdAt: new Date("2026-03-27T00:00:00.000Z"),
      });
    });
  });

  test("downloads inbound image messages from raw lark payloads and forwards runtimeImages", async () => {
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
      const messageResourceGet = vi.fn(async () => ({
        headers: { "content-type": "image/png" },
        getReadableStream: () => Readable.from(Buffer.from("raw-image")),
      }));
      const clients = {
        getOrCreate: vi.fn(() => ({
          sdk: {
            im: {
              messageResource: {
                get: messageResourceGet,
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

      await handler(makeRawMessage("image", { image_key: "img_v3_raw_123" }));

      expect(messageResourceGet).toHaveBeenCalledOnce();
      expect(submitMessage).toHaveBeenCalledExactlyOnceWith({
        sessionId: "sess_chat_1",
        scenario: "chat",
        content: "[图片 img_v3_raw_123]",
        userPayload: {
          content: "[图片 img_v3_raw_123]",
          images: [
            {
              type: "image",
              id: "img_v3_raw_123",
              messageId: "om_msg_raw_1",
              mimeType: "image/png",
            },
          ],
        },
        runtimeImages: [
          {
            type: "image",
            id: "img_v3_raw_123",
            messageId: "om_msg_raw_1",
            data: Buffer.from("raw-image").toString("base64"),
            mimeType: "image/png",
          },
        ],
        channelMessageId: "om_msg_raw_1",
        createdAt: new Date("2026-03-27T00:00:00.000Z"),
      });
    });
  });

  test("keeps only successfully fetched post images in payload metadata", async () => {
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
      const messageResourceGet = vi.fn(async (input: { path: { file_key: string } }) => {
        if (input.path.file_key === "img_v3_post_ok") {
          return {
            headers: { "content-type": "text/html; charset=utf-8" },
            getReadableStream: () => Readable.from(Buffer.from("post-image-ok")),
          };
        }
        throw new Error("download failed");
      });
      const clients = {
        getOrCreate: vi.fn(() => ({
          sdk: {
            im: {
              messageResource: {
                get: messageResourceGet,
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

      await handler(
        makeMessageEvent("post", {
          zh_cn: {
            content: [
              [
                { tag: "md", text: "Two images" },
                { tag: "img", image_key: "img_v3_post_ok" },
                { tag: "img", image_key: "img_v3_post_fail" },
              ],
            ],
          },
        }),
      );

      expect(messageResourceGet).toHaveBeenCalledTimes(2);
      expect(submitMessage).toHaveBeenCalledExactlyOnceWith({
        sessionId: "sess_chat_1",
        scenario: "chat",
        content: "Two images![image](img_v3_post_ok)![image](img_v3_post_fail)",
        userPayload: {
          content: "Two images![image](img_v3_post_ok)![image](img_v3_post_fail)",
          images: [
            {
              type: "image",
              id: "img_v3_post_ok",
              messageId: "om_msg_1",
              mimeType: "image/png",
            },
          ],
        },
        runtimeImages: [
          {
            type: "image",
            id: "img_v3_post_ok",
            messageId: "om_msg_1",
            data: Buffer.from("post-image-ok").toString("base64"),
            mimeType: "image/png",
          },
        ],
        channelMessageId: "om_msg_1",
        createdAt: new Date("2026-03-27T00:00:00.000Z"),
      });
    });
  });

  test("drops empty downloaded image resources from payload metadata", async () => {
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
      const messageResourceGet = vi.fn(async () => ({
        headers: { "content-type": "image/jpeg" },
        getReadableStream: () => Readable.from(Buffer.alloc(0)),
      }));
      const clients = {
        getOrCreate: vi.fn(() => ({
          sdk: {
            im: {
              messageResource: {
                get: messageResourceGet,
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

      await handler(makeMessageEvent("image", { image_key: "img_v3_empty" }));

      expect(messageResourceGet).toHaveBeenCalledOnce();
      expect(submitMessage).toHaveBeenCalledExactlyOnceWith({
        sessionId: "sess_chat_1",
        scenario: "chat",
        content: "[图片 img_v3_empty]",
        channelMessageId: "om_msg_1",
        createdAt: new Date("2026-03-27T00:00:00.000Z"),
      });
    });
  });

  test("routes image placeholders through runtime ingress", async () => {
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
          message_id: "om_msg_2",
          chat_id: "oc_chat_1",
          message_type: "image",
          content: JSON.stringify({ image_key: "img_1" }),
        },
      });

      expect(submitMessage).toHaveBeenCalledExactlyOnceWith({
        sessionId: "sess_chat_1",
        scenario: "chat",
        content: "[图片 img_1]",
        channelMessageId: "om_msg_2",
      });
    });
  });
});
