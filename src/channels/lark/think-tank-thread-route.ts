import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { ChannelThreadsRepo } from "@/src/storage/repos/channel-threads.repo.js";
import { LarkObjectBindingsRepo } from "@/src/storage/repos/lark-object-bindings.repo.js";
import { ThinkTankConsultationsRepo } from "@/src/storage/repos/think-tank-consultations.repo.js";
import type { LarkObjectBinding } from "@/src/storage/schema/types.js";

const logger = createSubsystemLogger("channels/lark-think-tank-thread-route");

const LARK_CHANNEL_TYPE = "lark";
const THINK_TANK_MAIN_CARD_OBJECT_KIND = "think_tank_main_card";
const THINK_TANK_EPISODE_CARD_OBJECT_KIND = "think_tank_episode_card";
const THINK_TANK_STEP_CARD_OBJECT_KIND = "think_tank_step_card";

export interface ThinkTankThreadRouteMessage {
  chatId: string;
  messageId: string;
  parentMessageId: string | null;
  threadId: string | null;
  createdAt?: Date;
}

export interface ResolvedThinkTankThreadRoute {
  kind: "think_tank_thread";
  consultationId: string;
  conversationId: string;
  branchId: string;
  sessionId: string;
  scenario: "chat";
  stopScope: "session";
  chatId: string;
  replyToMessageId: string | null;
}

export function resolveThinkTankThreadRoute(input: {
  db: StorageDb;
  installationId: string;
  normalized: ThinkTankThreadRouteMessage;
}): ResolvedThinkTankThreadRoute | null {
  const bindingsRepo = new LarkObjectBindingsRepo(input.db);
  const threadId = input.normalized.threadId;
  if (threadId == null) {
    return null;
  }

  const binding =
    bindingsRepo.getByThreadRootMessageId({
      channelInstallationId: input.installationId,
      threadRootMessageId: threadId,
    }) ??
    (input.normalized.parentMessageId == null
      ? null
      : bindingsRepo.getByLarkMessageId({
          channelInstallationId: input.installationId,
          larkMessageId: input.normalized.parentMessageId,
        }));
  if (binding == null) {
    return null;
  }

  const consultationId = extractThinkTankConsultationIdFromBinding(binding);
  if (consultationId == null) {
    return null;
  }

  if (binding.threadRootMessageId !== threadId) {
    bindingsRepo.upsert({
      id: binding.id,
      channelInstallationId: binding.channelInstallationId,
      conversationId: binding.conversationId,
      branchId: binding.branchId,
      internalObjectKind: binding.internalObjectKind,
      internalObjectId: binding.internalObjectId,
      larkMessageId: binding.larkMessageId,
      larkOpenMessageId: binding.larkOpenMessageId,
      larkCardId: binding.larkCardId,
      threadRootMessageId: threadId,
      cardElementId: binding.cardElementId,
      lastSequence: binding.lastSequence,
      status: normalizeBindingStatus(binding.status),
      metadataJson: binding.metadataJson,
      createdAt: new Date(binding.createdAt),
      updatedAt: input.normalized.createdAt ?? new Date(),
    });
  }

  const consultation = new ThinkTankConsultationsRepo(input.db).getById(consultationId);
  if (consultation == null) {
    logger.warn("ignoring lark think tank thread binding because consultation is missing", {
      channelInstallationId: binding.channelInstallationId,
      larkMessageId: binding.larkMessageId,
      threadRootMessageId: threadId,
      consultationId,
    });
    return null;
  }

  const channelThreadsRepo = new ChannelThreadsRepo(input.db);
  const openedFromMessageId =
    input.normalized.parentMessageId ??
    binding.larkMessageId ??
    binding.larkOpenMessageId ??
    input.normalized.messageId;
  const existingThread = channelThreadsRepo.getByRootThinkTankConsultation({
    channelType: LARK_CHANNEL_TYPE,
    channelInstallationId: input.installationId,
    rootThinkTankConsultationId: consultation.id,
  });
  const channelThread =
    existingThread == null
      ? channelThreadsRepo.upsert({
          id: randomUUID(),
          channelType: LARK_CHANNEL_TYPE,
          channelInstallationId: input.installationId,
          homeConversationId: consultation.sourceConversationId,
          externalChatId: input.normalized.chatId,
          externalThreadId: threadId,
          subjectKind: "think_tank",
          rootThinkTankConsultationId: consultation.id,
          openedFromMessageId,
          ...(input.normalized.createdAt == null
            ? {}
            : { createdAt: input.normalized.createdAt, updatedAt: input.normalized.createdAt }),
        })
      : existingThread.externalThreadId === threadId &&
          existingThread.externalChatId === input.normalized.chatId &&
          existingThread.openedFromMessageId != null
        ? existingThread
        : channelThreadsRepo.patchByRootThinkTankConsultation({
            channelType: LARK_CHANNEL_TYPE,
            channelInstallationId: input.installationId,
            rootThinkTankConsultationId: consultation.id,
            homeConversationId: consultation.sourceConversationId,
            externalChatId: input.normalized.chatId,
            externalThreadId: threadId,
            subjectKind: "think_tank",
            openedFromMessageId: existingThread.openedFromMessageId ?? openedFromMessageId,
            ...(input.normalized.createdAt == null
              ? {}
              : { updatedAt: input.normalized.createdAt }),
          });
  if (channelThread == null) {
    logger.warn("failed to adopt lark think tank thread into durable routing", {
      installationId: input.installationId,
      chatId: input.normalized.chatId,
      threadId,
      consultationId: consultation.id,
    });
    return null;
  }

  return {
    kind: "think_tank_thread",
    consultationId: consultation.id,
    conversationId: consultation.sourceConversationId,
    branchId: consultation.sourceBranchId,
    sessionId: consultation.moderatorSessionId,
    scenario: "chat",
    stopScope: "session",
    chatId: input.normalized.chatId,
    replyToMessageId: input.normalized.parentMessageId ?? channelThread.openedFromMessageId ?? null,
  };
}

function extractThinkTankConsultationIdFromBinding(input: LarkObjectBinding): string | null {
  if (
    input.internalObjectKind !== THINK_TANK_MAIN_CARD_OBJECT_KIND &&
    input.internalObjectKind !== THINK_TANK_EPISODE_CARD_OBJECT_KIND &&
    input.internalObjectKind !== THINK_TANK_STEP_CARD_OBJECT_KIND
  ) {
    return null;
  }
  const match = /^think_tank:([^:]+):/.exec(input.internalObjectId);
  return match?.[1] ?? null;
}

function normalizeBindingStatus(value: string): "active" | "finalized" | "stale" {
  return value === "finalized" || value === "stale" ? value : "active";
}
