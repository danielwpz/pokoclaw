import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { sendLarkImageMessage } from "@/src/channels/lark/image-message.js";

describe("lark image message", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir != null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test("uploads an image and sends a native image message", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-lark-image-message-"));
    const imagePath = path.join(tempDir, "chart.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const imageCreate = vi.fn(async () => ({ data: { image_key: "img_v3_uploaded" } }));
    const messageCreate = vi.fn(async () => ({
      data: { message_id: "om_image_1", open_message_id: "om_open_image_1" },
    }));

    const result = await sendLarkImageMessage({
      installationId: "default",
      chatId: "oc_chat_1",
      imagePath,
      clients: {
        getOrCreate: () =>
          ({
            sdk: {
              im: {
                image: { create: imageCreate },
                message: { create: messageCreate },
              },
            },
          }) as never,
      },
    });

    expect(imageCreate).toHaveBeenCalledWith({
      data: {
        image_type: "message",
        image: expect.objectContaining({ path: imagePath }),
      },
    });
    expect(messageCreate).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc_chat_1",
        msg_type: "image",
        content: JSON.stringify({ image_key: "img_v3_uploaded" }),
      },
    });
    expect(result).toEqual({
      imageKey: "img_v3_uploaded",
      messageId: "om_image_1",
      openMessageId: "om_open_image_1",
    });
  });

  test("uploads an image and replies in a thread when a reply target exists", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-lark-image-message-"));
    const imagePath = path.join(tempDir, "chart.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const imageCreate = vi.fn(async () => ({ data: { image_key: "img_v3_uploaded" } }));
    const reply = vi.fn(async () => ({ data: { message_id: "om_reply_1" } }));

    await sendLarkImageMessage({
      installationId: "default",
      chatId: "oc_chat_1",
      replyToMessageId: "om_thread_root",
      imagePath,
      clients: {
        getOrCreate: () =>
          ({
            sdk: {
              im: {
                image: { create: imageCreate },
                message: { reply },
              },
            },
          }) as never,
      },
    });

    expect(reply).toHaveBeenCalledWith({
      path: { message_id: "om_thread_root" },
      data: {
        msg_type: "image",
        content: JSON.stringify({ image_key: "img_v3_uploaded" }),
        reply_in_thread: true,
      },
    });
  });

  test("accepts legacy top-level image_key upload responses as a fallback", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-lark-image-message-"));
    const imagePath = path.join(tempDir, "chart.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const imageCreate = vi.fn(async () => ({ image_key: "img_v3_uploaded" }));
    const messageCreate = vi.fn(async () => ({ data: { message_id: "om_image_1" } }));

    const result = await sendLarkImageMessage({
      installationId: "default",
      chatId: "oc_chat_1",
      imagePath,
      clients: {
        getOrCreate: () =>
          ({
            sdk: {
              im: {
                image: { create: imageCreate },
                message: { create: messageCreate },
              },
            },
          }) as never,
      },
    });

    expect(messageCreate).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc_chat_1",
        msg_type: "image",
        content: JSON.stringify({ image_key: "img_v3_uploaded" }),
      },
    });
    expect(result.imageKey).toBe("img_v3_uploaded");
  });
});
