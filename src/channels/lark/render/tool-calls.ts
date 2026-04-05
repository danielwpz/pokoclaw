import {
  truncateLarkCardString,
  truncateLarkCardValueDeep,
} from "@/src/channels/lark/render/card-truncation.js";
import type { LarkToolSequenceBlock, LarkToolSequenceTool } from "@/src/channels/lark/run-state.js";

export function renderToolSequenceBlock(
  block: LarkToolSequenceBlock,
): Array<Record<string, unknown>> {
  return renderToolSequenceSlice({
    tools: block.tools,
    finalized: block.finalized,
    originalToolCount: block.tools.length,
    latestToolCallId: block.finalized ? null : (block.tools.at(-1)?.toolCallId ?? null),
  });
}

export function renderToolSequenceSlice(input: {
  tools: LarkToolSequenceTool[];
  finalized: boolean;
  originalToolCount?: number;
  latestToolCallId?: string | null;
}): Array<Record<string, unknown>> {
  const originalToolCount = input.originalToolCount ?? input.tools.length;
  if (input.tools.length === 0) {
    return [];
  }

  if (input.finalized) {
    if (originalToolCount <= 2) {
      return input.tools.map((tool) => renderToolDetail(tool));
    }
    return [renderCollapsedToolHistoryPanel(input.tools)];
  }

  if (originalToolCount <= 2) {
    return input.tools.map((tool) => renderToolDetail(tool));
  }

  const latestToolCallId = input.latestToolCallId ?? input.tools.at(-1)?.toolCallId ?? null;
  if (latestToolCallId == null) {
    return [renderCollapsedToolHistoryPanel(input.tools, "（已结束）")];
  }

  const latestToolIndex = input.tools.findIndex((tool) => tool.toolCallId === latestToolCallId);
  if (latestToolIndex < 0) {
    return [renderCollapsedToolHistoryPanel(input.tools, "（已结束）")];
  }

  const latestTool = input.tools[latestToolIndex];
  if (latestTool == null) {
    return [];
  }

  const elements: Array<Record<string, unknown>> = [];
  const priorTools = input.tools.slice(0, latestToolIndex);
  if (priorTools.length > 0) {
    elements.push(renderCollapsedToolHistoryPanel(priorTools, "（已结束）"));
  }
  elements.push(renderToolDetail(latestTool));
  return elements;
}

function renderCollapsedToolHistoryPanel(
  tools: LarkToolSequenceTool[],
  suffix = "",
): Record<string, unknown> {
  return {
    tag: "collapsible_panel",
    expanded: false,
    header: {
      title: {
        tag: "markdown",
        content: `☕ **${tools.length}个工具调用**${suffix}`,
      },
      vertical_align: "center",
      icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" },
      icon_position: "follow_text",
      icon_expanded_angle: -180,
    },
    border: { color: "blue", corner_radius: "5px" },
    vertical_spacing: "8px",
    padding: "8px 8px 8px 8px",
    elements: tools.map((tool) => renderToolDetail(tool)),
  };
}

function renderToolDetail(
  tool: LarkToolSequenceTool,
  options: {
    expanded?: boolean;
  } = {},
): Record<string, unknown> {
  const icon = tool.status === "completed" ? "✅" : tool.status === "failed" ? "❌" : "⏳";
  const summary = summarizeToolHeader(tool);
  const label = summarizeToolLabel(tool);
  const title = summary.length > 0 ? `${icon} **${label}** — ${summary}` : `${icon} **${label}**`;

  return {
    tag: "collapsible_panel",
    expanded: options.expanded ?? false,
    header: {
      title: {
        tag: "markdown",
        content: title,
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
  return tool.toolName;
}

function renderToolDetailContent(tool: LarkToolSequenceTool): string {
  if (tool.toolName === "request_permissions") {
    return renderPermissionRequestToolDetailContent(tool);
  }
  if (tool.toolName === "bash") {
    return renderBashToolDetailContent(tool);
  }

  const truncatedArgs = truncateLarkCardValueDeep(tool.args);
  const truncatedResult =
    tool.status === "failed"
      ? truncateLarkCardString(tool.errorMessage ?? "")
      : truncateLarkCardValueDeep(tool.result);

  return (
    `**Input**\n\`\`\`json\n${prettyPrint(truncatedArgs)}\n\`\`\`` +
    `\n\n**${
      tool.status === "failed" ? "Error" : "Output"
    }**\n\`\`\`\n${prettyPrint(truncatedResult)}\n\`\`\``
  );
}

function renderBashToolDetailContent(tool: LarkToolSequenceTool): string {
  const args = isRecord(tool.args) ? tool.args : null;
  const result = isRecord(tool.result) ? tool.result : null;
  const details = isRecord(result?.details) ? result.details : null;

  const command = truncateLarkCardString(firstString(args?.command, details?.command) ?? "", {
    maxChars: 240,
    maxLines: 8,
  });
  const cwd = firstString(args?.cwd, details?.cwd);
  const timeoutSec = firstNumber(args?.timeoutSec);
  const timeoutMs = firstNumber(args?.timeoutMs, details?.timeoutMs);
  const exitCode = firstNumber(details?.exitCode);
  const signal = firstString(details?.signal);
  const stdout = extractBashText(result, "stdout");
  const stderr = extractBashText(result, "stderr");

  let content = `**Command**\n\`\`\`bash\n${command}\n\`\`\``;
  if (cwd != null) {
    content += `\n\n**Cwd**\n\`${cwd}\``;
  }
  if (timeoutSec != null) {
    content += `\n\n**Timeout**\n\`${timeoutSec}s\``;
  } else if (timeoutMs != null) {
    content += `\n\n**Timeout**\n\`${timeoutMs}ms\``;
  }

  if (tool.status === "failed") {
    content += `\n\n**Error**\n\`\`\`\n${truncateLarkCardString(tool.errorMessage ?? "", {
      maxChars: 240,
      maxLines: 8,
    })}\n\`\`\``;
    return content;
  }

  if (exitCode != null || signal != null) {
    content += `\n\n**Result**\n- exit_code: \`${exitCode ?? ""}\`\n- signal: \`${signal ?? ""}\``;
  }

  if (stdout.length > 0) {
    content += `\n\n**Stdout**\n\`\`\`\n${truncateLarkCardString(stdout, {
      maxChars: 240,
      maxLines: 8,
    })}\n\`\`\``;
  }
  if (stderr.length > 0) {
    content += `\n\n**Stderr**\n\`\`\`\n${truncateLarkCardString(stderr, {
      maxChars: 240,
      maxLines: 8,
    })}\n\`\`\``;
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
    // No extra result footer for approved authorization requests; the approved
    // state is already clear from the card header/status.
  } else if (tool.status === "failed") {
    lines.push("", "**结果**", tool.errorMessage ?? "授权被拒绝或未完成。");
  } else {
    lines.push("", "**状态**", "等待授权处理。");
  }

  return lines.join("\n");
}

function summarizeToolHeader(tool: LarkToolSequenceTool): string {
  if (tool.status === "failed") {
    return truncateText(tool.errorMessage ?? "Tool failed", 80);
  }

  const args = isRecord(tool.args) ? tool.args : null;
  switch (tool.toolName) {
    case "schedule_task":
      return summarizeScheduleTask(args);
    case "create_subagent":
      return summarizeCreateSubagent(args);
    case "finish_task":
      return summarizeFinishTask(args);
    case "request_permissions":
      return summarizePermissionRequest(args);
    case "review_permission_request":
      return summarizePermissionReview(args);
    case "bash":
      return summarizeBash(args);
    case "read":
    case "write":
    case "edit":
    case "ls":
      return summarizePath(args);
    case "list_dir":
      return summarizeListDir(args);
    case "grep":
      return summarizeGrep(args);
    default:
      return summarizeGeneric(args);
  }
}

function summarizeScheduleTask(args: Record<string, unknown> | null): string {
  const action = readString(args?.action);
  if (action == null) {
    return "";
  }

  if (action === "list") {
    return "任务列表";
  }

  if (action === "create") {
    const name = readString(args?.name);
    const scheduleKind = readString(args?.scheduleKind);
    const scheduleValue = readString(args?.scheduleValue);
    const mode = scheduleKind === "at" ? "单次执行" : "周期执行";
    return summarizeParts(mode, name, scheduleValue);
  }

  if (action === "remove") {
    return summarizeParts("已删除", summarizeTaskRef(args));
  }
  if (action === "run") {
    return summarizeParts("立即执行", summarizeTaskRef(args));
  }
  if (action === "pause") {
    return summarizeParts("已暂停", summarizeTaskRef(args));
  }
  if (action === "resume") {
    return summarizeParts("已启用", summarizeTaskRef(args));
  }
  if (action === "update") {
    if (typeof args?.enabled === "boolean") {
      return summarizeParts(args.enabled ? "已启用" : "已暂停", summarizeTaskRef(args));
    }
    return summarizeParts("已更新", summarizeTaskRef(args));
  }

  return "";
}

function summarizeCreateSubagent(args: Record<string, unknown> | null): string {
  return readString(args?.title) ?? "";
}

function summarizeFinishTask(args: Record<string, unknown> | null): string {
  const status = readString(args?.status);
  if (status === "completed") {
    return "已完成";
  }
  if (status === "failed") {
    return "执行失败";
  }
  if (status === "blocked") {
    return "受阻";
  }
  return "";
}

function summarizePermissionRequest(args: Record<string, unknown> | null): string {
  return readString(args?.justification) ?? "";
}

function summarizePermissionReview(args: Record<string, unknown> | null): string {
  const decision = readString(args?.decision);
  const decisionLabel = decision === "approve" ? "已批准" : decision === "deny" ? "已拒绝" : null;
  const approvalId = readIdentifier(args?.approvalId);
  return summarizeParts(decisionLabel, approvalId == null ? null : `#${approvalId}`);
}

function summarizeBash(args: Record<string, unknown> | null): string {
  const command = readString(args?.command);
  return command == null ? "" : truncateText(normalizeSingleLine(command), 80);
}

function summarizePath(args: Record<string, unknown> | null): string {
  return readString(args?.path) ?? "";
}

function summarizeListDir(args: Record<string, unknown> | null): string {
  return readString(args?.dir_path) ?? summarizePath(args);
}

function summarizeGrep(args: Record<string, unknown> | null): string {
  const query = readString(args?.query);
  const path = readString(args?.path);
  return summarizeParts(query, path);
}

function summarizeGeneric(args: Record<string, unknown> | null): string {
  if (args == null) {
    return "";
  }
  const path = readString(args.path);
  if (path != null) {
    return path;
  }
  const name = readString(args.name);
  if (name != null) {
    return name;
  }
  const id = readString(args.id) ?? readString(args.jobId);
  if (id != null) {
    return `#${id}`;
  }
  const query = readString(args.query) ?? readString(args.pattern);
  if (query != null) {
    return query;
  }
  return "";
}

function summarizeTaskRef(args: Record<string, unknown> | null): string | null {
  const name = readString(args?.name);
  if (name != null) {
    return name;
  }
  const id = readString(args?.jobId);
  if (id != null) {
    return `#${id}`;
  }
  return null;
}

function summarizeParts(...parts: Array<string | null | undefined>): string {
  const normalized = parts
    .map((part) => (part == null ? null : part.trim()))
    .filter((part): part is string => part != null && part.length > 0);
  if (normalized.length === 0) {
    return "";
  }
  return truncateText(normalized.join(" · "), 80);
}

function normalizeSingleLine(text: string): string {
  return text
    .replace(/\s*\r?\n\s*/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
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

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readIdentifier(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
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
