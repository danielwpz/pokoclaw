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
  addLarkMessageReaction,
  removeLarkMessageReaction,
} from "@/src/channels/lark/reactions.js";
import {
  buildLarkRenderedApprovalCard,
  buildLarkRenderedRunCardPages,
  buildLarkRenderedSubagentCreationRequestCard,
  buildLarkRenderedTaskCard,
  describeTaskRunKind,
  describeTaskRunTerminal,
  getLarkTaskTerminalMessagePresentation,
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
import type { LarkSteerReactionState } from "@/src/channels/lark/steer-reaction-state.js";
import type {
  OrchestratedOutboundEventEnvelope,
  OrchestratedRuntimeEventEnvelope,
} from "@/src/orchestration/outbound-events.js";
import type { RuntimeEventBus } from "@/src/runtime/event-bus.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { ChannelSurfacesRepo } from "@/src/storage/repos/channel-surfaces.repo.js";
import { ChannelThreadsRepo } from "@/src/storage/repos/channel-threads.repo.js";
import { CronJobsRepo } from "@/src/storage/repos/cron-jobs.repo.js";
import { LarkObjectBindingsRepo } from "@/src/storage/repos/lark-object-bindings.repo.js";
import { TaskRunsRepo } from "@/src/storage/repos/task-runs.repo.js";
import type { LarkObjectBinding } from "@/src/storage/schema/types.js";

const logger = createSubsystemLogger("channels/lark-outbound");
const LARK_CHANNEL_TYPE = "lark";
const DELIVERY_INTERVAL_MS = 200;
const RUN_CARD_OBJECT_KIND = "run_card";
const APPROVAL_CARD_OBJECT_KIND = "approval_card";
const SUBAGENT_REQUEST_CARD_OBJECT_KIND = "subagent_creation_request_card";
const LARK_CARD_LOG_PREVIEW_MAX_LENGTH = 600;
const TASK_STATUS_DELIVERY_PREFIX = "task_status:";
const STEER_CONFIRMED_REACTION_EMOJI = "OK";

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

interface LarkInteractiveMessageResponse {
  data?: {
    message_id?: string;
    open_message_id?: string;
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
  steerReactionState?: LarkSteerReactionState;
}

export function createLarkOutboundRuntime(
  input: CreateLarkOutboundRuntimeInput,
): LarkOutboundRuntime {
  const runStates = new Map<string, LarkRunState>();
  const taskStates = new Map<string, LarkRunState>();
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
      } else if (deliveryId.startsWith(TASK_STATUS_DELIVERY_PREFIX)) {
        await flushTaskCard(deliveryId.slice(TASK_STATUS_DELIVERY_PREFIX.length));
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

  const ensureInteractiveCardReferenceBinding = async (bindingInput: {
    bindingsRepo: LarkObjectBindingsRepo;
    client: LarkSdkClient;
    cardkit: ReturnType<typeof getCardkitSdk>;
    channelInstallationId: string;
    conversationId: string;
    branchId: string;
    internalObjectKind: string;
    internalObjectId: string;
    chatId: string;
    surfaceObject: Record<string, unknown>;
    cardJson: string;
    cardElementId?: string | null;
    lastSequence?: number | null;
    status: "active" | "finalized" | "stale";
    metadataJson: string;
    logContext: Record<string, unknown>;
  }): Promise<LarkObjectBinding | null> => {
    const threadRootMessageId = readStringValue(bindingInput.surfaceObject.thread_id);
    let binding = bindingInput.bindingsRepo.reserveBinding({
      id: randomUUID(),
      channelInstallationId: bindingInput.channelInstallationId,
      conversationId: bindingInput.conversationId,
      branchId: bindingInput.branchId,
      internalObjectKind: bindingInput.internalObjectKind,
      internalObjectId: bindingInput.internalObjectId,
      larkMessageUuid: randomUUID(),
      threadRootMessageId,
      cardElementId: bindingInput.cardElementId,
      lastSequence: bindingInput.lastSequence,
      status: bindingInput.status,
      metadataJson: bindingInput.metadataJson,
    });

    if (binding.larkMessageUuid == null) {
      throw new Error(
        `Missing lark message uuid for ${bindingInput.internalObjectKind}:${bindingInput.internalObjectId}`,
      );
    }

    if (binding.larkCardId == null) {
      const createResp = await bindingInput.cardkit.card.create({
        data: {
          type: "card_json",
          data: bindingInput.cardJson,
        },
      });
      const larkCardId = createResp.data?.card_id ?? createResp.card_id ?? null;
      logger.debug("created lark cardkit card response", {
        ...bindingInput.logContext,
        channelInstallationId: bindingInput.channelInstallationId,
        responsePreview: truncateLogText(safeJson(createResp), LARK_CARD_LOG_PREVIEW_MAX_LENGTH),
      });
      if (larkCardId == null) {
        logger.warn("lark card create returned no card id", {
          ...bindingInput.logContext,
          channelInstallationId: bindingInput.channelInstallationId,
          responsePreview: truncateLogText(safeJson(createResp), LARK_CARD_LOG_PREVIEW_MAX_LENGTH),
        });
        return null;
      }

      const attachedBinding = bindingInput.bindingsRepo.attachCardAnchor({
        channelInstallationId: bindingInput.channelInstallationId,
        internalObjectKind: bindingInput.internalObjectKind,
        internalObjectId: bindingInput.internalObjectId,
        conversationId: bindingInput.conversationId,
        branchId: bindingInput.branchId,
        larkCardId,
        threadRootMessageId,
        cardElementId: bindingInput.cardElementId,
        lastSequence: bindingInput.lastSequence,
        status: bindingInput.status,
        metadataJson: bindingInput.metadataJson,
      });
      if (attachedBinding == null) {
        return null;
      }
      binding = attachedBinding;
    }

    if (binding.larkMessageId == null) {
      const larkCardId = binding.larkCardId;
      if (larkCardId == null) {
        return null;
      }
      logger.debug("sending lark card reference message", {
        ...bindingInput.logContext,
        channelInstallationId: bindingInput.channelInstallationId,
        chatId: bindingInput.chatId,
        larkCardId,
        larkMessageUuid: binding.larkMessageUuid,
      });
      const response = await sendLarkInteractiveCardReferenceMessage({
        client: bindingInput.client,
        chatId: bindingInput.chatId,
        surfaceObject: bindingInput.surfaceObject,
        larkCardId,
        larkMessageUuid: binding.larkMessageUuid,
      });
      const larkMessageId = response.data?.message_id ?? null;
      if (larkMessageId == null) {
        logger.warn("lark card reference send returned no message id", {
          ...bindingInput.logContext,
          channelInstallationId: bindingInput.channelInstallationId,
          larkCardId: binding.larkCardId,
          larkMessageUuid: binding.larkMessageUuid,
        });
        return null;
      }

      const attachedBinding = bindingInput.bindingsRepo.attachMessageAnchor({
        channelInstallationId: bindingInput.channelInstallationId,
        internalObjectKind: bindingInput.internalObjectKind,
        internalObjectId: bindingInput.internalObjectId,
        conversationId: bindingInput.conversationId,
        branchId: bindingInput.branchId,
        larkMessageId,
        larkOpenMessageId: response.data?.open_message_id ?? null,
        larkCardId: binding.larkCardId,
        threadRootMessageId,
        cardElementId: bindingInput.cardElementId,
        lastSequence: bindingInput.lastSequence,
        status: bindingInput.status,
        metadataJson: bindingInput.metadataJson,
      });
      if (attachedBinding == null) {
        return null;
      }
      binding = attachedBinding;
    }

    return binding;
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

    const deliveryTargets = listLarkDeliveryTargets(input.storage, {
      conversationId: state.conversationId,
      branchId: state.branchId,
      taskRunId: state.taskRunId,
    });

    for (const target of deliveryTargets) {
      const surfaceObject = target.surfaceObject;
      const chatId = typeof surfaceObject.chat_id === "string" ? surfaceObject.chat_id : null;
      if (chatId == null || chatId.length === 0) {
        logger.warn("skipping lark outbound delivery because surface is missing chat_id", {
          runId: state.runId,
          runCardObjectId,
          conversationId: state.conversationId,
          branchId: state.branchId,
          channelInstallationId: target.channelInstallationId,
        });
        continue;
      }

      const client = input.clients.getOrCreate(target.channelInstallationId);
      const cardkit = getCardkitSdk(client);
      const bindingsRepo = new LarkObjectBindingsRepo(input.storage);
      const taskRootBinding =
        state.taskRunId == null
          ? null
          : bindingsRepo.getByInternalObject({
              channelInstallationId: target.channelInstallationId,
              internalObjectKind: RUN_CARD_OBJECT_KIND,
              internalObjectId: buildTaskRunCardObjectId(state.taskRunId),
            });
      if (
        state.taskRunId != null &&
        shouldRenderStandaloneTaskCard(state.taskRunType) &&
        taskRootBinding?.larkMessageId == null
      ) {
        logger.debug("deferring task transcript flush until task status card exists", {
          runId: state.runId,
          runCardObjectId,
          taskRunId: state.taskRunId,
          channelInstallationId: target.channelInstallationId,
        });
        bumpVersionAndSchedule(`${TASK_STATUS_DELIVERY_PREFIX}${state.taskRunId}`, {
          immediate: true,
        });
        bumpVersionAndSchedule(`run:${runCardObjectId}`);
        continue;
      }
      const renderedPages = buildLarkRenderedRunCardPages(state, {
        suppressTaskHeader: state.taskRunId != null,
      });
      const existingBindings = listRunCardPageBindings(
        bindingsRepo,
        target.channelInstallationId,
        runCardObjectId,
      );
      const existingBindingsByObjectId = new Map(
        existingBindings.map((binding) => [binding.internalObjectId, binding]),
      );
      const deliveredPageObjectIds = new Set<string>();

      for (const renderedPage of renderedPages) {
        const pageObjectId = buildRunCardPageObjectId(runCardObjectId, renderedPage.pageIndex);
        deliveredPageObjectIds.add(pageObjectId);
        const existing = existingBindingsByObjectId.get(pageObjectId) ?? null;
        const snapshotKey = `${target.channelInstallationId}:run:${pageObjectId}`;
        const activeAssistantBlockId = renderedPage.activeAssistant?.elementId ?? null;
        const activeAssistantText = renderedPage.activeAssistant?.text ?? "";
        const snapshot = deliverySnapshots.get(snapshotKey) ?? null;
        const shouldRenderUpdate =
          snapshot == null || snapshot.structureSignature !== renderedPage.structureSignature;
        const canStreamDelta =
          existing?.larkCardId != null &&
          activeAssistantBlockId != null &&
          snapshot?.activeAssistantElementId === activeAssistantBlockId &&
          snapshot.activeAssistantText !== activeAssistantText;
        const pageStatus =
          state.terminal === "running" && renderedPage.pageIndex === renderedPage.pageCount
            ? "active"
            : "finalized";
        const metadataJson = JSON.stringify({
          activeAssistantBlockId,
          pageIndex: renderedPage.pageIndex,
          pageCount: renderedPage.pageCount,
          runId: state.runId,
          sessionId: state.sessionId,
          taskRunId: state.taskRunId,
          taskRunType: state.taskRunType,
        });

        logger.debug("computed lark run card delivery decision", {
          runId: state.runId,
          runCardObjectId,
          pageObjectId,
          pageIndex: renderedPage.pageIndex,
          pageCount: renderedPage.pageCount,
          jsonBytes: renderedPage.metrics.jsonBytes,
          taggedNodes: renderedPage.metrics.taggedNodes,
          channelInstallationId: target.channelInstallationId,
          larkCardId: existing?.larkCardId ?? null,
          lastSequence: existing?.lastSequence ?? null,
          structureChanged: shouldRenderUpdate,
          canStreamDelta,
          activeAssistantElementId: activeAssistantBlockId,
          activeAssistantTextPreview: truncateLogText(activeAssistantText, 160),
          previousAssistantElementId: snapshot?.activeAssistantElementId ?? null,
          previousAssistantTextPreview: truncateLogText(snapshot?.activeAssistantText ?? "", 160),
          structureSignaturePreview: truncateLogText(renderedPage.structureSignature, 160),
        });

        if (existing?.larkCardId == null || existing.larkMessageId == null) {
          const binding = await ensureInteractiveCardReferenceBinding({
            bindingsRepo,
            client,
            cardkit,
            channelInstallationId: target.channelInstallationId,
            conversationId: state.conversationId,
            branchId: state.branchId,
            internalObjectKind: RUN_CARD_OBJECT_KIND,
            internalObjectId: pageObjectId,
            chatId,
            surfaceObject:
              state.taskRunId != null &&
              shouldRenderStandaloneTaskCard(state.taskRunType) &&
              taskRootBinding?.larkMessageId != null
                ? {
                    chat_id: chatId,
                    reply_to_message_id: taskRootBinding.larkMessageId,
                  }
                : surfaceObject,
            cardJson: JSON.stringify(renderedPage.card),
            cardElementId: activeAssistantBlockId,
            lastSequence: 0,
            status: pageStatus,
            metadataJson,
            logContext: {
              runId: state.runId,
              runCardObjectId,
              pageObjectId,
              pageIndex: renderedPage.pageIndex,
            },
          });
          if (binding == null) {
            continue;
          }

          existingBindingsByObjectId.set(pageObjectId, binding);
          deliverySnapshots.set(snapshotKey, {
            structureSignature: renderedPage.structureSignature,
            activeAssistantElementId: activeAssistantBlockId,
            activeAssistantText,
          });

          logger.info("created lark run card", {
            runId: state.runId,
            runCardObjectId,
            pageObjectId,
            pageIndex: renderedPage.pageIndex,
            channelInstallationId: target.channelInstallationId,
            larkMessageId: binding.larkMessageId,
            larkCardId: binding.larkCardId,
            larkMessageUuid: binding.larkMessageUuid,
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
            channelInstallationId: target.channelInstallationId,
            internalObjectKind: RUN_CARD_OBJECT_KIND,
            internalObjectId: pageObjectId,
            lastSequence: sequence,
            status: pageStatus,
            metadataJson,
          });
          deliverySnapshots.set(snapshotKey, {
            structureSignature: snapshot?.structureSignature ?? renderedPage.structureSignature,
            activeAssistantElementId: activeAssistantBlockId,
            activeAssistantText,
          });
          logger.debug("streamed lark run card content", {
            runId: state.runId,
            runCardObjectId,
            pageObjectId,
            pageIndex: renderedPage.pageIndex,
            channelInstallationId: target.channelInstallationId,
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
              data: JSON.stringify(renderedPage.card),
            },
            sequence,
          },
        });
        bindingsRepo.updateDeliveryState({
          channelInstallationId: target.channelInstallationId,
          internalObjectKind: RUN_CARD_OBJECT_KIND,
          internalObjectId: pageObjectId,
          lastSequence: sequence,
          status: pageStatus,
          metadataJson,
        });
        deliverySnapshots.set(snapshotKey, {
          structureSignature: renderedPage.structureSignature,
          activeAssistantElementId: activeAssistantBlockId,
          activeAssistantText,
        });
        logger.debug("updated lark run card", {
          runId: state.runId,
          runCardObjectId,
          pageObjectId,
          pageIndex: renderedPage.pageIndex,
          channelInstallationId: target.channelInstallationId,
          larkCardId: existing.larkCardId,
          sequence,
        });
      }

      for (const binding of existingBindings) {
        if (
          deliveredPageObjectIds.has(binding.internalObjectId) ||
          binding.larkCardId == null ||
          binding.status === "stale"
        ) {
          continue;
        }

        const staleCard = buildStaleRunCardCard();
        const sequence = (binding.lastSequence ?? 0) + 1;
        await cardkit.card.update({
          path: { card_id: binding.larkCardId },
          data: {
            card: {
              type: "card_json",
              data: JSON.stringify(staleCard),
            },
            sequence,
          },
        });
        bindingsRepo.updateDeliveryState({
          channelInstallationId: target.channelInstallationId,
          internalObjectKind: RUN_CARD_OBJECT_KIND,
          internalObjectId: binding.internalObjectId,
          lastSequence: sequence,
          status: "stale",
          metadataJson: JSON.stringify({
            pageState: "stale",
            runId: state.runId,
          }),
        });
        deliverySnapshots.set(`${target.channelInstallationId}:run:${binding.internalObjectId}`, {
          structureSignature: JSON.stringify(staleCard),
          activeAssistantElementId: null,
          activeAssistantText: "",
        });
        logger.debug("marked stale lark run card page", {
          runId: state.runId,
          runCardObjectId,
          stalePageObjectId: binding.internalObjectId,
          channelInstallationId: target.channelInstallationId,
          larkCardId: binding.larkCardId,
          sequence,
        });
      }
    }
  };

  const flushTaskCard = async (taskRunId: string) => {
    const state = taskStates.get(taskRunId);
    if (state == null) {
      return;
    }
    if (!shouldRenderStandaloneTaskCard(state.taskRunType)) {
      taskStates.delete(taskRunId);
      return;
    }
    const taskTitle = resolveTaskCardTitle(input.storage, taskRunId);

    const deliveryTargets = listTaskCardDeliveryTargets(input.storage, {
      taskRunId,
      conversationId: state.conversationId,
      branchId: state.branchId,
    });

    for (const target of deliveryTargets) {
      const surfaceObject = target.surfaceObject;
      const chatId = typeof surfaceObject.chat_id === "string" ? surfaceObject.chat_id : null;
      if (chatId == null || chatId.length === 0) {
        continue;
      }

      const client = input.clients.getOrCreate(target.channelInstallationId);
      const cardkit = getCardkitSdk(client);
      const bindingsRepo = new LarkObjectBindingsRepo(input.storage);
      const internalObjectId = buildTaskRunCardObjectId(taskRunId);
      const existing = bindingsRepo.getByInternalObject({
        channelInstallationId: target.channelInstallationId,
        internalObjectKind: RUN_CARD_OBJECT_KIND,
        internalObjectId,
      });
      const existingMetadata = parseBindingMetadata(existing?.metadataJson ?? null);
      const rendered = buildLarkRenderedTaskCard(state, {
        ...(taskTitle == null ? {} : { title: taskTitle }),
      });
      const terminalMessage = getLarkTaskTerminalMessagePresentation(state.terminalMessage);
      const snapshotKey = `${target.channelInstallationId}:${TASK_STATUS_DELIVERY_PREFIX}${taskRunId}`;
      const snapshot = deliverySnapshots.get(snapshotKey) ?? null;
      const shouldRenderUpdate =
        snapshot == null || snapshot.structureSignature !== rendered.structureSignature;
      let metadataJson = JSON.stringify({
        sessionId: state.sessionId,
        taskRunId: state.taskRunId,
        taskRunType: state.taskRunType,
        role: "task_status",
        ...(taskTitle == null ? {} : { taskTitle }),
        ...(readStringValue(existingMetadata.fullTerminalMessageSignature) == null
          ? {}
          : {
              fullTerminalMessageSignature: readStringValue(
                existingMetadata.fullTerminalMessageSignature,
              ),
            }),
      });
      const status = state.terminal === "running" ? "active" : "finalized";

      if (existing?.larkCardId == null || existing.larkMessageId == null) {
        const binding = await ensureInteractiveCardReferenceBinding({
          bindingsRepo,
          client,
          cardkit,
          channelInstallationId: target.channelInstallationId,
          conversationId: state.conversationId,
          branchId: state.branchId,
          internalObjectKind: RUN_CARD_OBJECT_KIND,
          internalObjectId,
          chatId,
          surfaceObject,
          cardJson: JSON.stringify(rendered.card),
          lastSequence: 0,
          status,
          metadataJson,
          logContext: {
            taskRunId,
            cardRole: "task_status",
          },
        });
        if (binding == null) {
          continue;
        }

        deliverySnapshots.set(snapshotKey, {
          structureSignature: rendered.structureSignature,
          activeAssistantElementId: null,
          activeAssistantText: "",
        });
        metadataJson = await maybeSendFullTaskTerminalMessageToThread({
          bindingsRepo,
          channelInstallationId: target.channelInstallationId,
          binding,
          client,
          internalObjectId,
          metadataJson,
          state,
          taskTitle,
          terminalMessage,
        });
        continue;
      }

      if (!shouldRenderUpdate || existing.larkCardId == null) {
        await maybeSendFullTaskTerminalMessageToThread({
          bindingsRepo,
          channelInstallationId: target.channelInstallationId,
          binding: existing,
          client,
          internalObjectId,
          metadataJson,
          state,
          taskTitle,
          terminalMessage,
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
        channelInstallationId: target.channelInstallationId,
        internalObjectKind: RUN_CARD_OBJECT_KIND,
        internalObjectId,
        lastSequence: sequence,
        status,
        metadataJson,
      });
      deliverySnapshots.set(snapshotKey, {
        structureSignature: rendered.structureSignature,
        activeAssistantElementId: null,
        activeAssistantText: "",
      });
      await maybeSendFullTaskTerminalMessageToThread({
        bindingsRepo,
        channelInstallationId: target.channelInstallationId,
        binding: {
          ...existing,
          lastSequence: sequence,
          metadataJson,
        },
        client,
        internalObjectId,
        metadataJson,
        state,
        taskTitle,
        terminalMessage,
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

    const deliveryTargets = listLarkDeliveryTargets(input.storage, {
      conversationId: state.conversationId,
      branchId: state.branchId,
      taskRunId: state.taskRunId,
    });

    for (const target of deliveryTargets) {
      const surfaceObject = target.surfaceObject;
      const chatId = typeof surfaceObject.chat_id === "string" ? surfaceObject.chat_id : null;
      if (chatId == null || chatId.length === 0) {
        continue;
      }

      const client = input.clients.getOrCreate(target.channelInstallationId);
      const cardkit = getCardkitSdk(client);
      const bindingsRepo = new LarkObjectBindingsRepo(input.storage);
      const existing = bindingsRepo.getByInternalObject({
        channelInstallationId: target.channelInstallationId,
        internalObjectKind: APPROVAL_CARD_OBJECT_KIND,
        internalObjectId: approvalId,
      });
      const rendered = buildLarkRenderedApprovalCard(state);

      if (existing?.larkCardId == null || existing.larkMessageId == null) {
        const binding = await ensureInteractiveCardReferenceBinding({
          bindingsRepo,
          client,
          cardkit,
          channelInstallationId: target.channelInstallationId,
          conversationId: state.conversationId,
          branchId: state.branchId,
          internalObjectKind: APPROVAL_CARD_OBJECT_KIND,
          internalObjectId: approvalId,
          chatId,
          surfaceObject,
          cardJson: JSON.stringify(rendered.card),
          lastSequence: 0,
          status: state.resolved ? "finalized" : "active",
          metadataJson: JSON.stringify({
            approvalId,
            runId: state.runId,
          }),
          logContext: {
            approvalId,
            runId: state.runId,
          },
        });
        if (binding == null) {
          continue;
        }

        logger.info("created standalone lark approval card", {
          approvalId,
          runId: state.runId,
          channelInstallationId: target.channelInstallationId,
          larkMessageId: binding.larkMessageId,
          larkCardId: binding.larkCardId,
          larkMessageUuid: binding.larkMessageUuid,
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
        channelInstallationId: target.channelInstallationId,
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
        channelInstallationId: target.channelInstallationId,
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

      if (existing?.larkCardId == null || existing.larkMessageId == null) {
        const binding = await ensureInteractiveCardReferenceBinding({
          bindingsRepo,
          client,
          cardkit,
          channelInstallationId: surface.channelInstallationId,
          conversationId: entry.conversationId,
          branchId: entry.branchId,
          internalObjectKind: SUBAGENT_REQUEST_CARD_OBJECT_KIND,
          internalObjectId: requestId,
          chatId,
          surfaceObject,
          cardJson: JSON.stringify(rendered.card),
          lastSequence: 0,
          status: entry.state.status === "pending" ? "active" : "finalized",
          metadataJson: JSON.stringify({
            requestId,
            status: entry.state.status,
          }),
          logContext: {
            requestId,
            status: entry.state.status,
          },
        });
        if (binding == null) {
          continue;
        }
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

  const ensureRecoveredRunSegmentState = (runId: string): string | null => {
    const active = activeRunSegmentByRunId.get(runId);
    if (active != null) {
      return active;
    }

    const latest = latestRunSegmentByRunId.get(runId);
    if (latest != null) {
      return latest;
    }

    const bindings = new LarkObjectBindingsRepo(input.storage).listRunCardSegmentsByRunId({
      runId,
    });
    if (bindings.length === 0) {
      return null;
    }

    let latestSegmentIndex = 0;
    let latestRunCardObjectId: string | null = null;
    let activeSegmentIndex = 0;
    let activeRunCardObjectId: string | null = null;
    const seenObjectIds = new Set<string>();

    for (const binding of bindings) {
      if (seenObjectIds.has(binding.internalObjectId)) {
        if (binding.status === "active") {
          const segmentIndex = parseRunSegmentIndex(runId, binding.internalObjectId);
          if (segmentIndex > activeSegmentIndex) {
            activeSegmentIndex = segmentIndex;
            activeRunCardObjectId = binding.internalObjectId;
          }
        }
        continue;
      }
      seenObjectIds.add(binding.internalObjectId);

      const segmentIndex = parseRunSegmentIndex(runId, binding.internalObjectId);
      if (segmentIndex > latestSegmentIndex) {
        latestSegmentIndex = segmentIndex;
        latestRunCardObjectId = binding.internalObjectId;
      }
      if (binding.status === "active" && segmentIndex > activeSegmentIndex) {
        activeSegmentIndex = segmentIndex;
        activeRunCardObjectId = binding.internalObjectId;
      }
    }

    if (latestRunCardObjectId == null) {
      return null;
    }

    latestRunSegmentByRunId.set(runId, latestRunCardObjectId);
    nextRunSegmentIndexByRunId.set(runId, latestSegmentIndex);
    if (activeRunCardObjectId != null) {
      activeRunSegmentByRunId.set(runId, activeRunCardObjectId);
      return activeRunCardObjectId;
    }

    return latestRunCardObjectId;
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
      const sourceRunCardObjectId =
        activeRunSegmentByRunId.get(runId) ??
        latestRunSegmentByRunId.get(runId) ??
        ensureRecoveredRunSegmentState(runId);

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
          taskRunId: envelope.taskRun.taskRunId,
          taskRunType: envelope.taskRun.runType,
          sourceRunCardObjectId,
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

  const handleSteerConsumedReactionUpdate = async (
    envelope: OrchestratedRuntimeEventEnvelope,
  ): Promise<void> => {
    if (envelope.event.type !== "steer_message_consumed") {
      return;
    }
    const sourceMessageId = envelope.event.channelMessageId;
    if (sourceMessageId == null || sourceMessageId.length === 0) {
      return;
    }

    const deliveryTargets = listLarkDeliveryTargets(input.storage, {
      conversationId: envelope.target.conversationId,
      branchId: envelope.target.branchId,
      taskRunId: envelope.taskRun.taskRunId,
    });

    for (const target of deliveryTargets) {
      const client = input.clients.getOrCreate(target.channelInstallationId);
      await addLarkMessageReaction({
        client,
        messageId: sourceMessageId,
        emojiType: STEER_CONFIRMED_REACTION_EMOJI,
      });
      if (input.steerReactionState == null) {
        continue;
      }
      const pending = input.steerReactionState.takePendingReaction({
        installationId: target.channelInstallationId,
        messageId: sourceMessageId,
      });
      if (pending == null) {
        continue;
      }
      await removeLarkMessageReaction({
        client,
        messageId: sourceMessageId,
        reactionId: pending.reactionId,
      });
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
          if (!shouldRenderStandaloneTaskCard(envelope.taskRun.runType)) {
            taskStates.delete(envelope.event.taskRunId);
            return;
          }
          const next = reduceLarkRunState(
            taskStates.get(envelope.event.taskRunId) ?? null,
            envelope,
          );
          taskStates.set(envelope.event.taskRunId, next);
          logger.debug("accepted lark task run lifecycle event", {
            taskRunId: envelope.event.taskRunId,
            eventType: envelope.event.type,
            terminal: next.terminal,
          });
          bumpVersionAndSchedule(`${TASK_STATUS_DELIVERY_PREFIX}${envelope.event.taskRunId}`, {
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

        if (envelope.event.type === "steer_message_consumed") {
          void handleSteerConsumedReactionUpdate(envelope);
          return;
        }

        if (!shouldHandleLarkRuntimeEvent(envelope)) {
          return;
        }

        const runId = envelope.run.runId;
        if (runId == null) {
          return;
        }

        ensureRecoveredRunSegmentState(runId);

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
      taskStates.clear();
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
        activeRuns: runStates.size + taskStates.size,
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

function parseBindingMetadata(raw: string | null): Record<string, unknown> {
  if (raw == null || raw.trim().length === 0) {
    return {};
  }
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
  larkMessageUuid?: string | null;
}): Promise<LarkInteractiveMessageResponse> {
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
        ...(input.larkMessageUuid == null ? {} : { uuid: input.larkMessageUuid }),
      },
    }) as Promise<LarkInteractiveMessageResponse>;
  }

  return input.client.sdk.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: input.chatId,
      msg_type: "interactive",
      content,
      ...(input.larkMessageUuid == null ? {} : { uuid: input.larkMessageUuid }),
    },
  }) as Promise<LarkInteractiveMessageResponse>;
}

async function sendLarkThreadMarkdownCard(input: {
  client: LarkSdkClient;
  replyToMessageId: string;
  title: string;
  summary: string;
  markdownSections: string[];
}): Promise<LarkInteractiveMessageResponse> {
  const card = {
    schema: "2.0",
    config: {
      update_multi: true,
      wide_screen_mode: false,
      summary: {
        content: input.summary,
      },
    },
    header: {
      title: {
        tag: "plain_text",
        content: input.title,
      },
      template: "turquoise",
    },
    body: {
      elements: input.markdownSections.flatMap((section, index) => [
        ...(index === 0 ? [] : [{ tag: "hr" as const }]),
        {
          tag: "markdown",
          content: section,
        },
      ]),
    },
  };

  return input.client.sdk.im.message.reply({
    path: { message_id: input.replyToMessageId },
    data: {
      msg_type: "interactive",
      content: JSON.stringify(card),
      reply_in_thread: true,
    },
  }) as Promise<LarkInteractiveMessageResponse>;
}

async function maybeSendFullTaskTerminalMessageToThread(input: {
  bindingsRepo: LarkObjectBindingsRepo;
  channelInstallationId: string;
  binding: LarkObjectBinding;
  client: LarkSdkClient;
  internalObjectId: string;
  metadataJson: string;
  state: LarkRunState;
  taskTitle: string | null;
  terminalMessage: ReturnType<typeof getLarkTaskTerminalMessagePresentation>;
}): Promise<string> {
  if (
    input.binding.larkMessageId == null ||
    input.state.terminal === "running" ||
    input.terminalMessage.truncated !== true ||
    input.terminalMessage.fullText == null
  ) {
    return input.metadataJson;
  }

  const parsedMetadata = parseBindingMetadata(input.metadataJson);
  const signature = safeJson({
    terminal: input.state.terminal,
    fullText: input.terminalMessage.fullText,
  });
  if (readStringValue(parsedMetadata.fullTerminalMessageSignature) === signature) {
    return input.metadataJson;
  }

  const title = input.taskTitle ?? describeTaskTitleFallback(input.state);
  const statusLabel = `${describeTaskRunKind(input.state.taskRunType)}${describeTaskRunTerminal(input.state.terminal)}`;
  await sendLarkThreadMarkdownCard({
    client: input.client,
    replyToMessageId: input.binding.larkMessageId,
    title: `${title} · 完整结果`,
    summary: `${title}${statusLabel}完整结果`,
    markdownSections: [`**状态**：${statusLabel}`, input.terminalMessage.fullText],
  });

  const nextMetadataJson = JSON.stringify({
    ...parsedMetadata,
    fullTerminalMessageSignature: signature,
  });
  input.bindingsRepo.updateDeliveryState({
    channelInstallationId: input.channelInstallationId,
    internalObjectKind: RUN_CARD_OBJECT_KIND,
    internalObjectId: input.internalObjectId,
    metadataJson: nextMetadataJson,
  });
  return nextMetadataJson;
}

function describeTaskTitleFallback(state: LarkRunState): string {
  return describeTaskRunKind(state.taskRunType);
}

function readStringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function listLarkDeliveryTargets(
  storage: StorageDb,
  input: {
    conversationId: string;
    branchId: string;
    taskRunId?: string | null;
  },
): Array<{
  channelInstallationId: string;
  surfaceObject: Record<string, unknown>;
}> {
  const surfaces = new ChannelSurfacesRepo(storage).listByConversationBranch({
    channelType: LARK_CHANNEL_TYPE,
    conversationId: input.conversationId,
    branchId: input.branchId,
  });
  const taskRun =
    input.taskRunId == null ? null : new TaskRunsRepo(storage).getById(input.taskRunId);
  const channelThreadsRepo = new ChannelThreadsRepo(storage);

  return surfaces.map((surface) => {
    const threadBinding =
      taskRun == null
        ? null
        : channelThreadsRepo.getByRootTaskRun({
            channelType: LARK_CHANNEL_TYPE,
            channelInstallationId: surface.channelInstallationId,
            rootTaskRunId: taskRun.threadRootRunId ?? taskRun.id,
          });

    return {
      channelInstallationId: surface.channelInstallationId,
      surfaceObject:
        threadBinding == null
          ? parseSurfaceObject(surface.surfaceObjectJson)
          : {
              chat_id: threadBinding.externalChatId,
              thread_id: threadBinding.externalThreadId,
              ...(threadBinding.openedFromMessageId == null
                ? {}
                : { reply_to_message_id: threadBinding.openedFromMessageId }),
            },
    };
  });
}

function listTaskCardDeliveryTargets(
  storage: StorageDb,
  input: {
    taskRunId: string;
    conversationId: string;
    branchId: string;
  },
): Array<{
  channelInstallationId: string;
  surfaceObject: Record<string, unknown>;
}> {
  return listLarkDeliveryTargets(storage, input);
}

function shouldRenderStandaloneTaskCard(runType: string | null): boolean {
  return runType !== "thread";
}

function buildTaskRunCardObjectId(taskRunId: string): string {
  return `task:${taskRunId}`;
}

function resolveTaskCardTitle(storage: StorageDb, taskRunId: string): string | null {
  const taskRun = new TaskRunsRepo(storage).getById(taskRunId);
  if (taskRun == null) {
    return null;
  }

  if (taskRun.runType === "cron" && taskRun.cronJobId != null) {
    const cronName = new CronJobsRepo(storage).getById(taskRun.cronJobId)?.name ?? null;
    const normalizedCronName = normalizeTaskCardTitleValue(cronName);
    if (normalizedCronName != null) {
      return normalizedCronName;
    }
  }

  return normalizeTaskCardTitleValue(taskRun.description);
}

function normalizeTaskCardTitleValue(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  const singleLine = value
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (singleLine == null) {
    return null;
  }
  return singleLine.length <= 120 ? singleLine : `${singleLine.slice(0, 117)}...`;
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

function buildRunCardPageObjectId(runCardObjectId: string, pageIndex: number): string {
  return pageIndex <= 1 ? runCardObjectId : `${runCardObjectId}:page:${pageIndex}`;
}

function parseRunCardPageIndex(runCardObjectId: string, internalObjectId: string): number {
  if (internalObjectId === runCardObjectId) {
    return 1;
  }

  const prefix = `${runCardObjectId}:page:`;
  if (!internalObjectId.startsWith(prefix)) {
    return Number.MAX_SAFE_INTEGER;
  }

  const suffix = internalObjectId.slice(prefix.length);
  const parsed = Number.parseInt(suffix, 10);
  return Number.isFinite(parsed) && parsed > 1 ? parsed : Number.MAX_SAFE_INTEGER;
}

function parseRunSegmentIndex(runId: string, internalObjectId: string): number {
  const prefix = `${runId}:seg:`;
  if (!internalObjectId.startsWith(prefix)) {
    return 0;
  }

  const suffix = internalObjectId.slice(prefix.length);
  const parsed = Number.parseInt(suffix, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function listRunCardPageBindings(
  bindingsRepo: LarkObjectBindingsRepo,
  channelInstallationId: string,
  runCardObjectId: string,
) {
  return bindingsRepo
    .listByInternalObjectPrefix({
      channelInstallationId,
      internalObjectKind: RUN_CARD_OBJECT_KIND,
      internalObjectIdPrefix: runCardObjectId,
    })
    .sort(
      (left, right) =>
        parseRunCardPageIndex(runCardObjectId, left.internalObjectId) -
        parseRunCardPageIndex(runCardObjectId, right.internalObjectId),
    );
}

function buildStaleRunCardCard(): Record<string, unknown> {
  return {
    schema: "2.0",
    config: {
      summary: {
        content: "已整理",
      },
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: "ℹ️ **此页已收起，请查看上方更新后的运行卡片。**",
        },
      ],
    },
  };
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
