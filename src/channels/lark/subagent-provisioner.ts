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
const LARK_API_RESPONSE_LOG_MAX_CHARS = 4000;

interface LarkApiErrorDetails {
  message: string;
  httpStatus?: number;
  larkCode?: string | number;
  larkMsg?: string;
  responseBody?: string;
}

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
      let memberCount: number | null = null;

      try {
        const createResp = await runLarkApiStep("create subagent chat", () =>
          client.sdk.im.chat.create({
            data: {
              name: buildSubagentChatName(params.title),
            },
          }),
        );
        assertLarkOk(createResp, "create subagent chat");

        externalChatId = createResp?.data?.chat_id ?? "";
        if (externalChatId.length === 0) {
          return {
            status: "failed",
            reason: "Lark chat.create returned no chat_id",
            retryable: true,
          };
        }
        const createdExternalChatId = externalChatId;

        const memberIds = await listChatMemberIds(client, sourceConversation.externalChatId);
        memberCount = memberIds.length;
        if (memberIds.length > 0) {
          const addResp = await runLarkApiStep("add subagent chat members", () =>
            client.sdk.im.chatMembers.create({
              path: { chat_id: createdExternalChatId },
              params: { member_id_type: "open_id" },
              data: { id_list: memberIds },
            }),
          );
          assertLarkOk(addResp, "add subagent chat members");
        }

        const shareLink = await getChatShareLink(client, createdExternalChatId);
        await publishWelcomeNotice({
          client,
          chatId: createdExternalChatId,
          title: params.title,
          description: params.description,
          initialTask: params.initialTask,
          workdir: params.workdir,
          privateWorkspaceDir: params.privateWorkspaceDir,
          shareLink,
        });

        logger.info("provisioned lark subagent chat surface", {
          title: params.title,
          sourceConversationId: params.sourceConversationId,
          externalChatId: createdExternalChatId,
          shareLink,
          channelInstallationId: installationId,
          memberCount: memberIds.length,
        });

        return {
          status: "provisioned",
          externalChatId: createdExternalChatId,
          shareLink,
          conversationKind: "group",
          channelSurface: {
            channelType: "lark",
            channelInstallationId: installationId,
            surfaceKey: buildLarkChatSurfaceKey(createdExternalChatId),
            surfaceObjectJson: JSON.stringify({
              chat_id: createdExternalChatId,
            }),
          },
        };
      } catch (error: unknown) {
        const cleanupError =
          externalChatId == null ? null : await cleanupProvisioningFailure(client, externalChatId);
        const reason = describeLarkApiError(error);
        logger.error("failed to provision lark subagent chat surface", {
          title: params.title,
          sourceConversationId: params.sourceConversationId,
          sourceExternalChatId: sourceConversation.externalChatId,
          installationId,
          externalChatId,
          memberCount,
          cleanupError,
          ...buildLarkApiErrorLogContext(error),
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
    const response = await runLarkApiStep(`list chat members for ${chatId}`, () =>
      client.sdk.im.chatMembers.get({
        path: { chat_id: chatId },
        params: {
          member_id_type: "open_id",
          page_size: 100,
          ...(pageToken == null ? {} : { page_token: pageToken }),
        },
      }),
    );
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
    const response = await runLarkApiStep(`get subagent chat share link for ${chatId}`, () =>
      client.sdk.im.chat.link({
        path: { chat_id: chatId },
        data: { validity_period: "permanently" },
      }),
    );
    assertLarkOk(response, `get subagent chat share link for ${chatId}`);
    const shareLink = response.data?.share_link ?? "";
    return shareLink.length > 0 ? shareLink : null;
  } catch (error: unknown) {
    logger.warn("failed to get lark subagent chat share link", {
      chatId,
      ...buildLarkApiErrorLogContext(error),
      error: describeLarkApiError(error),
    });
    return null;
  }
}

async function deleteChat(client: LarkSdkClient, chatId: string): Promise<void> {
  const response = await runLarkApiStep(`delete subagent chat ${chatId}`, () =>
    client.sdk.im.chat.delete({
      path: { chat_id: chatId },
    }),
  );
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
    return describeLarkApiError(error);
  }
}

async function publishWelcomeNotice(input: {
  client: LarkSdkClient;
  chatId: string;
  title: string;
  description: string;
  initialTask: string;
  workdir: string;
  privateWorkspaceDir: string;
  shareLink: string | null;
}): Promise<void> {
  try {
    const response = await runLarkApiStep(`send subagent welcome card to ${input.chatId}`, () =>
      input.client.sdk.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: input.chatId,
          msg_type: "interactive",
          content: JSON.stringify(buildSubagentWelcomeCard(input)),
        },
      }),
    );
    assertLarkOk(response, `send subagent welcome card to ${input.chatId}`);
  } catch (error: unknown) {
    logger.warn("failed to publish lark subagent welcome notice", {
      chatId: input.chatId,
      ...buildLarkApiErrorLogContext(error),
      error: describeLarkApiError(error),
    });
  }
}

function buildSubagentWelcomeCard(input: {
  title: string;
  description: string;
  initialTask: string;
  workdir: string;
  privateWorkspaceDir: string;
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
        `**工作目录**：\`${input.workdir}\``,
        "",
        `**私有工作区**：\`${input.privateWorkspaceDir}\``,
      ].join("\n"),
    },
    {
      tag: "collapsible_panel",
      expanded: false,
      header: {
        title: {
          tag: "markdown",
          content: "📝 **初始任务**",
        },
        vertical_align: "center",
        icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" },
        icon_position: "follow_text",
        icon_expanded_angle: -180,
      },
      border: { color: "grey", corner_radius: "5px" },
      vertical_spacing: "8px",
      padding: "8px 8px 8px 8px",
      elements: [
        {
          tag: "markdown",
          content: input.initialTask,
          text_size: "notation",
        },
      ],
    },
    {
      tag: "markdown",
      content: "后续你可以在这里直接和这个 SubAgent 协作。常用帮助和 FAQ 后面再继续补。",
    },
    {
      tag: "markdown",
      content:
        "说明：`工作目录` 是默认执行目录；`私有工作区` 用于笔记、scratch 文件、导出物和其他临时产物。没有单独 cwd 时，两者会是同一个目录。",
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
    code?: number | string | undefined;
    msg?: string | undefined;
    data?: unknown;
  },
  context: string,
): void {
  if (response.code !== undefined && !isLarkSuccessCode(response.code)) {
    throw new LarkApiStepError(context, extractLarkApiResponseDetails(response));
  }
}

async function runLarkApiStep<T>(context: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    throw new LarkApiStepError(context, extractLarkApiErrorDetails(error), { cause: error });
  }
}

class LarkApiStepError extends Error {
  constructor(
    readonly step: string,
    readonly details: LarkApiErrorDetails,
    options?: ErrorOptions,
  ) {
    super(`${step}: ${formatLarkApiErrorDetails(details)}`, options);
    this.name = "LarkApiStepError";
  }
}

function describeLarkApiError(error: unknown): string {
  if (error instanceof LarkApiStepError) {
    return error.message;
  }

  return formatLarkApiErrorDetails(extractLarkApiErrorDetails(error));
}

function buildLarkApiErrorLogContext(error: unknown): Record<string, unknown> {
  if (error instanceof LarkApiStepError) {
    return {
      apiStep: error.step,
      apiError: error.details,
    };
  }

  return {
    apiError: extractLarkApiErrorDetails(error),
  };
}

function extractLarkApiErrorDetails(error: unknown): LarkApiErrorDetails {
  const message = error instanceof Error ? error.message : String(error);
  const response = readRecordProperty(error, "response");
  const responseBody = response == null ? undefined : response.data;
  const httpStatus = response == null ? undefined : readNumber(response.status);
  return {
    message,
    ...(response == null ? {} : extractLarkApiBodyDetails(responseBody)),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(responseBody === undefined ? {} : { responseBody: formatUnknownForLog(responseBody) }),
  };
}

function extractLarkApiResponseDetails(response: {
  code?: number | string | undefined;
  msg?: string | undefined;
  data?: unknown;
}): LarkApiErrorDetails {
  const responseBody = formatUnknownForLog(response);
  return {
    message: response.msg ?? `code=${response.code}`,
    ...(response.code === undefined ? {} : { larkCode: response.code }),
    ...(response.msg === undefined ? {} : { larkMsg: response.msg }),
    responseBody,
  };
}

function extractLarkApiBodyDetails(body: unknown): Partial<LarkApiErrorDetails> {
  if (!isRecord(body)) {
    return {};
  }

  const code = readStringOrNumber(body.code);
  const msg = readString(body.msg) ?? readString(body.message);
  return {
    ...(code === undefined ? {} : { larkCode: code }),
    ...(msg === undefined ? {} : { larkMsg: msg }),
  };
}

function isLarkSuccessCode(code: number | string): boolean {
  return code === 0 || code === "0";
}

function formatLarkApiErrorDetails(details: LarkApiErrorDetails): string {
  return [
    details.message,
    ...(details.httpStatus === undefined ? [] : [`httpStatus=${details.httpStatus}`]),
    ...(details.larkCode === undefined ? [] : [`larkCode=${details.larkCode}`]),
    ...(details.larkMsg === undefined ? [] : [`larkMsg=${details.larkMsg}`]),
    ...(details.responseBody === undefined ? [] : [`responseBody=${details.responseBody}`]),
  ].join(" ");
}

function formatUnknownForLog(value: unknown): string {
  const text = typeof value === "string" ? value : safeJsonStringify(value);
  return text.length <= LARK_API_RESPONSE_LOG_MAX_CHARS
    ? text
    : `${text.slice(0, LARK_API_RESPONSE_LOG_MAX_CHARS)}...`;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function readRecordProperty(value: unknown, property: string): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }

  const child = value[property];
  return isRecord(child) ? child : null;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readStringOrNumber(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  return readString(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
