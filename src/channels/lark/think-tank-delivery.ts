import { randomUUID } from "node:crypto";
import type { LarkThinkTankConsultationState } from "@/src/channels/lark/think-tank-state.js";
import type { OrchestratedOutboundEventEnvelope } from "@/src/orchestration/outbound-events.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { ChannelSurfacesRepo } from "@/src/storage/repos/channel-surfaces.repo.js";
import { ChannelThreadsRepo } from "@/src/storage/repos/channel-threads.repo.js";
import type { LarkObjectBinding } from "@/src/storage/schema/types.js";

const LARK_CHANNEL_TYPE = "lark";

export const THINK_TANK_MAIN_DELIVERY_PREFIX = "think_tank_main:";
export const THINK_TANK_EPISODE_DELIVERY_PREFIX = "think_tank_episode:";
export const THINK_TANK_STEP_DELIVERY_PREFIX = "think_tank_step:";

export function buildThinkTankMainCardObjectId(consultationId: string): string {
  return `think_tank:${consultationId}:main`;
}

export function buildThinkTankEpisodeCardObjectId(
  consultationId: string,
  episodeId: string,
): string {
  return `think_tank:${consultationId}:episode:${episodeId}`;
}

export function buildThinkTankStepCardObjectId(
  consultationId: string,
  episodeId: string,
  stepKey: string,
): string {
  return `think_tank:${consultationId}:episode:${episodeId}:step:${stepKey}`;
}

export function listThinkTankThreadDeliveryTargets(
  storage: StorageDb,
  input: {
    consultationId: string;
    conversationId: string;
    branchId: string;
  },
): Array<{
  channelInstallationId: string;
  chatId: string;
  surfaceObject: Record<string, unknown>;
}> {
  const surfaces = new ChannelSurfacesRepo(storage).listByConversationBranch({
    channelType: LARK_CHANNEL_TYPE,
    conversationId: input.conversationId,
    branchId: input.branchId,
  });
  const channelThreadsRepo = new ChannelThreadsRepo(storage);

  return surfaces.flatMap((surface) => {
    const threadBinding = channelThreadsRepo.getByRootThinkTankConsultation({
      channelType: LARK_CHANNEL_TYPE,
      channelInstallationId: surface.channelInstallationId,
      rootThinkTankConsultationId: input.consultationId,
    });
    if (
      threadBinding == null ||
      threadBinding.externalChatId.length === 0 ||
      threadBinding.externalThreadId.length === 0 ||
      threadBinding.openedFromMessageId == null
    ) {
      return [];
    }
    return [
      {
        channelInstallationId: surface.channelInstallationId,
        chatId: threadBinding.externalChatId,
        surfaceObject: {
          chat_id: threadBinding.externalChatId,
          thread_id: threadBinding.externalThreadId,
          reply_to_message_id: threadBinding.openedFromMessageId,
        },
      },
    ];
  });
}

export function ensureThinkTankThreadBindingFromMainCard(input: {
  storage: StorageDb;
  channelInstallationId: string;
  consultationId: string;
  conversationId: string;
  binding: LarkObjectBinding;
  chatId: string;
}): void {
  const threadRootId = input.binding.larkOpenMessageId ?? input.binding.larkMessageId;
  const replyToMessageId = input.binding.larkMessageId;
  if (threadRootId == null || replyToMessageId == null) {
    return;
  }
  new ChannelThreadsRepo(input.storage).upsert({
    id: randomUUID(),
    channelType: LARK_CHANNEL_TYPE,
    channelInstallationId: input.channelInstallationId,
    homeConversationId: input.conversationId,
    externalChatId: input.chatId,
    externalThreadId: threadRootId,
    subjectKind: "think_tank",
    rootThinkTankConsultationId: input.consultationId,
    openedFromMessageId: replyToMessageId,
  });
}

export function scheduleKnownThinkTankThreadDeliveries(input: {
  state: LarkThinkTankConsultationState;
  consultationId: string;
  bumpVersionAndSchedule: (
    deliveryId: string,
    options?: { immediate?: boolean; delayMs?: number },
  ) => void;
}): void {
  for (const episode of input.state.episodes.values()) {
    input.bumpVersionAndSchedule(
      `${THINK_TANK_EPISODE_DELIVERY_PREFIX}${input.consultationId}:${episode.episodeId}`,
    );
  }
}

export function scheduleThinkTankEventDeliveries(input: {
  envelope: Extract<OrchestratedOutboundEventEnvelope, { kind: "think_tank_event" }>;
  bumpVersionAndSchedule: (
    deliveryId: string,
    options?: { immediate?: boolean; delayMs?: number },
  ) => void;
}): void {
  if (input.envelope.event.type === "consultation_upserted") {
    input.bumpVersionAndSchedule(
      `${THINK_TANK_MAIN_DELIVERY_PREFIX}${input.envelope.consultationId}`,
    );
    return;
  }
  if (input.envelope.event.type === "episode_started") {
    input.bumpVersionAndSchedule(
      `${THINK_TANK_EPISODE_DELIVERY_PREFIX}${input.envelope.consultationId}:${input.envelope.event.episodeId}`,
    );
    return;
  }
  if (input.envelope.event.type === "episode_step_upserted") {
    input.bumpVersionAndSchedule(
      `${THINK_TANK_EPISODE_DELIVERY_PREFIX}${input.envelope.consultationId}:${input.envelope.event.episodeId}`,
    );
    return;
  }
  if (input.envelope.event.type === "episode_settled") {
    input.bumpVersionAndSchedule(
      `${THINK_TANK_EPISODE_DELIVERY_PREFIX}${input.envelope.consultationId}:${input.envelope.event.episodeId}`,
    );
  }
}
