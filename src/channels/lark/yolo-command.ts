import type { LarkSdkClient } from "@/src/channels/lark/client.js";
import { sendLarkTextMessage } from "@/src/channels/lark/text-message.js";
import type { RuntimeModeService } from "@/src/runtime/runtime-modes.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";

const logger = createSubsystemLogger("channels/lark-yolo-command");

export const LARK_YOLO_ENABLED_MESSAGE =
  "⚠️ YOLO mode is on. Risky actions may run without asking first. Send /yolo again to turn it off.";
export const LARK_YOLO_DISABLED_MESSAGE =
  "🔒 YOLO mode is off. Future privileged actions will ask for approval again.";
export const LARK_YOLO_MISSING_OWNER_MESSAGE =
  "YOLO mode could not be changed because this route has no owner agent.";

export function isLarkYoloCommand(text: string): boolean {
  return text === "/yolo";
}

export async function handleLarkYoloCommand(input: {
  text: string;
  installationId: string;
  storage: StorageDb;
  runtimeModes?: RuntimeModeService;
  route: {
    kind: string;
    conversationId: string;
    sessionId: string;
    chatId: string;
    replyToMessageId: string | null;
  };
  message: {
    chatId: string;
    messageId: string;
    senderOpenId: string | null;
    createdAt?: Date;
  };
  clients?: {
    getOrCreate(installationId: string): LarkSdkClient;
  };
}): Promise<boolean> {
  if (!isLarkYoloCommand(input.text)) {
    return false;
  }

  if (input.runtimeModes == null) {
    logger.warn("ignoring lark yolo command because no runtime mode service is configured", {
      installationId: input.installationId,
      chatId: input.message.chatId,
      messageId: input.message.messageId,
    });
    return true;
  }

  const session = new SessionsRepo(input.storage).getById(input.route.sessionId);
  if (session?.ownerAgentId == null || session.ownerAgentId.trim().length === 0) {
    await sendLarkTextMessage({
      installationId: input.installationId,
      chatId: input.route.chatId,
      replyToMessageId: input.route.replyToMessageId,
      text: LARK_YOLO_MISSING_OWNER_MESSAGE,
      ...(input.clients == null ? {} : { clients: input.clients }),
    });
    logger.warn("failed to process lark yolo command because route has no owner agent", {
      installationId: input.installationId,
      chatId: input.message.chatId,
      messageId: input.message.messageId,
      conversationId: input.route.conversationId,
      sessionId: input.route.sessionId,
      routeKind: input.route.kind,
    });
    return true;
  }

  const toggled = input.runtimeModes.toggleYolo({
    ownerAgentId: session.ownerAgentId,
    updatedBy:
      input.message.senderOpenId == null
        ? `lark:${input.installationId}:unknown`
        : `lark:${input.installationId}:${input.message.senderOpenId}`,
    updatedAt: input.message.createdAt ?? new Date(),
  });
  await sendLarkTextMessage({
    installationId: input.installationId,
    chatId: input.route.chatId,
    replyToMessageId: input.route.replyToMessageId,
    text: toggled.yoloEnabled ? LARK_YOLO_ENABLED_MESSAGE : LARK_YOLO_DISABLED_MESSAGE,
    ...(input.clients == null ? {} : { clients: input.clients }),
  });
  logger.info("processed lark yolo command", {
    installationId: input.installationId,
    chatId: input.message.chatId,
    messageId: input.message.messageId,
    conversationId: input.route.conversationId,
    sessionId: input.route.sessionId,
    ownerAgentId: session.ownerAgentId,
    yoloEnabled: toggled.yoloEnabled,
    routeKind: input.route.kind,
  });
  return true;
}
