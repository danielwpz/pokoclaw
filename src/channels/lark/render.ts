/**
 * Lark card renderer.
 *
 * Pure rendering layer that converts `LarkRunState` / `LarkApprovalState`
 * into CardKit JSON payloads. Transport and flush policy live in `outbound.ts`.
 */
import type { LarkApprovalState } from "@/src/channels/lark/approval-state.js";
import {
  buildLarkAssistantElementId,
  LARK_ASSISTANT_PLACEHOLDER_TEXT,
  type LarkAssistantTextBlock,
  type LarkFooterStatus,
  type LarkRunState,
  type LarkToolSequenceBlock,
  type LarkToolSequenceTool,
} from "@/src/channels/lark/run-state.js";

export interface LarkRenderedRunCard {
  card: Record<string, unknown>;
  structureSignature: string;
  activeAssistant: {
    elementId: string;
    text: string;
  } | null;
}

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

export function renderLarkRunCard(state: LarkRunState): Record<string, unknown> {
  return buildLarkRenderedRunCard(state).card;
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

export function buildLarkRenderedRunCard(state: LarkRunState): LarkRenderedRunCard {
  const full = buildCard(state, { normalizeActiveAssistantText: false });
  const normalized = buildCard(state, { normalizeActiveAssistantText: true });

  return {
    card: full.card,
    structureSignature: JSON.stringify(normalized.card),
    activeAssistant: full.activeAssistant,
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
      subtitle: {
        tag: "plain_text",
        content: !state.resolved ? "请选择操作" : approved ? "(已允许)" : "(已拒绝)",
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

function buildCard(
  state: LarkRunState,
  options: {
    normalizeActiveAssistantText: boolean;
  },
): {
  card: Record<string, unknown>;
  activeAssistant: {
    elementId: string;
    text: string;
  } | null;
} {
  const elements: Array<Record<string, unknown>> = [];

  const reasoningBlock = renderReasoningBlock(state);
  if (reasoningBlock != null) {
    elements.push(reasoningBlock);
  }

  let activeAssistant: { elementId: string; text: string } | null = null;
  const hasVisibleTranscript = state.blocks.length > 0;

  for (const block of state.blocks) {
    if (block.kind === "assistant_text") {
      const rendered = renderAssistantTextBlock(state, block, options);
      if (rendered == null) {
        continue;
      }
      elements.push(rendered.element);
      if (rendered.isActiveAssistant) {
        activeAssistant = {
          elementId: block.elementId,
          text: block.text,
        };
      }
      continue;
    }

    if (block.kind === "tool_sequence") {
      elements.push(...renderToolSequenceBlock(block));
    }
  }

  if (
    !hasVisibleTranscript &&
    state.terminal === "running" &&
    state.activeAssistantMessageId != null
  ) {
    const elementId = buildLarkAssistantElementId(state.activeAssistantMessageId);
    const content = options.normalizeActiveAssistantText
      ? "__ACTIVE_ASSISTANT_STREAM__"
      : LARK_ASSISTANT_PLACEHOLDER_TEXT;
    elements.push({
      tag: "markdown",
      content,
      element_id: elementId,
    });
    activeAssistant = {
      elementId,
      text: LARK_ASSISTANT_PLACEHOLDER_TEXT,
    };
  }

  const emptyTerminalPlaceholder = renderEmptyRunStatePlaceholder(state, hasVisibleTranscript);
  if (emptyTerminalPlaceholder != null) {
    elements.push(emptyTerminalPlaceholder);
  }

  const footerElements = renderFooter(state.footerStatus, state.terminal, state.runId);
  if (footerElements.length > 0) {
    elements.push({ tag: "hr" }, ...footerElements);
  }

  return {
    card: {
      schema: "2.0",
      config: {
        streaming_mode: state.terminal === "running" && state.activeAssistantMessageId != null,
        summary: {
          content: summarizeRunState(state),
        },
      },
      body: {
        elements,
      },
    },
    activeAssistant,
  };
}

function renderReasoningBlock(state: LarkRunState): Record<string, unknown> | null {
  if (state.reasoning.content.length === 0) {
    return null;
  }

  return {
    tag: "collapsible_panel",
    expanded: state.reasoning.active,
    header: {
      title: {
        tag: "markdown",
        content: state.reasoning.active ? "🧠 **思考中**" : "🧠 **思考完成，点击查看**",
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
        content: state.reasoning.content,
        text_size: "notation",
      },
    ],
  };
}

function renderAssistantTextBlock(
  state: LarkRunState,
  block: LarkAssistantTextBlock,
  options: {
    normalizeActiveAssistantText: boolean;
  },
): {
  element: Record<string, unknown>;
  isActiveAssistant: boolean;
} | null {
  const isActiveAssistant = block.messageId === state.activeAssistantMessageId;
  const isPlaceholder =
    isActiveAssistant && block.text.length === 0 && state.terminal === "running";
  if (!isPlaceholder && block.text.length === 0) {
    return null;
  }

  let content = block.text;
  if (options.normalizeActiveAssistantText && isActiveAssistant) {
    content = "__ACTIVE_ASSISTANT_STREAM__";
  } else if (isPlaceholder) {
    content = LARK_ASSISTANT_PLACEHOLDER_TEXT;
  }

  return {
    element: {
      tag: "markdown",
      content,
      element_id: block.elementId,
    },
    isActiveAssistant,
  };
}

function renderToolSequenceBlock(block: LarkToolSequenceBlock): Array<Record<string, unknown>> {
  if (block.tools.length === 0) {
    return [];
  }

  if (!block.finalized || block.tools.length <= 2) {
    return block.tools.map((tool) => renderToolDetail(tool));
  }

  return [
    {
      tag: "collapsible_panel",
      expanded: false,
      header: {
        title: {
          tag: "markdown",
          content: `☕ **${block.tools.length}个工具调用**`,
        },
        vertical_align: "center",
        icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" },
        icon_position: "follow_text",
        icon_expanded_angle: -180,
      },
      border: { color: "blue", corner_radius: "5px" },
      vertical_spacing: "8px",
      padding: "8px 8px 8px 8px",
      elements: block.tools.map((tool) => renderToolDetail(tool)),
    },
  ];
}

function buildApprovalCardElements(state: LarkApprovalState): Array<Record<string, unknown>> {
  const approved = state.decision === "approve";
  const requestedBashPrefixLines = formatRequestedBashPrefixLines(state.requestedBashPrefixes);
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "markdown",
      content: !state.resolved
        ? [
            "### 需要你的授权",
            "",
            `**操作**：${formatApprovalTitleMarkdown(state.title)}`,
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
              ...requestedBashPrefixLines,
              "",
              "**结果**：agent 将继续执行。",
            ].join("\n")
          : [
              `**操作**：${formatApprovalTitleMarkdown(state.title)}`,
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

function renderEmptyRunStatePlaceholder(
  state: LarkRunState,
  hasVisibleTranscript: boolean,
): Record<string, unknown> | null {
  if (hasVisibleTranscript) {
    return null;
  }

  if (state.terminal === "awaiting_approval") {
    return {
      tag: "markdown",
      content: "🔐 **当前执行已暂停**\n\n等待你处理下方的授权卡。",
    };
  }

  if (state.terminal === "continued") {
    return {
      tag: "markdown",
      content: "✅ **已获得授权**\n\n后续执行会在新的卡片中继续。",
    };
  }

  if (state.terminal === "denied") {
    return {
      tag: "markdown",
      content: "❌ **授权已拒绝**\n\n本次执行已停止。",
    };
  }

  if (state.terminal === "failed") {
    const details = formatTerminalMessage(state.terminalMessage);
    return {
      tag: "markdown",
      content:
        details == null
          ? "❌ **执行失败**"
          : `❌ **执行失败**\n\n**错误**\n\`\`\`\n${details}\n\`\`\``,
    };
  }

  if (state.terminal === "cancelled") {
    const details = formatTerminalMessage(state.terminalMessage);
    return {
      tag: "markdown",
      content:
        details == null ? "⏹ **已停止**" : `⏹ **已停止**\n\n**原因**\n\`\`\`\n${details}\n\`\`\``,
    };
  }

  return null;
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

function renderToolDetail(tool: LarkToolSequenceTool): Record<string, unknown> {
  const icon = tool.status === "completed" ? "✅" : tool.status === "failed" ? "❌" : "⏳";
  const summary = summarizeToolHeader(tool);
  const label = summarizeToolLabel(tool);

  return {
    tag: "collapsible_panel",
    expanded: tool.status === "running",
    header: {
      title: {
        tag: "markdown",
        content: `${icon} **${label}** — ${summary}`,
      },
      vertical_align: "center",
      icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" },
      icon_position: "follow_text",
      icon_expanded_angle: -180,
    },
    border: { color: tool.status === "failed" ? "red" : "grey", corner_radius: "5px" },
    vertical_spacing: "8px",
    padding: "8px 8px 8px 8px",
    elements: [
      {
        tag: "markdown",
        content: renderToolDetailContent(tool),
        text_size: "notation",
      },
    ],
  };
}

function summarizeToolLabel(tool: LarkToolSequenceTool): string {
  if (tool.toolName === "request_permissions") {
    return "请求授权";
  }

  return tool.toolName;
}

function renderToolDetailContent(tool: LarkToolSequenceTool): string {
  if (tool.toolName === "request_permissions") {
    return renderPermissionRequestToolDetailContent(tool);
  }
  if (tool.toolName === "bash") {
    return renderBashToolDetailContent(tool);
  }

  return (
    `**Input**\n\`\`\`json\n${prettyPrint(tool.args)}\n\`\`\`` +
    `\n\n**${
      tool.status === "failed" ? "Error" : "Output"
    }**\n\`\`\`\n${tool.status === "failed" ? (tool.errorMessage ?? "") : prettyPrint(tool.result)}\n\`\`\``
  );
}

function renderBashToolDetailContent(tool: LarkToolSequenceTool): string {
  const args = isRecord(tool.args) ? tool.args : null;
  const result = isRecord(tool.result) ? tool.result : null;
  const details = isRecord(result?.details) ? result.details : null;

  const command = firstString(args?.command, details?.command) ?? "";
  const cwd = firstString(args?.cwd, details?.cwd);
  const timeoutMs = firstNumber(args?.timeoutMs, details?.timeoutMs);
  const exitCode = firstNumber(details?.exitCode);
  const signal = firstString(details?.signal);
  const stdout = extractBashText(result, "stdout");
  const stderr = extractBashText(result, "stderr");

  let content = `**Command**\n\`\`\`bash\n${command}\n\`\`\``;
  if (cwd != null) {
    content += `\n\n**Cwd**\n\`${cwd}\``;
  }
  if (timeoutMs != null) {
    content += `\n\n**Timeout**\n\`${timeoutMs}ms\``;
  }

  if (tool.status === "failed") {
    content += `\n\n**Error**\n\`\`\`\n${tool.errorMessage ?? ""}\n\`\`\``;
    return content;
  }

  if (exitCode != null || signal != null) {
    content += `\n\n**Result**\n- exit_code: \`${exitCode ?? ""}\`\n- signal: \`${signal ?? ""}\``;
  }

  if (stdout.length > 0) {
    content += `\n\n**Stdout**\n\`\`\`\n${truncateText(stdout, 1600)}\n\`\`\``;
  }
  if (stderr.length > 0) {
    content += `\n\n**Stderr**\n\`\`\`\n${truncateText(stderr, 1600)}\n\`\`\``;
  }

  return content;
}

function renderPermissionRequestToolDetailContent(tool: LarkToolSequenceTool): string {
  const args = isRecord(tool.args) ? tool.args : null;
  const entries = Array.isArray(args?.entries) ? args.entries : [];
  const justification =
    typeof args?.justification === "string" && args.justification.trim().length > 0
      ? args.justification.trim()
      : null;

  const lines: string[] = [];
  if (justification != null) {
    lines.push("**原因**");
    lines.push(justification);
  }

  if (entries.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push("**请求的权限**");
    for (const entry of entries.slice(0, 8)) {
      if (!isRecord(entry)) {
        continue;
      }
      const path = typeof entry.path === "string" ? entry.path : "(unknown path)";
      const access = typeof entry.access === "string" ? entry.access : "unknown_access";
      const scope = typeof entry.scope === "string" ? entry.scope : "unknown_scope";
      lines.push(`- \`${access}\` · \`${scope}\` · \`${path}\``);
    }
    if (entries.length > 8) {
      lines.push(`- 还有 ${entries.length - 8} 项未展开`);
    }
  }

  if (tool.status === "completed") {
    lines.push("", "**结果**", "授权已通过，agent 将继续执行。");
  } else if (tool.status === "failed") {
    lines.push("", "**结果**", tool.errorMessage ?? "授权被拒绝或未完成。");
  } else {
    lines.push("", "**状态**", "等待你的授权。详见下方授权卡。");
  }

  return lines.join("\n");
}

function renderFooter(
  status: LarkFooterStatus,
  terminal: LarkRunState["terminal"],
  runId: string,
): Array<Record<string, unknown>> {
  const elements: Array<Record<string, unknown>> = [];
  if (status === "thinking") {
    elements.push({
      tag: "markdown",
      content: "🧠 正在思考",
      text_size: "notation",
    });
  }
  if (status === "tool_running") {
    elements.push({
      tag: "markdown",
      content: "🧰 正在调用工具",
      text_size: "notation",
    });
  }
  if (terminal === "running") {
    elements.push({
      tag: "button",
      text: { tag: "plain_text", content: "⏹ 停止" },
      type: "danger",
      value: { action: "stop_run", runId },
    });
  }
  return elements;
}

function prettyPrint(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function summarizeUnknown(value: unknown): string {
  return truncateText(
    typeof value === "string" ? value : prettyPrint(value).replace(/\s+/g, " "),
    80,
  );
}

function summarizeToolHeader(tool: LarkToolSequenceTool): string {
  const args = isRecord(tool.args) ? tool.args : null;
  if (tool.toolName === "request_permissions") {
    if (typeof args?.justification === "string" && args.justification.length > 0) {
      return truncateText(args.justification, 80);
    }
    const entries = Array.isArray(args?.entries) ? args.entries : [];
    return entries.length > 0 ? `请求 ${entries.length} 项额外权限` : "请求额外权限";
  }
  if (tool.toolName === "bash" && typeof args?.command === "string" && args.command.length > 0) {
    return truncateText(args.command, 80);
  }
  if (typeof args?.path === "string" && args.path.length > 0) {
    return truncateText(args.path, 80);
  }
  if (typeof args?.query === "string" && args.query.length > 0) {
    return truncateText(args.query, 80);
  }
  if (tool.status === "failed") {
    return truncateText(tool.errorMessage ?? "Tool failed", 80);
  }
  return summarizeUnknown(tool.args);
}

function summarizeRunState(state: LarkRunState): string {
  if (state.terminal === "completed") {
    return "已完成";
  }
  if (state.terminal === "failed") {
    return "已失败";
  }
  if (state.terminal === "cancelled") {
    return "已停止";
  }
  if (state.terminal === "awaiting_approval") {
    return "等待授权";
  }
  if (state.terminal === "continued") {
    return "已获授权";
  }
  if (state.terminal === "denied") {
    return "已拒绝";
  }
  if (state.footerStatus === "thinking") {
    return "正在思考";
  }
  if (state.footerStatus === "tool_running") {
    return "正在调用工具";
  }
  const activeAssistant = findActiveAssistantBlock(state);
  if (activeAssistant != null && activeAssistant.text.length === 0) {
    return "正在思考";
  }
  if (state.activeAssistantMessageId != null) {
    return "正在输出内容";
  }
  return "运行中";
}

function summarizeApprovalState(state: LarkApprovalState): string {
  if (!state.resolved) {
    return "等待授权";
  }
  return state.decision === "approve" ? "授权成功" : "已拒绝";
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
  const match = title.match(/^Approval required:\s+(Read\/write|Read|Write)\s+(.+)$/i);
  if (match == null) {
    return title;
  }

  const access = match[1] ?? "";
  const target = match[2] ?? "";
  return `Approval required: **${access}** \`${target}\``;
}

function findActiveAssistantBlock(state: LarkRunState): LarkAssistantTextBlock | null {
  if (state.activeAssistantMessageId == null) {
    return null;
  }
  for (let index = state.blocks.length - 1; index >= 0; index -= 1) {
    const block = state.blocks[index];
    if (block?.kind === "assistant_text" && block.messageId === state.activeAssistantMessageId) {
      return block;
    }
  }
  return null;
}

function extractBashText(result: Record<string, unknown> | null, tag: "stdout" | "stderr"): string {
  const content = Array.isArray(result?.content) ? result.content : [];
  for (const entry of content) {
    if (!isRecord(entry) || typeof entry.text !== "string") {
      continue;
    }
    const text = entry.text;
    const match = text.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "i"));
    if (match?.[1] != null) {
      return match[1].trim();
    }
  }
  return "";
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatTerminalMessage(message: string | null): string | null {
  if (message == null) {
    return null;
  }
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return truncateText(trimmed, 1600);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}
