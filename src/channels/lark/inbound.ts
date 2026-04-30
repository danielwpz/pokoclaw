/**
 * Lark inbound adapter.
 *
 * Parses lark message/callback payloads, resolves channel surface bindings, and
 * translates user actions into runtime ingress/control commands (`submitMessage`,
 * `/status`, `/stop`, approval decisions).
 */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import * as Lark from "@larksuiteoapi/node-sdk";
import {
  type AgentUserImagePayload,
  type AgentUserPayload,
  type AgentUserRuntimeImagePayload,
  normalizeAgentUserImageMessageId,
} from "@/src/agent/llm/messages.js";
import type { ModelScenario } from "@/src/agent/llm/models.js";
import type { AgentLoopAfterToolResultHook } from "@/src/agent/loop.js";
import { buildSlashCommandHelpPresentation } from "@/src/channels/help.js";
import type { LarkSdkClient } from "@/src/channels/lark/client.js";
import { addLarkMessageReaction } from "@/src/channels/lark/reactions.js";
import {
  buildLarkRenderedModelSwitchCard,
  type LarkModelSwitchCardState,
} from "@/src/channels/lark/render.js";
import type { LarkSteerReactionState } from "@/src/channels/lark/steer-reaction-state.js";
import { sendLarkTextMessage } from "@/src/channels/lark/text-message.js";
import type { ConfiguredLarkInstallation } from "@/src/channels/lark/types.js";
import { handleLarkYoloCommand, isLarkYoloCommand } from "@/src/channels/lark/yolo-command.js";
import type { ScenarioModelSwitchService } from "@/src/config/scenario-model-switch.js";
import type { ResolveSubagentCreationRequestResult } from "@/src/orchestration/agent-manager.js";
import { materializeForkedSessionSnapshotInStorage } from "@/src/orchestration/session-fork.js";
import type { RuntimeControlService } from "@/src/runtime/control.js";
import type { SubmitMessageResult } from "@/src/runtime/ingress.js";
import type { RuntimeModeService } from "@/src/runtime/runtime-modes.js";
import {
  buildConversationStatusPresentation,
  type RuntimeStatusService,
} from "@/src/runtime/status.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { AgentsRepo } from "@/src/storage/repos/agents.repo.js";
import { ChannelInstancesRepo } from "@/src/storage/repos/channel-instances.repo.js";
import { ChannelSurfacesRepo } from "@/src/storage/repos/channel-surfaces.repo.js";
import { ChannelThreadsRepo } from "@/src/storage/repos/channel-threads.repo.js";
import { ConversationBranchesRepo } from "@/src/storage/repos/conversation-branches.repo.js";
import { ConversationsRepo } from "@/src/storage/repos/conversations.repo.js";
import { CronJobsRepo } from "@/src/storage/repos/cron-jobs.repo.js";
import { LarkObjectBindingsRepo } from "@/src/storage/repos/lark-object-bindings.repo.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { TaskRunsRepo } from "@/src/storage/repos/task-runs.repo.js";
import { TaskWorkstreamsRepo } from "@/src/storage/repos/task-workstreams.repo.js";
import type { ChannelSurface, TaskRun } from "@/src/storage/schema/types.js";
import { extractTaskCompletionSignal } from "@/src/tasks/task-completion.js";

const logger = createSubsystemLogger("channels/lark-inbound");

const LARK_CHANNEL_TYPE = "lark";
const LARK_INBOUND_LOG_PREVIEW_MAX_LENGTH = 144;
const LARK_CARD_ACTION_LOG_PREVIEW_MAX_LENGTH = 320;
const LARK_INTERACTIVE_TEXT_NODE_LIMIT = 48;
const LARK_INTERACTIVE_TEXT_CHAR_LIMIT = 4_000;
const LARK_INTERACTIVE_TEXT_TRUNCATED_NOTICE = "[卡片内容过长，引用文本已截断]";
const RUN_CARD_OBJECT_KIND = "run_card";
const STEER_PENDING_REACTION_EMOJI = "Typing";

export interface LarkInboundIngress {
  submitMessage(input: {
    sessionId: string;
    scenario: "chat" | "task";
    content: string;
    userPayload?: AgentUserPayload;
    runtimeImages?: AgentUserRuntimeImagePayload[];
    messageType?: string;
    visibility?: string;
    channelMessageId?: string | null;
    channelParentMessageId?: string | null;
    channelThreadId?: string | null;
    createdAt?: Date;
    maxTurns?: number;
    afterToolResultHook?: AgentLoopAfterToolResultHook;
  }): Promise<unknown>;
  submitApprovalDecision(input: {
    approvalId: number;
    decision: "approve" | "deny";
    actor: string;
    rawInput?: string | null;
    grantedBy?: "user" | "main_agent";
    reasonText?: string | null;
    expiresAt?: Date | null;
  }): boolean;
}

export interface CreateLarkInboundRuntimeInput {
  installations: ConfiguredLarkInstallation[];
  storage: StorageDb;
  ingress: LarkInboundIngress;
  control: RuntimeControlService;
  status?: RuntimeStatusService;
  runtimeModes?: RuntimeModeService;
  modelSwitch?: ScenarioModelSwitchService;
  clients?: {
    getOrCreate(installationId: string): LarkSdkClient;
  };
  wsClientFactory?: (installation: ConfiguredLarkInstallation) => Lark.WSClient;
  subagentRequests?: {
    approve(requestId: string): Promise<ResolveSubagentCreationRequestResult>;
    deny(
      requestId: string,
    ): Promise<ResolveSubagentCreationRequestResult> | ResolveSubagentCreationRequestResult;
  };
  a2uiCallbacks?: {
    handleCardAction(input: { installationId: string; payload: unknown }): Promise<unknown | null>;
  };
  taskThreads?: {
    createFollowupExecution(input: {
      rootTaskRunId: string;
      initiatorThreadId?: string | null;
      createdAt?: Date;
    }): {
      taskRunId: string;
      sessionId: string;
      conversationId: string;
      branchId: string;
    };
    completeTaskExecution(input: {
      taskRunId: string;
      resultSummary?: string | null;
      finishedAt?: Date;
    }): void;
    blockTaskExecution(input: {
      taskRunId: string;
      resultSummary?: string | null;
      finishedAt?: Date;
    }): void;
    failTaskExecution(input: {
      taskRunId: string;
      errorText?: string | null;
      resultSummary?: string | null;
      finishedAt?: Date;
    }): void;
  };
  steerReactionState?: LarkSteerReactionState;
}

export interface LarkInboundRuntimeStatus {
  started: boolean;
  activeSockets: number;
}

export interface LarkInboundRuntime {
  start(): void;
  shutdown(): Promise<void>;
  status(): LarkInboundRuntimeStatus;
}

export interface LarkMessageReceiveEvent {
  sender?: {
    sender_id?: {
      open_id?: string;
    };
    id?: string;
    id_type?: string;
    sender_type?: string;
  };
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: string;
    thread_id?: string;
    parent_id?: string;
    message_type?: string;
    create_time?: string;
    content?: string;
  };
  message_id?: string;
  chat_id?: string;
  chat_type?: string;
  thread_id?: string;
  parent_id?: string;
  msg_type?: string;
  create_time?: string;
  body?: {
    content?: string;
  };
}

export interface NormalizedLarkTextMessage {
  chatId: string;
  messageId: string;
  messageType: string;
  parentMessageId: string | null;
  threadId: string | null;
  senderOpenId: string | null;
  senderType: string | null;
  chatType: string | null;
  text: string;
  imageKeys?: string[];
  createdAt?: Date;
}

interface LarkInboundImageAsset {
  id: string;
  messageId: string;
  data: string;
  mimeType: string;
}

interface LarkQuotedMessage {
  messageType: string;
  text: string;
}

interface LarkInteractiveTextCollection {
  nodes: string[];
  totalLength: number;
  truncated: boolean;
}

export interface NormalizedLarkCardAction {
  action: string;
  runId: string | null;
  approvalId: number | null;
  requestId: string | null;
  grantTtl: "one_day" | "permanent" | null;
  actorOpenId: string | null;
  scenario: ModelScenario | null;
  modelId: string | null;
}

export function buildLarkChatSurfaceKey(chatId: string): string {
  return `chat:${chatId}`;
}

export function buildLarkThreadSurfaceKey(chatId: string, threadId: string): string {
  return `chat:${chatId}:thread:${threadId}`;
}

interface LarkInboundRoute {
  kind: "main_chat" | "ordinary_thread" | "task_thread";
  conversationId: string;
  branchId: string;
  sessionId: string;
  taskRunId?: string | null;
  scenario: "chat" | "task";
  stopScope: "conversation" | "session";
  chatId: string;
  replyToMessageId: string | null;
}

export function normalizeLarkTextMessage(
  data: unknown,
): NormalizedLarkTextMessage | { skipReason: string } {
  if (!isRecord(data)) {
    return { skipReason: "event payload is not an object" };
  }

  const nestedMessage = isRecord(data.message) ? data.message : null;
  const flatMessage = nestedMessage == null ? data : null;
  const message = nestedMessage ?? flatMessage;
  if (message == null) {
    return { skipReason: "event payload is missing message" };
  }

  const messageType = readString(nestedMessage?.message_type) ?? readString(flatMessage?.msg_type);
  if (messageType == null) {
    return { skipReason: "message is missing message_type" };
  }

  const chatId = readString(message.chat_id) ?? "";
  if (chatId.length === 0) {
    return { skipReason: "text message is missing chat_id" };
  }

  const messageId = readString(message.message_id) ?? "";
  if (messageId.length === 0) {
    return { skipReason: "text message is missing message_id" };
  }

  const contentRaw =
    readString(nestedMessage?.content) ??
    readString(isRecord(flatMessage?.body) ? flatMessage.body.content : null) ??
    "";
  const text = parseLarkMessageContent(messageType, contentRaw);
  if (text.length === 0) {
    logger.debug("normalized lark message produced empty text", {
      messageShape: nestedMessage == null ? "raw" : "event",
      chatId,
      messageId,
      messageType,
      hasBodyContent: contentRaw.length > 0,
    });
    return { skipReason: "text message content is empty" };
  }
  const imageKeys = extractLarkImageKeys(messageType, contentRaw);

  const parentMessageId = readString(message.parent_id);
  const threadId = readString(message.thread_id);
  const sender = isRecord(data.sender) ? data.sender : null;
  const senderId = sender != null && isRecord(sender.sender_id) ? sender.sender_id : null;
  const senderOpenId =
    readString(senderId?.open_id) ??
    (readString(sender?.id_type) === "open_id" ? readString(sender?.id) : null);
  const senderType = readString(sender?.sender_type);
  const chatType = readString(message.chat_type);
  const createdAt = parseLarkMessageCreatedAt(message.create_time);

  logger.debug("normalized lark inbound message", {
    messageShape: nestedMessage == null ? "raw" : "event",
    chatId,
    messageId,
    messageType,
    parentMessageId,
    threadId,
    senderOpenId,
    senderType,
    chatType,
    imageKeyCount: imageKeys.length,
    imageKeys,
    contentPreview: truncateLogText(text, LARK_INBOUND_LOG_PREVIEW_MAX_LENGTH),
  });

  return {
    chatId,
    messageId,
    messageType,
    parentMessageId,
    threadId,
    senderOpenId,
    senderType,
    chatType,
    text,
    ...(imageKeys.length === 0 ? {} : { imageKeys }),
    ...(createdAt == null ? {} : { createdAt }),
  };
}

export function createLarkMessageReceiveHandler(input: {
  installationId: string;
  storage: StorageDb;
  ingress: LarkInboundIngress;
  control: RuntimeControlService;
  status?: RuntimeStatusService;
  runtimeModes?: RuntimeModeService;
  modelSwitch?: ScenarioModelSwitchService;
  clients?: {
    getOrCreate(installationId: string): LarkSdkClient;
  };
  quoteMessageFetcher?: (input: {
    installationId: string;
    messageId: string;
  }) => Promise<LarkQuotedMessage | null>;
  taskThreads?: CreateLarkInboundRuntimeInput["taskThreads"];
  steerReactionState?: LarkSteerReactionState;
}): (data: unknown) => Promise<void> {
  return async (data: unknown) => {
    const normalized = normalizeLarkTextMessage(data);
    if ("skipReason" in normalized) {
      logger.debug("ignoring lark inbound message", {
        installationId: input.installationId,
        reason: normalized.skipReason,
      });
      return;
    }

    const hydrated = await hydrateLarkInboundMessageText({
      installationId: input.installationId,
      normalized,
      ...(input.quoteMessageFetcher == null
        ? {}
        : { messageTextFetcher: input.quoteMessageFetcher }),
    });

    if (hydrated.senderType != null && hydrated.senderType !== "user") {
      logger.debug("ignoring non-user lark inbound message", {
        installationId: input.installationId,
        chatId: hydrated.chatId,
        messageId: hydrated.messageId,
        senderType: hydrated.senderType,
      });
      return;
    }

    const mainSurface = resolveOrPairLarkChatSurface({
      db: input.storage,
      installationId: input.installationId,
      chatId: hydrated.chatId,
      chatType: hydrated.chatType,
    });
    if (mainSurface == null) {
      logger.warn("dropping lark inbound message because no channel surface matched or paired", {
        installationId: input.installationId,
        chatId: hydrated.chatId,
        messageId: hydrated.messageId,
      });
      return;
    }

    const route = await resolveLarkInboundRoute({
      db: input.storage,
      installationId: input.installationId,
      mainSurface,
      normalized: hydrated,
      ...(input.taskThreads == null ? {} : { taskThreads: input.taskThreads }),
      ...(input.quoteMessageFetcher == null
        ? {}
        : { quoteMessageFetcher: input.quoteMessageFetcher }),
    });
    if (route == null) {
      logger.warn("dropping lark inbound message because no route was resolved", {
        installationId: input.installationId,
        chatId: hydrated.chatId,
        messageId: hydrated.messageId,
        parentMessageId: hydrated.parentMessageId,
        threadId: hydrated.threadId,
      });
      return;
    }

    if (hydrated.text === "/stop") {
      const result =
        route.stopScope === "conversation"
          ? input.control.stopConversation({
              conversationId: route.conversationId,
              actor:
                hydrated.senderOpenId == null
                  ? `lark:${input.installationId}:unknown`
                  : `lark:${input.installationId}:${hydrated.senderOpenId}`,
              sourceKind: "command",
              requestScope: "conversation",
              reasonText: "stop requested from lark command",
            })
          : input.control.stopSession({
              sessionId: route.sessionId,
              actor:
                hydrated.senderOpenId == null
                  ? `lark:${input.installationId}:unknown`
                  : `lark:${input.installationId}:${hydrated.senderOpenId}`,
              sourceKind: "command",
              requestScope: "session",
              reasonText: "stop requested from lark command",
            });
      logger.info("processed lark stop command", {
        installationId: input.installationId,
        chatId: hydrated.chatId,
        messageId: hydrated.messageId,
        conversationId: route.conversationId,
        sessionId: route.sessionId,
        stopScope: route.stopScope,
        acceptedCount: "acceptedCount" in result ? result.acceptedCount : Number(result.accepted),
      });
      return;
    }

    if (hydrated.text === "/status") {
      if (input.status == null) {
        logger.warn("ignoring lark status command because no status service is configured", {
          installationId: input.installationId,
          chatId: hydrated.chatId,
          messageId: hydrated.messageId,
        });
        return;
      }
      const snapshot = input.status.getConversationStatus({
        conversationId: route.conversationId,
        sessionId: route.sessionId,
        scenario: route.scenario,
      });
      await sendLarkStatusCard({
        installationId: input.installationId,
        chatId: route.chatId,
        replyToMessageId: route.replyToMessageId,
        presentation: buildConversationStatusPresentation(snapshot),
        ...(input.clients == null ? {} : { clients: input.clients }),
      });
      logger.info("processed lark status command", {
        installationId: input.installationId,
        chatId: hydrated.chatId,
        messageId: hydrated.messageId,
        conversationId: route.conversationId,
        sessionId: route.sessionId,
        scenario: route.scenario,
        routeKind: route.kind,
      });
      return;
    }

    if (isLarkYoloCommand(hydrated.text)) {
      await handleLarkYoloCommand({
        text: hydrated.text,
        installationId: input.installationId,
        storage: input.storage,
        ...(input.runtimeModes == null ? {} : { runtimeModes: input.runtimeModes }),
        route,
        message: hydrated,
        ...(input.clients == null ? {} : { clients: input.clients }),
      });
      return;
    }

    if (hydrated.text === "/model") {
      if (input.modelSwitch == null) {
        logger.warn("ignoring lark model command because no model switch service is configured", {
          installationId: input.installationId,
          chatId: hydrated.chatId,
          messageId: hydrated.messageId,
        });
        return;
      }
      await sendLarkModelSwitchCard({
        installationId: input.installationId,
        chatId: route.chatId,
        replyToMessageId: route.replyToMessageId,
        state: {
          overview: input.modelSwitch.getOverview(),
          selectedScenario: null,
        },
        ...(input.clients == null ? {} : { clients: input.clients }),
      });
      logger.info("processed lark model command", {
        installationId: input.installationId,
        chatId: hydrated.chatId,
        messageId: hydrated.messageId,
        conversationId: route.conversationId,
        sessionId: route.sessionId,
        routeKind: route.kind,
      });
      return;
    }

    if (hydrated.text === "/help") {
      await sendLarkHelpMessage({
        installationId: input.installationId,
        chatId: route.chatId,
        replyToMessageId: route.replyToMessageId,
        channelType: "lark",
        ...(input.clients == null ? {} : { clients: input.clients }),
      });
      logger.info("processed lark help command", {
        installationId: input.installationId,
        chatId: hydrated.chatId,
        messageId: hydrated.messageId,
        conversationId: route.conversationId,
        sessionId: route.sessionId,
        routeKind: route.kind,
      });
      return;
    }

    logger.info("submitting lark inbound message to runtime ingress", {
      installationId: input.installationId,
      chatId: hydrated.chatId,
      messageId: hydrated.messageId,
      parentMessageId: hydrated.parentMessageId,
      threadId: hydrated.threadId,
      sessionId: route.sessionId,
      conversationId: route.conversationId,
      branchId: route.branchId,
      routeKind: route.kind,
      scenario: route.scenario,
      chatType: hydrated.chatType,
      contentPreview: truncateLogText(hydrated.text, LARK_INBOUND_LOG_PREVIEW_MAX_LENGTH),
    });

    const content =
      route.kind === "ordinary_thread"
        ? hydrated.text
        : await buildInboundMessageContent(hydrated, input);
    const imageAssets =
      input.clients == null
        ? []
        : await fetchLarkInboundImageAssets({
            installationId: input.installationId,
            messageId: hydrated.messageId,
            imageKeys: hydrated.imageKeys ?? [],
            clients: input.clients,
          });
    const userPayload = buildLarkInboundUserPayload({
      content,
      imageAssets,
    });
    const runtimeImages = buildLarkInboundRuntimeImages(imageAssets);

    if ((hydrated.imageKeys?.length ?? 0) > 0 || runtimeImages.length > 0) {
      logger.info("prepared lark inbound image payloads", {
        installationId: input.installationId,
        chatId: hydrated.chatId,
        messageId: hydrated.messageId,
        imageKeyCount: hydrated.imageKeys?.length ?? 0,
        fetchedImageAssetCount: imageAssets.length,
        fetchedImageAssets: imageAssets.map((image) => ({
          id: image.id,
          messageId: image.messageId,
          mimeType: image.mimeType,
          byteLength: Buffer.from(image.data, "base64").length,
        })),
        userPayloadImageCount: userPayload?.images?.length ?? 0,
        runtimeImageCount: runtimeImages.length,
      });
    }

    try {
      const submitResult = await input.ingress.submitMessage({
        sessionId: route.sessionId,
        scenario: route.scenario,
        content,
        ...(userPayload == null ? {} : { userPayload }),
        ...(runtimeImages.length === 0 ? {} : { runtimeImages }),
        channelMessageId: hydrated.messageId,
        ...(hydrated.parentMessageId == null
          ? {}
          : { channelParentMessageId: hydrated.parentMessageId }),
        ...(hydrated.threadId == null ? {} : { channelThreadId: hydrated.threadId }),
        ...(hydrated.createdAt == null ? {} : { createdAt: hydrated.createdAt }),
        ...(route.taskRunId == null || input.taskThreads == null
          ? {}
          : {
              afterToolResultHook: {
                afterToolResult: ({ toolCall, result }) => {
                  const completion = extractTaskCompletionSignal({
                    toolName: toolCall.name,
                    result,
                  });
                  if (completion == null) {
                    return { kind: "continue" } as const;
                  }

                  return {
                    kind: "stop_run",
                    reason: "task_completion",
                    payload: {
                      taskCompletion: completion,
                    },
                  } as const;
                },
              },
            }),
      });
      if (route.taskRunId != null && input.taskThreads != null) {
        settleTaskThreadCompletionIfNeeded({
          taskThreads: input.taskThreads,
          taskRunId: route.taskRunId,
          submitResult,
          finishedAt: hydrated.createdAt ?? new Date(),
        });
      }
      if (
        submitResult != null &&
        typeof submitResult === "object" &&
        "status" in submitResult &&
        submitResult.status === "steered" &&
        input.clients != null &&
        input.steerReactionState != null
      ) {
        const client = input.clients.getOrCreate(input.installationId);
        const reactionId = await addLarkMessageReaction({
          client,
          messageId: hydrated.messageId,
          emojiType: STEER_PENDING_REACTION_EMOJI,
        });
        if (reactionId != null) {
          input.steerReactionState.rememberPendingReaction({
            installationId: input.installationId,
            messageId: hydrated.messageId,
            reactionId,
            emojiType: STEER_PENDING_REACTION_EMOJI,
          });
        }
      }
    } catch (error) {
      if (!isAbortLikeError(error)) {
        await sendLarkRunFailureCard({
          installationId: input.installationId,
          chatId: route.chatId,
          replyToMessageId: route.replyToMessageId,
          errorMessage: error instanceof Error ? error.message : String(error),
          ...(input.clients == null ? {} : { clients: input.clients }),
        }).catch((notifyError: unknown) => {
          logger.warn("failed to send lark run failure card", {
            installationId: input.installationId,
            chatId: route.chatId,
            replyToMessageId: route.replyToMessageId,
            error: notifyError instanceof Error ? notifyError.message : String(notifyError),
          });
        });
      }
      throw error;
    }
  };
}

async function hydrateLarkInboundMessageText(input: {
  installationId: string;
  normalized: NormalizedLarkTextMessage;
  messageTextFetcher?: (input: {
    installationId: string;
    messageId: string;
  }) => Promise<LarkQuotedMessage | null>;
}): Promise<NormalizedLarkTextMessage> {
  if (input.normalized.messageType !== "interactive" || input.messageTextFetcher == null) {
    return input.normalized;
  }

  const fetched = await input.messageTextFetcher({
    installationId: input.installationId,
    messageId: input.normalized.messageId,
  });
  if (fetched == null || fetched.text.length === 0 || fetched.text === input.normalized.text) {
    return input.normalized;
  }

  logger.info("hydrated interactive lark inbound message via message.get", {
    installationId: input.installationId,
    messageId: input.normalized.messageId,
    contentPreview: truncateLogText(fetched.text, LARK_INBOUND_LOG_PREVIEW_MAX_LENGTH),
  });
  return {
    ...input.normalized,
    text: fetched.text,
  };
}

export function normalizeLarkCardAction(
  data: unknown,
): NormalizedLarkCardAction | { skipReason: string } {
  if (!isRecord(data)) {
    return { skipReason: "card action payload is not an object" };
  }

  const action = isRecord(data.action) ? data.action : null;
  const value = action != null && isRecord(action.value) ? action.value : null;
  const actionName = typeof value?.action === "string" ? value.action.trim() : "";
  if (actionName.length === 0) {
    return { skipReason: "card action is missing action name" };
  }

  const runId = typeof value?.runId === "string" && value.runId.length > 0 ? value.runId : null;
  const requestId =
    typeof value?.requestId === "string" && value.requestId.trim().length > 0
      ? value.requestId.trim()
      : null;
  const approvalIdRaw = value?.approvalId;
  const approvalId =
    typeof approvalIdRaw === "number" && Number.isFinite(approvalIdRaw)
      ? approvalIdRaw
      : typeof approvalIdRaw === "string" && approvalIdRaw.length > 0
        ? Number.parseInt(approvalIdRaw, 10)
        : null;
  const grantTtl =
    value?.grantTtl === "one_day" || value?.grantTtl === "permanent" ? value.grantTtl : null;
  const operator = isRecord(data.operator) ? data.operator : null;
  const actorOpenId =
    operator != null && typeof operator.open_id === "string" && operator.open_id.length > 0
      ? operator.open_id
      : null;
  const scenario = normalizeModelScenario(value?.scenario);
  const modelId =
    typeof value?.modelId === "string" && value.modelId.trim().length > 0
      ? value.modelId.trim()
      : null;

  return {
    action: actionName,
    runId,
    approvalId:
      approvalId == null || Number.isNaN(approvalId) || !Number.isFinite(approvalId)
        ? null
        : approvalId,
    requestId,
    grantTtl,
    actorOpenId,
    scenario,
    modelId,
  };
}

export function createLarkCardActionHandler(input: {
  installationId: string;
  ingress: LarkInboundIngress;
  control: RuntimeControlService;
  modelSwitch?: ScenarioModelSwitchService;
  subagentRequests?: {
    approve(requestId: string): Promise<ResolveSubagentCreationRequestResult>;
    deny(
      requestId: string,
    ): Promise<ResolveSubagentCreationRequestResult> | ResolveSubagentCreationRequestResult;
  };
  a2uiCallbacks?: CreateLarkInboundRuntimeInput["a2uiCallbacks"];
}): (data: unknown) => Promise<unknown> {
  return async (data: unknown) => {
    logger.debug("received raw lark card action callback", {
      installationId: input.installationId,
      payloadPreview: truncateLogText(safeJson(data), LARK_CARD_ACTION_LOG_PREVIEW_MAX_LENGTH),
    });

    const a2uiResult = await input.a2uiCallbacks?.handleCardAction({
      installationId: input.installationId,
      payload: data,
    });
    if (a2uiResult != null) {
      return a2uiResult;
    }

    const normalized = normalizeLarkCardAction(data);
    if ("skipReason" in normalized) {
      logger.debug("ignoring lark card action", {
        installationId: input.installationId,
        reason: normalized.skipReason,
        payloadPreview: truncateLogText(safeJson(data), LARK_CARD_ACTION_LOG_PREVIEW_MAX_LENGTH),
      });
      return null;
    }

    logger.info("received lark card action", {
      installationId: input.installationId,
      action: normalized.action,
      runId: normalized.runId,
      approvalId: normalized.approvalId,
      requestId: normalized.requestId,
      grantTtl: normalized.grantTtl,
      actor:
        normalized.actorOpenId == null
          ? `lark:${input.installationId}:unknown`
          : `lark:${input.installationId}:${normalized.actorOpenId}`,
    });

    if (
      normalized.action !== "stop_run" &&
      normalized.action !== "approve_permission" &&
      normalized.action !== "deny_permission" &&
      normalized.action !== "approve_subagent_creation" &&
      normalized.action !== "deny_subagent_creation" &&
      normalized.action !== "model_switch_select_scenario" &&
      normalized.action !== "model_switch_apply"
    ) {
      logger.debug("ignoring unsupported lark card action", {
        installationId: input.installationId,
        action: normalized.action,
      });
      return null;
    }

    if (normalized.action === "stop_run") {
      if (normalized.runId == null) {
        logger.warn("ignoring stop card action without run id", {
          installationId: input.installationId,
          action: normalized.action,
        });
        return {
          toast: {
            type: "error",
            content: "无法识别要停止的运行",
          },
        };
      }

      const result = input.control.stopRun({
        runId: normalized.runId,
        actor:
          normalized.actorOpenId == null
            ? `lark:${input.installationId}:unknown`
            : `lark:${input.installationId}:${normalized.actorOpenId}`,
        sourceKind: "button",
        requestScope: "run",
        reasonText: "stop requested from lark card action",
      });

      logger.info("processed lark stop card action", {
        installationId: input.installationId,
        action: normalized.action,
        runId: normalized.runId,
        accepted: result.accepted,
      });

      return {
        toast: {
          type: result.accepted ? "success" : "info",
          content: result.accepted ? "正在停止..." : "该运行已结束或无法停止",
        },
      };
    }

    if (
      normalized.action === "model_switch_select_scenario" ||
      normalized.action === "model_switch_apply"
    ) {
      if (input.modelSwitch == null) {
        return {
          toast: {
            type: "error",
            content: "当前环境未启用模型切换",
          },
        };
      }
      if (normalized.scenario == null) {
        return {
          toast: {
            type: "error",
            content: "无法识别目标场景",
          },
        };
      }

      try {
        if (normalized.action === "model_switch_select_scenario") {
          return buildLarkModelSwitchCardCallbackResponse({
            overview: input.modelSwitch.getOverview(),
            selectedScenario: normalized.scenario,
          });
        }

        if (normalized.modelId == null) {
          return {
            toast: {
              type: "error",
              content: "无法识别目标模型",
            },
          };
        }

        const result = await input.modelSwitch.switchScenarioModel({
          scenario: normalized.scenario,
          modelId: normalized.modelId,
        });
        return buildLarkModelSwitchCardCallbackResponse({
          overview: input.modelSwitch.getOverview(),
          selectedScenario: result.scenario,
          message: `已将 ${result.scenario} 切换到 ${result.nextModelId}。新配置会从下一次新的输入开始生效。`,
          warnings: result.warnings,
          toast: {
            type: "success",
            content: `已切换 ${result.scenario} → ${result.nextModelId}`,
          },
        });
      } catch (error: unknown) {
        logger.error("failed to process lark model switch card action", {
          installationId: input.installationId,
          action: normalized.action,
          scenario: normalized.scenario,
          modelId: normalized.modelId,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          toast: {
            type: "error",
            content: error instanceof Error ? error.message : "模型切换失败",
          },
        };
      }
    }

    if (
      normalized.action === "approve_subagent_creation" ||
      normalized.action === "deny_subagent_creation"
    ) {
      if (normalized.requestId == null) {
        return {
          toast: {
            type: "error",
            content: "无法识别 SubAgent 创建请求",
          },
        };
      }

      if (input.subagentRequests == null) {
        logger.warn("received subagent creation card action without orchestration handler", {
          installationId: input.installationId,
          action: normalized.action,
          requestId: normalized.requestId,
        });
        return {
          toast: {
            type: "error",
            content: "当前环境未启用 SubAgent 创建",
          },
        };
      }

      try {
        if (normalized.action === "approve_subagent_creation") {
          const result = await input.subagentRequests.approve(normalized.requestId);
          return {
            toast: buildSubagentCreationActionToast(result),
          };
        }

        const result = await input.subagentRequests.deny(normalized.requestId);
        return {
          toast: buildSubagentCreationActionToast(result),
        };
      } catch (error: unknown) {
        logger.error("failed to process lark subagent creation card action", {
          installationId: input.installationId,
          action: normalized.action,
          requestId: normalized.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          toast: {
            type: "error",
            content: "SubAgent 创建失败",
          },
        };
      }
    }

    if (normalized.approvalId == null) {
      logger.warn("ignoring approval card action without approval id", {
        installationId: input.installationId,
        action: normalized.action,
      });
      return {
        toast: {
          type: "error",
          content: "无法识别授权请求",
        },
      };
    }

    const actor =
      normalized.actorOpenId == null
        ? `lark:${input.installationId}:unknown`
        : `lark:${input.installationId}:${normalized.actorOpenId}`;
    const matched = input.ingress.submitApprovalDecision({
      approvalId: normalized.approvalId,
      decision: normalized.action === "deny_permission" ? "deny" : "approve",
      actor,
      rawInput:
        normalized.action === "deny_permission"
          ? "deny"
          : normalized.grantTtl === "one_day"
            ? "approve_1d"
            : normalized.grantTtl === "permanent"
              ? "approve_permanent"
              : "approve",
      grantedBy: "user",
      ...(normalized.action === "deny_permission"
        ? {}
        : {
            expiresAt:
              normalized.grantTtl === "one_day" ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null,
          }),
    });

    logger.info("processed lark approval card action", {
      installationId: input.installationId,
      action: normalized.action,
      approvalId: normalized.approvalId,
      grantTtl: normalized.grantTtl,
      matched,
    });

    return {
      toast: {
        type:
          normalized.action === "deny_permission"
            ? matched
              ? "error"
              : "info"
            : matched
              ? "success"
              : "info",
        content: !matched
          ? "该授权请求已结束或无法处理"
          : normalized.action === "deny_permission"
            ? "已拒绝"
            : normalized.grantTtl === "one_day"
              ? "已允许 1天"
              : normalized.grantTtl === "permanent"
                ? "已允许 永久"
                : "已允许 本次",
      },
    };
  };
}

function buildSubagentCreationActionToast(result: ResolveSubagentCreationRequestResult): {
  type: "success" | "info";
  content: string;
} {
  switch (result.outcome) {
    case "created":
      return {
        type: "success",
        content: "SubAgent 已创建",
      };
    case "denied":
      return {
        type: "info",
        content: "已取消创建",
      };
    case "already_created":
      return {
        type: "info",
        content: "SubAgent 已创建",
      };
    case "already_denied":
      return {
        type: "info",
        content: "该请求已取消",
      };
    case "already_expired":
      return {
        type: "info",
        content: "该请求已过期",
      };
    case "already_failed":
      return {
        type: "info",
        content: "该请求已结束",
      };
    case "provisioning":
      return {
        type: "info",
        content: "SubAgent 正在创建中",
      };
  }
}

export function createLarkInboundRuntime(input: CreateLarkInboundRuntimeInput): LarkInboundRuntime {
  const wsClientFactory =
    input.wsClientFactory ??
    ((installation: ConfiguredLarkInstallation) =>
      new Lark.WSClient({
        appId: installation.appId,
        appSecret: installation.appSecret,
        autoReconnect: true,
      }));
  const sockets = new Map<string, Lark.WSClient>();
  let started = false;

  return {
    start() {
      if (started) {
        logger.debug("lark inbound runtime start skipped because it is already running");
        return;
      }

      for (const installation of input.installations) {
        if (installation.config.connectionMode !== "websocket") {
          logger.warn(
            "skipping lark inbound installation because webhook mode is not implemented",
            {
              installationId: installation.installationId,
              connectionMode: installation.config.connectionMode,
            },
          );
          continue;
        }

        logger.info("initializing lark websocket inbound installation", {
          installationId: installation.installationId,
          connectionMode: installation.config.connectionMode,
          appId: installation.appId,
          appSecretLength: installation.appSecret.length,
        });

        const onMessage = createLarkMessageReceiveHandler({
          installationId: installation.installationId,
          storage: input.storage,
          ingress: input.ingress,
          control: input.control,
          ...(input.clients == null ? {} : { clients: input.clients }),
          ...(input.status == null ? {} : { status: input.status }),
          ...(input.runtimeModes == null ? {} : { runtimeModes: input.runtimeModes }),
          ...(input.modelSwitch == null ? {} : { modelSwitch: input.modelSwitch }),
          ...(input.clients == null
            ? {}
            : {
                quoteMessageFetcher: createLarkQuoteMessageFetcher({
                  installationId: installation.installationId,
                  clients: input.clients,
                }),
              }),
          ...(input.taskThreads == null ? {} : { taskThreads: input.taskThreads }),
          ...(input.steerReactionState == null
            ? {}
            : { steerReactionState: input.steerReactionState }),
        });
        const onCardAction = createLarkCardActionHandler({
          installationId: installation.installationId,
          ingress: input.ingress,
          control: input.control,
          ...(input.modelSwitch == null ? {} : { modelSwitch: input.modelSwitch }),
          ...(input.subagentRequests == null ? {} : { subagentRequests: input.subagentRequests }),
          ...(input.a2uiCallbacks == null ? {} : { a2uiCallbacks: input.a2uiCallbacks }),
        });

        const dispatcher = new Lark.EventDispatcher({}).register({
          "im.message.receive_v1": (data: unknown) => {
            void onMessage(data).catch((error: unknown) => {
              if (isAbortLikeError(error)) {
                logger.info("lark inbound message run was cancelled", {
                  installationId: installation.installationId,
                  reason: error instanceof Error ? error.message : String(error),
                });
                return;
              }

              logger.error("failed to process lark inbound message", {
                installationId: installation.installationId,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          },
          "im.message.message_read_v1": () => {},
          "card.action.trigger": (data: unknown) => {
            logger.debug("dispatching lark card action callback", {
              installationId: installation.installationId,
              payloadPreview: truncateLogText(
                safeJson(data),
                LARK_CARD_ACTION_LOG_PREVIEW_MAX_LENGTH,
              ),
            });

            return onCardAction(data).catch((error: unknown) => {
              logger.error("failed to process lark card action", {
                installationId: installation.installationId,
                error: error instanceof Error ? error.message : String(error),
              });
              return {
                toast: {
                  type: "error",
                  content: "操作失败",
                },
              };
            });
          },
        } as Record<string, (data: unknown) => void>);

        const socket = wsClientFactory(installation);
        patchWsClientForCardCallbacks(socket);
        socket.start({ eventDispatcher: dispatcher });
        sockets.set(installation.installationId, socket);

        logger.info("started lark websocket inbound monitor", {
          installationId: installation.installationId,
        });
      }

      started = true;
      logger.info("lark inbound runtime started", {
        configuredInstallations: input.installations.length,
        activeSockets: sockets.size,
      });
    },

    async shutdown() {
      if (!started) {
        logger.debug("lark inbound runtime shutdown skipped because it never started");
        return;
      }

      for (const [installationId, socket] of sockets) {
        socket.close({ force: true });
        logger.info("closed lark websocket inbound monitor", {
          installationId,
        });
      }
      sockets.clear();
      started = false;
      logger.info("lark inbound runtime shutdown complete");
    },

    status(): LarkInboundRuntimeStatus {
      return {
        started,
        activeSockets: sockets.size,
      };
    },
  };
}

function patchWsClientForCardCallbacks(socket: Lark.WSClient): void {
  const candidate = socket as unknown as {
    handleEventData?: (data: unknown) => unknown;
  };
  if (typeof candidate.handleEventData !== "function") {
    return;
  }

  const original = candidate.handleEventData.bind(socket);
  candidate.handleEventData = (data: unknown) => {
    if (isRecord(data) && Array.isArray(data.headers)) {
      const isCardPacket = data.headers.some(
        (header) => isRecord(header) && header.key === "type" && header.value === "card",
      );
      if (isCardPacket) {
        logger.debug("received lark ws card callback packet", {
          payloadPreview: truncateLogText(safeJson(data), LARK_CARD_ACTION_LOG_PREVIEW_MAX_LENGTH),
        });
      }

      data.headers = data.headers.map((header) => {
        if (isRecord(header) && header.key === "type" && header.value === "card") {
          return {
            ...header,
            value: "event",
          };
        }

        return header;
      });
    }

    return original(data);
  };
}

function resolveOrPairLarkChatSurface(input: {
  db: StorageDb;
  installationId: string;
  chatId: string;
  chatType: string | null;
}) {
  const surfacesRepo = new ChannelSurfacesRepo(input.db);
  const surfaceKey = buildLarkChatSurfaceKey(input.chatId);
  const existing = surfacesRepo.getBySurfaceKey({
    channelType: LARK_CHANNEL_TYPE,
    channelInstallationId: input.installationId,
    surfaceKey,
  });
  if (existing != null) {
    return existing;
  }

  const channelInstancesRepo = new ChannelInstancesRepo(input.db);
  const conversationsRepo = new ConversationsRepo(input.db);
  const branchesRepo = new ConversationBranchesRepo(input.db);
  const agentsRepo = new AgentsRepo(input.db);
  const sessionsRepo = new SessionsRepo(input.db);
  const now = new Date();

  const channelInstance = channelInstancesRepo.getByProviderAndAccountKey(
    LARK_CHANNEL_TYPE,
    input.installationId,
  );
  if (channelInstance == null) {
    return pairInitialLarkInstallation({
      db: input.db,
      installationId: input.installationId,
      chatId: input.chatId,
      chatType: input.chatType,
      now,
    });
  }
  if (channelInstance == null) {
    return null;
  }

  const conversation = conversationsRepo.findByChannelInstanceAndExternalChat(
    channelInstance.id,
    input.chatId,
  );
  if (conversation == null) {
    logger.info("ignoring unmatched lark chat for already paired installation", {
      installationId: input.installationId,
      chatId: input.chatId,
      channelInstanceId: channelInstance.id,
      reason: "installation already paired but conversation is unknown",
    });
    return null;
  }
  if (conversation == null) {
    return null;
  }

  let mainBranch = branchesRepo.findByConversationAndBranchKey(conversation.id, "main");
  if (mainBranch == null) {
    const branchId = randomUUID();
    branchesRepo.create({
      id: branchId,
      conversationId: conversation.id,
      kind: conversation.kind === "dm" ? "dm_main" : "group_main",
      branchKey: "main",
      createdAt: now,
      updatedAt: now,
    });
    mainBranch = branchesRepo.getById(branchId);
    logger.info("provisioned main branch for lark conversation", {
      installationId: input.installationId,
      chatId: input.chatId,
      conversationId: conversation.id,
      branchId,
    });
  }
  if (mainBranch == null) {
    return null;
  }

  let mainAgent = agentsRepo.findByConversationId(conversation.id);
  if (mainAgent == null) {
    const agentId = randomUUID();
    agentsRepo.create({
      id: agentId,
      conversationId: conversation.id,
      kind: "main",
      createdAt: now,
    });
    mainAgent = agentsRepo.getById(agentId);
    logger.info("provisioned main agent for lark conversation", {
      installationId: input.installationId,
      chatId: input.chatId,
      conversationId: conversation.id,
      agentId,
    });
  }
  if (mainAgent == null) {
    return null;
  }

  const latestSession = sessionsRepo.findLatestByConversationBranch(
    conversation.id,
    mainBranch.id,
    {
      purpose: "chat",
      statuses: ["active", "paused"],
    },
  );
  if (latestSession == null) {
    const sessionId = randomUUID();
    sessionsRepo.create({
      id: sessionId,
      conversationId: conversation.id,
      branchId: mainBranch.id,
      ownerAgentId: mainAgent.id,
      purpose: "chat",
      createdAt: now,
      updatedAt: now,
    });
    logger.info("provisioned main chat session for lark conversation", {
      installationId: input.installationId,
      chatId: input.chatId,
      conversationId: conversation.id,
      branchId: mainBranch.id,
      sessionId,
    });
  }

  logger.info("pairing or refreshing lark channel surface from existing conversation", {
    installationId: input.installationId,
    chatId: input.chatId,
    conversationId: conversation.id,
    branchId: mainBranch.id,
  });

  return surfacesRepo.upsert({
    id: randomUUID(),
    channelType: LARK_CHANNEL_TYPE,
    channelInstallationId: input.installationId,
    conversationId: conversation.id,
    branchId: mainBranch.id,
    surfaceKey,
    surfaceObjectJson: JSON.stringify({
      chat_id: input.chatId,
      ...(input.chatType == null ? {} : { chat_type: input.chatType }),
    }),
  });
}

function pairInitialLarkInstallation(input: {
  db: StorageDb;
  installationId: string;
  chatId: string;
  chatType: string | null;
  now: Date;
}) {
  const channelInstancesRepo = new ChannelInstancesRepo(input.db);
  const conversationsRepo = new ConversationsRepo(input.db);
  const branchesRepo = new ConversationBranchesRepo(input.db);
  const agentsRepo = new AgentsRepo(input.db);
  const sessionsRepo = new SessionsRepo(input.db);
  const surfacesRepo = new ChannelSurfacesRepo(input.db);

  const channelInstanceId = randomUUID();
  const conversationId = randomUUID();
  const branchId = randomUUID();
  const agentId = randomUUID();
  const sessionId = randomUUID();
  const conversationKind = input.chatType === "p2p" ? "dm" : "group";
  const surfaceKey = buildLarkChatSurfaceKey(input.chatId);

  channelInstancesRepo.create({
    id: channelInstanceId,
    provider: LARK_CHANNEL_TYPE,
    accountKey: input.installationId,
    createdAt: input.now,
    updatedAt: input.now,
  });
  conversationsRepo.create({
    id: conversationId,
    channelInstanceId,
    externalChatId: input.chatId,
    kind: conversationKind,
    createdAt: input.now,
    updatedAt: input.now,
  });
  branchesRepo.create({
    id: branchId,
    conversationId,
    kind: conversationKind === "dm" ? "dm_main" : "group_main",
    branchKey: "main",
    createdAt: input.now,
    updatedAt: input.now,
  });
  agentsRepo.create({
    id: agentId,
    conversationId,
    kind: "main",
    createdAt: input.now,
  });
  sessionsRepo.create({
    id: sessionId,
    conversationId,
    branchId,
    ownerAgentId: agentId,
    purpose: "chat",
    createdAt: input.now,
    updatedAt: input.now,
  });

  logger.info("paired initial lark installation to first inbound chat", {
    installationId: input.installationId,
    chatId: input.chatId,
    channelInstanceId,
    conversationId,
    branchId,
    agentId,
    sessionId,
    conversationKind,
  });

  return surfacesRepo.upsert({
    id: randomUUID(),
    channelType: LARK_CHANNEL_TYPE,
    channelInstallationId: input.installationId,
    conversationId,
    branchId,
    surfaceKey,
    surfaceObjectJson: JSON.stringify({
      chat_id: input.chatId,
      ...(input.chatType == null ? {} : { chat_type: input.chatType }),
    }),
    createdAt: input.now,
    updatedAt: input.now,
  });
}

async function resolveLarkInboundRoute(input: {
  db: StorageDb;
  installationId: string;
  mainSurface: ChannelSurface;
  normalized: NormalizedLarkTextMessage;
  taskThreads?: CreateLarkInboundRuntimeInput["taskThreads"];
  quoteMessageFetcher?: (input: {
    installationId: string;
    messageId: string;
  }) => Promise<LarkQuotedMessage | null>;
}): Promise<LarkInboundRoute | null> {
  const sessionsRepo = new SessionsRepo(input.db);

  if (input.normalized.threadId == null) {
    const session = sessionsRepo.findLatestByConversationBranch(
      input.mainSurface.conversationId,
      input.mainSurface.branchId,
      {
        purpose: "chat",
        statuses: ["active", "paused"],
      },
    );
    if (session == null) {
      logger.warn("dropping lark inbound message because no chat session matched main surface", {
        installationId: input.installationId,
        chatId: input.normalized.chatId,
        messageId: input.normalized.messageId,
        conversationId: input.mainSurface.conversationId,
        branchId: input.mainSurface.branchId,
      });
      return null;
    }

    return {
      kind: "main_chat",
      conversationId: input.mainSurface.conversationId,
      branchId: input.mainSurface.branchId,
      sessionId: session.id,
      scenario: "chat",
      stopScope: "conversation",
      chatId: input.normalized.chatId,
      replyToMessageId: null,
    };
  }

  const allowTaskFollowupCreation = !isLarkThreadControlCommand(input.normalized.text);
  // channel_threads is the durable source of truth for thread routing. We only
  // fall back to lark_object_bindings when bootstrapping an older task thread
  // into that persisted model for the first time.
  const channelThread = new ChannelThreadsRepo(input.db).getByExternalThread({
    channelType: LARK_CHANNEL_TYPE,
    channelInstallationId: input.installationId,
    externalChatId: input.normalized.chatId,
    externalThreadId: input.normalized.threadId,
  });
  if (channelThread != null) {
    const routed = resolveStoredChannelThreadRoute({
      db: input.db,
      installationId: input.installationId,
      normalized: input.normalized,
      channelThread,
      allowTaskFollowupCreation,
      taskThreads: input.taskThreads,
    });
    if (routed != null) {
      return routed;
    }
  }

  const taskThread = resolveTaskThreadRoute({
    db: input.db,
    installationId: input.installationId,
    normalized: input.normalized,
    allowTaskFollowupCreation,
    taskThreads: input.taskThreads,
  });
  if (taskThread != null) {
    return taskThread;
  }

  const ordinaryThread = resolveExistingOrdinaryThreadRoute({
    db: input.db,
    installationId: input.installationId,
    chatId: input.normalized.chatId,
    threadId: input.normalized.threadId,
    ...(input.normalized.createdAt == null ? {} : { createdAt: input.normalized.createdAt }),
  });
  if (ordinaryThread != null) {
    return ordinaryThread;
  }

  return createOrdinaryThreadRoute({
    db: input.db,
    installationId: input.installationId,
    mainSurface: input.mainSurface,
    normalized: input.normalized,
    ...(input.quoteMessageFetcher == null
      ? {}
      : { quoteMessageFetcher: input.quoteMessageFetcher }),
  });
}

function resolveExistingOrdinaryThreadRoute(input: {
  db: StorageDb;
  installationId: string;
  chatId: string;
  threadId: string;
  createdAt?: Date;
}): LarkInboundRoute | null {
  const surfacesRepo = new ChannelSurfacesRepo(input.db);
  const sessionsRepo = new SessionsRepo(input.db);
  const channelThreadsRepo = new ChannelThreadsRepo(input.db);
  const threadSurface = surfacesRepo.getBySurfaceKey({
    channelType: LARK_CHANNEL_TYPE,
    channelInstallationId: input.installationId,
    surfaceKey: buildLarkThreadSurfaceKey(input.chatId, input.threadId),
  });
  if (threadSurface == null) {
    return null;
  }

  const threadSession = sessionsRepo.findLatestByConversationBranch(
    threadSurface.conversationId,
    threadSurface.branchId,
    {
      purpose: "chat",
      statuses: ["active", "paused"],
    },
  );
  if (threadSession == null) {
    logger.warn("lark thread surface exists without an active thread chat session", {
      installationId: input.installationId,
      chatId: input.chatId,
      threadId: input.threadId,
      conversationId: threadSurface.conversationId,
      branchId: threadSurface.branchId,
    });
    return null;
  }

  const surfaceObject = parseSurfaceObject(threadSurface.surfaceObjectJson);
  channelThreadsRepo.upsert({
    id: randomUUID(),
    channelType: LARK_CHANNEL_TYPE,
    channelInstallationId: input.installationId,
    homeConversationId: threadSurface.conversationId,
    externalChatId: input.chatId,
    externalThreadId: input.threadId,
    subjectKind: "chat",
    branchId: threadSurface.branchId,
    openedFromMessageId: readString(surfaceObject.reply_to_message_id),
    ...(input.createdAt == null ? {} : { createdAt: input.createdAt, updatedAt: input.createdAt }),
  });
  return {
    kind: "ordinary_thread",
    conversationId: threadSurface.conversationId,
    branchId: threadSurface.branchId,
    sessionId: threadSession.id,
    scenario: "chat",
    stopScope: "session",
    chatId: input.chatId,
    replyToMessageId: readString(surfaceObject.reply_to_message_id),
  };
}

function resolveTaskThreadRoute(input: {
  db: StorageDb;
  installationId: string;
  normalized: NormalizedLarkTextMessage;
  allowTaskFollowupCreation: boolean;
  taskThreads?: CreateLarkInboundRuntimeInput["taskThreads"];
}): LarkInboundRoute | null {
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

  const metadata = parseBindingMetadata(binding.metadataJson);
  const taskRunId = readString(metadata.taskRunId);
  if (taskRunId == null) {
    return null;
  }

  const taskRunsRepo = new TaskRunsRepo(input.db);
  const taskRun = taskRunsRepo.getById(taskRunId);
  if (taskRun == null) {
    logger.warn("ignoring lark task thread binding because task run is missing", {
      channelInstallationId: binding.channelInstallationId,
      larkMessageId: binding.larkMessageId,
      threadRootMessageId: threadId,
      taskRunId,
    });
    return null;
  }

  const workstreamId = ensureTaskRunWorkstream({
    db: input.db,
    taskRun,
    ...(input.normalized.createdAt == null ? {} : { createdAt: input.normalized.createdAt }),
  });
  const rootTaskRunId = ensureTaskRunThreadRoot({
    db: input.db,
    taskRun,
  });
  const rootBinding = bindingsRepo.getByInternalObject({
    channelInstallationId: input.installationId,
    internalObjectKind: RUN_CARD_OBJECT_KIND,
    internalObjectId: buildTaskRunCardObjectId(taskRun.id),
  });
  const channelThread = new ChannelThreadsRepo(input.db).upsert({
    id: randomUUID(),
    channelType: LARK_CHANNEL_TYPE,
    channelInstallationId: input.installationId,
    homeConversationId: taskRun.conversationId,
    externalChatId: input.normalized.chatId,
    externalThreadId: threadId,
    subjectKind: "task",
    rootTaskRunId,
    openedFromMessageId:
      rootBinding?.larkMessageId ??
      binding.larkMessageId ??
      input.normalized.parentMessageId ??
      input.normalized.messageId,
    ...(input.normalized.createdAt == null
      ? {}
      : { createdAt: input.normalized.createdAt, updatedAt: input.normalized.createdAt }),
  });
  if (
    taskRun.initiatorThreadId == null ||
    taskRun.workstreamId == null ||
    taskRun.threadRootRunId == null
  ) {
    taskRunsRepo.updateWorkstream({
      id: taskRun.id,
      workstreamId,
      threadRootRunId: rootTaskRunId,
      initiatorThreadId: taskRun.initiatorThreadId ?? channelThread.id,
    });
  }

  return resolveStoredChannelThreadRoute({
    db: input.db,
    installationId: input.installationId,
    normalized: input.normalized,
    channelThread,
    allowTaskFollowupCreation: input.allowTaskFollowupCreation,
    taskThreads: input.taskThreads,
  });
}

async function createOrdinaryThreadRoute(input: {
  db: StorageDb;
  installationId: string;
  mainSurface: ChannelSurface;
  normalized: NormalizedLarkTextMessage;
  quoteMessageFetcher?: (input: {
    installationId: string;
    messageId: string;
  }) => Promise<LarkQuotedMessage | null>;
}): Promise<LarkInboundRoute | null> {
  const sessionsRepo = new SessionsRepo(input.db);
  const branchesRepo = new ConversationBranchesRepo(input.db);
  const surfacesRepo = new ChannelSurfacesRepo(input.db);
  const channelThreadsRepo = new ChannelThreadsRepo(input.db);
  const messagesRepo = new MessagesRepo(input.db);
  const now = input.normalized.createdAt ?? new Date();
  const threadId = input.normalized.threadId;
  if (threadId == null) {
    return null;
  }

  const sourceSession = sessionsRepo.findLatestByConversationBranch(
    input.mainSurface.conversationId,
    input.mainSurface.branchId,
    {
      purpose: "chat",
      statuses: ["active", "paused"],
    },
  );
  if (sourceSession == null) {
    logger.warn("cannot create ordinary lark thread because main chat session is missing", {
      installationId: input.installationId,
      chatId: input.normalized.chatId,
      threadId,
      conversationId: input.mainSurface.conversationId,
      branchId: input.mainSurface.branchId,
    });
    return null;
  }

  const branchId = randomUUID();
  const sessionId = randomUUID();
  branchesRepo.create({
    id: branchId,
    conversationId: input.mainSurface.conversationId,
    kind: input.normalized.chatType === "p2p" ? "dm_thread" : "group_thread",
    branchKey: `thread:${threadId}`,
    externalBranchId: threadId,
    parentBranchId: input.mainSurface.branchId,
    createdAt: now,
    updatedAt: now,
  });
  materializeForkedSessionSnapshotInStorage({
    db: input.db,
    targetSession: {
      id: sessionId,
      conversationId: input.mainSurface.conversationId,
      branchId,
      ownerAgentId: sourceSession.ownerAgentId,
      purpose: "chat",
      contextMode: sourceSession.contextMode,
      createdAt: now,
      updatedAt: now,
    },
    sourceSessionId: sourceSession.id,
  });
  messagesRepo.append({
    id: randomUUID(),
    sessionId,
    seq: messagesRepo.getNextSeq(sessionId),
    role: "user",
    messageType: "thread_kickoff",
    visibility: "hidden_system",
    payloadJson: JSON.stringify({
      content: await buildOrdinaryThreadKickoffContent({
        normalized: input.normalized,
        installationId: input.installationId,
        ...(input.quoteMessageFetcher == null
          ? {}
          : { quoteMessageFetcher: input.quoteMessageFetcher }),
      }),
    }),
    createdAt: now,
  });
  surfacesRepo.upsert({
    id: randomUUID(),
    channelType: LARK_CHANNEL_TYPE,
    channelInstallationId: input.installationId,
    conversationId: input.mainSurface.conversationId,
    branchId,
    surfaceKey: buildLarkThreadSurfaceKey(input.normalized.chatId, threadId),
    surfaceObjectJson: JSON.stringify({
      chat_id: input.normalized.chatId,
      thread_id: threadId,
      reply_to_message_id: input.normalized.parentMessageId ?? input.normalized.messageId,
    }),
    createdAt: now,
    updatedAt: now,
  });
  channelThreadsRepo.upsert({
    id: randomUUID(),
    channelType: LARK_CHANNEL_TYPE,
    channelInstallationId: input.installationId,
    homeConversationId: input.mainSurface.conversationId,
    externalChatId: input.normalized.chatId,
    externalThreadId: threadId,
    subjectKind: "chat",
    branchId,
    openedFromMessageId: input.normalized.parentMessageId ?? input.normalized.messageId,
    createdAt: now,
    updatedAt: now,
  });

  return {
    kind: "ordinary_thread",
    conversationId: input.mainSurface.conversationId,
    branchId,
    sessionId,
    scenario: "chat",
    stopScope: "session",
    chatId: input.normalized.chatId,
    replyToMessageId: input.normalized.parentMessageId ?? input.normalized.messageId,
  };
}

function resolveStoredChannelThreadRoute(input: {
  db: StorageDb;
  installationId: string;
  normalized: NormalizedLarkTextMessage;
  channelThread: {
    id: string;
    subjectKind: string;
    branchId: string | null;
    rootTaskRunId: string | null;
    homeConversationId: string;
    openedFromMessageId: string | null;
  };
  allowTaskFollowupCreation: boolean;
  taskThreads?: CreateLarkInboundRuntimeInput["taskThreads"];
}): LarkInboundRoute | null {
  const sessionsRepo = new SessionsRepo(input.db);
  if (input.channelThread.subjectKind === "chat") {
    if (input.channelThread.branchId == null) {
      logger.warn("ignoring invalid stored lark chat thread without branch", {
        installationId: input.installationId,
        threadId: input.normalized.threadId,
        channelThreadId: input.channelThread.id,
      });
      return null;
    }

    const threadSession = sessionsRepo.findLatestByConversationBranch(
      input.channelThread.homeConversationId,
      input.channelThread.branchId,
      {
        purpose: "chat",
        statuses: ["active", "paused"],
      },
    );
    if (threadSession == null) {
      logger.warn("stored lark chat thread has no active chat session", {
        installationId: input.installationId,
        threadId: input.normalized.threadId,
        channelThreadId: input.channelThread.id,
        conversationId: input.channelThread.homeConversationId,
        branchId: input.channelThread.branchId,
      });
      return null;
    }

    return {
      kind: "ordinary_thread",
      conversationId: input.channelThread.homeConversationId,
      branchId: input.channelThread.branchId,
      sessionId: threadSession.id,
      scenario: "chat",
      stopScope: "session",
      chatId: input.normalized.chatId,
      replyToMessageId: input.channelThread.openedFromMessageId,
    };
  }

  if (input.channelThread.rootTaskRunId == null) {
    logger.warn("ignoring invalid stored lark task thread without root task run", {
      installationId: input.installationId,
      threadId: input.normalized.threadId,
      channelThreadId: input.channelThread.id,
    });
    return null;
  }

  const taskRunsRepo = new TaskRunsRepo(input.db);
  const activeRun = taskRunsRepo.findActiveByThreadRootRunId(input.channelThread.rootTaskRunId);
  if (activeRun != null && activeRun.executionSessionId != null) {
    const activeSession = sessionsRepo.getById(activeRun.executionSessionId);
    if (
      activeSession != null &&
      activeSession.purpose === "task" &&
      (activeSession.status === "active" || activeSession.status === "paused")
    ) {
      return {
        kind: "task_thread",
        conversationId: activeRun.conversationId,
        branchId: activeRun.branchId,
        sessionId: activeSession.id,
        taskRunId: activeRun.id,
        scenario: "task",
        stopScope: "session",
        chatId: input.normalized.chatId,
        replyToMessageId:
          input.normalized.parentMessageId ?? input.channelThread.openedFromMessageId ?? null,
      };
    }

    logger.warn("ignoring stale active task run session for stored lark task thread", {
      installationId: input.installationId,
      threadId: input.normalized.threadId,
      channelThreadId: input.channelThread.id,
      taskRunId: activeRun.id,
      executionSessionId: activeRun.executionSessionId,
      sessionStatus: activeSession?.status ?? null,
      sessionPurpose: activeSession?.purpose ?? null,
    });
  }

  const latestRun = taskRunsRepo.findLatestByThreadRootRunId(input.channelThread.rootTaskRunId);
  if (latestRun == null) {
    logger.warn("stored lark task thread has no runs in its lineage", {
      installationId: input.installationId,
      threadId: input.normalized.threadId,
      channelThreadId: input.channelThread.id,
      rootTaskRunId: input.channelThread.rootTaskRunId,
    });
    return null;
  }

  if (input.allowTaskFollowupCreation && input.taskThreads != null) {
    const created = input.taskThreads.createFollowupExecution({
      rootTaskRunId: input.channelThread.rootTaskRunId,
      initiatorThreadId: input.channelThread.id,
      ...(input.normalized.createdAt == null ? {} : { createdAt: input.normalized.createdAt }),
    });
    return {
      kind: "task_thread",
      conversationId: created.conversationId,
      branchId: created.branchId,
      sessionId: created.sessionId,
      taskRunId: created.taskRunId,
      scenario: "task",
      stopScope: "session",
      chatId: input.normalized.chatId,
      replyToMessageId:
        input.normalized.parentMessageId ?? input.channelThread.openedFromMessageId ?? null,
    };
  }

  if (latestRun.executionSessionId == null) {
    logger.warn("latest task run for stored lark task thread has no execution session", {
      installationId: input.installationId,
      threadId: input.normalized.threadId,
      channelThreadId: input.channelThread.id,
      taskRunId: latestRun.id,
    });
    return null;
  }

  const latestSession = sessionsRepo.getById(latestRun.executionSessionId);
  if (latestSession == null || latestSession.purpose !== "task") {
    logger.warn("latest task run session for stored lark task thread is missing or invalid", {
      installationId: input.installationId,
      threadId: input.normalized.threadId,
      channelThreadId: input.channelThread.id,
      taskRunId: latestRun.id,
      executionSessionId: latestRun.executionSessionId,
      sessionPurpose: latestSession?.purpose ?? null,
    });
    return null;
  }

  return {
    kind: "task_thread",
    conversationId: latestRun.conversationId,
    branchId: latestRun.branchId,
    sessionId: latestSession.id,
    taskRunId: latestRun.id,
    scenario: "task",
    stopScope: "session",
    chatId: input.normalized.chatId,
    replyToMessageId:
      input.normalized.parentMessageId ?? input.channelThread.openedFromMessageId ?? null,
  };
}

function ensureTaskRunWorkstream(input: {
  db: StorageDb;
  taskRun: TaskRun;
  createdAt?: Date;
}): string {
  if (input.taskRun.workstreamId != null) {
    return input.taskRun.workstreamId;
  }

  const now = input.createdAt ?? new Date();
  const workstream = new TaskWorkstreamsRepo(input.db).create({
    id: randomUUID(),
    ownerAgentId: input.taskRun.ownerAgentId,
    conversationId: input.taskRun.conversationId,
    branchId: input.taskRun.branchId,
    createdAt: now,
    updatedAt: now,
  });
  new TaskRunsRepo(input.db).updateWorkstream({
    id: input.taskRun.id,
    workstreamId: workstream.id,
  });

  if (input.taskRun.cronJobId != null) {
    const cronJobsRepo = new CronJobsRepo(input.db);
    const cronJob = cronJobsRepo.getById(input.taskRun.cronJobId);
    if (cronJob != null && cronJob.workstreamId == null) {
      cronJobsRepo.updateWorkstreamId({
        id: cronJob.id,
        workstreamId: workstream.id,
      });
    }
  }

  return workstream.id;
}

function ensureTaskRunThreadRoot(input: { db: StorageDb; taskRun: TaskRun }): string {
  if (input.taskRun.threadRootRunId != null) {
    return input.taskRun.threadRootRunId;
  }

  new TaskRunsRepo(input.db).updateWorkstream({
    id: input.taskRun.id,
    workstreamId: input.taskRun.workstreamId ?? null,
    threadRootRunId: input.taskRun.id,
  });
  return input.taskRun.id;
}

function settleTaskThreadCompletionIfNeeded(input: {
  taskThreads: NonNullable<CreateLarkInboundRuntimeInput["taskThreads"]>;
  taskRunId: string;
  submitResult: unknown;
  finishedAt: Date;
}): void {
  const started = extractStartedSubmitMessageResult(input.submitResult);
  if (started == null) {
    return;
  }

  const completion = extractTaskCompletionSignal({
    details: started.run.stopSignal?.payload,
  });
  if (completion == null) {
    return;
  }

  if (completion.status === "completed") {
    input.taskThreads.completeTaskExecution({
      taskRunId: input.taskRunId,
      resultSummary: completion.finalMessage,
      finishedAt: input.finishedAt,
    });
    return;
  }

  if (completion.status === "blocked") {
    input.taskThreads.blockTaskExecution({
      taskRunId: input.taskRunId,
      resultSummary: completion.finalMessage,
      finishedAt: input.finishedAt,
    });
    return;
  }

  input.taskThreads.failTaskExecution({
    taskRunId: input.taskRunId,
    errorText: completion.finalMessage,
    resultSummary: completion.finalMessage,
    finishedAt: input.finishedAt,
  });
}

function extractStartedSubmitMessageResult(
  value: unknown,
): Extract<SubmitMessageResult, { status: "started" }> | null {
  if (!isRecord(value) || value.status !== "started" || !isRecord(value.run)) {
    return null;
  }
  return value as Extract<SubmitMessageResult, { status: "started" }>;
}

function isLarkThreadControlCommand(text: string): boolean {
  return (
    text === "/stop" ||
    text === "/status" ||
    text === "/model" ||
    text === "/help" ||
    isLarkYoloCommand(text)
  );
}

function buildTaskRunCardObjectId(taskRunId: string): string {
  return `task:${taskRunId}`;
}

async function buildOrdinaryThreadKickoffContent(input: {
  normalized: NormalizedLarkTextMessage;
  installationId: string;
  quoteMessageFetcher?: (input: {
    installationId: string;
    messageId: string;
  }) => Promise<LarkQuotedMessage | null>;
}): Promise<string> {
  const lines = ["<thread_kickoff>", "  The user opened a separate thread."];
  const parentMessageId = input.normalized.parentMessageId;
  if (parentMessageId != null) {
    const quoted =
      input.quoteMessageFetcher == null
        ? null
        : await input.quoteMessageFetcher({
            installationId: input.installationId,
            messageId: parentMessageId,
          });
    if (quoted != null) {
      lines.push("  The quoted message is below. Continue the discussion around it.");
      lines.push("  <quoted_message>");
      lines.push(indentBlock(quoted.text, 4));
      lines.push("  </quoted_message>");
    } else {
      lines.push(
        "  The user quoted an earlier message, but its text is unavailable. Tell the user you cannot see the quoted message and ask them to send it again.",
      );
      lines.push("  <quoted_message_unavailable>true</quoted_message_unavailable>");
    }
  } else {
    lines.push("  Continue the discussion in this thread.");
  }
  lines.push("</thread_kickoff>");
  return lines.join("\n");
}

function extractLarkImageKeys(messageType: string, content: string): string[] {
  if (content.length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(content);
    if (!isRecord(parsed)) {
      return [];
    }

    switch (messageType) {
      case "image": {
        const imageKey = readString(parsed.image_key);
        return imageKey == null ? [] : [imageKey];
      }
      case "post": {
        const body = unwrapLarkPostContent(parsed);
        if (body == null) {
          return [];
        }

        const keys: string[] = [];
        const content = Array.isArray(body.content) ? body.content : [];
        for (const paragraph of content) {
          if (!Array.isArray(paragraph)) {
            continue;
          }
          for (const element of paragraph) {
            if (!isRecord(element) || readString(element.tag) !== "img") {
              continue;
            }
            const imageKey = readString(element.image_key);
            if (imageKey != null) {
              keys.push(imageKey);
            }
          }
        }
        return keys;
      }
      default:
        return [];
    }
  } catch {
    return [];
  }
}

function parseLarkMessageContent(messageType: string, content: string): string {
  if (content.length === 0) {
    return "";
  }

  try {
    const parsed = JSON.parse(content);
    if (!isRecord(parsed)) {
      return "";
    }

    switch (messageType) {
      case "text":
        return typeof parsed.text === "string" ? parsed.text.trim() : "";
      case "image":
        return typeof parsed.image_key === "string" ? `[图片 ${parsed.image_key}]` : "[图片]";
      case "audio":
        return typeof parsed.file_key === "string" ? `[语音 ${parsed.file_key}]` : "[语音]";
      case "file":
        return typeof parsed.file_key === "string" ? `[文件 ${parsed.file_key}]` : "[文件]";
      case "post":
        return parseLarkPostMessageContent(parsed);
      case "interactive": {
        const interactiveText = parseLarkInteractiveMessageContent(parsed);
        return interactiveText.length > 0 ? interactiveText : "[卡片消息]";
      }
      default:
        return parseLarkUnknownContent(messageType, parsed, content);
    }
  } catch {
    return content.trim().length > 0 ? `[${messageType}消息]` : "";
  }
}

function parseLarkPostMessageContent(parsed: Record<string, unknown>): string {
  const body = unwrapLarkPostContent(parsed);
  if (body == null) {
    return "[富文本]";
  }

  const lines: string[] = [];
  const title = readString(body.title);
  if (title != null) {
    lines.push(`**${title}**`, "");
  }

  const content = Array.isArray(body.content) ? body.content : [];
  for (const paragraph of content) {
    if (!Array.isArray(paragraph)) {
      continue;
    }
    const line = paragraph
      .map((element) => renderLarkPostElement(element))
      .join("")
      .trimEnd();
    if (line.length > 0) {
      lines.push(line);
    }
  }

  return lines.join("\n").trim() || "[富文本]";
}

function unwrapLarkPostContent(parsed: Record<string, unknown>): Record<string, unknown> | null {
  if ("title" in parsed || "content" in parsed) {
    return parsed;
  }

  for (const locale of ["zh_cn", "en_us", "ja_jp"]) {
    const localized = parsed[locale];
    if (isRecord(localized)) {
      return localized;
    }
  }

  const firstLocalized = Object.values(parsed).find((value) => isRecord(value));
  return isRecord(firstLocalized) ? firstLocalized : null;
}

function renderLarkPostElement(value: unknown): string {
  if (!isRecord(value)) {
    return "";
  }

  const tag = readString(value.tag);
  switch (tag) {
    case "text":
      return applyLarkPostTextStyle(readString(value.text) ?? "", value.style);
    case "md":
      return readString(value.text) ?? "";
    case "a": {
      const text = readString(value.text) ?? readString(value.href) ?? "";
      const href = readString(value.href);
      return href == null ? text : `[${text}](${href})`;
    }
    case "at": {
      const userId = readString(value.user_id);
      if (userId === "all") {
        return "@all";
      }
      return `@${readString(value.user_name) ?? userId ?? "user"}`;
    }
    case "img": {
      const imageKey = readString(value.image_key);
      return imageKey == null ? "[图片]" : `![image](${imageKey})`;
    }
    case "media": {
      const fileKey = readString(value.file_key);
      return fileKey == null ? "[文件]" : `[文件 ${fileKey}]`;
    }
    case "emotion":
      return readString(value.emoji_type) ?? "[表情]";
    case "code_block": {
      const language = readString(value.language) ?? "";
      const text = readString(value.text) ?? "";
      return `\n\`\`\`${language}\n${text}\n\`\`\`\n`;
    }
    case "hr":
      return "\n---\n";
    default:
      return readString(value.text) ?? "";
  }
}

function applyLarkPostTextStyle(text: string, style: unknown): string {
  if (!Array.isArray(style) || style.length === 0) {
    return text;
  }

  let formatted = text;
  const flags = new Set(style.filter((item): item is string => typeof item === "string"));
  if (flags.has("bold")) {
    formatted = `**${formatted}**`;
  }
  if (flags.has("italic")) {
    formatted = `*${formatted}*`;
  }
  if (flags.has("codeInline")) {
    formatted = `\`${formatted}\``;
  }
  if (flags.has("lineThrough")) {
    formatted = `~~${formatted}~~`;
  }
  return formatted;
}

function parseLarkInteractiveMessageContent(parsed: Record<string, unknown>): string {
  if (typeof parsed.json_card === "string") {
    try {
      const rawCard = JSON.parse(parsed.json_card);
      if (isRecord(rawCard)) {
        const rawCardText = parseLarkInteractiveContent(rawCard);
        if (rawCardText.length > 0) {
          return rawCardText;
        }
      }
    } catch {
      // Fall back to direct interactive parsing.
    }
  }

  return parseLarkInteractiveContent(parsed);
}

function parseLarkInteractiveContent(parsed: Record<string, unknown>): string {
  const fragments: string[] = [];
  const seen = new Set<string>();
  const title = extractLarkInteractiveTitle(parsed);
  if (title.length > 0) {
    fragments.push(title);
    seen.add(title);
  }

  const collected = collectLarkTextNodes(resolveLarkInteractiveElements(parsed));
  const dedupedNodes = collected.nodes.filter((text) => {
    if (seen.has(text)) {
      return false;
    }
    seen.add(text);
    return true;
  });
  if (dedupedNodes.length > 0) {
    fragments.push(dedupedNodes.join(" "));
  }
  if (collected.truncated) {
    fragments.push(LARK_INTERACTIVE_TEXT_TRUNCATED_NOTICE);
  }

  return fragments.join("\n").trim();
}

function extractLarkInteractiveTitle(parsed: Record<string, unknown>): string {
  if (typeof parsed.title === "string" && parsed.title.trim().length > 0) {
    return parsed.title.trim();
  }

  const header = isRecord(parsed.header) ? parsed.header : null;
  if (header == null) {
    return "";
  }

  const title = header.title;
  if (typeof title === "string" && title.trim().length > 0) {
    return title.trim();
  }
  if (!isRecord(title)) {
    return "";
  }

  return extractLarkInteractiveText(title);
}

function resolveLarkInteractiveElements(parsed: Record<string, unknown>): unknown {
  if (parsed.elements != null) {
    return parsed.elements;
  }

  const body = isRecord(parsed.body) ? parsed.body : null;
  if (body == null) {
    return undefined;
  }
  if (body.elements != null) {
    return body.elements;
  }

  const property = isRecord(body.property) ? body.property : null;
  return property?.elements;
}

function collectLarkTextNodes(value: unknown): LarkInteractiveTextCollection {
  const state: LarkInteractiveTextCollection = {
    nodes: [],
    totalLength: 0,
    truncated: false,
  };
  collectLarkTextNodesInto(value, state);
  return state;
}

function collectLarkTextNodesInto(value: unknown, state: LarkInteractiveTextCollection): void {
  if (state.truncated) {
    return;
  }

  if (typeof value === "string") {
    appendLarkTextNode(state, value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectLarkTextNodesInto(item, state);
      if (state.truncated) {
        return;
      }
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const text = extractLarkInteractiveText(value);
  appendLarkTextNode(state, text);
  if (state.truncated) {
    return;
  }

  const children = [
    value.property,
    value.elements,
    value.children,
    value.fields,
    value.rows,
    value.columns,
    value.extra,
  ];
  for (const nested of children) {
    collectLarkTextNodesInto(nested, state);
    if (state.truncated) {
      return;
    }
  }
}

function appendLarkTextNode(state: LarkInteractiveTextCollection, rawText: string): void {
  const text = rawText.trim();
  if (text.length === 0 || state.truncated) {
    return;
  }

  if (state.nodes.length >= LARK_INTERACTIVE_TEXT_NODE_LIMIT) {
    state.truncated = true;
    return;
  }

  const remainingChars = LARK_INTERACTIVE_TEXT_CHAR_LIMIT - state.totalLength;
  if (remainingChars <= 0) {
    state.truncated = true;
    return;
  }

  if (text.length > remainingChars) {
    state.nodes.push(text.slice(0, remainingChars).trimEnd());
    state.totalLength = LARK_INTERACTIVE_TEXT_CHAR_LIMIT;
    state.truncated = true;
    return;
  }

  state.nodes.push(text);
  state.totalLength += text.length;
}

function extractLarkInteractiveText(value: Record<string, unknown>): string {
  if (typeof value.text === "string" && value.text.trim().length > 0) {
    return value.text.trim();
  }
  if (typeof value.content === "string" && value.content.trim().length > 0) {
    return value.content.trim();
  }

  const property = isRecord(value.property) ? value.property : null;
  if (property != null) {
    const propertyText = extractLarkInteractiveText(property);
    if (propertyText.length > 0) {
      return propertyText;
    }
  }

  const i18nContent = isRecord(value.i18n_content) ? value.i18n_content : null;
  if (i18nContent != null) {
    for (const language of ["zh_cn", "en_us", "ja_jp"]) {
      const localized = i18nContent[language];
      if (typeof localized === "string" && localized.trim().length > 0) {
        return localized.trim();
      }
    }
  }

  return "";
}

function parseLarkUnknownContent(
  messageType: string,
  parsed: Record<string, unknown>,
  rawContent: string,
): string {
  if (typeof parsed.text === "string" && parsed.text.trim().length > 0) {
    return parsed.text.trim();
  }
  if (typeof parsed.title === "string" && parsed.title.trim().length > 0) {
    return parsed.title.trim();
  }
  return rawContent.trim().length > 0 ? `[${messageType}消息]` : "";
}

function parseLarkMessageCreatedAt(value: unknown): Date | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return undefined;
  }

  return new Date(milliseconds);
}

function truncateLogText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function parseSurfaceObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (isRecord(parsed)) {
      return parsed;
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

async function buildInboundMessageContent(
  normalized: NormalizedLarkTextMessage,
  input: {
    installationId: string;
    quoteMessageFetcher?: (input: {
      installationId: string;
      messageId: string;
    }) => Promise<LarkQuotedMessage | null>;
  },
): Promise<string> {
  const parentMessageId = normalized.parentMessageId;
  const isQuote = parentMessageId != null && normalized.threadId == null;
  if (!isQuote) {
    return normalized.text;
  }

  const quoted =
    input.quoteMessageFetcher == null
      ? null
      : await input.quoteMessageFetcher({
          installationId: input.installationId,
          messageId: parentMessageId,
        });

  if (quoted == null) {
    logger.warn("falling back because quoted lark message could not be resolved", {
      installationId: input.installationId,
      parentMessageId,
      threadId: normalized.threadId,
    });
    return [
      "The user quoted an earlier message, but the quoted text could not be retrieved.",
      "",
      "Tell the user you cannot see the quoted message and ask them to send it again.",
      "",
      `The user's new message: ${normalized.text}`,
    ].join("\n");
  }

  return [
    "The user quoted a message:",
    quoted.text,
    "",
    `The user's new message: ${normalized.text}`,
  ].join("\n");
}

export function createLarkQuoteMessageFetcher(input: {
  installationId: string;
  clients: {
    getOrCreate(installationId: string): LarkSdkClient;
  };
}): (input: { installationId: string; messageId: string }) => Promise<LarkQuotedMessage | null> {
  return async ({ messageId }) => {
    try {
      const client = input.clients.getOrCreate(input.installationId);
      const response = (await fetchQuotedLarkMessage({
        client,
        messageId,
      })) as {
        code?: number;
        msg?: string;
        data?: {
          items?: Array<{
            msg_type?: string;
            body?: {
              content?: string;
            };
          }>;
        };
      };
      if (typeof response.code === "number" && response.code !== 0) {
        logger.warn("lark quote message.get returned non-zero code", {
          installationId: input.installationId,
          messageId,
          code: response.code,
          msg: response.msg ?? null,
        });
      }
      const item = response.data?.items?.[0];
      if (item == null) {
        logger.warn("lark quote message.get returned no item", {
          installationId: input.installationId,
          messageId,
          code: response.code ?? null,
          msg: response.msg ?? null,
        });
        return null;
      }

      const messageType = typeof item.msg_type === "string" ? item.msg_type : "text";
      const rawContent = typeof item.body?.content === "string" ? item.body.content : "";
      if (rawContent.length === 0) {
        logger.warn("lark quote message item has empty content", {
          installationId: input.installationId,
          messageId,
          messageType,
        });
      }
      const text = parseLarkMessageContent(messageType, rawContent);
      if (text.length === 0) {
        logger.warn("lark quote message parsing produced empty text", {
          installationId: input.installationId,
          messageId,
          messageType,
          rawContentPreview: truncateLogText(rawContent, LARK_INBOUND_LOG_PREVIEW_MAX_LENGTH),
        });
        return null;
      }

      logger.info("resolved quoted lark message", {
        installationId: input.installationId,
        messageId,
        messageType,
        contentPreview: truncateLogText(text, LARK_INBOUND_LOG_PREVIEW_MAX_LENGTH),
      });
      return { messageType, text };
    } catch (error) {
      logger.warn("failed to resolve quoted lark message", {
        installationId: input.installationId,
        messageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };
}

function buildLarkInboundUserPayload(input: {
  content: string;
  imageAssets: LarkInboundImageAsset[];
}): AgentUserPayload | null {
  if (input.imageAssets.length === 0) {
    return null;
  }

  return {
    content: input.content,
    images: input.imageAssets.map(
      (image): AgentUserImagePayload => ({
        type: "image",
        id: image.id,
        messageId: normalizeAgentUserImageMessageId(image.id, image.messageId),
        mimeType: image.mimeType,
      }),
    ),
  };
}

function buildLarkInboundRuntimeImages(
  imageAssets: LarkInboundImageAsset[],
): AgentUserRuntimeImagePayload[] {
  const runtimeImages = imageAssets.map(
    (image): AgentUserRuntimeImagePayload => ({
      type: "image",
      id: image.id,
      messageId: normalizeAgentUserImageMessageId(image.id, image.messageId),
      data: image.data,
      mimeType: image.mimeType,
    }),
  );
  if (runtimeImages.length > 0) {
    logger.debug("built lark inbound runtime images", {
      imageCount: runtimeImages.length,
      images: runtimeImages.map((image) => ({
        id: image.id,
        messageId: image.messageId,
        mimeType: image.mimeType,
        byteLength: Buffer.from(image.data, "base64").length,
      })),
    });
  }
  return runtimeImages;
}

async function fetchLarkInboundImageAssets(input: {
  installationId: string;
  messageId: string;
  imageKeys: string[];
  clients: {
    getOrCreate(installationId: string): LarkSdkClient;
  };
}): Promise<LarkInboundImageAsset[]> {
  if (input.imageKeys.length === 0) {
    logger.debug("no lark inbound images to fetch", {
      installationId: input.installationId,
      messageId: input.messageId,
    });
    return [];
  }

  logger.debug("fetching lark inbound image assets", {
    installationId: input.installationId,
    messageId: input.messageId,
    imageKeyCount: input.imageKeys.length,
    imageKeys: input.imageKeys,
  });

  const client = input.clients.getOrCreate(input.installationId);
  const assets: LarkInboundImageAsset[] = [];
  for (const imageKey of input.imageKeys) {
    try {
      logger.debug("requesting lark inbound image resource", {
        installationId: input.installationId,
        messageId: input.messageId,
        imageKey,
      });
      const response = await client.sdk.im.messageResource.get({
        path: {
          message_id: input.messageId,
          file_key: imageKey,
        },
        params: {
          type: "image",
        },
      });
      const buffer = await readLarkResourceBuffer(response.getReadableStream());
      if (buffer.length === 0) {
        throw new Error("empty lark inbound image resource");
      }
      const mimeType = normalizeLarkImageMimeType(response.headers?.["content-type"]);
      const data = buffer.toString("base64");
      assets.push({
        id: imageKey,
        messageId: input.messageId,
        data,
        mimeType,
      });
      logger.debug("fetched lark inbound image resource", {
        installationId: input.installationId,
        messageId: input.messageId,
        imageKey,
        mimeType,
        byteLength: buffer.length,
      });
    } catch (error) {
      logger.warn("failed to fetch lark inbound image resource", {
        installationId: input.installationId,
        messageId: input.messageId,
        imageKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.debug("finished fetching lark inbound image assets", {
    installationId: input.installationId,
    messageId: input.messageId,
    requestedImageKeyCount: input.imageKeys.length,
    fetchedAssetCount: assets.length,
  });

  return assets;
}

async function readLarkResourceBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function normalizeLarkImageMimeType(value: unknown): string {
  if (typeof value === "string") {
    const normalized = value.split(";")[0]?.trim().toLowerCase();
    if (normalized?.startsWith("image/")) {
      return normalized;
    }
    return "image/png";
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== "string") {
        continue;
      }
      const normalized = item.split(";")[0]?.trim().toLowerCase();
      if (normalized?.startsWith("image/")) {
        return normalized;
      }
    }
  }

  return "image/png";
}

async function fetchQuotedLarkMessage(input: {
  client: LarkSdkClient;
  messageId: string;
}): Promise<unknown> {
  const rawRequest = (
    input.client.sdk as Lark.Client & {
      request?: (payload: {
        method: string;
        url: string;
        params: Record<string, string>;
      }) => Promise<unknown>;
    }
  ).request;

  if (typeof rawRequest === "function") {
    return rawRequest.call(input.client.sdk, {
      method: "GET",
      url: `/open-apis/im/v1/messages/${input.messageId}`,
      params: {
        user_id_type: "open_id",
        card_msg_content_type: "raw_card_content",
      },
    });
  }

  return input.client.sdk.im.message.get({
    path: { message_id: input.messageId },
    params: { user_id_type: "open_id" },
  });
}

function buildLarkModelSwitchCardCallbackResponse(input: {
  overview: ReturnType<ScenarioModelSwitchService["getOverview"]>;
  selectedScenario: ModelScenario | null;
  message?: string;
  warnings?: string[];
  toast?: {
    type: "success" | "info" | "error" | "warning";
    content: string;
  };
}): {
  card: {
    type: "raw";
    data: Record<string, unknown>;
  };
  toast?: {
    type: "success" | "info" | "error" | "warning";
    content: string;
  };
} {
  const state: LarkModelSwitchCardState = {
    overview: input.overview,
    selectedScenario: input.selectedScenario,
    ...(input.message == null ? {} : { message: input.message }),
    ...(input.warnings == null ? {} : { warnings: input.warnings }),
  };
  const rendered = buildLarkRenderedModelSwitchCard(state);
  return {
    card: {
      type: "raw",
      data: rendered.card,
    },
    ...(input.toast == null ? {} : { toast: input.toast }),
  };
}

async function sendLarkModelSwitchCard(input: {
  installationId: string;
  chatId: string;
  replyToMessageId?: string | null;
  state: LarkModelSwitchCardState;
  clients?: {
    getOrCreate(installationId: string): LarkSdkClient;
  };
}): Promise<void> {
  const rendered = buildLarkRenderedModelSwitchCard(input.state);
  await sendLarkInteractiveCard({
    installationId: input.installationId,
    chatId: input.chatId,
    ...(input.replyToMessageId === undefined ? {} : { replyToMessageId: input.replyToMessageId }),
    card: rendered.card,
    ...(input.clients == null ? {} : { clients: input.clients }),
  });
}

async function sendLarkInteractiveCard(input: {
  installationId: string;
  chatId: string;
  replyToMessageId?: string | null;
  card: Record<string, unknown>;
  clients?: {
    getOrCreate(installationId: string): LarkSdkClient;
  };
}): Promise<void> {
  if (input.clients == null) {
    logger.warn("cannot send lark interactive card because no sdk clients are configured", {
      installationId: input.installationId,
      chatId: input.chatId,
    });
    return;
  }

  const client = input.clients.getOrCreate(input.installationId);
  if (input.replyToMessageId != null && input.replyToMessageId.length > 0) {
    await client.sdk.im.message.reply({
      path: { message_id: input.replyToMessageId },
      data: {
        msg_type: "interactive",
        content: JSON.stringify(input.card),
        reply_in_thread: true,
      },
    });
    return;
  }

  await client.sdk.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: input.chatId,
      msg_type: "interactive",
      content: JSON.stringify(input.card),
    },
  });
}

async function sendLarkStatusCard(input: {
  installationId: string;
  chatId: string;
  replyToMessageId?: string | null;
  template?: string;
  presentation: {
    title: string;
    summary: string;
    markdownSections: string[];
  };
  clients?: {
    getOrCreate(installationId: string): LarkSdkClient;
  };
}): Promise<void> {
  const card = {
    schema: "2.0",
    config: {
      update_multi: true,
      wide_screen_mode: false,
      summary: {
        content: input.presentation.summary,
      },
    },
    header: {
      title: {
        tag: "plain_text",
        content: input.presentation.title,
      },
      template: input.template ?? "turquoise",
    },
    body: {
      elements: input.presentation.markdownSections.flatMap((section, index) => [
        ...(index === 0 ? [] : [{ tag: "hr" as const }]),
        {
          tag: "markdown",
          content: section,
        },
      ]),
    },
  };
  await sendLarkInteractiveCard({
    installationId: input.installationId,
    chatId: input.chatId,
    ...(input.replyToMessageId === undefined ? {} : { replyToMessageId: input.replyToMessageId }),
    card,
    ...(input.clients == null ? {} : { clients: input.clients }),
  });
}

async function sendLarkHelpMessage(input: {
  installationId: string;
  chatId: string;
  replyToMessageId?: string | null;
  channelType: string;
  clients?: {
    getOrCreate(installationId: string): LarkSdkClient;
  };
}): Promise<void> {
  const presentation = buildSlashCommandHelpPresentation(input.channelType);
  if (presentation.renderMode === "markdown") {
    await sendLarkStatusCard({
      installationId: input.installationId,
      chatId: input.chatId,
      ...(input.replyToMessageId == null ? {} : { replyToMessageId: input.replyToMessageId }),
      presentation: {
        title: presentation.title,
        summary: presentation.summary,
        markdownSections: presentation.markdownSections,
      },
      ...(input.clients == null ? {} : { clients: input.clients }),
    });
    return;
  }

  await sendLarkTextMessage({
    installationId: input.installationId,
    chatId: input.chatId,
    ...(input.replyToMessageId == null ? {} : { replyToMessageId: input.replyToMessageId }),
    text: presentation.plainText,
    ...(input.clients == null ? {} : { clients: input.clients }),
  });
}

async function sendLarkRunFailureCard(input: {
  installationId: string;
  chatId: string;
  replyToMessageId?: string | null;
  errorMessage: string;
  clients?: {
    getOrCreate(installationId: string): LarkSdkClient;
  };
}): Promise<void> {
  await sendLarkStatusCard({
    installationId: input.installationId,
    chatId: input.chatId,
    template: "red",
    presentation: {
      title: "执行失败",
      summary: truncateLogText(input.errorMessage, LARK_INBOUND_LOG_PREVIEW_MAX_LENGTH),
      markdownSections: [
        "本轮运行在返回最终答复前失败了。",
        ["**错误信息**", "```text", input.errorMessage, "```"].join("\n"),
      ],
    },
    ...(input.replyToMessageId === undefined ? {} : { replyToMessageId: input.replyToMessageId }),
    ...(input.clients == null ? {} : { clients: input.clients }),
  });
}

function parseBindingMetadata(raw: string | null): Record<string, unknown> {
  if (raw == null || raw.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {}

  return {};
}

function normalizeModelScenario(value: unknown): ModelScenario | null {
  return value === "chat" ||
    value === "compaction" ||
    value === "task" ||
    value === "meditationBucket" ||
    value === "meditationConsolidation"
    ? value
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeBindingStatus(value: string): "active" | "finalized" | "stale" {
  return value === "finalized" || value === "stale" ? value : "active";
}

function indentBlock(text: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function isAbortLikeError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === "AbortError" || /(aborted|stop requested|cancelled)/i.test(error.message);
  }

  return typeof error === "string" && /(aborted|stop requested|cancelled)/i.test(error);
}
