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

export function renderLarkRunCard(state: LarkRunState): Record<string, unknown> {
  return buildLarkRenderedRunCard(state).card;
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

    elements.push(...renderToolSequenceBlock(block));
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

  const footerElements = renderFooter(state.footerStatus, state.terminal);
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

function renderToolDetail(tool: LarkToolSequenceTool): Record<string, unknown> {
  const icon = tool.status === "completed" ? "✅" : tool.status === "failed" ? "❌" : "⏳";
  const summary = summarizeToolHeader(tool);

  return {
    tag: "collapsible_panel",
    expanded: tool.status === "running",
    header: {
      title: {
        tag: "markdown",
        content: `${icon} **${tool.toolName}** — ${summary}`,
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

function renderToolDetailContent(tool: LarkToolSequenceTool): string {
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

function renderFooter(
  status: LarkFooterStatus,
  terminal: LarkRunState["terminal"],
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
      value: { action: "stop_run_placeholder" },
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}
