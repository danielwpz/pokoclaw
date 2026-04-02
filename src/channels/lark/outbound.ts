/**
 * Lark outbound adapter.
 *
 * Consumes orchestrated runtime events, reduces them into lark-specific run and
 * approval states, and flushes CardKit create/update/stream operations with
 * throttling, sequencing, and durable lark object bindings.
 */
import { randomUUID } from "node:crypto";
import {
  createLarkApprovalStateFromRequest,
  type LarkApprovalState,
  reduceLarkApprovalState,
  shouldHandleLarkApprovalRuntimeEvent,
} from "@/src/channels/lark/approval-state.js";
import type { LarkSdkClient } from "@/src/channels/lark/client.js";
import {
  buildLarkRenderedApprovalCard,
  buildLarkRenderedRunCard,
  buildLarkRenderedSubagentCreationRequestCard,
  type LarkSubagentCreationRequestCardState,
} from "@/src/channels/lark/render.js";
import {
  type LarkRunState,
  markLarkRunApprovalResolved,
  markLarkRunAwaitingApproval,
  reduceLarkRunState,
  shouldHandleLarkRuntimeEvent,
  shouldHandleLarkTaskRunEvent,
} from "@/src/channels/lark/run-state.js";
import type {
  OrchestratedOutboundEventEnvelope,
  OrchestratedRuntimeEventEnvelope,
} from "@/src/orchestration/outbound-events.js";
import type { RuntimeEventBus } from "@/src/runtime/event-bus.js";
import { parsePermissionRequestJson } from "@/src/security/scope.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { ApprovalsRepo } from "@/src/storage/repos/approvals.repo.js";
import { ChannelSurfacesRepo } from "@/src/storage/repos/channel-surfaces.repo.js";
import { LarkObjectBindingsRepo } from "@/src/storage/repos/lark-object-bindings.repo.js";

const logger = createSubsystemLogger("channels/lark-outbound");
const LARK_CHANNEL_TYPE = "lark";
const DELIVERY_INTERVAL_MS = 200;
const RUN_CARD_OBJECT_KIND = "run_card";
const APPROVAL_CARD_OBJECT_KIND = "approval_card";
const SUBAGENT_REQUEST_CARD_OBJECT_KIND = "subagent_creation_request_card";
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
  const approvalStates = new Map<string, LarkApprovalState>();
  const activeRunSegmentByRunId = new Map<string, string>();
  const latestRunSegmentByRunId = new Map<string, string>();
  const nextRunSegmentIndexByRunId = new Map<string, number>();
  const latestApprovalByRunId = new Map<string, string>();
  const subagentRequestStates = new Map<
    string,
    {
      conversationId: string;
      branchId: string;
      state: LarkSubagentCreationRequestCardState;
    }
  >();
  const scheduled = new Map<string, NodeJS.Timeout>();
  const deliverySnapshots = new Map<string, LarkRunDeliverySnapshot>();
  const deliveryVersions = new Map<string, number>();
  const flushing = new Set<string>();
  const urgentFlushes = new Set<string>();
  let unsubscribe: (() => void) | null = null;

  const scheduleFlush = (deliveryId: string, options?: { immediate?: boolean }) => {
    if (options?.immediate === true) {
      urgentFlushes.add(deliveryId);
      const existing = scheduled.get(deliveryId);
      if (existing != null) {
        clearTimeout(existing);
        scheduled.delete(deliveryId);
      }
      void flushDelivery(deliveryId).catch((error: unknown) => {
        logger.error("failed to flush lark delivery object", {
          deliveryId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }
    if (scheduled.has(deliveryId)) {
      return;
    }
    scheduled.set(
      deliveryId,
      setTimeout(() => {
        void flushDelivery(deliveryId).catch((error: unknown) => {
          logger.error("failed to flush lark delivery object", {
            deliveryId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, DELIVERY_INTERVAL_MS),
    );
  };

  const bumpVersionAndSchedule = (deliveryId: string, options?: { immediate?: boolean }) => {
    deliveryVersions.set(deliveryId, (deliveryVersions.get(deliveryId) ?? 0) + 1);
    scheduleFlush(deliveryId, options);
  };

  const flushDelivery = async (deliveryId: string) => {
    scheduled.delete(deliveryId);
    if (flushing.has(deliveryId)) {
      return;
    }
    const flushVersion = deliveryVersions.get(deliveryId) ?? 0;
    flushing.add(deliveryId);

    try {
      if (deliveryId.startsWith("run:")) {
        await flushRunCard(deliveryId.slice(4));
      } else if (deliveryId.startsWith("approval:")) {
        await flushApprovalCard(deliveryId.slice("approval:".length));
      } else if (deliveryId.startsWith("subagent:")) {
        await flushSubagentRequestCard(deliveryId.slice("subagent:".length));
      }
    } finally {
      flushing.delete(deliveryId);
      const rescheduleImmediate = urgentFlushes.delete(deliveryId);
      if ((deliveryVersions.get(deliveryId) ?? 0) !== flushVersion) {
        logger.debug("re-scheduling lark outbound flush after newer events arrived", {
          deliveryId,
          completedVersion: flushVersion,
          latestVersion: deliveryVersions.get(deliveryId) ?? 0,
        });
        scheduleFlush(deliveryId, { immediate: rescheduleImmediate });
      }
    }
  };

  const flushRunCard = async (runCardObjectId: string) => {
    const state = runStates.get(runCardObjectId);
    if (state == null) {
      return;
    }

    logger.debug("starting lark run card flush", {
      runId: state.runId,
      runCardObjectId,
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
          runId: state.runId,
          runCardObjectId,
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
        internalObjectId: runCardObjectId,
      });
      const snapshotKey = `${surface.channelInstallationId}:run:${runCardObjectId}`;

      const rendered = buildLarkRenderedRunCard(state);
      const activeAssistantBlockId = rendered.activeAssistant?.elementId ?? null;
      const activeAssistantText = rendered.activeAssistant?.text ?? "";
      const snapshot = deliverySnapshots.get(snapshotKey) ?? null;
      const shouldRenderUpdate =
        snapshot == null || snapshot.structureSignature !== rendered.structureSignature;
      const canStreamDelta =
        existing?.larkCardId != null &&
        activeAssistantBlockId != null &&
        snapshot?.activeAssistantElementId === activeAssistantBlockId &&
        snapshot.activeAssistantText !== activeAssistantText;

      logger.debug("computed lark run card delivery decision", {
        runId: state.runId,
        runCardObjectId,
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
        logger.debug("created lark cardkit card response", {
          runId: state.runId,
          runCardObjectId,
          channelInstallationId: surface.channelInstallationId,
          responsePreview: truncateLogText(safeJson(createResp), LARK_CARD_LOG_PREVIEW_MAX_LENGTH),
        });
        const larkCardId = createResp.data?.card_id ?? createResp.card_id ?? null;
        if (larkCardId == null) {
          logger.warn("lark run card create returned no card id", {
            runId: state.runId,
            runCardObjectId,
            channelInstallationId: surface.channelInstallationId,
            responsePreview: truncateLogText(
              safeJson(createResp),
              LARK_CARD_LOG_PREVIEW_MAX_LENGTH,
            ),
          });
          continue;
        }

        logger.debug("sending lark card reference message", {
          runId: state.runId,
          runCardObjectId,
          channelInstallationId: surface.channelInstallationId,
          chatId,
          larkCardId,
          cardPreview: truncateLogText(
            JSON.stringify(rendered.card),
            LARK_CARD_LOG_PREVIEW_MAX_LENGTH,
          ),
        });
        const response = (await sendLarkInteractiveCardReferenceMessage({
          client,
          chatId,
          surfaceObject,
          larkCardId,
        })) as { data?: { message_id?: string; open_message_id?: string } };
        const larkMessageId = response.data?.message_id ?? null;
        if (larkMessageId == null) {
          logger.warn("lark run card create returned no message id", {
            runId: state.runId,
            runCardObjectId,
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
          internalObjectId: runCardObjectId,
          larkMessageId,
          larkOpenMessageId: response.data?.open_message_id ?? null,
          larkCardId,
          threadRootMessageId: readStringValue(surfaceObject.thread_id),
          cardElementId: activeAssistantBlockId,
          lastSequence: 0,
          status: state.terminal === "running" ? "active" : "finalized",
          metadataJson: JSON.stringify({
            activeAssistantBlockId,
            runId: state.runId,
            sessionId: state.sessionId,
            taskRunId: state.taskRunId,
            taskRunType: state.taskRunType,
          }),
        });

        deliverySnapshots.set(snapshotKey, {
          structureSignature: rendered.structureSignature,
          activeAssistantElementId: activeAssistantBlockId,
          activeAssistantText,
        });

        logger.info("created lark run card", {
          runId: state.runId,
          runCardObjectId,
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
          internalObjectId: runCardObjectId,
          lastSequence: sequence,
          metadataJson: JSON.stringify({
            activeAssistantBlockId,
            runId: state.runId,
            sessionId: state.sessionId,
            taskRunId: state.taskRunId,
            taskRunType: state.taskRunType,
          }),
        });
        deliverySnapshots.set(snapshotKey, {
          structureSignature: snapshot?.structureSignature ?? rendered.structureSignature,
          activeAssistantElementId: activeAssistantBlockId,
          activeAssistantText,
        });
        logger.debug("streamed lark run card content", {
          runId: state.runId,
          runCardObjectId,
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
        internalObjectId: runCardObjectId,
        lastSequence: sequence,
        status: state.terminal === "running" ? "active" : "finalized",
        metadataJson: JSON.stringify({
          activeAssistantBlockId,
          runId: state.runId,
          sessionId: state.sessionId,
          taskRunId: state.taskRunId,
          taskRunType: state.taskRunType,
        }),
      });
      deliverySnapshots.set(snapshotKey, {
        structureSignature: rendered.structureSignature,
        activeAssistantElementId: activeAssistantBlockId,
        activeAssistantText,
      });
      logger.debug("updated lark run card", {
        runId: state.runId,
        runCardObjectId,
        channelInstallationId: surface.channelInstallationId,
        larkCardId: existing.larkCardId,
        sequence,
      });
    }
  };

  const flushApprovalCard = async (approvalId: string) => {
    const state = approvalStates.get(approvalId);
    if (state == null) {
      return;
    }
    if (!shouldCreateStandaloneLarkApprovalCard(state)) {
      logger.debug("skipping standalone lark approval card delivery for delegated approval", {
        approvalId,
        runId: state.runId,
        approvalTarget: state.approvalTarget,
      });
      return;
    }

    logger.debug("starting lark approval card flush", {
      approvalId,
      runId: state.runId,
      resolved: state.resolved,
      decision: state.decision,
      sourceRunCardObjectId: state.sourceRunCardObjectId,
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
        continue;
      }

      const client = input.clients.getOrCreate(surface.channelInstallationId);
      const cardkit = getCardkitSdk(client);
      const bindingsRepo = new LarkObjectBindingsRepo(input.storage);
      const existing = bindingsRepo.getByInternalObject({
        channelInstallationId: surface.channelInstallationId,
        internalObjectKind: APPROVAL_CARD_OBJECT_KIND,
        internalObjectId: approvalId,
      });
      const rendered = buildLarkRenderedApprovalCard(state);

      if (existing?.larkCardId == null) {
        const createResp = await cardkit.card.create({
          data: {
            type: "card_json",
            data: JSON.stringify(rendered.card),
          },
        });
        logger.debug("created lark approval cardkit response", {
          approvalId,
          runId: state.runId,
          channelInstallationId: surface.channelInstallationId,
          responsePreview: truncateLogText(safeJson(createResp), LARK_CARD_LOG_PREVIEW_MAX_LENGTH),
        });
        const larkCardId = createResp.data?.card_id ?? createResp.card_id ?? null;
        if (larkCardId == null) {
          continue;
        }

        const response = (await sendLarkInteractiveCardReferenceMessage({
          client,
          chatId,
          surfaceObject,
          larkCardId,
        })) as { data?: { message_id?: string; open_message_id?: string } };
        const larkMessageId = response.data?.message_id ?? null;
        if (larkMessageId == null) {
          continue;
        }

        bindingsRepo.upsert({
          id: randomUUID(),
          channelInstallationId: surface.channelInstallationId,
          conversationId: state.conversationId,
          branchId: state.branchId,
          internalObjectKind: APPROVAL_CARD_OBJECT_KIND,
          internalObjectId: approvalId,
          larkMessageId,
          larkOpenMessageId: response.data?.open_message_id ?? null,
          larkCardId,
          lastSequence: 0,
          status: state.resolved ? "finalized" : "active",
          metadataJson: JSON.stringify({
            approvalId,
            runId: state.runId,
          }),
        });

        logger.info("created standalone lark approval card", {
          approvalId,
          runId: state.runId,
          channelInstallationId: surface.channelInstallationId,
          larkMessageId,
          larkCardId,
        });
        continue;
      }

      if (existing.larkCardId == null) {
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
        internalObjectKind: APPROVAL_CARD_OBJECT_KIND,
        internalObjectId: approvalId,
        lastSequence: sequence,
        status: state.resolved ? "finalized" : "active",
        metadataJson: JSON.stringify({
          approvalId,
          runId: state.runId,
        }),
      });
      logger.debug("updated standalone lark approval card", {
        approvalId,
        runId: state.runId,
        channelInstallationId: surface.channelInstallationId,
        larkCardId: existing.larkCardId,
        sequence,
      });
    }
  };

  const flushSubagentRequestCard = async (requestId: string) => {
    const entry = subagentRequestStates.get(requestId);
    if (entry == null) {
      return;
    }

    const surfaces = new ChannelSurfacesRepo(input.storage).listByConversationBranch({
      channelType: LARK_CHANNEL_TYPE,
      conversationId: entry.conversationId,
      branchId: entry.branchId,
    });

    for (const surface of surfaces) {
      const surfaceObject = parseSurfaceObject(surface.surfaceObjectJson);
      const chatId = typeof surfaceObject.chat_id === "string" ? surfaceObject.chat_id : null;
      if (chatId == null || chatId.length === 0) {
        continue;
      }

      const client = input.clients.getOrCreate(surface.channelInstallationId);
      const cardkit = getCardkitSdk(client);
      const bindingsRepo = new LarkObjectBindingsRepo(input.storage);
      const existing = bindingsRepo.getByInternalObject({
        channelInstallationId: surface.channelInstallationId,
        internalObjectKind: SUBAGENT_REQUEST_CARD_OBJECT_KIND,
        internalObjectId: requestId,
      });
      const rendered = buildLarkRenderedSubagentCreationRequestCard(entry.state);

      if (existing?.larkCardId == null) {
        const createResp = await cardkit.card.create({
          data: {
            type: "card_json",
            data: JSON.stringify(rendered.card),
          },
        });
        const larkCardId = createResp.data?.card_id ?? createResp.card_id ?? null;
        if (larkCardId == null) {
          continue;
        }

        const response = (await sendLarkInteractiveCardReferenceMessage({
          client,
          chatId,
          surfaceObject,
          larkCardId,
        })) as { data?: { message_id?: string; open_message_id?: string } };
        const larkMessageId = response.data?.message_id ?? null;
        if (larkMessageId == null) {
          continue;
        }

        bindingsRepo.upsert({
          id: randomUUID(),
          channelInstallationId: surface.channelInstallationId,
          conversationId: entry.conversationId,
          branchId: entry.branchId,
          internalObjectKind: SUBAGENT_REQUEST_CARD_OBJECT_KIND,
          internalObjectId: requestId,
          larkMessageId,
          larkOpenMessageId: response.data?.open_message_id ?? null,
          larkCardId,
          lastSequence: 0,
          status: entry.state.status === "pending" ? "active" : "finalized",
          metadataJson: JSON.stringify({
            requestId,
            status: entry.state.status,
          }),
        });
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
        internalObjectKind: SUBAGENT_REQUEST_CARD_OBJECT_KIND,
        internalObjectId: requestId,
        lastSequence: sequence,
        status: entry.state.status === "pending" ? "active" : "finalized",
        metadataJson: JSON.stringify({
          requestId,
          status: entry.state.status,
        }),
      });
    }
  };

  const allocateRunSegmentObjectId = (runId: string): string => {
    const nextIndex = (nextRunSegmentIndexByRunId.get(runId) ?? 0) + 1;
    nextRunSegmentIndexByRunId.set(runId, nextIndex);
    const runCardObjectId = `${runId}:seg:${nextIndex}`;
    activeRunSegmentByRunId.set(runId, runCardObjectId);
    latestRunSegmentByRunId.set(runId, runCardObjectId);
    logger.debug("opened lark run card segment", {
      runId,
      runCardObjectId,
      segmentIndex: nextIndex,
    });
    return runCardObjectId;
  };

  const handleApprovalEvent = (envelope: OrchestratedRuntimeEventEnvelope) => {
    if (!shouldHandleLarkApprovalRuntimeEvent(envelope)) {
      return;
    }
    const event = envelope.event;
    if (event.type !== "approval_requested" && event.type !== "approval_resolved") {
      return;
    }
    const approvalId = event.approvalId;
    const runId = envelope.run.runId;
    if (runId == null) {
      return;
    }

    if (event.type === "approval_requested") {
      const taskRunCardObjectId =
        isTaskRunCardRuntimeEnvelope(envelope) && envelope.taskRun.taskRunId != null
          ? buildTaskRunCardObjectId(envelope.taskRun.taskRunId)
          : null;
      const sourceRunCardObjectId =
        taskRunCardObjectId ??
        activeRunSegmentByRunId.get(runId) ??
        latestRunSegmentByRunId.get(runId) ??
        null;

      if (sourceRunCardObjectId != null) {
        const existingRunState = runStates.get(sourceRunCardObjectId);
        if (existingRunState != null) {
          runStates.set(sourceRunCardObjectId, markLarkRunAwaitingApproval(existingRunState));
          activeRunSegmentByRunId.delete(runId);
          latestRunSegmentByRunId.set(runId, sourceRunCardObjectId);
          logger.debug("finalized lark run card segment awaiting approval", {
            runId,
            approvalId,
            sourceRunCardObjectId,
          });
          bumpVersionAndSchedule(`run:${sourceRunCardObjectId}`);
        }
      }

      approvalStates.set(
        approvalId,
        createLarkApprovalStateFromRequest({
          event,
          sourceRunCardObjectId,
          requestedBashPrefixes: loadRequestedBashPrefixes(input.storage, approvalId),
        }),
      );
      latestApprovalByRunId.set(runId, approvalId);
      if (shouldCreateStandaloneLarkApprovalCard(event)) {
        logger.debug("queued standalone lark approval card", {
          runId,
          approvalId,
          sourceRunCardObjectId,
          approvalTarget: event.approvalTarget,
        });
        bumpVersionAndSchedule(`approval:${approvalId}`);
      } else {
        logger.debug("suppressed standalone lark approval card for delegated approval", {
          runId,
          approvalId,
          sourceRunCardObjectId,
          approvalTarget: event.approvalTarget,
        });
      }
      return;
    }

    const previousApprovalState = approvalStates.get(approvalId) ?? null;
    const nextApprovalState = reduceLarkApprovalState(previousApprovalState, envelope);
    if (nextApprovalState == null) {
      return;
    }
    approvalStates.set(approvalId, nextApprovalState);
    latestApprovalByRunId.delete(runId);
    if (shouldCreateStandaloneLarkApprovalCard(nextApprovalState)) {
      bumpVersionAndSchedule(`approval:${approvalId}`);
    }

    if (previousApprovalState?.sourceRunCardObjectId != null) {
      const sourceRunState = runStates.get(previousApprovalState.sourceRunCardObjectId);
      if (sourceRunState != null) {
        runStates.set(
          previousApprovalState.sourceRunCardObjectId,
          markLarkRunApprovalResolved(sourceRunState, event.decision),
        );
        logger.debug("updated prior lark run card segment after approval resolution", {
          runId,
          approvalId,
          sourceRunCardObjectId: previousApprovalState.sourceRunCardObjectId,
          decision: event.decision,
        });
        bumpVersionAndSchedule(`run:${previousApprovalState.sourceRunCardObjectId}`);
      }
    }
  };

  return {
    start() {
      if (unsubscribe != null) {
        logger.debug("lark outbound runtime start skipped because it is already running");
        return;
      }

      unsubscribe = input.outboundEventBus.subscribe((envelope) => {
        if (envelope.kind === "subagent_creation_event") {
          const event = envelope.event;
          const nextState: LarkSubagentCreationRequestCardState =
            event.type === "subagent_creation_requested"
              ? {
                  requestId: event.requestId,
                  title: event.title,
                  description: event.description,
                  workdir: event.workdir,
                  expiresAt: event.expiresAt,
                  status: "pending",
                  failureReason: null,
                  externalChatId: null,
                  shareLink: null,
                }
              : {
                  requestId: event.requestId,
                  title: event.title,
                  description: "",
                  workdir: "",
                  expiresAt: null,
                  status: event.status,
                  failureReason: event.failureReason,
                  externalChatId: event.externalChatId,
                  shareLink: event.shareLink,
                };
          const previous = subagentRequestStates.get(event.requestId);
          subagentRequestStates.set(event.requestId, {
            conversationId: envelope.target.conversationId,
            branchId: envelope.target.branchId,
            state:
              previous == null
                ? nextState
                : {
                    ...previous.state,
                    ...nextState,
                    description:
                      nextState.description.length > 0
                        ? nextState.description
                        : previous.state.description,
                    workdir:
                      nextState.workdir.length > 0 ? nextState.workdir : previous.state.workdir,
                    expiresAt: nextState.expiresAt ?? previous.state.expiresAt,
                  },
          });
          bumpVersionAndSchedule(`subagent:${event.requestId}`);
          return;
        }

        if (envelope.kind === "task_run_event") {
          if (!shouldHandleLarkTaskRunEvent(envelope)) {
            return;
          }
          const runCardObjectId = buildTaskRunCardObjectId(envelope.event.taskRunId);
          const next = reduceLarkRunState(runStates.get(runCardObjectId) ?? null, envelope);
          runStates.set(runCardObjectId, next);
          logger.debug("accepted lark task run lifecycle event", {
            taskRunId: envelope.event.taskRunId,
            runCardObjectId,
            eventType: envelope.event.type,
            terminal: next.terminal,
          });
          bumpVersionAndSchedule(`run:${runCardObjectId}`, {
            immediate: isTaskLifecycleTerminalEvent(envelope),
          });
          return;
        }

        if (envelope.kind !== "runtime_event") {
          return;
        }

        if (!shouldDeliverLarkRuntimeTranscript(envelope)) {
          logger.debug("ignoring non-deliverable runtime transcript for lark", {
            runId: envelope.run.runId,
            sessionId: envelope.session.sessionId,
            sessionPurpose: envelope.session.purpose,
            eventType: envelope.event.type,
          });
          return;
        }

        if (shouldHandleLarkApprovalRuntimeEvent(envelope)) {
          handleApprovalEvent(envelope);
          return;
        }

        if (!shouldHandleLarkRuntimeEvent(envelope)) {
          return;
        }

        const runId = envelope.run.runId;
        if (runId == null) {
          return;
        }

        if (
          shouldIgnorePostApprovalPermissionToolResolution(envelope, runId, {
            activeRunSegmentByRunId,
            latestRunSegmentByRunId,
            runStates,
          })
        ) {
          const event = envelope.event;
          const toolCallId =
            event.type === "tool_call_completed" || event.type === "tool_call_failed"
              ? event.toolCallId
              : null;
          const toolName =
            event.type === "tool_call_completed" || event.type === "tool_call_failed"
              ? event.toolName
              : null;
          logger.debug(
            "ignoring post-approval request_permissions resolution for lark transcript",
            {
              runId,
              eventType: event.type,
              toolName,
              toolCallId,
            },
          );
          return;
        }

        if (isTaskRunCardRuntimeEnvelope(envelope)) {
          if (isTaskRuntimeTerminalEvent(envelope)) {
            logger.debug(
              "ignoring task runtime terminal event because task lifecycle owns final state",
              {
                runId,
                taskRunId: envelope.taskRun.taskRunId,
                eventType: envelope.event.type,
              },
            );
            return;
          }

          const taskRunId = envelope.taskRun.taskRunId;
          if (taskRunId == null) {
            return;
          }
          const runCardObjectId = buildTaskRunCardObjectId(taskRunId);
          const next = reduceLarkRunState(runStates.get(runCardObjectId) ?? null, envelope);
          runStates.set(runCardObjectId, next);

          logger.debug("accepted lark task transcript runtime event", {
            runId,
            taskRunId,
            runCardObjectId,
            eventType: envelope.event.type,
            turn: "turn" in envelope.event ? envelope.event.turn : null,
            activeAssistantMessageId: next.activeAssistantMessageId,
            activeToolSequenceBlockId: next.activeToolSequenceBlockId,
            blockCount: next.blocks.length,
            footerStatus: next.footerStatus,
            terminal: next.terminal,
          });
          bumpVersionAndSchedule(`run:${runCardObjectId}`, {
            immediate: isTaskRuntimeTerminalEvent(envelope),
          });
          return;
        }

        const pendingApprovalId = latestApprovalByRunId.get(runId);
        if (pendingApprovalId != null) {
          const pendingApproval = approvalStates.get(pendingApprovalId);
          if (pendingApproval != null && !pendingApproval.resolved) {
            const terminalEvent =
              envelope.event.type === "run_completed" ||
              envelope.event.type === "run_cancelled" ||
              envelope.event.type === "run_failed";
            if (!terminalEvent) {
              logger.debug("ignoring lark run card event while approval is unresolved", {
                runId,
                approvalId: pendingApprovalId,
                eventType: envelope.event.type,
              });
              return;
            }
          }
        }

        let runCardObjectId = activeRunSegmentByRunId.get(runId) ?? null;
        if (runCardObjectId == null) {
          runCardObjectId = findResolvedApprovalToolRunCardObjectId(envelope, runId, {
            latestRunSegmentByRunId,
            runStates,
          });
        }
        if (runCardObjectId == null) {
          const terminalEvent =
            envelope.event.type === "run_completed" ||
            envelope.event.type === "run_cancelled" ||
            envelope.event.type === "run_failed";
          if (terminalEvent) {
            runCardObjectId = latestRunSegmentByRunId.get(runId) ?? null;
            if (runCardObjectId == null) {
              return;
            }
          } else if (shouldCreateRunSegmentForEvent(envelope)) {
            runCardObjectId = allocateRunSegmentObjectId(runId);
          } else {
            logger.debug("deferring lark run card creation until visible content arrives", {
              runId,
              eventType: envelope.event.type,
              turn: "turn" in envelope.event ? envelope.event.turn : null,
            });
            return;
          }
        }

        const next = reduceLarkRunState(runStates.get(runCardObjectId) ?? null, envelope);
        runStates.set(runCardObjectId, next);
        latestRunSegmentByRunId.set(runId, runCardObjectId);
        if (next.terminal === "running") {
          activeRunSegmentByRunId.set(runId, runCardObjectId);
        } else if (activeRunSegmentByRunId.get(runId) === runCardObjectId) {
          activeRunSegmentByRunId.delete(runId);
        }

        logger.debug("accepted lark run card runtime event", {
          runId,
          runCardObjectId,
          eventType: envelope.event.type,
          turn: "turn" in envelope.event ? envelope.event.turn : null,
          activeAssistantMessageId: next.activeAssistantMessageId,
          activeToolSequenceBlockId: next.activeToolSequenceBlockId,
          blockCount: next.blocks.length,
          footerStatus: next.footerStatus,
          terminal: next.terminal,
        });
        bumpVersionAndSchedule(`run:${runCardObjectId}`, {
          immediate: isRunTerminalEvent(envelope),
        });
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
      deliveryVersions.clear();
      flushing.clear();
      runStates.clear();
      approvalStates.clear();
      activeRunSegmentByRunId.clear();
      latestRunSegmentByRunId.clear();
      nextRunSegmentIndexByRunId.clear();
      latestApprovalByRunId.clear();
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

async function sendLarkInteractiveCardReferenceMessage(input: {
  client: LarkSdkClient;
  chatId: string;
  surfaceObject: Record<string, unknown>;
  larkCardId: string;
}): Promise<unknown> {
  const threadReplyMessageId = readStringValue(input.surfaceObject.reply_to_message_id);
  const content = JSON.stringify({
    type: "card",
    data: {
      card_id: input.larkCardId,
    },
  });

  if (threadReplyMessageId != null) {
    return input.client.sdk.im.message.reply({
      path: { message_id: threadReplyMessageId },
      data: {
        msg_type: "interactive",
        content,
        reply_in_thread: true,
      },
    });
  }

  return input.client.sdk.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: input.chatId,
      msg_type: "interactive",
      content,
    },
  });
}

function readStringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function buildTaskRunCardObjectId(taskRunId: string): string {
  return `task:${taskRunId}`;
}

function isTaskRunCardRuntimeEnvelope(envelope: OrchestratedRuntimeEventEnvelope): boolean {
  return (
    envelope.session.sessionId != null &&
    envelope.session.purpose === "task" &&
    envelope.taskRun.taskRunId != null
  );
}

function isTaskRuntimeTerminalEvent(envelope: OrchestratedRuntimeEventEnvelope): boolean {
  return (
    envelope.event.type === "run_completed" ||
    envelope.event.type === "run_failed" ||
    envelope.event.type === "run_cancelled"
  );
}

function isRunTerminalEvent(envelope: OrchestratedRuntimeEventEnvelope): boolean {
  return (
    envelope.event.type === "run_completed" ||
    envelope.event.type === "run_failed" ||
    envelope.event.type === "run_cancelled"
  );
}

function isTaskLifecycleTerminalEvent(envelope: OrchestratedOutboundEventEnvelope): boolean {
  return (
    envelope.kind === "task_run_event" &&
    (envelope.event.type === "task_run_completed" ||
      envelope.event.type === "task_run_failed" ||
      envelope.event.type === "task_run_cancelled")
  );
}

function shouldDeliverLarkRuntimeTranscript(envelope: OrchestratedRuntimeEventEnvelope): boolean {
  return envelope.session.purpose === "chat" || envelope.session.purpose === "task";
}

function shouldCreateStandaloneLarkApprovalCard(value: {
  approvalTarget: "user" | "main_agent";
}): boolean {
  return value.approvalTarget === "user";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function shouldCreateRunSegmentForEvent(envelope: OrchestratedRuntimeEventEnvelope): boolean {
  switch (envelope.event.type) {
    case "assistant_message_started":
    case "assistant_message_delta":
    case "assistant_message_completed":
    case "tool_call_started":
    case "tool_call_completed":
    case "tool_call_failed":
    case "run_failed":
    case "run_cancelled":
      return true;
    default:
      return false;
  }
}

function shouldIgnorePostApprovalPermissionToolResolution(
  envelope: OrchestratedRuntimeEventEnvelope,
  runId: string,
  state: {
    activeRunSegmentByRunId: Map<string, string>;
    latestRunSegmentByRunId: Map<string, string>;
    runStates: Map<string, LarkRunState>;
  },
): boolean {
  const isPermissionResolutionEvent =
    (envelope.event.type === "tool_call_completed" || envelope.event.type === "tool_call_failed") &&
    envelope.event.toolName === "request_permissions";
  if (!isPermissionResolutionEvent) {
    return false;
  }

  if (state.activeRunSegmentByRunId.get(runId) != null) {
    return false;
  }

  const latestRunCardObjectId = state.latestRunSegmentByRunId.get(runId);
  if (latestRunCardObjectId == null) {
    return false;
  }

  const latestRunState = state.runStates.get(latestRunCardObjectId);
  return latestRunState?.terminal === "continued" || latestRunState?.terminal === "denied";
}

function findResolvedApprovalToolRunCardObjectId(
  envelope: OrchestratedRuntimeEventEnvelope,
  runId: string,
  state: {
    latestRunSegmentByRunId: Map<string, string>;
    runStates: Map<string, LarkRunState>;
  },
): string | null {
  if (envelope.event.type !== "tool_call_completed" && envelope.event.type !== "tool_call_failed") {
    return null;
  }
  const toolCallId = envelope.event.toolCallId;

  const latestRunCardObjectId = state.latestRunSegmentByRunId.get(runId);
  if (latestRunCardObjectId == null) {
    return null;
  }

  const latestRunState = state.runStates.get(latestRunCardObjectId);
  if (latestRunState == null) {
    return null;
  }
  if (latestRunState.terminal !== "continued" && latestRunState.terminal !== "denied") {
    return null;
  }

  return latestRunState.blocks.some(
    (block) =>
      block.kind === "tool_sequence" &&
      block.tools.some((tool) => tool.toolCallId === toolCallId && tool.status === "running"),
  )
    ? latestRunCardObjectId
    : null;
}

function loadRequestedBashPrefixes(storage: StorageDb, approvalId: string): string[][] {
  const numericApprovalId = Number.parseInt(approvalId, 10);
  if (!Number.isFinite(numericApprovalId)) {
    return [];
  }

  const approval = new ApprovalsRepo(storage).getById(numericApprovalId);
  if (approval == null) {
    return [];
  }

  try {
    return parsePermissionRequestJson(approval.requestedScopeJson).scopes.flatMap((scope) =>
      scope.kind === "bash.full_access" ? [scope.prefix] : [],
    );
  } catch (error: unknown) {
    logger.warn("failed to parse requested approval scopes for lark approval card", {
      approvalId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
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
