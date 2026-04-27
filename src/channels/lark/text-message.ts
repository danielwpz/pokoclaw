import type { LarkSdkClient } from "@/src/channels/lark/client.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";

const logger = createSubsystemLogger("channels/lark-text-message");

export async function sendLarkTextMessage(input: {
  installationId: string;
  chatId: string;
  replyToMessageId?: string | null;
  text: string;
  clients?: {
    getOrCreate(installationId: string): LarkSdkClient;
  };
}): Promise<void> {
  if (input.clients == null) {
    logger.warn("cannot send lark text message because no sdk clients are configured", {
      installationId: input.installationId,
      chatId: input.chatId,
    });
    return;
  }

  const client = input.clients.getOrCreate(input.installationId);
  const content = JSON.stringify({ text: input.text });
  if (input.replyToMessageId != null && input.replyToMessageId.length > 0) {
    await client.sdk.im.message.reply({
      path: { message_id: input.replyToMessageId },
      data: {
        msg_type: "text",
        content,
        reply_in_thread: true,
      },
    });
    return;
  }

  await client.sdk.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: input.chatId,
      msg_type: "text",
      content,
    },
  });
}
