import { randomUUID } from "node:crypto";
import type { LarkSdkClient } from "@/src/channels/lark/client.js";
import { buildLarkRenderedRunCard } from "@/src/channels/lark/render.js";
import {
  type LarkRunState,
  reduceLarkRunState,
  shouldHandleLarkRuntimeEvent,
} from "@/src/channels/lark/run-state.js";
import type { OrchestratedOutboundEventEnvelope } from "@/src/orchestration/outbound-events.js";
import type { RuntimeEventBus } from "@/src/runtime/event-bus.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { ChannelSurfacesRepo } from "@/src/storage/repos/channel-surfaces.repo.js";
import { LarkObjectBindingsRepo } from "@/src/storage/repos/lark-object-bindings.repo.js";

const logger = createSubsystemLogger("channels/lark-outbound");
const LARK_CHANNEL_TYPE = "lark";
const DELIVERY_INTERVAL_MS = 200;
const RUN_CARD_OBJECT_KIND = "run_card";
const LARK_CARD_LOG_PREVIEW_MAX_LENGTH = 600;

interface LarkCardCreateResponse {
  data?: {
    card_id?: string;
  };
  card_id?: string;
}

interface LarkCardElementContentInput {
  path: {
    card_id: string;
    element_id: string;
  };
  data: {
    content: string;
    sequence: number;
  };
}

interface LarkCardUpdateInput {
  path: {
    card_id: string;
  };
  data: {
    card: {
      type: "card_json";
      data: string;
    };
    sequence: number;
  };
}

interface LarkRunDeliverySnapshot {
  structureSignature: string;
  activeAssistantElementId: string | null;
  activeAssistantText: string;
}

export interface LarkOutboundRuntimeStatus {
  started: boolean;
  subscribed: boolean;
  activeRuns: number;
}

export interface LarkOutboundRuntime {
  start(): void;
  shutdown(): Promise<void>;
  status(): LarkOutboundRuntimeStatus;
}

export interface CreateLarkOutboundRuntimeInput {
  storage: StorageDb;
  outboundEventBus: RuntimeEventBus<OrchestratedOutboundEventEnvelope>;
  clients: {
    getOrCreate(installationId: string): LarkSdkClient;
  };
}

export function createLarkOutboundRuntime(
  input: CreateLarkOutboundRuntimeInput,
): LarkOutboundRuntime {
  const runStates = new Map<string, LarkRunState>();
  const scheduled = new Map<string, NodeJS.Timeout>();
  const deliverySnapshots = new Map<string, LarkRunDeliverySnapshot>();
  const runVersions = new Map<string, number>();
  const flushing = new Set<string>();
  let unsubscribe: (() => void) | null = null;

  const flushRun = async (runId: string) => {
    scheduled.delete(runId);
    if (flushing.has(runId)) {
      return;
    }
    const state = runStates.get(runId);
    if (state == null) {
      return;
    }
    const flushVersion = runVersions.get(runId) ?? 0;
    flushing.add(runId);

    try {
      logger.debug("starting lark outbound flush", {
        runId,
        flushVersion,
        terminal: state.terminal,
        activeAssistantMessageId: state.activeAssistantMessageId,
        activeToolSequenceBlockId: state.activeToolSequenceBlockId,
        blockCount: state.blocks.length,
        footerStatus: state.footerStatus,
      });
      const surfaces = new ChannelSurfacesRepo(input.storage).listByConversationBranch({
        channelType: LARK_CHANNEL_TYPE,
        conversationId: state.conversationId,
        branchId: state.branchId,
      });

      for (const surface of surfaces) {
        const surfaceObject = parseSurfaceObject(surface.surfaceObjectJson);
        const chatId = typeof surfaceObject.chat_id === "string" ? surfaceObject.chat_id : null;
        if (chatId == null || chatId.length === 0) {
          logger.warn("skipping lark outbound delivery because surface is missing chat_id", {
            runId,
            conversationId: state.conversationId,
            branchId: state.branchId,
            channelInstallationId: surface.channelInstallationId,
          });
          continue;
        }

        const client = input.clients.getOrCreate(surface.channelInstallationId);
        const cardkit = getCardkitSdk(client);
        const bindingsRepo = new LarkObjectBindingsRepo(input.storage);
        const existing = bindingsRepo.getByInternalObject({
          channelInstallationId: surface.channelInstallationId,
          internalObjectKind: RUN_CARD_OBJECT_KIND,
          internalObjectId: runId,
        });

        const rendered = buildLarkRenderedRunCard(state);
        const activeAssistantBlockId = rendered.activeAssistant?.elementId ?? null;
        const activeAssistantText = rendered.activeAssistant?.text ?? "";
        const deliveryKey = `${surface.channelInstallationId}:${runId}`;
        const snapshot = deliverySnapshots.get(deliveryKey) ?? null;
        const shouldRenderUpdate =
          snapshot == null || snapshot.structureSignature !== rendered.structureSignature;
        const canStreamDelta =
          existing?.larkCardId != null &&
          activeAssistantBlockId != null &&
          snapshot?.activeAssistantElementId === activeAssistantBlockId &&
          snapshot.activeAssistantText !== activeAssistantText;

        logger.debug("computed lark outbound delivery decision", {
          runId,
          channelInstallationId: surface.channelInstallationId,
          larkCardId: existing?.larkCardId ?? null,
          lastSequence: existing?.lastSequence ?? null,
          structureChanged: shouldRenderUpdate,
          canStreamDelta,
          activeAssistantElementId: activeAssistantBlockId,
          activeAssistantTextPreview: truncateLogText(activeAssistantText, 160),
          previousAssistantElementId: snapshot?.activeAssistantElementId ?? null,
          previousAssistantTextPreview: truncateLogText(snapshot?.activeAssistantText ?? "", 160),
          structureSignaturePreview: truncateLogText(rendered.structureSignature, 160),
        });

        if (existing?.larkCardId == null) {
          const createResp = await cardkit.card.create({
            data: {
              type: "card_json",
              data: JSON.stringify(rendered.card),
            },
          });
          logger.info("created lark cardkit card response", {
            runId,
            channelInstallationId: surface.channelInstallationId,
            responsePreview: truncateLogText(
              safeJson(createResp),
              LARK_CARD_LOG_PREVIEW_MAX_LENGTH,
            ),
          });
          const larkCardId = createResp.data?.card_id ?? createResp.card_id ?? null;
          if (larkCardId == null) {
            logger.warn("lark run card create returned no card id", {
              runId,
              channelInstallationId: surface.channelInstallationId,
              responsePreview: truncateLogText(
                safeJson(createResp),
                LARK_CARD_LOG_PREVIEW_MAX_LENGTH,
              ),
            });
            continue;
          }

          logger.info("sending lark card reference message", {
            runId,
            channelInstallationId: surface.channelInstallationId,
            chatId,
            larkCardId,
            cardPreview: truncateLogText(
              JSON.stringify(rendered.card),
              LARK_CARD_LOG_PREVIEW_MAX_LENGTH,
            ),
          });
          const response = (await client.sdk.im.message.create({
            params: { receive_id_type: "chat_id" },
            data: {
              receive_id: chatId,
              msg_type: "interactive",
              content: JSON.stringify({
                type: "card",
                data: {
                  card_id: larkCardId,
                },
              }),
            },
          })) as { data?: { message_id?: string; open_message_id?: string } };
          const larkMessageId = response.data?.message_id ?? null;
          if (larkMessageId == null) {
            logger.warn("lark run card create returned no message id", {
              runId,
              channelInstallationId: surface.channelInstallationId,
              larkCardId,
            });
            continue;
          }

          bindingsRepo.upsert({
            id: randomUUID(),
            channelInstallationId: surface.channelInstallationId,
            conversationId: state.conversationId,
            branchId: state.branchId,
            internalObjectKind: RUN_CARD_OBJECT_KIND,
            internalObjectId: runId,
            larkMessageId,
            larkOpenMessageId: response.data?.open_message_id ?? null,
            larkCardId,
            cardElementId: activeAssistantBlockId,
            lastSequence: 0,
            status: state.terminal === "running" ? "active" : "finalized",
            metadataJson: JSON.stringify({
              activeAssistantBlockId,
            }),
          });

          deliverySnapshots.set(deliveryKey, {
            structureSignature: rendered.structureSignature,
            activeAssistantElementId: activeAssistantBlockId,
            activeAssistantText,
          });

          logger.info("created lark run card", {
            runId,
            channelInstallationId: surface.channelInstallationId,
            larkMessageId,
            larkCardId,
          });
          continue;
        }

        if (!shouldRenderUpdate && canStreamDelta) {
          const elementId = activeAssistantBlockId;
          if (elementId == null || existing.larkCardId == null) {
            continue;
          }
          const sequence = (existing.lastSequence ?? 0) + 1;
          await cardkit.cardElement.content({
            path: {
              card_id: existing.larkCardId,
              element_id: elementId,
            },
            data: {
              content: activeAssistantText,
              sequence,
            },
          });
          bindingsRepo.updateDeliveryState({
            channelInstallationId: surface.channelInstallationId,
            internalObjectKind: RUN_CARD_OBJECT_KIND,
            internalObjectId: runId,
            lastSequence: sequence,
            metadataJson: JSON.stringify({
              activeAssistantBlockId,
            }),
          });
          deliverySnapshots.set(deliveryKey, {
            structureSignature: snapshot?.structureSignature ?? rendered.structureSignature,
            activeAssistantElementId: activeAssistantBlockId,
            activeAssistantText,
          });
          logger.info("streamed lark run card content", {
            runId,
            channelInstallationId: surface.channelInstallationId,
            larkCardId: existing.larkCardId,
            elementId,
            sequence,
          });
          continue;
        }

        if (!shouldRenderUpdate || existing.larkCardId == null) {
          continue;
        }

        const sequence = (existing.lastSequence ?? 0) + 1;
        await cardkit.card.update({
          path: { card_id: existing.larkCardId },
          data: {
            card: {
              type: "card_json",
              data: JSON.stringify(rendered.card),
            },
            sequence,
          },
        });
        bindingsRepo.updateDeliveryState({
          channelInstallationId: surface.channelInstallationId,
          internalObjectKind: RUN_CARD_OBJECT_KIND,
          internalObjectId: runId,
          lastSequence: sequence,
          status: state.terminal === "running" ? "active" : "finalized",
          metadataJson: JSON.stringify({
            activeAssistantBlockId,
          }),
        });
        deliverySnapshots.set(deliveryKey, {
          structureSignature: rendered.structureSignature,
          activeAssistantElementId: activeAssistantBlockId,
          activeAssistantText,
        });
        logger.info("updated lark run card", {
          runId,
          channelInstallationId: surface.channelInstallationId,
          larkCardId: existing.larkCardId,
          sequence,
        });
      }
    } finally {
      flushing.delete(runId);
      if ((runVersions.get(runId) ?? 0) !== flushVersion) {
        logger.debug("re-scheduling lark outbound flush after newer events arrived", {
          runId,
          completedVersion: flushVersion,
          latestVersion: runVersions.get(runId) ?? 0,
        });
        scheduleFlush(runId);
      }
    }
  };

  const scheduleFlush = (runId: string) => {
    if (scheduled.has(runId)) {
      return;
    }
    scheduled.set(
      runId,
      setTimeout(() => {
        void flushRun(runId).catch((error: unknown) => {
          logger.error("failed to flush lark run card", {
            runId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, DELIVERY_INTERVAL_MS),
    );
  };

  return {
    start() {
      if (unsubscribe != null) {
        logger.debug("lark outbound runtime start skipped because it is already running");
        return;
      }

      unsubscribe = input.outboundEventBus.subscribe((envelope) => {
        if (envelope.kind !== "runtime_event") {
          return;
        }
        if (!shouldHandleLarkRuntimeEvent(envelope)) {
          return;
        }
        const runId = envelope.run.runId;
        if (runId == null) {
          return;
        }

        const next = reduceLarkRunState(runStates.get(runId) ?? null, envelope);
        runStates.set(runId, next);
        runVersions.set(runId, (runVersions.get(runId) ?? 0) + 1);
        logger.debug("accepted lark outbound runtime event", {
          runId,
          eventType: envelope.event.type,
          turn: "turn" in envelope.event ? envelope.event.turn : null,
          activeAssistantMessageId: next.activeAssistantMessageId,
          activeToolSequenceBlockId: next.activeToolSequenceBlockId,
          blockCount: next.blocks.length,
          footerStatus: next.footerStatus,
          terminal: next.terminal,
        });
        scheduleFlush(runId);
      });

      logger.info("lark outbound runtime started");
    },

    async shutdown() {
      unsubscribe?.();
      unsubscribe = null;
      for (const timer of scheduled.values()) {
        clearTimeout(timer);
      }
      scheduled.clear();
      deliverySnapshots.clear();
      runVersions.clear();
      flushing.clear();
      runStates.clear();
      logger.info("lark outbound runtime shutdown complete");
    },

    status() {
      return {
        started: unsubscribe != null,
        subscribed: unsubscribe != null,
        activeRuns: runStates.size,
      };
    },
  };
}

function parseSurfaceObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed != null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {}

  return {};
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateLogText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function getCardkitSdk(client: LarkSdkClient): {
  card: {
    create(input: {
      data: {
        type: "card_json";
        data: string;
      };
    }): Promise<LarkCardCreateResponse>;
    update(input: LarkCardUpdateInput): Promise<unknown>;
  };
  cardElement: {
    content(input: LarkCardElementContentInput): Promise<unknown>;
  };
} {
  const sdk = client.sdk as unknown as {
    cardkit?: {
      v1?: {
        card?: {
          create?: (input: {
            data: {
              type: "card_json";
              data: string;
            };
          }) => Promise<LarkCardCreateResponse>;
          update?: (input: LarkCardUpdateInput) => Promise<unknown>;
        };
        cardElement?: {
          content?: (input: LarkCardElementContentInput) => Promise<unknown>;
        };
      };
    };
  };

  const create = sdk.cardkit?.v1?.card?.create;
  const update = sdk.cardkit?.v1?.card?.update;
  const content = sdk.cardkit?.v1?.cardElement?.content;
  if (create == null || update == null || content == null) {
    throw new Error("Lark CardKit SDK is not available on the configured client");
  }

  return {
    card: {
      create,
      update,
    },
    cardElement: {
      content,
    },
  };
}
