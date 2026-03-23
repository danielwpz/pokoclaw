import type { CompactionReason } from "@/src/agent/compaction.js";
import type { AgentLlmErrorKind } from "@/src/agent/llm/errors.js";
import type { ModelScenario } from "@/src/agent/llm/models.js";
import type { MessageUsage } from "@/src/storage/repos/messages.repo.js";
import type { ToolFailureKind } from "@/src/tools/errors.js";

export interface AgentToolCall {
  id: string;
  name: string;
  args: unknown;
}

interface AgentRuntimeEventBase {
  eventId: string;
  sessionId: string;
  conversationId: string;
  branchId: string;
  runId: string;
  createdAt: string;
}

export interface RunStartedEvent extends AgentRuntimeEventBase {
  type: "run_started";
  scenario: ModelScenario;
  modelId: string;
}

export interface RunCompletedEvent extends AgentRuntimeEventBase {
  type: "run_completed";
  scenario: ModelScenario;
  modelId: string;
  appendedMessageIds: string[];
  toolExecutions: number;
  compactionRequested: boolean;
}

export interface RunFailedEvent extends AgentRuntimeEventBase {
  type: "run_failed";
  scenario: ModelScenario;
  modelId: string;
  errorKind: AgentLlmErrorKind | ToolFailureKind | "unknown";
  errorMessage: string;
  retryable: boolean;
}

export interface TurnStartedEvent extends AgentRuntimeEventBase {
  type: "turn_started";
  turn: number;
}

export interface TurnCompletedEvent extends AgentRuntimeEventBase {
  type: "turn_completed";
  turn: number;
  toolCallsRequested: number;
  toolExecutions: number;
}

export interface AssistantMessageStartedEvent extends AgentRuntimeEventBase {
  type: "assistant_message_started";
  turn: number;
  messageId: string;
}

export interface AssistantMessageDeltaEvent extends AgentRuntimeEventBase {
  type: "assistant_message_delta";
  turn: number;
  messageId: string;
  delta: string;
  accumulatedText: string;
}

export interface AssistantMessageCompletedEvent extends AgentRuntimeEventBase {
  type: "assistant_message_completed";
  turn: number;
  messageId: string;
  text: string;
  toolCalls: AgentToolCall[];
  usage: MessageUsage | null;
}

export interface ToolCallStartedEvent extends AgentRuntimeEventBase {
  type: "tool_call_started";
  turn: number;
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ToolCallCompletedEvent extends AgentRuntimeEventBase {
  type: "tool_call_completed";
  turn: number;
  toolCallId: string;
  toolName: string;
  messageId: string;
  result: unknown;
}

export interface ToolCallFailedEvent extends AgentRuntimeEventBase {
  type: "tool_call_failed";
  turn: number;
  toolCallId: string;
  toolName: string;
  errorKind: "recoverable_error" | "internal_error";
  errorMessage: string;
  retryable: boolean;
}

export interface CompactionRequestedEvent extends AgentRuntimeEventBase {
  type: "compaction_requested";
  reason: CompactionReason;
  thresholdTokens: number;
  effectiveWindow: number;
}

export interface CompactionStartedEvent extends AgentRuntimeEventBase {
  type: "compaction_started";
  reason: CompactionReason;
  modelId: string;
}

export interface CompactionCompletedEvent extends AgentRuntimeEventBase {
  type: "compaction_completed";
  reason: CompactionReason;
  modelId: string;
  compacted: boolean;
  compactCursor: number;
  summaryTokenTotal: number | null;
}

export interface CompactionFailedEvent extends AgentRuntimeEventBase {
  type: "compaction_failed";
  reason: CompactionReason;
  modelId: string;
  errorKind: AgentLlmErrorKind | "unknown";
  errorMessage: string;
  retryable: boolean;
}

export interface ApprovalRequestedEvent extends AgentRuntimeEventBase {
  type: "approval_requested";
  approvalId: string;
  title: string;
  reasonText: string;
  options: string[];
  expiresAt: string | null;
}

export interface ApprovalResolvedEvent extends AgentRuntimeEventBase {
  type: "approval_resolved";
  approvalId: string;
  decision: "approve" | "deny";
  actor: string;
  rawInput: string | null;
}

export type AgentRuntimeEvent =
  | RunStartedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | AssistantMessageStartedEvent
  | AssistantMessageDeltaEvent
  | AssistantMessageCompletedEvent
  | ToolCallStartedEvent
  | ToolCallCompletedEvent
  | ToolCallFailedEvent
  | CompactionRequestedEvent
  | CompactionStartedEvent
  | CompactionCompletedEvent
  | CompactionFailedEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent;

export type AgentRuntimeEventInput =
  | Omit<RunStartedEvent, "eventId" | "createdAt">
  | Omit<RunCompletedEvent, "eventId" | "createdAt">
  | Omit<RunFailedEvent, "eventId" | "createdAt">
  | Omit<TurnStartedEvent, "eventId" | "createdAt">
  | Omit<TurnCompletedEvent, "eventId" | "createdAt">
  | Omit<AssistantMessageStartedEvent, "eventId" | "createdAt">
  | Omit<AssistantMessageDeltaEvent, "eventId" | "createdAt">
  | Omit<AssistantMessageCompletedEvent, "eventId" | "createdAt">
  | Omit<ToolCallStartedEvent, "eventId" | "createdAt">
  | Omit<ToolCallCompletedEvent, "eventId" | "createdAt">
  | Omit<ToolCallFailedEvent, "eventId" | "createdAt">
  | Omit<CompactionRequestedEvent, "eventId" | "createdAt">
  | Omit<CompactionStartedEvent, "eventId" | "createdAt">
  | Omit<CompactionCompletedEvent, "eventId" | "createdAt">
  | Omit<CompactionFailedEvent, "eventId" | "createdAt">
  | Omit<ApprovalRequestedEvent, "eventId" | "createdAt">
  | Omit<ApprovalResolvedEvent, "eventId" | "createdAt">;
