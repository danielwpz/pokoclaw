import type { LarkSdkClient } from "@/src/channels/lark/client.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";

const logger = createSubsystemLogger("channels/lark-reactions");

export async function addLarkMessageReaction(input: {
  client: LarkSdkClient;
  messageId: string;
  emojiType: string;
}): Promise<string | null> {
  try {
    const response = await input.client.sdk.im.messageReaction.create({
      path: {
        message_id: input.messageId,
      },
      data: {
        reaction_type: {
          emoji_type: input.emojiType,
        },
      },
    });
    return response.data?.reaction_id ?? null;
  } catch (error) {
    logger.warn("failed to add lark message reaction", {
      messageId: input.messageId,
      emojiType: input.emojiType,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function removeLarkMessageReaction(input: {
  client: LarkSdkClient;
  messageId: string;
  reactionId: string;
}): Promise<boolean> {
  try {
    await input.client.sdk.im.messageReaction.delete({
      path: {
        message_id: input.messageId,
        reaction_id: input.reactionId,
      },
    });
    return true;
  } catch (error) {
    logger.warn("failed to remove lark message reaction", {
      messageId: input.messageId,
      reactionId: input.reactionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
