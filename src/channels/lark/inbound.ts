import { randomUUID } from "node:crypto";
import * as Lark from "@larksuiteoapi/node-sdk";

import type { ConfiguredLarkInstallation } from "@/src/channels/lark/types.js";
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

export interface LarkInboundIngress {
  submitMessage(input: {
    sessionId: string;
    scenario: "chat";
    content: string;
    createdAt?: Date;
  }): Promise<unknown>;
}

export interface CreateLarkInboundRuntimeInput {
  installations: ConfiguredLarkInstallation[];
  storage: StorageDb;
  ingress: LarkInboundIngress;
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
    message_type?: string;
    create_time?: string;
    content?: string;
  };
}

export interface NormalizedLarkTextMessage {
  chatId: string;
  messageId: string;
  senderOpenId: string | null;
  senderType: string | null;
  chatType: string | null;
  text: string;
  createdAt?: Date;
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
  const text = parseLarkTextContent(contentRaw);
  if (text.length === 0) {
    return { skipReason: "text message content is empty" };
  }

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

    logger.info("submitting lark inbound message to runtime ingress", {
      installationId: input.installationId,
      chatId: normalized.chatId,
      messageId: normalized.messageId,
      sessionId: session.id,
      conversationId: surface.conversationId,
      branchId: surface.branchId,
      chatType: normalized.chatType,
      contentPreview: truncateLogText(normalized.text, LARK_INBOUND_LOG_PREVIEW_MAX_LENGTH),
    });

    await input.ingress.submitMessage({
      sessionId: session.id,
      scenario: "chat",
      content: normalized.text,
      ...(normalized.createdAt == null ? {} : { createdAt: normalized.createdAt }),
    });
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
        });

        const dispatcher = new Lark.EventDispatcher({}).register({
          "im.message.receive_v1": (data: unknown) => {
            void onMessage(data).catch((error: unknown) => {
              logger.error("failed to process lark inbound message", {
                installationId: installation.installationId,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          },
        } as Record<string, (data: unknown) => void>);

        const socket = wsClientFactory(installation);
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

function parseLarkTextContent(content: string): string {
  if (content.length === 0) {
    return "";
  }

  try {
    const parsed = JSON.parse(content);
    if (isRecord(parsed) && typeof parsed.text === "string") {
      return parsed.text.trim();
    }
  } catch {
    return "";
  }

  return "";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}
