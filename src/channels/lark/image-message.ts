import { createReadStream } from "node:fs";

import type { LarkSdkClient } from "@/src/channels/lark/client.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";

const logger = createSubsystemLogger("channels/lark-image-message");

export interface SendLarkImageMessageResult {
  imageKey: string;
  messageId?: string;
  openMessageId?: string;
}

export async function uploadLarkImageMessageAsset(input: {
  installationId: string;
  chatId: string;
  imagePath: string;
  clients?: {
    getOrCreate(installationId: string): LarkSdkClient;
  };
}): Promise<{ imageKey: string }> {
  if (input.clients == null) {
    throw new Error("Lark image sending is not configured in this runtime.");
  }

  const client = input.clients.getOrCreate(input.installationId);
  const upload = await client.sdk.im.image.create({
    data: {
      image_type: "message",
      image: createReadStream(input.imagePath),
    },
  });
  const imageKey = readImageKey(upload);
  if (imageKey == null) {
    throw new Error("Lark image upload did not return image_key.");
  }

  logger.info("uploaded lark image message asset", {
    installationId: input.installationId,
    chatId: input.chatId,
    imagePath: input.imagePath,
    imageKey,
  });

  return { imageKey };
}

export async function sendLarkImageMessage(input: {
  installationId: string;
  chatId: string;
  replyToMessageId?: string | null;
  imagePath: string;
  clients?: {
    getOrCreate(installationId: string): LarkSdkClient;
  };
}): Promise<SendLarkImageMessageResult> {
  if (input.clients == null) {
    throw new Error("Lark image sending is not configured in this runtime.");
  }

  const client = input.clients.getOrCreate(input.installationId);
  const { imageKey } = await uploadLarkImageMessageAsset(input);
  const content = JSON.stringify({ image_key: imageKey });
  const response =
    input.replyToMessageId != null && input.replyToMessageId.length > 0
      ? await client.sdk.im.message.reply({
          path: { message_id: input.replyToMessageId },
          data: {
            msg_type: "image",
            content,
            reply_in_thread: true,
          },
        })
      : await client.sdk.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: input.chatId,
            msg_type: "image",
            content,
          },
        });

  const messageId = readStringField(response?.data, "message_id") ?? undefined;
  const openMessageId = readStringField(response?.data, "open_message_id") ?? undefined;

  return {
    imageKey,
    ...(messageId === undefined ? {} : { messageId }),
    ...(openMessageId === undefined ? {} : { openMessageId }),
  };
}

function readImageKey(upload: unknown): string | null {
  return (
    readStringField(readObjectField(upload, "data"), "image_key") ??
    readStringField(upload, "image_key")
  );
}

function readObjectField(value: unknown, key: string): Record<string, unknown> | null {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    return null;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "object" && field != null && !Array.isArray(field)
    ? (field as Record<string, unknown>)
    : null;
}

function readStringField(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    return null;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim().length > 0 ? field.trim() : null;
}
