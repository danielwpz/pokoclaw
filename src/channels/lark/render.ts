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
  const requestedPermissionLines = formatRequestedPermissionLines(
    describePermissionRequestLines(state.request),
  );
  const requestedBashPrefixLines = formatRequestedBashPrefixLines(
    state.request.scopes.flatMap((scope) =>
      scope.kind === "bash.full_access" ? [scope.prefix] : [],
    ),
  );
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "markdown",
      content: !state.resolved
        ? [
            "### 需要你的授权",
            "",
            `**操作**：${formatApprovalTitleMarkdown(state.title)}`,
            ...requestedPermissionLines,
            ...requestedBashPrefixLines,
            "",
            `**原因**：${state.reasonText}`,
            ...(state.expiresAt == null ? [] : ["", `**有效期至**：\`${state.expiresAt}\``]),
            "",
            "> 你处理后，agent 才会继续执行。",
          ].join("\n")
        : approved
          ? [
              `**操作**：${formatApprovalTitleMarkdown(state.title)}`,
              ...requestedPermissionLines,
              ...requestedBashPrefixLines,
            ].join("\n")
          : [
              `**操作**：${formatApprovalTitleMarkdown(state.title)}`,
              ...requestedPermissionLines,
              ...requestedBashPrefixLines,
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
        ...(state.expiresAt == null ? [] : ["", `**确认截止**：\`${state.expiresAt}\``]),
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

function formatRequestedPermissionLines(lines: string[]): string[] {
  if (lines.length === 0) {
    return [];
  }

  return ["", "**权限**", ...lines.map((line) => `- ${formatPermissionScopeMarkdown(line)}`)];
}

function formatRequestedBashPrefixLines(prefixes: string[][]): string[] {
  if (prefixes.length === 0) {
    return [];
  }
  if (prefixes.length === 1) {
    return ["", `**Prefix**：\`${prefixes[0]?.join(" ") ?? ""}\``];
  }

  return ["", "**Prefixes**", ...prefixes.map((prefix) => `- \`${prefix.join(" ")}\``)];
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
