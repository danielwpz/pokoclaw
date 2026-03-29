import type { LarkSdkClient } from "@/src/channels/lark/client.js";
import { buildLarkChatSurfaceKey } from "@/src/channels/lark/inbound.js";
import type {
  CleanupProvisionedSubagentSurfaceInput,
  ProvisionSubagentSurfaceInput,
  ProvisionSubagentSurfaceResult,
} from "@/src/orchestration/subagents.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { ChannelInstancesRepo } from "@/src/storage/repos/channel-instances.repo.js";
import { ConversationsRepo } from "@/src/storage/repos/conversations.repo.js";

const logger = createSubsystemLogger("channels/lark-subagent-provisioner");

export interface CreateLarkSubagentConversationSurfaceProvisionerInput {
  storage: StorageDb;
  clients: {
    getOrCreate(installationId: string): LarkSdkClient;
  };
}

export function createLarkSubagentConversationSurfaceProvisioner(
  input: CreateLarkSubagentConversationSurfaceProvisionerInput,
) {
  return {
    async cleanupProvisionedSubagentSurface(
      params: CleanupProvisionedSubagentSurfaceInput,
    ): Promise<void> {
      const channelInstance = new ChannelInstancesRepo(input.storage).getById(
        params.channelInstanceId,
      );
      if (channelInstance == null) {
        throw new Error(`Channel instance not found: ${params.channelInstanceId}`);
      }

      const client = input.clients.getOrCreate(channelInstance.accountKey);
      await deleteChat(client, params.externalChatId);
    },

    async provisionSubagentSurface(
      params: ProvisionSubagentSurfaceInput,
    ): Promise<ProvisionSubagentSurfaceResult> {
      const sourceConversation = new ConversationsRepo(input.storage).getById(
        params.sourceConversationId,
      );
      if (sourceConversation == null) {
        return {
          status: "failed",
          reason: `Source conversation not found: ${params.sourceConversationId}`,
          retryable: false,
        };
      }

      const channelInstance = new ChannelInstancesRepo(input.storage).getById(
        params.channelInstanceId,
      );
      if (channelInstance == null) {
        return {
          status: "failed",
          reason: `Channel instance not found: ${params.channelInstanceId}`,
          retryable: false,
        };
      }

      const installationId = channelInstance.accountKey;
      const client = input.clients.getOrCreate(installationId);
      let externalChatId: string | null = null;

      try {
        const createResp = await client.sdk.im.chat.create({
          data: {
            name: buildSubagentChatName(params.title),
          },
        });
        assertLarkOk(createResp, "create subagent chat");

        externalChatId = createResp?.data?.chat_id ?? "";
        if (externalChatId.length === 0) {
          return {
            status: "failed",
            reason: "Lark chat.create returned no chat_id",
            retryable: true,
          };
        }

        const memberIds = await listChatMemberIds(client, sourceConversation.externalChatId);
        if (memberIds.length > 0) {
          const addResp = await client.sdk.im.chatMembers.create({
            path: { chat_id: externalChatId },
            params: { member_id_type: "open_id" },
            data: { id_list: memberIds },
          });
          assertLarkOk(addResp, "add subagent chat members");
        }

        const shareLink = await getChatShareLink(client, externalChatId);
        await publishWelcomeNotice({
          client,
          chatId: externalChatId,
          title: params.title,
          description: params.description,
          initialTask: params.initialTask,
          workdir: params.workdir,
          shareLink,
        });

        logger.info("provisioned lark subagent chat surface", {
          title: params.title,
          sourceConversationId: params.sourceConversationId,
          externalChatId,
          shareLink,
          channelInstallationId: installationId,
          memberCount: memberIds.length,
        });

        return {
          status: "provisioned",
          externalChatId,
          shareLink,
          conversationKind: "group",
          channelSurface: {
            channelType: "lark",
            channelInstallationId: installationId,
            surfaceKey: buildLarkChatSurfaceKey(externalChatId),
            surfaceObjectJson: JSON.stringify({
              chat_id: externalChatId,
            }),
          },
        };
      } catch (error: unknown) {
        const cleanupError =
          externalChatId == null ? null : await cleanupProvisioningFailure(client, externalChatId);
        const reason = error instanceof Error ? error.message : String(error);
        logger.error("failed to provision lark subagent chat surface", {
          title: params.title,
          sourceConversationId: params.sourceConversationId,
          installationId,
          externalChatId,
          cleanupError,
          error: reason,
        });
        return {
          status: "failed",
          reason:
            cleanupError == null
              ? reason
              : `${reason}; cleanup failed for chat ${externalChatId}: ${cleanupError}`,
          retryable: true,
        };
      }
    },
  };
}

async function listChatMemberIds(client: LarkSdkClient, chatId: string): Promise<string[]> {
  const memberIds = new Set<string>();
  let pageToken: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const response = await client.sdk.im.chatMembers.get({
      path: { chat_id: chatId },
      params: {
        member_id_type: "open_id",
        page_size: 100,
        ...(pageToken == null ? {} : { page_token: pageToken }),
      },
    });
    assertLarkOk(response, `list chat members for ${chatId}`);

    for (const item of response.data?.items ?? []) {
      if (typeof item.member_id === "string" && item.member_id.length > 0) {
        memberIds.add(item.member_id);
      }
    }

    pageToken = response.data?.page_token ?? undefined;
    hasMore = response.data?.has_more === true && pageToken != null && pageToken.length > 0;
  }

  return Array.from(memberIds);
}

function buildSubagentChatName(title: string): string {
  return title.trim();
}

async function getChatShareLink(client: LarkSdkClient, chatId: string): Promise<string | null> {
  try {
    const response = await client.sdk.im.chat.link({
      path: { chat_id: chatId },
      data: { validity_period: "permanently" },
    });
    assertLarkOk(response, `get subagent chat share link for ${chatId}`);
    const shareLink = response.data?.share_link ?? "";
    return shareLink.length > 0 ? shareLink : null;
  } catch (error: unknown) {
    logger.warn("failed to get lark subagent chat share link", {
      chatId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function deleteChat(client: LarkSdkClient, chatId: string): Promise<void> {
  const response = await client.sdk.im.chat.delete({
    path: { chat_id: chatId },
  });
  assertLarkOk(response, `delete subagent chat ${chatId}`);
}

async function cleanupProvisioningFailure(
  client: LarkSdkClient,
  chatId: string,
): Promise<string | null> {
  try {
    await deleteChat(client, chatId);
    return null;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function publishWelcomeNotice(input: {
  client: LarkSdkClient;
  chatId: string;
  title: string;
  description: string;
  initialTask: string;
  workdir: string;
  shareLink: string | null;
}): Promise<void> {
  try {
    const response = await input.client.sdk.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: input.chatId,
        msg_type: "interactive",
        content: JSON.stringify(buildSubagentWelcomeCard(input)),
      },
    });
    assertLarkOk(response, `send subagent welcome card to ${input.chatId}`);

    const messageId = response.data?.message_id ?? "";
    if (messageId.length === 0) {
      logger.warn("sent subagent welcome card without message_id", {
        chatId: input.chatId,
      });
      return;
    }

    const topNoticeResp = await input.client.sdk.im.chatTopNotice.putTopNotice({
      path: { chat_id: input.chatId },
      data: {
        chat_top_notice: [{ action_type: "1", message_id: messageId }],
      },
    });
    assertLarkOk(topNoticeResp, `pin subagent welcome card in ${input.chatId}`);
  } catch (error: unknown) {
    logger.warn("failed to publish lark subagent welcome notice", {
      chatId: input.chatId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function buildSubagentWelcomeCard(input: {
  title: string;
  description: string;
  initialTask: string;
  workdir: string;
  shareLink: string | null;
}): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "markdown",
      content: `## 欢迎来到 ${buildSubagentChatName(input.title)}`,
    },
    {
      tag: "markdown",
      content: [
        `**标题**：${input.title}`,
        "",
        `**职责**：${input.description}`,
        "",
        `**初始任务**：${input.initialTask}`,
        "",
        `**工作目录**：\`${input.workdir}\``,
      ].join("\n"),
    },
    {
      tag: "markdown",
      content: "后续你可以在这里直接和这个 SubAgent 协作。常用帮助和 FAQ 后面再继续补。",
    },
  ];

  if (input.shareLink != null) {
    elements.push({
      tag: "button",
      text: { tag: "plain_text", content: "分享群链接" },
      type: "default",
      url: input.shareLink,
    });
  }

  return {
    schema: "2.0",
    config: {
      update_multi: true,
    },
    body: {
      elements,
    },
  };
}

function assertLarkOk(
  response: {
    code?: number | undefined;
    msg?: string | undefined;
  },
  context: string,
): void {
  if (response.code !== undefined && response.code !== 0) {
    throw new Error(`${context}: ${response.msg ?? `code=${response.code}`}`);
  }
}
