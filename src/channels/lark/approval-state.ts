/**
 * Reducer state model for lark approval cards.
 *
 * Tracks one logical approval flow across one or more concrete approval
 * attempts so channel rendering can present a stable card even when a task
 * approval times out and falls back to delegated review.
 */
import type { ApprovalRequestedEvent, ApprovalResolvedEvent } from "@/src/agent/events.js";
import type { OrchestratedRuntimeEventEnvelope } from "@/src/orchestration/outbound-events.js";
import type { PermissionRequest } from "@/src/security/scope.js";

export type LarkApprovalFlowPhase =
  | "waiting_user"
  | "handoff_to_delegate"
  | "waiting_delegate"
  | "approved"
  | "denied";

export interface LarkApprovalAttemptState {
  approvalId: string;
  attemptIndex: number;
  approvalTarget: "user" | "main_agent";
  status: "pending" | "timed_out" | "approved" | "denied";
  actor: string | null;
}

export interface LarkApprovalState {
  flowId: string;
  approvalId: string;
  runId: string;
  conversationId: string;
  branchId: string;
  taskRunId: string | null;
  taskRunType: string | null;
  title: string;
  request: PermissionRequest;
  reasonText: string;
  commandText: string | null;
  approvalTarget: "user" | "main_agent";
  currentApprovalId: string | null;
  currentAttemptIndex: number;
  expiresAt: string | null;
  attempts: LarkApprovalAttemptState[];
  phase: LarkApprovalFlowPhase;
  resolved: boolean;
  decision: "approve" | "deny" | null;
  actor: string | null;
  sourceRunCardObjectId: string | null;
}

export function createLarkApprovalStateFromRequest(input: {
  event: ApprovalRequestedEvent;
  taskRunId?: string | null;
  taskRunType?: string | null;
  sourceRunCardObjectId: string | null;
}): LarkApprovalState {
  const flowId = readApprovalFlowId(input.event);
  const attemptIndex = readApprovalAttemptIndex(input.event);
  return {
    flowId,
    approvalId: input.event.approvalId,
    runId: input.event.runId,
    conversationId: input.event.conversationId,
    branchId: input.event.branchId,
    taskRunId: input.taskRunId ?? null,
    taskRunType: input.taskRunType ?? null,
    title: input.event.title,
    request: input.event.request,
    reasonText: input.event.reasonText,
    commandText: input.event.commandText ?? null,
    approvalTarget: input.event.approvalTarget,
    currentApprovalId: input.event.approvalId,
    currentAttemptIndex: attemptIndex,
    expiresAt: input.event.expiresAt,
    attempts: [
      {
        approvalId: input.event.approvalId,
        attemptIndex,
        approvalTarget: input.event.approvalTarget,
        status: "pending",
        actor: null,
      },
    ],
    phase: input.event.approvalTarget === "user" ? "waiting_user" : "waiting_delegate",
    resolved: false,
    decision: null,
    actor: null,
    sourceRunCardObjectId: input.sourceRunCardObjectId,
  };
}

export function reduceLarkApprovalState(
  previous: LarkApprovalState | null,
  envelope: OrchestratedRuntimeEventEnvelope,
  input?: {
    sourceRunCardObjectId?: string | null;
  },
): LarkApprovalState | null {
  switch (envelope.event.type) {
    case "approval_requested":
      return onApprovalRequested(
        previous,
        envelope as OrchestratedRuntimeEventEnvelope & { event: ApprovalRequestedEvent },
        input,
      );
    case "approval_resolved":
      return onApprovalResolved(
        previous,
        envelope as OrchestratedRuntimeEventEnvelope & { event: ApprovalResolvedEvent },
      );
    default:
      return previous;
  }
}

export function shouldHandleLarkApprovalRuntimeEvent(
  envelope: OrchestratedRuntimeEventEnvelope,
): boolean {
  return (
    envelope.event.type === "approval_requested" || envelope.event.type === "approval_resolved"
  );
}

function onApprovalRequested(
  previous: LarkApprovalState | null,
  envelope: OrchestratedRuntimeEventEnvelope & { event: ApprovalRequestedEvent },
  input?: {
    sourceRunCardObjectId?: string | null;
  },
): LarkApprovalState {
  if (previous == null || previous.flowId !== readApprovalFlowId(envelope.event)) {
    return createLarkApprovalStateFromRequest({
      event: envelope.event,
      taskRunId: envelope.taskRun.taskRunId,
      taskRunType: envelope.taskRun.runType,
      sourceRunCardObjectId: input?.sourceRunCardObjectId ?? null,
    });
  }

  const attemptIndex = readApprovalAttemptIndex(envelope.event);
  return {
    ...previous,
    approvalId: envelope.event.approvalId,
    runId: envelope.event.runId,
    conversationId: envelope.event.conversationId,
    branchId: envelope.event.branchId,
    taskRunId: envelope.taskRun.taskRunId ?? previous.taskRunId,
    taskRunType: envelope.taskRun.runType ?? previous.taskRunType,
    title: envelope.event.title,
    request: envelope.event.request,
    reasonText: envelope.event.reasonText,
    commandText: envelope.event.commandText ?? null,
    approvalTarget: envelope.event.approvalTarget,
    currentApprovalId: envelope.event.approvalId,
    currentAttemptIndex: attemptIndex,
    expiresAt: envelope.event.expiresAt,
    attempts: upsertAttempt(previous.attempts, {
      approvalId: envelope.event.approvalId,
      attemptIndex,
      approvalTarget: envelope.event.approvalTarget,
      status: "pending",
      actor: null,
    }),
    phase: envelope.event.approvalTarget === "user" ? "waiting_user" : "waiting_delegate",
    resolved: false,
    decision: null,
    actor: null,
    sourceRunCardObjectId: input?.sourceRunCardObjectId ?? previous.sourceRunCardObjectId ?? null,
  };
}

function onApprovalResolved(
  previous: LarkApprovalState | null,
  envelope: OrchestratedRuntimeEventEnvelope & { event: ApprovalResolvedEvent },
): LarkApprovalState | null {
  if (previous == null) {
    return null;
  }

  const flowContinues = envelope.event.flowContinues === true;
  const updatedAttempts = previous.attempts.map((attempt) =>
    attempt.approvalId !== envelope.event.approvalId
      ? attempt
      : {
          ...attempt,
          status: describeResolvedAttemptStatus(envelope.event.decision, envelope.event.actor, {
            flowContinues,
          }),
          actor: envelope.event.actor,
        },
  );

  if (flowContinues) {
    return {
      ...previous,
      approvalId: envelope.event.approvalId,
      currentApprovalId: null,
      currentAttemptIndex: envelope.event.approvalAttemptIndex ?? previous.currentAttemptIndex,
      expiresAt: null,
      attempts: updatedAttempts,
      phase: "handoff_to_delegate",
      resolved: false,
      decision: null,
      actor: envelope.event.actor,
    };
  }

  return {
    ...previous,
    approvalId: envelope.event.approvalId,
    currentApprovalId: null,
    currentAttemptIndex: envelope.event.approvalAttemptIndex ?? previous.currentAttemptIndex,
    expiresAt: null,
    attempts: updatedAttempts,
    phase: envelope.event.decision === "approve" ? "approved" : "denied",
    resolved: true,
    decision: envelope.event.decision,
    actor: envelope.event.actor,
  };
}

function upsertAttempt(
  attempts: LarkApprovalAttemptState[],
  nextAttempt: LarkApprovalAttemptState,
): LarkApprovalAttemptState[] {
  const existingIndex = attempts.findIndex(
    (attempt) => attempt.approvalId === nextAttempt.approvalId,
  );
  if (existingIndex < 0) {
    return [...attempts, nextAttempt];
  }

  return attempts.map((attempt, index) => (index === existingIndex ? nextAttempt : attempt));
}

function readApprovalFlowId(event: ApprovalRequestedEvent | ApprovalResolvedEvent): string {
  return event.approvalFlowId;
}

function readApprovalAttemptIndex(event: ApprovalRequestedEvent | ApprovalResolvedEvent): number {
  return event.approvalAttemptIndex;
}

function describeResolvedAttemptStatus(
  decision: ApprovalResolvedEvent["decision"],
  actor: ApprovalResolvedEvent["actor"],
  input: {
    flowContinues: boolean;
  },
): LarkApprovalAttemptState["status"] {
  if (decision === "approve") {
    return "approved";
  }

  if (input.flowContinues && actor === "system:timeout") {
    return "timed_out";
  }

  return "denied";
}
