/**
 * Lark inbound adapter.
 *
 * Parses lark message/callback payloads, resolves channel surface bindings, and
 * translates user actions into runtime ingress/control commands (`submitMessage`,
 * `/status`, `/stop`, approval decisions).
 */
import { randomUUID } from "node:crypto";
import * as Lark from "@larksuiteoapi/node-sdk";
import type { LarkSdkClient } from "@/src/channels/lark/client.js";
import type { ConfiguredLarkInstallation } from "@/src/channels/lark/types.js";
import type { RuntimeControlService } from "@/src/runtime/control.js";
import {
  buildConversationStatusPresentation,
  type RuntimeStatusService,
} from "@/src/runtime/status.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { AgentsRepo } from "@/src/storage/repos/agents.repo.js";
import { ChannelInstancesRepo } from "@/src/storage/repos/channel-instances.repo.js";
import { ChannelSurfacesRepo } from "@/src/storage/repos/channel-surfaces.repo.js";
import { ConversationBranchesRepo } from "@/src/storage/repos/conversation-branches.repo.js";
import { ConversationsRepo } from "@/src/storage/repos/conversations.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";

const logger = createSubsystemLogger("channels/lark-inbound");

const LARK_CHANNEL_TYPE = "lark";
const LARK_INBOUND_LOG_PREVIEW_MAX_LENGTH = 144;
const LARK_CARD_ACTION_LOG_PREVIEW_MAX_LENGTH = 320;

export interface LarkInboundIngress {
  submitMessage(input: {
    sessionId: string;
    scenario: "chat";
    content: string;
    createdAt?: Date;
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
  clients?: {
    getOrCreate(installationId: string): LarkSdkClient;
  };
  wsClientFactory?: (installation: ConfiguredLarkInstallation) => Lark.WSClient;
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
}

export interface NormalizedLarkTextMessage {
  chatId: string;
  messageId: string;
  parentMessageId: string | null;
  threadId: string | null;
  senderOpenId: string | null;
  senderType: string | null;
  chatType: string | null;
  text: string;
  createdAt?: Date;
}

interface LarkQuotedMessage {
  messageType: string;
  text: string;
}

export interface NormalizedLarkCardAction {
  action: string;
  runId: string | null;
  approvalId: number | null;
  grantTtl: "one_day" | "permanent" | null;
  actorOpenId: string | null;
}

export function buildLarkChatSurfaceKey(chatId: string): string {
  return `chat:${chatId}`;
}

export function normalizeLarkTextMessage(
  data: unknown,
): NormalizedLarkTextMessage | { skipReason: string } {
  if (!isRecord(data)) {
    return { skipReason: "event payload is not an object" };
  }

  const message = isRecord(data.message) ? data.message : null;
  if (message == null) {
    return { skipReason: "event payload is missing message" };
  }

  const messageType = typeof message.message_type === "string" ? message.message_type : null;
  if (messageType !== "text") {
    return { skipReason: `unsupported message_type ${String(messageType)}` };
  }

  const chatId = typeof message.chat_id === "string" ? message.chat_id.trim() : "";
  if (chatId.length === 0) {
    return { skipReason: "text message is missing chat_id" };
  }

  const messageId = typeof message.message_id === "string" ? message.message_id.trim() : "";
  if (messageId.length === 0) {
    return { skipReason: "text message is missing message_id" };
  }

  const contentRaw = typeof message.content === "string" ? message.content : "";
  const text = parseLarkMessageContent(messageType, contentRaw);
  if (text.length === 0) {
    return { skipReason: "text message content is empty" };
  }

  const parentMessageId =
    typeof message.parent_id === "string" && message.parent_id.trim().length > 0
      ? message.parent_id.trim()
      : null;
  const threadId =
    typeof message.thread_id === "string" && message.thread_id.trim().length > 0
      ? message.thread_id.trim()
      : null;
  const sender = isRecord(data.sender) ? data.sender : null;
  const senderId = sender != null && isRecord(sender.sender_id) ? sender.sender_id : null;
  const senderOpenId =
    senderId != null && typeof senderId.open_id === "string" && senderId.open_id.length > 0
      ? senderId.open_id
      : null;
  const senderType =
    sender != null && typeof sender.sender_type === "string" ? sender.sender_type : null;
  const chatType = typeof message.chat_type === "string" ? message.chat_type : null;
  const createdAt = parseLarkMessageCreatedAt(message.create_time);

  return {
    chatId,
    messageId,
    parentMessageId,
    threadId,
    senderOpenId,
    senderType,
    chatType,
    text,
    ...(createdAt == null ? {} : { createdAt }),
  };
}

export function createLarkMessageReceiveHandler(input: {
  installationId: string;
  storage: StorageDb;
  ingress: LarkInboundIngress;
  control: RuntimeControlService;
  status?: RuntimeStatusService;
  clients?: {
    getOrCreate(installationId: string): LarkSdkClient;
  };
  quoteMessageFetcher?: (input: {
    installationId: string;
    messageId: string;
  }) => Promise<LarkQuotedMessage | null>;
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

    if (normalized.senderType != null && normalized.senderType !== "user") {
      logger.debug("ignoring non-user lark inbound message", {
        installationId: input.installationId,
        chatId: normalized.chatId,
        messageId: normalized.messageId,
        senderType: normalized.senderType,
      });
      return;
    }

    const surface = resolveOrPairLarkChatSurface({
      db: input.storage,
      installationId: input.installationId,
      chatId: normalized.chatId,
      chatType: normalized.chatType,
    });
    if (surface == null) {
      logger.warn("dropping lark inbound message because no channel surface matched or paired", {
        installationId: input.installationId,
        chatId: normalized.chatId,
        messageId: normalized.messageId,
      });
      return;
    }

    const sessionsRepo = new SessionsRepo(input.storage);
    const session = sessionsRepo.findLatestByConversationBranch(
      surface.conversationId,
      surface.branchId,
      {
        purpose: "chat",
        statuses: ["active", "paused"],
      },
    );
    if (session == null) {
      logger.warn("dropping lark inbound message because no chat session matched surface", {
        installationId: input.installationId,
        chatId: normalized.chatId,
        messageId: normalized.messageId,
        conversationId: surface.conversationId,
        branchId: surface.branchId,
      });
      return;
    }

    if (normalized.text === "/stop") {
      const result = input.control.stopConversation({
        conversationId: surface.conversationId,
        actor:
          normalized.senderOpenId == null
            ? `lark:${input.installationId}:unknown`
            : `lark:${input.installationId}:${normalized.senderOpenId}`,
        reasonText: "stop requested from lark command",
      });
      logger.info("processed lark stop command", {
        installationId: input.installationId,
        chatId: normalized.chatId,
        messageId: normalized.messageId,
        conversationId: surface.conversationId,
        acceptedCount: result.acceptedCount,
      });
      return;
    }

    if (normalized.text === "/status") {
      if (input.status == null) {
        logger.warn("ignoring lark status command because no status service is configured", {
          installationId: input.installationId,
          chatId: normalized.chatId,
          messageId: normalized.messageId,
        });
        return;
      }
      const snapshot = input.status.getConversationStatus({
        conversationId: surface.conversationId,
        sessionId: session.id,
        scenario: "chat",
      });
      await sendLarkStatusCard({
        installationId: input.installationId,
        chatId: normalized.chatId,
        presentation: buildConversationStatusPresentation(snapshot),
        ...(input.clients == null ? {} : { clients: input.clients }),
      });
      logger.info("processed lark status command", {
        installationId: input.installationId,
        chatId: normalized.chatId,
        messageId: normalized.messageId,
        conversationId: surface.conversationId,
        sessionId: session.id,
      });
      return;
    }

    logger.info("submitting lark inbound message to runtime ingress", {
      installationId: input.installationId,
      chatId: normalized.chatId,
      messageId: normalized.messageId,
      parentMessageId: normalized.parentMessageId,
      threadId: normalized.threadId,
      sessionId: session.id,
      conversationId: surface.conversationId,
      branchId: surface.branchId,
      chatType: normalized.chatType,
      contentPreview: truncateLogText(normalized.text, LARK_INBOUND_LOG_PREVIEW_MAX_LENGTH),
    });

    const content = await buildInboundMessageContent(normalized, input);

    await input.ingress.submitMessage({
      sessionId: session.id,
      scenario: "chat",
      content,
      ...(normalized.createdAt == null ? {} : { createdAt: normalized.createdAt }),
    });
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

  return {
    action: actionName,
    runId,
    approvalId:
      approvalId == null || Number.isNaN(approvalId) || !Number.isFinite(approvalId)
        ? null
        : approvalId,
    grantTtl,
    actorOpenId,
  };
}

export function createLarkCardActionHandler(input: {
  installationId: string;
  ingress: LarkInboundIngress;
  control: RuntimeControlService;
}): (data: unknown) => Promise<unknown> {
  return async (data: unknown) => {
    logger.debug("received raw lark card action callback", {
      installationId: input.installationId,
      payloadPreview: truncateLogText(safeJson(data), LARK_CARD_ACTION_LOG_PREVIEW_MAX_LENGTH),
    });

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
      grantTtl: normalized.grantTtl,
      actor:
        normalized.actorOpenId == null
          ? `lark:${input.installationId}:unknown`
          : `lark:${input.installationId}:${normalized.actorOpenId}`,
    });

    if (
      normalized.action !== "stop_run" &&
      normalized.action !== "approve_permission" &&
      normalized.action !== "deny_permission"
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
            : "approve_permanent",
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
              : "已允许 永久",
      },
    };
  };
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
          ...(input.clients == null
            ? {}
            : {
                quoteMessageFetcher: createLarkQuoteMessageFetcher({
                  installationId: installation.installationId,
                  clients: input.clients,
                }),
              }),
        });
        const onCardAction = createLarkCardActionHandler({
          installationId: installation.installationId,
          ingress: input.ingress,
          control: input.control,
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
        return "[富文本]";
      case "interactive": {
        const interactiveText = parseLarkInteractiveContent(parsed);
        return interactiveText.length > 0 ? interactiveText : "[卡片消息]";
      }
      default:
        return parseLarkUnknownContent(messageType, parsed, content);
    }
  } catch {
    return content.trim().length > 0 ? `[${messageType}消息]` : "";
  }
}

function parseLarkInteractiveContent(parsed: Record<string, unknown>): string {
  const fragments: string[] = [];
  const seen = new Set<string>();
  const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
  if (title.length > 0) {
    fragments.push(title);
    seen.add(title);
  }

  const textNodes: string[] = [];
  collectLarkTextNodes(parsed.elements, textNodes);
  const dedupedNodes = textNodes.filter((text) => {
    if (seen.has(text)) {
      return false;
    }
    seen.add(text);
    return true;
  });
  if (dedupedNodes.length > 0) {
    fragments.push(dedupedNodes.join(" "));
  }

  return fragments.join("\n").trim();
}

function collectLarkTextNodes(value: unknown, sink: string[]): void {
  if (sink.length >= 8) {
    return;
  }

  if (typeof value === "string") {
    const text = value.trim();
    if (text.length > 0) {
      sink.push(text);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectLarkTextNodes(item, sink);
      if (sink.length >= 8) {
        return;
      }
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  if (typeof value.text === "string") {
    const text = value.text.trim();
    if (text.length > 0) {
      sink.push(text);
    }
  }
  if (typeof value.content === "string" && typeof value.text !== "string") {
    const content = value.content.trim();
    if (content.length > 0) {
      sink.push(content);
    }
  }

  const children = [
    value.elements,
    value.children,
    value.fields,
    value.rows,
    value.columns,
    value.extra,
  ];
  for (const nested of children) {
    collectLarkTextNodes(nested, sink);
    if (sink.length >= 8) {
      return;
    }
  }
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
      "用户引用了一条消息，但系统未能读取原文。",
      "",
      `用户的新消息：${normalized.text}`,
    ].join("\n");
  }

  return ["用户引用了一条消息：", quoted.text, "", `用户的新消息：${normalized.text}`].join("\n");
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
      const response = (await client.sdk.im.message.get({
        path: { message_id: messageId },
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

async function sendLarkStatusCard(input: {
  installationId: string;
  chatId: string;
  presentation: {
    title: string;
    summary: string;
    markdownSections: string[];
  };
  clients?: {
    getOrCreate(installationId: string): LarkSdkClient;
  };
}): Promise<void> {
  if (input.clients == null) {
    logger.warn("cannot send lark status card because no sdk clients are configured", {
      installationId: input.installationId,
      chatId: input.chatId,
    });
    return;
  }

  const client = input.clients.getOrCreate(input.installationId);
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
      template: "turquoise",
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
  await client.sdk.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: input.chatId,
      msg_type: "interactive",
      content: JSON.stringify(card),
    },
  });
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
