/**
 * Runtime-to-channel outbound event projection.
 *
 * Converts raw AgentLoop events and task lifecycle changes into channel-safe
 * envelopes with ownership/session/task anchors. Channel adapters consume these
 * envelopes and decide concrete rendering/transport behavior.
 */
import type { AgentRuntimeEvent } from "@/src/agent/events.js";
import {
  resolveSessionLiveState,
  resolveTaskRunLiveStateFromTaskRun,
} from "@/src/runtime/live-state.js";
import type { AgentRuntimeRole } from "@/src/security/policy.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import type { Session, SubagentCreationRequest, TaskRun } from "@/src/storage/schema/types.js";
import type {
  ThinkTankConsultationStatus,
  ThinkTankEpisodeStatus,
  ThinkTankEpisodeStepSnapshot,
  ThinkTankStructuredSummary,
} from "@/src/think-tank/types.js";

export interface OutboundEventContext {
  target: {
    conversationId: string;
    branchId: string;
  };
  session: {
    sessionId: string | null;
    purpose: string | null;
  };
  agent: {
    ownerAgentId: string | null;
    ownerRole: AgentRuntimeRole | null;
    mainAgentId: string | null;
  };
  taskRun: {
    taskRunId: string | null;
    runType: string | null;
    status: string | null;
    executionSessionId: string | null;
  };
  run: {
    runId: string | null;
  };
  object: {
    messageId: string | null;
    toolCallId: string | null;
    toolName: string | null;
    approvalId: string | null;
  };
}

export interface OrchestratedRuntimeEventEnvelope extends OutboundEventContext {
  kind: "runtime_event";
  event: AgentRuntimeEvent;
}

export interface TaskRunStartedOutboundEvent {
  type: "task_run_started";
  taskRunId: string;
  runType: string;
  status: string;
  startedAt: string;
  initiatorSessionId: string | null;
  parentRunId: string | null;
  cronJobId: string | null;
  executionSessionId: string | null;
}

export interface TaskRunCompletedOutboundEvent {
  type: "task_run_completed";
  taskRunId: string;
  runType: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  resultSummary: string | null;
  executionSessionId: string | null;
}

export interface TaskRunFailedOutboundEvent {
  type: "task_run_failed";
  taskRunId: string;
  runType: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  resultSummary: string | null;
  errorText: string | null;
  executionSessionId: string | null;
}

export interface TaskRunBlockedOutboundEvent {
  type: "task_run_blocked";
  taskRunId: string;
  runType: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  resultSummary: string | null;
  executionSessionId: string | null;
}

export interface TaskRunCancelledOutboundEvent {
  type: "task_run_cancelled";
  taskRunId: string;
  runType: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  resultSummary: string | null;
  cancelledBy: string | null;
  executionSessionId: string | null;
}

export type TaskRunOutboundEvent =
  | TaskRunStartedOutboundEvent
  | TaskRunCompletedOutboundEvent
  | TaskRunBlockedOutboundEvent
  | TaskRunFailedOutboundEvent
  | TaskRunCancelledOutboundEvent;

export interface OrchestratedTaskRunEventEnvelope extends OutboundEventContext {
  kind: "task_run_event";
  event: TaskRunOutboundEvent;
}

export interface SubagentCreationRequestedOutboundEvent {
  type: "subagent_creation_requested";
  requestId: string;
  title: string;
  description: string;
  workdir: string;
  expiresAt: string | null;
}

export interface SubagentCreationResolvedOutboundEvent {
  type: "subagent_creation_resolved";
  requestId: string;
  title: string;
  status: "created" | "denied" | "failed" | "expired";
  decidedAt: string | null;
  failureReason: string | null;
  createdSubagentAgentId: string | null;
  externalChatId: string | null;
  shareLink: string | null;
}

export type SubagentCreationOutboundEvent =
  | SubagentCreationRequestedOutboundEvent
  | SubagentCreationResolvedOutboundEvent;

export interface OrchestratedSubagentCreationEventEnvelope extends OutboundEventContext {
  kind: "subagent_creation_event";
  event: SubagentCreationOutboundEvent;
}

export interface ThinkTankConsultationUpsertedOutboundEvent {
  type: "consultation_upserted";
  status: ThinkTankConsultationStatus;
  topic: string;
  participants: Array<{
    id: string;
    title: string | null;
    model: string;
  }>;
  latestSummary: ThinkTankStructuredSummary | null;
  firstCompleted: boolean;
}

export interface ThinkTankEpisodeStartedOutboundEvent {
  type: "episode_started";
  episodeId: string;
  episodeSequence: number;
  prompt: string;
  plannedSteps: Array<{
    key: string;
    kind: ThinkTankEpisodeStepSnapshot["kind"];
    title: string;
    order: number;
  }> | null;
}

export interface ThinkTankEpisodeStepUpsertedOutboundEvent {
  type: "episode_step_upserted";
  episodeId: string;
  episodeSequence: number;
  step: ThinkTankEpisodeStepSnapshot;
}

export interface ThinkTankEpisodeSettledOutboundEvent {
  type: "episode_settled";
  episodeId: string;
  episodeSequence: number;
  status: Extract<ThinkTankEpisodeStatus, "completed" | "failed" | "cancelled">;
  latestSummary: ThinkTankStructuredSummary | null;
}

export type ThinkTankOutboundEvent =
  | ThinkTankConsultationUpsertedOutboundEvent
  | ThinkTankEpisodeStartedOutboundEvent
  | ThinkTankEpisodeStepUpsertedOutboundEvent
  | ThinkTankEpisodeSettledOutboundEvent;

export interface OrchestratedThinkTankEventEnvelope extends OutboundEventContext {
  kind: "think_tank_event";
  consultationId: string;
  episodeId: string | null;
  event: ThinkTankOutboundEvent;
}

export type OrchestratedOutboundEventEnvelope =
  | OrchestratedRuntimeEventEnvelope
  | OrchestratedTaskRunEventEnvelope
  | OrchestratedSubagentCreationEventEnvelope
  | OrchestratedThinkTankEventEnvelope;

export function projectRuntimeEvent(input: {
  db: StorageDb;
  event: AgentRuntimeEvent;
}): OrchestratedRuntimeEventEnvelope {
  const state = resolveSessionLiveState({
    db: input.db,
    sessionId: input.event.sessionId,
  });

  return {
    kind: "runtime_event",
    ...buildContext({
      conversationId: input.event.conversationId,
      branchId: input.event.branchId,
      sessionId: input.event.sessionId,
      sessionPurpose: state?.session.purpose ?? null,
      ownerAgentId: state?.ownerAgentId ?? null,
      ownerRole: state?.ownerRole ?? null,
      mainAgentId: state?.mainAgentId ?? null,
      taskRun: state?.taskRun ?? null,
      runId: input.event.runId,
      object: extractRuntimeObjectAnchors(input.event),
    }),
    event: input.event,
  };
}

export function projectTaskRunEvent(input: {
  db: StorageDb;
  event: TaskRunOutboundEvent;
  taskRun: TaskRun;
  executionSession: Session | null;
}): OrchestratedTaskRunEventEnvelope {
  const state = resolveTaskRunLiveStateFromTaskRun({
    db: input.db,
    taskRun: input.taskRun,
  });

  return {
    kind: "task_run_event",
    ...buildContext({
      conversationId: input.taskRun.conversationId,
      branchId: input.taskRun.branchId,
      sessionId: input.executionSession?.id ?? input.taskRun.executionSessionId ?? null,
      sessionPurpose: input.executionSession?.purpose ?? null,
      ownerAgentId: input.taskRun.ownerAgentId,
      ownerRole: state.ownerRole,
      mainAgentId: state.mainAgentId,
      taskRun: input.taskRun,
      runId: null,
      object: {
        messageId: null,
        toolCallId: null,
        toolName: null,
        approvalId: null,
      },
    }),
    event: input.event,
  };
}

export function projectSubagentCreationEvent(input: {
  db: StorageDb;
  request: SubagentCreationRequest;
  event: SubagentCreationOutboundEvent;
}): OrchestratedSubagentCreationEventEnvelope {
  const state = resolveSessionLiveState({
    db: input.db,
    sessionId: input.request.sourceSessionId,
  });

  return {
    kind: "subagent_creation_event",
    ...buildContext({
      conversationId: input.request.sourceConversationId,
      branchId: state?.session.branchId ?? "main",
      sessionId: input.request.sourceSessionId,
      sessionPurpose: state?.session.purpose ?? null,
      ownerAgentId: state?.ownerAgentId ?? input.request.sourceAgentId,
      ownerRole: state?.ownerRole ?? null,
      mainAgentId: state?.mainAgentId ?? input.request.sourceAgentId,
      taskRun: state?.taskRun ?? null,
      runId: null,
      object: {
        messageId: null,
        toolCallId: null,
        toolName: null,
        approvalId: null,
      },
    }),
    event: input.event,
  };
}

export function projectThinkTankEvent(input: {
  db: StorageDb;
  consultation: {
    id: string;
    sourceConversationId: string;
    sourceBranchId: string;
    sourceSessionId: string;
  };
  event: ThinkTankOutboundEvent;
}): OrchestratedThinkTankEventEnvelope {
  const state = resolveSessionLiveState({
    db: input.db,
    sessionId: input.consultation.sourceSessionId,
  });

  const episodeId =
    "episodeId" in input.event && typeof input.event.episodeId === "string"
      ? input.event.episodeId
      : null;

  return {
    kind: "think_tank_event",
    consultationId: input.consultation.id,
    episodeId,
    ...buildContext({
      conversationId: input.consultation.sourceConversationId,
      branchId: input.consultation.sourceBranchId,
      sessionId: input.consultation.sourceSessionId,
      sessionPurpose: state?.session.purpose ?? null,
      ownerAgentId: state?.ownerAgentId ?? null,
      ownerRole: state?.ownerRole ?? null,
      mainAgentId: state?.mainAgentId ?? null,
      taskRun: state?.taskRun ?? null,
      runId: null,
      object: {
        messageId: null,
        toolCallId: null,
        toolName: null,
        approvalId: null,
      },
    }),
    event: input.event,
  };
}

function buildContext(input: {
  conversationId: string;
  branchId: string;
  sessionId: string | null;
  sessionPurpose: string | null;
  ownerAgentId: string | null;
  ownerRole: AgentRuntimeRole | null;
  mainAgentId: string | null;
  taskRun: TaskRun | null;
  runId: string | null;
  object: OutboundEventContext["object"];
}): OutboundEventContext {
  return {
    target: {
      conversationId: input.conversationId,
      branchId: input.branchId,
    },
    session: {
      sessionId: input.sessionId,
      purpose: input.sessionPurpose,
    },
    agent: {
      ownerAgentId: input.ownerAgentId,
      ownerRole: input.ownerRole,
      mainAgentId: input.mainAgentId,
    },
    taskRun: {
      taskRunId: input.taskRun?.id ?? null,
      runType: input.taskRun?.runType ?? null,
      status: input.taskRun?.status ?? null,
      executionSessionId: input.taskRun?.executionSessionId ?? null,
    },
    run: {
      runId: input.runId,
    },
    object: input.object,
  };
}

function extractRuntimeObjectAnchors(event: AgentRuntimeEvent): OutboundEventContext["object"] {
  switch (event.type) {
    case "assistant_message_started":
    case "assistant_message_delta":
    case "assistant_reasoning_delta":
    case "assistant_message_completed":
    case "steer_message_consumed":
      return {
        messageId: event.messageId,
        toolCallId: null,
        toolName: null,
        approvalId: null,
      };
    case "tool_call_started":
    case "tool_call_completed":
    case "tool_call_failed":
      return {
        messageId: "messageId" in event ? event.messageId : null,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        approvalId: null,
      };
    case "approval_requested":
    case "approval_resolved":
      return {
        messageId: null,
        toolCallId: null,
        toolName: null,
        approvalId: event.approvalId,
      };
    default:
      return {
        messageId: null,
        toolCallId: null,
        toolName: null,
        approvalId: null,
      };
  }
}
