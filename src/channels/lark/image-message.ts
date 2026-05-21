import { createReadStream } from "node:fs";

import type { LarkSdkClient } from "@/src/channels/lark/client.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";

const logger = createSubsystemLogger("channels/lark-image-message");

export interface SendLarkImageMessageResult {
  imageKey: string;
  messageId?: string;
  openMessageId?: string;
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
  const upload = await client.sdk.im.image.create({
    data: {
      image_type: "message",
      image: createReadStream(input.imagePath),
    },
  });
  const imageKey = upload?.image_key ?? null;
  if (imageKey == null || imageKey.trim().length === 0) {
    throw new Error("Lark image upload did not return image_key.");
  }

  logger.info("uploaded lark image message asset", {
    installationId: input.installationId,
    chatId: input.chatId,
    imagePath: input.imagePath,
    imageKey,
  });

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

  const responseData =
    typeof response?.data === "object" && response.data != null
      ? (response.data as Record<string, unknown>)
      : {};
  const messageId =
    typeof responseData.message_id === "string" ? responseData.message_id : undefined;
  const openMessageId =
    typeof responseData.open_message_id === "string" ? responseData.open_message_id : undefined;

  return {
    imageKey,
    ...(messageId === undefined ? {} : { messageId }),
    ...(openMessageId === undefined ? {} : { openMessageId }),
  };
}
