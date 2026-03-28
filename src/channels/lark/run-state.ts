import type {
  AssistantMessageCompletedEvent,
  AssistantMessageDeltaEvent,
  AssistantMessageStartedEvent,
  ToolCallCompletedEvent,
  ToolCallFailedEvent,
  ToolCallStartedEvent,
} from "@/src/agent/events.js";
import type { OrchestratedRuntimeEventEnvelope } from "@/src/orchestration/outbound-events.js";

export type LarkFooterStatus = "thinking" | "tool_running" | null;

export interface LarkAssistantTextBlock {
  kind: "assistant_text";
  blockId: string;
  elementId: string;
  messageId: string;
  text: string;
  streaming: boolean;
}

export interface LarkToolSequenceTool {
  toolCallId: string;
  toolName: string;
  status: "running" | "completed" | "failed";
  args: unknown;
  result?: unknown;
  errorMessage?: string;
}

export interface LarkToolSequenceBlock {
  kind: "tool_sequence";
  blockId: string;
  tools: LarkToolSequenceTool[];
  finalized: boolean;
}

export interface LarkReasoningState {
  content: string;
  expanded: boolean;
  active: boolean;
}

export type LarkRunTerminal =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "awaiting_approval"
  | "continued"
  | "denied";

export interface LarkRunState {
  runId: string;
  conversationId: string;
  branchId: string;
  sessionId: string | null;
  blocks: Array<LarkAssistantTextBlock | LarkToolSequenceBlock>;
  activeAssistantMessageId: string | null;
  activeToolSequenceBlockId: string | null;
  footerStatus: LarkFooterStatus;
  reasoning: LarkReasoningState;
  terminal: LarkRunTerminal;
}

export const LARK_ASSISTANT_PLACEHOLDER_TEXT = "_正在思考..._";

export function reduceLarkRunState(
  previous: LarkRunState | null,
  envelope: OrchestratedRuntimeEventEnvelope,
): LarkRunState {
  const state =
    previous ??
    createInitialRunState({
      runId: envelope.run.runId ?? `run:${envelope.event.eventId}`,
      conversationId: envelope.target.conversationId,
      branchId: envelope.target.branchId,
      sessionId: envelope.session.sessionId,
    });

  switch (envelope.event.type) {
    case "assistant_message_started":
      return onAssistantMessageStarted(state, envelope.event);
    case "assistant_message_delta":
      return onAssistantMessageDelta(state, envelope.event);
    case "assistant_message_completed":
      return onAssistantMessageCompleted(state, envelope.event);
    case "tool_call_started":
      return onToolCallStarted(state, envelope.event);
    case "tool_call_completed":
      return onToolCallCompleted(state, envelope.event);
    case "tool_call_failed":
      return onToolCallFailed(state, envelope.event);
    case "run_completed":
      return finalizeRun(state, "completed");
    case "run_cancelled":
      return finalizeRun(state, "cancelled");
    case "run_failed":
      return finalizeRun(state, "failed");
    default:
      return state;
  }
}

function createInitialRunState(input: {
  runId: string;
  conversationId: string;
  branchId: string;
  sessionId: string | null;
}): LarkRunState {
  return {
    runId: input.runId,
    conversationId: input.conversationId,
    branchId: input.branchId,
    sessionId: input.sessionId,
    blocks: [],
    activeAssistantMessageId: null,
    activeToolSequenceBlockId: null,
    footerStatus: null,
    reasoning: {
      content: "",
      expanded: false,
      active: false,
    },
    terminal: "running",
  };
}

function onAssistantMessageStarted(
  state: LarkRunState,
  event: AssistantMessageStartedEvent,
): LarkRunState {
  return {
    ...state,
    activeAssistantMessageId: event.messageId,
    footerStatus: "thinking",
    reasoning: {
      ...state.reasoning,
      active: false,
      expanded: false,
    },
  };
}

export function buildLarkAssistantElementId(messageId: string): string {
  let hash = 2166136261;
  for (let index = 0; index < messageId.length; index += 1) {
    hash ^= messageId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return `a_${(hash >>> 0).toString(36)}`;
}

function onAssistantMessageDelta(
  state: LarkRunState,
  event: AssistantMessageDeltaEvent,
): LarkRunState {
  const existingBlock = findAssistantBlock(state.blocks, event.messageId);
  const blocks =
    existingBlock == null && event.accumulatedText.length > 0
      ? [
          ...finalizeActiveToolSequenceIfNeeded(state.blocks, state.activeToolSequenceBlockId),
          createAssistantTextBlock(event.messageId, event.accumulatedText, true),
        ]
      : state.blocks.map((block) =>
          block.kind === "assistant_text" && block.messageId === event.messageId
            ? { ...block, text: event.accumulatedText, streaming: true }
            : block,
        );

  return {
    ...state,
    blocks,
    activeToolSequenceBlockId:
      existingBlock == null && event.accumulatedText.length > 0
        ? null
        : state.activeToolSequenceBlockId,
    footerStatus: null,
    reasoning: {
      ...state.reasoning,
      active: false,
      expanded: false,
    },
  };
}

function onAssistantMessageCompleted(
  state: LarkRunState,
  event: AssistantMessageCompletedEvent,
): LarkRunState {
  const existingBlock = findAssistantBlock(state.blocks, event.messageId);
  const hasVisibleText = event.text.length > 0;
  const blocks =
    existingBlock == null && hasVisibleText
      ? [
          ...finalizeActiveToolSequenceIfNeeded(state.blocks, state.activeToolSequenceBlockId),
          createAssistantTextBlock(event.messageId, event.text, false),
        ]
      : state.blocks.map((block) =>
          block.kind === "assistant_text" && block.messageId === event.messageId
            ? { ...block, text: event.text, streaming: false }
            : block,
        );

  return {
    ...state,
    blocks,
    activeAssistantMessageId:
      state.activeAssistantMessageId === event.messageId ? null : state.activeAssistantMessageId,
    activeToolSequenceBlockId:
      existingBlock == null && hasVisibleText ? null : state.activeToolSequenceBlockId,
    footerStatus: null,
    reasoning: {
      content:
        event.reasoningText == null || event.reasoningText.trim().length === 0
          ? state.reasoning.content
          : appendReasoningContent(state.reasoning.content, event.reasoningText),
      active: false,
      expanded: false,
    },
  };
}

function onToolCallStarted(state: LarkRunState, event: ToolCallStartedEvent): LarkRunState {
  const activeToolSequenceBlockId = state.activeToolSequenceBlockId ?? `tools:${event.toolCallId}`;
  const existing = state.blocks.find(
    (block) => block.kind === "tool_sequence" && block.blockId === activeToolSequenceBlockId,
  );

  const blocks =
    existing == null
      ? [
          ...state.blocks,
          {
            kind: "tool_sequence" as const,
            blockId: activeToolSequenceBlockId,
            tools: [],
            finalized: false,
          },
        ]
      : state.blocks;

  return {
    ...state,
    blocks: blocks.map((block) =>
      block.kind === "tool_sequence" && block.blockId === activeToolSequenceBlockId
        ? {
            ...block,
            tools: [
              ...block.tools,
              {
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                status: "running",
                args: event.args,
              },
            ],
          }
        : block,
    ),
    activeToolSequenceBlockId,
    footerStatus: "tool_running",
    reasoning: {
      ...state.reasoning,
      active: false,
      expanded: false,
    },
  };
}

function onToolCallCompleted(state: LarkRunState, event: ToolCallCompletedEvent): LarkRunState {
  return {
    ...state,
    blocks: state.blocks.map((block) =>
      block.kind === "tool_sequence"
        ? {
            ...block,
            tools: block.tools.map((tool) =>
              tool.toolCallId === event.toolCallId
                ? { ...tool, status: "completed", result: event.result }
                : tool,
            ),
          }
        : block,
    ),
    footerStatus: hasRunningTool(state.blocks, event.toolCallId) ? "tool_running" : null,
  };
}

function onToolCallFailed(state: LarkRunState, event: ToolCallFailedEvent): LarkRunState {
  return {
    ...state,
    blocks: state.blocks.map((block) =>
      block.kind === "tool_sequence"
        ? {
            ...block,
            tools: block.tools.map((tool) =>
              tool.toolCallId === event.toolCallId
                ? {
                    ...tool,
                    status: "failed",
                    errorMessage: event.rawErrorMessage ?? event.errorMessage,
                  }
                : tool,
            ),
          }
        : block,
    ),
    footerStatus: hasRunningTool(state.blocks, event.toolCallId) ? "tool_running" : null,
  };
}

function hasRunningTool(
  blocks: Array<LarkAssistantTextBlock | LarkToolSequenceBlock>,
  completedToolCallId: string,
): boolean {
  for (const block of blocks) {
    if (block.kind !== "tool_sequence") {
      continue;
    }
    for (const tool of block.tools) {
      if (tool.toolCallId !== completedToolCallId && tool.status === "running") {
        return true;
      }
    }
  }
  return false;
}

function finalizeRun(
  state: LarkRunState,
  terminal: "completed" | "failed" | "cancelled",
): LarkRunState {
  return {
    ...state,
    blocks: finalizeActiveToolSequenceIfNeeded(state.blocks, state.activeToolSequenceBlockId),
    activeAssistantMessageId: null,
    activeToolSequenceBlockId: null,
    footerStatus: null,
    reasoning: {
      ...state.reasoning,
      active: false,
      expanded: false,
    },
    terminal,
  };
}

export function markLarkRunAwaitingApproval(state: LarkRunState): LarkRunState {
  return {
    ...state,
    blocks: finalizeActiveToolSequenceIfNeeded(state.blocks, state.activeToolSequenceBlockId),
    activeAssistantMessageId: null,
    activeToolSequenceBlockId: null,
    footerStatus: null,
    reasoning: {
      ...state.reasoning,
      active: false,
      expanded: false,
    },
    terminal: "awaiting_approval",
  };
}

export function markLarkRunApprovalResolved(
  state: LarkRunState,
  decision: "approve" | "deny",
): LarkRunState {
  return {
    ...state,
    blocks: resolvePendingPermissionRequestTools(state.blocks, decision),
    activeAssistantMessageId: null,
    activeToolSequenceBlockId: null,
    footerStatus: null,
    reasoning: {
      ...state.reasoning,
      active: false,
      expanded: false,
    },
    terminal: decision === "approve" ? "continued" : "denied",
  };
}

export function hasVisibleLarkRunBlocks(state: LarkRunState): boolean {
  return state.blocks.some((block) => {
    if (block.kind === "assistant_text") {
      return block.text.trim().length > 0;
    }

    return block.tools.length > 0;
  });
}

function finalizeActiveToolSequenceIfNeeded(
  blocks: Array<LarkAssistantTextBlock | LarkToolSequenceBlock>,
  blockId: string | null,
): Array<LarkAssistantTextBlock | LarkToolSequenceBlock> {
  if (blockId == null) {
    return blocks;
  }

  return blocks.map((block) =>
    block.kind === "tool_sequence" && block.blockId === blockId
      ? { ...block, finalized: true }
      : block,
  );
}

function appendReasoningContent(existing: string, next: string): string {
  if (existing.length === 0) {
    return next;
  }
  return `${existing}\n\n${next}`;
}

function resolvePendingPermissionRequestTools(
  blocks: Array<LarkAssistantTextBlock | LarkToolSequenceBlock>,
  decision: "approve" | "deny",
): Array<LarkAssistantTextBlock | LarkToolSequenceBlock> {
  return blocks.map((block) => {
    if (block.kind !== "tool_sequence") {
      return block;
    }

    return {
      ...block,
      tools: block.tools.map((tool) => {
        if (tool.toolName !== "request_permissions" || tool.status !== "running") {
          return tool;
        }

        return decision === "approve"
          ? {
              ...tool,
              status: "completed",
              result: {
                status: "approved",
              },
            }
          : {
              ...tool,
              status: "failed",
              errorMessage: "用户拒绝了这次授权请求。",
            };
      }),
    };
  });
}

function createAssistantTextBlock(
  messageId: string,
  text: string,
  streaming: boolean,
): LarkAssistantTextBlock {
  return {
    kind: "assistant_text",
    blockId: `assistant:${messageId}`,
    elementId: buildLarkAssistantElementId(messageId),
    messageId,
    text,
    streaming,
  };
}

function findAssistantBlock(
  blocks: Array<LarkAssistantTextBlock | LarkToolSequenceBlock>,
  messageId: string,
): LarkAssistantTextBlock | null {
  for (const block of blocks) {
    if (block.kind === "assistant_text" && block.messageId === messageId) {
      return block;
    }
  }

  return null;
}

export function shouldHandleLarkRuntimeEvent(envelope: OrchestratedRuntimeEventEnvelope): boolean {
  return (
    envelope.event.type === "assistant_message_started" ||
    envelope.event.type === "assistant_message_delta" ||
    envelope.event.type === "assistant_message_completed" ||
    envelope.event.type === "tool_call_started" ||
    envelope.event.type === "tool_call_completed" ||
    envelope.event.type === "tool_call_failed" ||
    envelope.event.type === "run_completed" ||
    envelope.event.type === "run_cancelled" ||
    envelope.event.type === "run_failed"
  );
}
