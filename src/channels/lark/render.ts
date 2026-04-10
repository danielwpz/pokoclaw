/**
 * Lark card renderer.
 *
 * Pure rendering layer that converts `LarkRunState` / `LarkApprovalState`
 * into CardKit JSON payloads. Transport and flush policy live in `outbound.ts`.
 */
import type { LarkApprovalState } from "@/src/channels/lark/approval-state.js";
import { describePermissionRequestLines } from "@/src/security/scope.js";

export {
  buildLarkRenderedModelSwitchCard,
  type LarkModelSwitchCardState,
  type LarkRenderedModelSwitchCard,
} from "@/src/channels/lark/render/model-switch-card.js";
export {
  buildLarkRenderedRunCard,
  buildLarkRenderedRunCardPages,
  type LarkRenderedRunCard,
  type LarkRenderedRunCardPage,
  renderLarkRunCard,
} from "@/src/channels/lark/render/run-card.js";
export {
  buildLarkRenderedTaskCard,
  describeTaskRunIcon,
  describeTaskRunKind,
  describeTaskRunTemplate,
  describeTaskRunTerminal,
  getLarkTaskTerminalMessagePresentation,
  type LarkRenderedTaskCard,
  type LarkTaskTerminalMessagePresentation,
} from "@/src/channels/lark/render/task-card.js";

export interface LarkRenderedApprovalCard {
  card: Record<string, unknown>;
  structureSignature: string;
}

export interface LarkSubagentCreationRequestCardState {
  requestId: string;
  title: string;
  description: string;
  workdir: string;
  expiresAt: string | null;
  status: "pending" | "created" | "denied" | "failed" | "expired";
  failureReason: string | null;
  externalChatId: string | null;
  shareLink: string | null;
}

export interface LarkRenderedSubagentCreationRequestCard {
  card: Record<string, unknown>;
  structureSignature: string;
}

export function renderLarkApprovalCard(state: LarkApprovalState): Record<string, unknown> {
  return buildLarkRenderedApprovalCard(state).card;
}

export function buildLarkRenderedSubagentCreationRequestCard(
  state: LarkSubagentCreationRequestCardState,
): LarkRenderedSubagentCreationRequestCard {
  const approved = state.status === "created";
  const denied = state.status === "denied";
  const failed = state.status === "failed" || state.status === "expired";
  const card = {
    schema: "2.0",
    config: {
      update_multi: true,
      wide_screen_mode: false,
      summary: {
        content: summarizeSubagentRequestState(state),
      },
    },
    header: {
      title: {
        tag: "plain_text",
        content:
          state.status === "pending"
            ? "SubAgent 创建请求"
            : approved
              ? "SubAgent 已创建"
              : denied
                ? "SubAgent 创建已取消"
                : "SubAgent 创建失败",
      },
      subtitle: {
        tag: "plain_text",
        content: state.title,
      },
      template: failed ? "red" : approved ? "green" : denied ? "grey" : "blue",
      icon: {
        tag: "standard_icon",
        token: failed ? "warning_outlined" : approved ? "yes_filled" : "robot_outlined",
      },
    },
    body: {
      elements: buildSubagentCreationRequestCardElements(state),
    },
  };

  return {
    card,
    structureSignature: JSON.stringify(card),
  };
}

export function buildLarkRenderedApprovalCard(state: LarkApprovalState): LarkRenderedApprovalCard {
  const approved = state.decision === "approve";
  const denied = state.decision === "deny";
  const card = {
    schema: "2.0",
    config: {
      update_multi: true,
      wide_screen_mode: false,
      summary: {
        content: summarizeApprovalState(state),
      },
    },
    header: {
      title: {
        tag: "plain_text",
        content: state.resolved ? `授权请求 — ${approved ? "授权成功" : "已拒绝"}` : "授权请求",
      },
      template: denied ? "red" : approved ? "green" : "blue",
      icon: {
        tag: "standard_icon",
        token: denied ? "close_filled" : approved ? "yes_filled" : "lock_chat_filled",
      },
    },
    body: {
      elements: buildApprovalCardElements(state),
    },
  };

  return {
    card,
    structureSignature: JSON.stringify(card),
  };
}

function buildApprovalCardElements(state: LarkApprovalState): Array<Record<string, unknown>> {
  const approved = state.decision === "approve";
  const permissionSummaryLines = formatPermissionSummaryLines(state);
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "markdown",
      content: !state.resolved
        ? [
            "### 授权运行命令",
            "",
            "**原因**",
            state.reasonText,
            ...formatApprovalCommandLines(state.commandText),
            ...permissionSummaryLines,
            ...formatHumanDeadlineLines("有效期至", state.expiresAt),
            "",
            "> 你处理后，agent 才会继续执行。",
          ].join("\n")
        : approved
          ? [
              `**操作**：${formatApprovalTitleMarkdown(state.title)}`,
              ...formatResolvedPermissionLines(state.request),
            ].join("\n")
          : [
              `**操作**：${formatApprovalTitleMarkdown(state.title)}`,
              ...formatResolvedPermissionLines(state.request),
              "",
              "**结果**：当前操作已停止。",
            ].join("\n"),
      text_size: "normal",
    },
  ];

  if (state.resolved) {
    elements.push({ tag: "hr" });
  } else {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "column_set",
      flex_mode: "none",
      horizontal_align: "right",
      columns: [
        {
          tag: "column",
          width: "auto",
          elements: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "允许 1天" },
              type: "default",
              size: "medium",
              value: {
                action: "approve_permission",
                approvalId: state.approvalId,
                grantTtl: "one_day",
              },
            },
            {
              tag: "button",
              text: { tag: "plain_text", content: "允许 永久" },
              type: "primary",
              size: "medium",
              value: {
                action: "approve_permission",
                approvalId: state.approvalId,
                grantTtl: "permanent",
              },
            },
            {
              tag: "button",
              text: { tag: "plain_text", content: "拒绝" },
              type: "danger",
              size: "medium",
              value: {
                action: "deny_permission",
                approvalId: state.approvalId,
              },
            },
          ],
        },
      ],
    });
  }

  return elements;
}

function buildSubagentCreationRequestCardElements(
  state: LarkSubagentCreationRequestCardState,
): Array<Record<string, unknown>> {
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "markdown",
      content: [
        `### ${state.title}`,
        "",
        state.description,
        "",
        `**工作目录**：\`${state.workdir}\``,
        ...formatHumanDeadlineLines("确认截止", state.expiresAt),
      ].join("\n"),
      text_size: "normal",
    },
  ];

  if (state.status === "pending") {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "column_set",
      flex_mode: "none",
      horizontal_align: "right",
      columns: [
        {
          tag: "column",
          width: "auto",
          elements: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "创建 SubAgent" },
              type: "primary",
              size: "medium",
              value: {
                action: "approve_subagent_creation",
                requestId: state.requestId,
              },
            },
            {
              tag: "button",
              text: { tag: "plain_text", content: "取消" },
              type: "default",
              size: "medium",
              value: {
                action: "deny_subagent_creation",
                requestId: state.requestId,
              },
            },
          ],
        },
      ],
    });
    return elements;
  }

  elements.push({ tag: "hr" });
  elements.push({
    tag: "markdown",
    content:
      state.status === "created"
        ? [
            "**结果**：SubAgent 群聊已创建并已启动。",
            ...(state.externalChatId == null ? [] : ["", `**群聊**：\`${state.externalChatId}\``]),
          ].join("\n")
        : state.status === "denied"
          ? "**结果**：用户已取消本次创建请求。"
          : [
              "**结果**：创建未完成。",
              ...(state.failureReason == null ? [] : ["", `**原因**：${state.failureReason}`]),
            ].join("\n"),
    text_size: "normal",
  });

  if (state.status === "created" && state.shareLink != null) {
    elements.push({
      tag: "button",
      text: { tag: "plain_text", content: "打开 SubAgent 群聊" },
      type: "primary",
      size: "medium",
      url: state.shareLink,
    });
  }

  return elements;
}

function summarizeSubagentRequestState(state: LarkSubagentCreationRequestCardState): string {
  if (state.status === "pending") {
    return `等待确认创建 SubAgent：${state.title}`;
  }
  if (state.status === "created") {
    return `已创建 SubAgent：${state.title}`;
  }
  if (state.status === "denied") {
    return `已取消 SubAgent 创建：${state.title}`;
  }
  return `SubAgent 创建失败：${state.title}`;
}

function summarizeApprovalState(state: LarkApprovalState): string {
  if (!state.resolved) {
    return "等待授权";
  }
  return state.decision === "approve" ? "授权成功" : "已拒绝";
}

function formatHumanDeadlineLines(label: string, isoTimestamp: string | null): string[] {
  if (isoTimestamp == null) {
    return [];
  }

  return ["", `**${label}**：${formatHumanLocalTimestamp(isoTimestamp)}`];
}

function formatHumanLocalTimestamp(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) {
    return `\`${isoTimestamp}\``;
  }

  try {
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    return `\`${isoTimestamp}\``;
  }
}

function formatPermissionSummaryLines(state: LarkApprovalState): string[] {
  const bashPrefixes = state.request.scopes.flatMap((scope) =>
    scope.kind === "bash.full_access" ? [scope.prefix] : [],
  );

  if (state.commandText != null && bashPrefixes.length > 0) {
    return formatBashPermissionSummaryLines({
      commandText: state.commandText,
      prefixes: bashPrefixes,
    });
  }

  return formatResolvedPermissionLines(state.request);
}

function formatResolvedPermissionLines(request: LarkApprovalState["request"]): string[] {
  const bashPrefixes = request.scopes.flatMap((scope) =>
    scope.kind === "bash.full_access" ? [scope.prefix.join(" ")] : [],
  );
  if (bashPrefixes.length > 0) {
    return ["", "**命令**", ...bashPrefixes.map((prefix) => `\`${prefix}\``)];
  }

  return formatRequestedPermissionLines(describePermissionRequestLines(request));
}

function formatApprovalCommandLines(commandText: string | null): string[] {
  if (commandText == null || commandText.trim().length === 0) {
    return [];
  }

  return ["", "**命令**", `\`${commandText.trim()}\``];
}

function formatBashPermissionSummaryLines(input: {
  commandText: string;
  prefixes: string[][];
}): string[] {
  const distinctPrefixes = input.prefixes.map((prefix) => prefix.join(" "));
  const commandText = input.commandText.trim();
  const widerPrefixes = distinctPrefixes.filter((prefix) => prefix !== commandText);
  if (widerPrefixes.length === 0) {
    return [];
  }
  if (widerPrefixes.length === 1) {
    return ["", "**授权范围**", `\`${widerPrefixes[0]}\``];
  }

  return ["", "**授权范围**", ...widerPrefixes.map((prefix) => `- \`${prefix}\``)];
}

function formatRequestedPermissionLines(lines: string[]): string[] {
  if (lines.length === 0) {
    return [];
  }

  return ["", "**权限**", ...lines.map((line) => `- ${formatPermissionScopeMarkdown(line)}`)];
}

function formatApprovalTitleMarkdown(title: string): string {
  const prefix = "Approval required: ";
  if (!title.startsWith(prefix)) {
    return title;
  }

  const scopes = title
    .slice(prefix.length)
    .split("; ")
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
  if (scopes.length === 0) {
    return title;
  }

  return `${prefix}${scopes.map((scope) => formatPermissionScopeMarkdown(scope)).join("; ")}`;
}

function formatPermissionScopeMarkdown(scopeText: string): string {
  const match = scopeText.match(/^(Read\/write|Read|Write)\s+(.+)$/i);
  if (match == null) {
    return scopeText;
  }

  const access = match[1] ?? "";
  const target = match[2] ?? "";
  return `**${access}** \`${target}\``;
}
