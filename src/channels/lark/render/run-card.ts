import { capLarkCardReasoningTail } from "@/src/channels/lark/render/card-truncation.js";
import { renderToolSequenceSlice } from "@/src/channels/lark/render/tool-calls.js";
import {
  buildLarkAssistantElementId,
  LARK_ASSISTANT_PLACEHOLDER_TEXT,
  type LarkAssistantTextBlock,
  type LarkFooterStatus,
  type LarkRunState,
  type LarkToolSequenceTool,
} from "@/src/channels/lark/run-state.js";

const ACTIVE_ASSISTANT_SIGNATURE_TEXT = "__ACTIVE_ASSISTANT_STREAM__";
const REASONING_TAIL_MAX_CHARS = 500;
export const LARK_RUN_CARD_BYTE_BUDGET = 27 * 1024;
export const LARK_RUN_CARD_NODE_BUDGET = 180;

export interface LarkRenderedRunCard {
  card: Record<string, unknown>;
  structureSignature: string;
  activeAssistant: {
    elementId: string;
    text: string;
  } | null;
}

export interface LarkRenderedRunCardPage extends LarkRenderedRunCard {
  pageIndex: number;
  pageCount: number;
  metrics: {
    jsonBytes: number;
    taggedNodes: number;
  };
}

interface AssistantRunCardAtom {
  kind: "assistant_text";
  sourceBlockId: string;
  messageId: string;
  elementId: string | null;
  text: string;
  active: boolean;
}

interface ToolRunCardAtom {
  kind: "tool_call";
  sourceBlockId: string;
  tool: LarkToolSequenceTool;
  originalToolCount: number;
  originalFinalized: boolean;
  latestToolCallId: string | null;
}

type RunCardAtom = AssistantRunCardAtom | ToolRunCardAtom;

export function renderLarkRunCard(state: LarkRunState): Record<string, unknown> {
  return buildLarkRenderedRunCard(state).card;
}

export function buildLarkRenderedRunCard(state: LarkRunState): LarkRenderedRunCard {
  const pages = buildLarkRenderedRunCardPages(state);
  return pages.at(-1) ?? buildRenderedRunCardPage(state, [], { pageIndex: 1, pageCount: 1 });
}

export function buildLarkRenderedRunCardPages(state: LarkRunState): LarkRenderedRunCardPage[] {
  const atoms = buildRunCardAtoms(state);
  const pages = paginateRunCardAtoms(state, atoms);
  const pageCount = Math.max(1, pages.length);

  return pages.map((atomsForPage, index) =>
    buildRenderedRunCardPage(state, atomsForPage, {
      pageIndex: index + 1,
      pageCount,
    }),
  );
}

function buildRunCardAtoms(state: LarkRunState): RunCardAtom[] {
  const atoms: RunCardAtom[] = [];

  for (const block of state.blocks) {
    if (block.kind === "assistant_text") {
      atoms.push({
        kind: "assistant_text",
        sourceBlockId: block.blockId,
        messageId: block.messageId,
        elementId: block.messageId === state.activeAssistantMessageId ? block.elementId : null,
        text: block.text,
        active: block.messageId === state.activeAssistantMessageId,
      });
      continue;
    }

    for (const tool of block.tools) {
      atoms.push({
        kind: "tool_call",
        sourceBlockId: block.blockId,
        tool,
        originalToolCount: block.tools.length,
        originalFinalized: block.finalized,
        latestToolCallId: block.tools.at(-1)?.toolCallId ?? null,
      });
    }
  }

  return atoms;
}

function paginateRunCardAtoms(state: LarkRunState, atoms: RunCardAtom[]): RunCardAtom[][] {
  if (atoms.length === 0) {
    return [[]];
  }

  const pages: RunCardAtom[][] = [[]];
  const queue = [...atoms];

  while (queue.length > 0) {
    const atom = queue[0];
    if (atom == null) {
      break;
    }

    const currentPage = pages.at(-1);
    if (currentPage == null) {
      break;
    }

    const candidate = [...currentPage, atom];
    if (candidateFitsWithinBudget(state, candidate, { isFirstPage: pages.length === 1 })) {
      currentPage.push(atom);
      queue.shift();
      continue;
    }

    if (atom.kind === "assistant_text") {
      const splitAtoms = splitAssistantAtom(atom);
      if (splitAtoms.length > 1) {
        queue.splice(0, 1, ...splitAtoms);
        continue;
      }
    }

    if (currentPage.length === 0) {
      currentPage.push(atom);
      queue.shift();
      continue;
    }

    pages.push([]);
  }

  ensureLastPageFitsWithinBudget(state, pages);
  return pages;
}

function ensureLastPageFitsWithinBudget(state: LarkRunState, pages: RunCardAtom[][]): void {
  while (pages.length > 0) {
    const lastPageIndex = pages.length - 1;
    const lastPage = pages[lastPageIndex];
    if (lastPage == null) {
      return;
    }

    const rendered = buildRenderedRunCardPage(state, lastPage, {
      pageIndex: lastPageIndex + 1,
      pageCount: pages.length,
    });
    if (
      rendered.metrics.jsonBytes <= LARK_RUN_CARD_BYTE_BUDGET &&
      rendered.metrics.taggedNodes <= LARK_RUN_CARD_NODE_BUDGET
    ) {
      return;
    }
    if (lastPage.length <= 1) {
      return;
    }

    const carry: RunCardAtom[] = [];
    while (lastPage.length > 1) {
      const atom = lastPage.shift();
      if (atom != null) {
        carry.push(atom);
      }
      const nextRendered = buildRenderedRunCardPage(state, lastPage, {
        pageIndex: lastPageIndex + 2,
        pageCount: pages.length + 1,
      });
      if (
        nextRendered.metrics.jsonBytes <= LARK_RUN_CARD_BYTE_BUDGET &&
        nextRendered.metrics.taggedNodes <= LARK_RUN_CARD_NODE_BUDGET
      ) {
        break;
      }
    }

    if (carry.length === 0) {
      return;
    }

    pages.splice(lastPageIndex, 0, carry);
  }
}

function candidateFitsWithinBudget(
  state: LarkRunState,
  atoms: RunCardAtom[],
  options: { isFirstPage: boolean },
): boolean {
  const rendered = buildRenderedRunCardPage(state, atoms, {
    pageIndex: options.isFirstPage ? 1 : 2,
    pageCount: options.isFirstPage ? 1 : 2,
    includeFooter: false,
    includeTerminalSummary: false,
    allowEmptyPlaceholder: false,
  });

  return (
    rendered.metrics.jsonBytes <= LARK_RUN_CARD_BYTE_BUDGET &&
    rendered.metrics.taggedNodes <= LARK_RUN_CARD_NODE_BUDGET
  );
}

function splitAssistantAtom(atom: AssistantRunCardAtom): AssistantRunCardAtom[] {
  if (atom.active) {
    return [atom];
  }

  const fragments = splitTextForCards(atom.text);
  if (fragments.length <= 1) {
    return [atom];
  }

  return fragments.map((text) => ({
    kind: "assistant_text",
    sourceBlockId: atom.sourceBlockId,
    messageId: atom.messageId,
    elementId: null,
    text,
    active: false,
  }));
}

function splitTextForCards(text: string): string[] {
  const paragraphFragments = splitTextBySeparator(text, "\n\n");
  if (paragraphFragments.length > 1) {
    return paragraphFragments;
  }

  const lineFragments = splitTextBySeparator(text, "\n");
  if (lineFragments.length > 1) {
    return lineFragments;
  }

  const normalized = text.trim();
  if (normalized.length <= 1600) {
    return [text];
  }

  const fragments: string[] = [];
  for (let cursor = 0; cursor < text.length; cursor += 1600) {
    fragments.push(text.slice(cursor, cursor + 1600));
  }
  return fragments;
}

function splitTextBySeparator(text: string, separator: "\n\n" | "\n"): string[] {
  if (!text.includes(separator)) {
    return [text];
  }

  const parts = text.split(separator);
  const fragments: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part == null) {
      continue;
    }
    const suffix = index < parts.length - 1 ? separator : "";
    const fragment = `${part}${suffix}`;
    if (fragment.length > 0) {
      fragments.push(fragment);
    }
  }

  return fragments.length > 0 ? fragments : [text];
}

function buildRenderedRunCardPage(
  state: LarkRunState,
  atoms: RunCardAtom[],
  options: {
    pageIndex: number;
    pageCount: number;
    includeFooter?: boolean;
    includeTerminalSummary?: boolean;
    allowEmptyPlaceholder?: boolean;
  },
): LarkRenderedRunCardPage {
  const full = buildRunCardPage(state, atoms, {
    ...options,
    normalizeActiveAssistantText: false,
  });
  const normalized = buildRunCardPage(state, atoms, {
    ...options,
    normalizeActiveAssistantText: true,
  });
  const cardJson = JSON.stringify(full.card);

  return {
    card: full.card,
    structureSignature: JSON.stringify(normalized.card),
    activeAssistant: full.activeAssistant,
    pageIndex: options.pageIndex,
    pageCount: options.pageCount,
    metrics: {
      jsonBytes: Buffer.byteLength(cardJson, "utf8"),
      taggedNodes: countTaggedNodes(full.card),
    },
  };
}

function buildRunCardPage(
  state: LarkRunState,
  atoms: RunCardAtom[],
  options: {
    pageIndex: number;
    pageCount: number;
    normalizeActiveAssistantText: boolean;
    includeFooter?: boolean;
    includeTerminalSummary?: boolean;
    allowEmptyPlaceholder?: boolean;
  },
): {
  card: Record<string, unknown>;
  activeAssistant: {
    elementId: string;
    text: string;
  } | null;
} {
  const elements: Array<Record<string, unknown>> = [];
  const includeFooter = options.includeFooter ?? true;
  const includeTerminalSummary = options.includeTerminalSummary ?? true;
  const allowEmptyPlaceholder = options.allowEmptyPlaceholder ?? true;
  const reasoningContent =
    options.pageIndex === 1 && state.reasoning.content.length > 0
      ? capLarkCardReasoningTail(state.reasoning.content, REASONING_TAIL_MAX_CHARS)
      : "";

  if (reasoningContent.length > 0) {
    elements.push(renderReasoningBlock(state, reasoningContent));
  }

  let activeAssistant: { elementId: string; text: string } | null = null;
  let hasVisibleTranscript = false;

  for (let index = 0; index < atoms.length; index += 1) {
    const atom = atoms[index];
    if (atom == null) {
      continue;
    }

    if (atom.kind === "assistant_text") {
      const rendered = renderAssistantAtom(state, atom, {
        normalizeActiveAssistantText: options.normalizeActiveAssistantText,
      });
      if (rendered != null) {
        elements.push(rendered.element);
        hasVisibleTranscript = true;
        if (rendered.isActiveAssistant) {
          activeAssistant = rendered.activeAssistant;
        }
      }
      continue;
    }

    const group: ToolRunCardAtom[] = [atom];
    for (let cursor = index + 1; cursor < atoms.length; cursor += 1) {
      const nextAtom = atoms[cursor];
      if (nextAtom?.kind !== "tool_call" || nextAtom.sourceBlockId !== atom.sourceBlockId) {
        break;
      }
      group.push(nextAtom);
      index = cursor;
    }

    elements.push(...renderToolGroup(group));
    hasVisibleTranscript = true;
  }

  if (!hasVisibleTranscript && options.pageIndex === options.pageCount) {
    if (state.terminal === "running" && state.activeAssistantMessageId != null) {
      const elementId = buildLarkAssistantElementId(state.activeAssistantMessageId);
      const content = options.normalizeActiveAssistantText
        ? ACTIVE_ASSISTANT_SIGNATURE_TEXT
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

    if (allowEmptyPlaceholder) {
      const emptyTerminalPlaceholder = renderEmptyRunStatePlaceholder(state, hasVisibleTranscript);
      if (emptyTerminalPlaceholder != null) {
        elements.push(emptyTerminalPlaceholder);
      }
    }
  }

  if (includeTerminalSummary && options.pageIndex === options.pageCount) {
    const terminalSummary = renderVisibleTerminalSummary(state, hasVisibleTranscript);
    if (terminalSummary != null) {
      elements.push(terminalSummary);
    }
  }

  if (includeFooter && options.pageIndex === options.pageCount) {
    const footerElements = renderFooter(state.footerStatus, state.terminal, state.runId);
    if (footerElements.length > 0) {
      elements.push({ tag: "hr" }, ...footerElements);
    }
  }

  return {
    card: {
      schema: "2.0",
      config: {
        streaming_mode: state.terminal === "running" && activeAssistant != null,
        summary: {
          content: summarizeRunState(state),
        },
      },
      ...(buildTaskRunHeader(state) == null ? {} : { header: buildTaskRunHeader(state) }),
      body: {
        elements,
      },
    },
    activeAssistant,
  };
}

function renderToolGroup(group: ToolRunCardAtom[]): Array<Record<string, unknown>> {
  const tools = group.map((atom) => atom.tool);
  const first = group[0];
  if (first == null) {
    return [];
  }

  return renderToolSequenceSlice({
    tools,
    finalized: first.originalFinalized,
    originalToolCount: first.originalToolCount,
    latestToolCallId: first.latestToolCallId,
  });
}

function renderReasoningBlock(state: LarkRunState, content: string): Record<string, unknown> {
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
        content,
        text_size: "notation",
      },
    ],
  };
}

function renderAssistantAtom(
  state: LarkRunState,
  atom: AssistantRunCardAtom,
  options: {
    normalizeActiveAssistantText: boolean;
  },
): {
  element: Record<string, unknown>;
  isActiveAssistant: boolean;
  activeAssistant: {
    elementId: string;
    text: string;
  };
} | null {
  const isActiveAssistant = atom.active;
  const isPlaceholder = isActiveAssistant && atom.text.length === 0 && state.terminal === "running";
  if (!isPlaceholder && atom.text.length === 0) {
    return null;
  }

  let content = atom.text;
  if (options.normalizeActiveAssistantText && isActiveAssistant) {
    content = ACTIVE_ASSISTANT_SIGNATURE_TEXT;
  } else if (isPlaceholder) {
    content = LARK_ASSISTANT_PLACEHOLDER_TEXT;
  }

  return {
    element: {
      tag: "markdown",
      content,
      ...(atom.elementId == null ? {} : { element_id: atom.elementId }),
    },
    isActiveAssistant,
    activeAssistant:
      atom.elementId == null
        ? {
            elementId: buildLarkAssistantElementId(atom.messageId),
            text: atom.text,
          }
        : {
            elementId: atom.elementId,
            text: atom.text,
          },
  };
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

  if (state.terminal === "running" && state.taskRunId != null) {
    return {
      tag: "markdown",
      content: "⏳ **任务已启动**\n\n等待输出或工具执行结果。",
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

  if (state.terminal === "blocked") {
    const details = formatTerminalMessage(state.terminalMessage);
    return {
      tag: "markdown",
      content:
        details == null
          ? "⏸ **任务已阻塞**"
          : `⏸ **任务已阻塞**\n\n**需要处理**\n\`\`\`\n${details}\n\`\`\``,
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

function renderVisibleTerminalSummary(
  state: LarkRunState,
  hasVisibleTranscript: boolean,
): Record<string, unknown> | null {
  if (!hasVisibleTranscript) {
    return null;
  }

  const details = formatTerminalMessage(state.terminalMessage);
  if (state.taskRunId != null && state.terminal === "completed" && details != null) {
    return {
      tag: "markdown",
      content: `✅ **任务已完成**\n\n${details}`,
    };
  }
  if (state.taskRunId != null && state.terminal === "blocked" && details != null) {
    return {
      tag: "markdown",
      content: `⏸ **任务已阻塞**\n\n${details}`,
    };
  }
  if (state.taskRunId != null && state.terminal === "failed" && details != null) {
    return {
      tag: "markdown",
      content: `❌ **任务失败**\n\n${details}`,
    };
  }
  if (state.taskRunId != null && state.terminal === "cancelled" && details != null) {
    return {
      tag: "markdown",
      content: `⏹ **任务已停止**\n\n${details}`,
    };
  }

  if (state.terminal === "failed") {
    return {
      tag: "markdown",
      content: details == null ? "❌ **执行失败**" : `❌ **执行失败**\n\n${details}`,
    };
  }

  if (state.terminal === "cancelled") {
    return {
      tag: "markdown",
      content: details == null ? "⏹ **已停止**" : `⏹ **已停止**\n\n${details}`,
    };
  }

  if (state.terminal === "denied") {
    return {
      tag: "markdown",
      content: "❌ **授权已拒绝**\n\n本次执行已停止。",
    };
  }

  return null;
}

function renderFooter(
  status: LarkFooterStatus,
  terminal: LarkRunState["terminal"],
  runId: string | null,
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
  if (terminal === "running" && runId != null && runId.trim().length > 0) {
    elements.push({
      tag: "button",
      text: { tag: "plain_text", content: "⏹ 停止" },
      type: "danger",
      value: { action: "stop_run", runId },
    });
  }
  return elements;
}

function summarizeRunState(state: LarkRunState): string {
  const taskKind = state.taskRunId == null ? null : describeTaskRunKind(state.taskRunType);

  if (taskKind != null) {
    if (state.terminal === "completed") {
      return `${taskKind}已完成`;
    }
    if (state.terminal === "blocked") {
      return `${taskKind}已阻塞`;
    }
    if (state.terminal === "failed") {
      return `${taskKind}失败`;
    }
    if (state.terminal === "cancelled") {
      return `${taskKind}已停止`;
    }
    if (state.terminal === "awaiting_approval") {
      return `${taskKind}等待授权`;
    }
    if (state.terminal === "continued") {
      return `${taskKind}已获授权`;
    }
    if (state.terminal === "denied") {
      return `${taskKind}已拒绝`;
    }
    if (state.footerStatus === "thinking") {
      return `${taskKind}正在思考`;
    }
    if (state.footerStatus === "tool_running") {
      return `${taskKind}正在调用工具`;
    }
    if (state.activeAssistantMessageId != null) {
      return `${taskKind}正在输出`;
    }
    return `${taskKind}运行中`;
  }

  if (state.terminal === "completed") {
    return "已完成";
  }
  if (state.terminal === "blocked") {
    return "已阻塞";
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
  if (state.taskRunId != null) {
    return "任务运行中";
  }
  return "运行中";
}

function buildTaskRunHeader(state: LarkRunState): Record<string, unknown> | null {
  if (state.taskRunId == null) {
    return null;
  }

  const kindLabel = describeTaskRunKind(state.taskRunType);
  return {
    title: {
      tag: "plain_text",
      content: `${kindLabel}${describeTaskRunTerminal(state.terminal)}`,
    },
    template: describeTaskRunTemplate(state.terminal),
    icon: {
      tag: "standard_icon",
      token: describeTaskRunIcon(state.terminal),
    },
  };
}

function describeTaskRunKind(runType: string | null): string {
  if (runType === "cron") {
    return "定时任务";
  }
  if (runType === "system") {
    return "系统任务";
  }
  return "后台任务";
}

function describeTaskRunTerminal(terminal: LarkRunState["terminal"]): string {
  if (terminal === "completed") {
    return "已完成";
  }
  if (terminal === "blocked") {
    return "已阻塞";
  }
  if (terminal === "failed") {
    return "失败";
  }
  if (terminal === "cancelled") {
    return "已停止";
  }
  if (terminal === "awaiting_approval") {
    return "等待授权";
  }
  if (terminal === "continued") {
    return "已获授权";
  }
  if (terminal === "denied") {
    return "已拒绝";
  }
  return "运行中";
}

function describeTaskRunTemplate(terminal: LarkRunState["terminal"]): string {
  if (terminal === "completed" || terminal === "continued") {
    return "green";
  }
  if (terminal === "failed" || terminal === "cancelled" || terminal === "denied") {
    return "red";
  }
  if (terminal === "blocked") {
    return "grey";
  }
  return "blue";
}

function describeTaskRunIcon(terminal: LarkRunState["terminal"]): string {
  if (terminal === "completed" || terminal === "continued") {
    return "yes_filled";
  }
  if (terminal === "cancelled" || terminal === "denied") {
    return "close_filled";
  }
  if (terminal === "failed" || terminal === "blocked") {
    return "warning_outlined";
  }
  if (terminal === "awaiting_approval") {
    return "lock_chat_filled";
  }
  return "robot_outlined";
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

function countTaggedNodes(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, entry) => sum + countTaggedNodes(entry), 0);
  }

  if (value == null || typeof value !== "object") {
    return 0;
  }

  const record = value as Record<string, unknown>;
  const selfCount = typeof record.tag === "string" ? 1 : 0;
  return (
    selfCount +
    Object.values(record).reduce<number>((sum, entry) => sum + countTaggedNodes(entry), 0)
  );
}
