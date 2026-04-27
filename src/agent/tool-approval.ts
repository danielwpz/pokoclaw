/**
 * Approval bridge for tool-time permission escalation.
 *
 * AgentLoop calls this module when a tool requests additional permission.
 * It creates approval records, emits approval events, waits for decisions, and
 * returns deterministic resume outcomes back to the active run.
 */
import type { AgentRuntimeEventInput, AgentToolCall } from "@/src/agent/events.js";
import type { RunAgentLoopInput } from "@/src/agent/loop.js";
import {
  isExplicitUserApprovalDecision,
  isUserApprovalTimeoutOutcome,
  type SessionApprovalFlowRegistry,
} from "@/src/runtime/approval-flow.js";
import { resolveApprovalRouteForSession } from "@/src/runtime/approval-routing.js";
import type {
  ApprovalWaitOutcome,
  SessionApprovalWaitRegistry,
} from "@/src/runtime/approval-waits.js";
import type {
  EffectiveApprovalModeSource,
  RuntimeModeService,
} from "@/src/runtime/runtime-modes.js";
import { YOLO_SUGGESTION_MESSAGE } from "@/src/runtime/runtime-modes.js";
import { describePermissionScope, type PermissionRequest } from "@/src/security/scope.js";
import type { SecurityService } from "@/src/security/service.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { Session } from "@/src/storage/schema/types.js";

const logger = createSubsystemLogger("agent/tool-approval");

interface ApprovalResumePayload {
  toolCallId: string;
  toolName: string;
  toolArgs: unknown;
  turn: number;
  runId: string;
}

function buildApprovalFlowId(input: { runId: string; toolCallId: string }): string {
  return `approval_flow:${input.runId}:${input.toolCallId}`;
}

export async function requestToolApproval(input: {
  storage: import("@/src/storage/db/client.js").StorageDb;
  security: SecurityService;
  approvalWaits: SessionApprovalWaitRegistry;
  sessions: {
    updateStatus(input: { id: string; status: "paused" | "active"; updatedAt: Date }): void;
  };
  approvalTimeoutMs: number;
  approvalFlow: SessionApprovalFlowRegistry;
  runtimeModes?: RuntimeModeService;
  runInput: RunAgentLoopInput;
  session: Session;
  toolCall: AgentToolCall;
  turn: number;
  runId: string;
  request: PermissionRequest;
  reasonText: string;
  approvalTitle?: string;
  approvalCommand?: string;
  grantOnApprove: boolean;
  signal: AbortSignal;
  recordEvent(event: AgentRuntimeEventInput): void;
  onRequested?: (input: { approvalId: number; createdAt: Date; expiresAt: Date }) => void;
}): Promise<
  ApprovalWaitOutcome & {
    approvalId: number;
    request: PermissionRequest;
    skippedHumanApproval?: boolean;
    approvalModeSource?: EffectiveApprovalModeSource;
  }
> {
  const approvalRoute = resolveApprovalRouteForSession({
    db: input.storage,
    session: input.session,
  });
  const approvalFlowId = buildApprovalFlowId({
    runId: input.runId,
    toolCallId: input.toolCall.id,
  });
  const approvalPlan = input.approvalFlow.resolvePlan({
    sessionId: input.runInput.sessionId,
    route: approvalRoute,
  });
  const effectiveMode = input.runtimeModes?.getEffectiveApprovalMode(input.session.ownerAgentId);

  if (effectiveMode?.skipHumanApproval === true) {
    return approveWithoutHumanApproval({
      ...input,
      approvalFlowId,
      approvalAttemptIndex: 1,
      approvalTarget: approvalPlan.initialTarget,
      effectiveMode,
    });
  }

  let currentApprovalId: number | null = null;
  input.sessions.updateStatus({
    id: input.runInput.sessionId,
    status: "paused",
    updatedAt: new Date(),
  });

  const onAbort = () => {
    if (currentApprovalId != null) {
      input.approvalWaits.cancelSession({
        sessionId: input.runInput.sessionId,
        actor: "system:cancel",
        reasonText: "Run cancelled while waiting for approval.",
        decidedAt: new Date(),
      });
    }
  };
  input.signal.addEventListener("abort", onAbort, { once: true });

  try {
    let outcome = await requestApprovalRound({
      ...input,
      approvalRoute,
      approvalFlowId,
      approvalAttemptIndex: 1,
      approvalTarget: approvalPlan.initialTarget,
      resolveFlowContinues: (roundOutcome) =>
        roundOutcome.actor === "system:timeout" && approvalPlan.fallbackTarget != null,
      setCurrentApprovalId: (approvalId) => {
        currentApprovalId = approvalId;
      },
    });

    if (outcome.approvalTarget === "user") {
      if (isExplicitUserApprovalDecision(outcome)) {
        input.approvalFlow.resetUserTimeouts(input.runInput.sessionId);
      } else if (isUserApprovalTimeoutOutcome(outcome) && approvalPlan.fallbackTarget != null) {
        input.approvalFlow.recordUserTimeout(input.runInput.sessionId);
        input.security.resolveApproval({
          approvalId: outcome.approvalId,
          status: "cancelled",
          reasonText: outcome.reasonText,
          decidedAt: outcome.decidedAt,
        });
        outcome = await requestApprovalRound({
          ...input,
          approvalRoute,
          approvalFlowId,
          approvalAttemptIndex: 2,
          approvalTarget: approvalPlan.fallbackTarget,
          resolveFlowContinues: () => false,
          setCurrentApprovalId: (approvalId) => {
            currentApprovalId = approvalId;
          },
        });
      }
    }

    if (input.signal.aborted && outcome.actor === "system:cancel") {
      input.security.resolveApproval({
        approvalId: outcome.approvalId,
        status: "cancelled",
        reasonText: outcome.reasonText,
        decidedAt: outcome.decidedAt,
      });
      input.signal.throwIfAborted();
    }

    return outcome;
  } finally {
    input.signal.removeEventListener("abort", onAbort);
    input.sessions.updateStatus({
      id: input.runInput.sessionId,
      status: "active",
      updatedAt: new Date(),
    });
  }
}

function buildApprovalTitle(): string {
  return "Approval required";
}

function approveWithoutHumanApproval(input: {
  security: SecurityService;
  approvalTimeoutMs: number;
  runInput: RunAgentLoopInput;
  session: Session;
  toolCall: AgentToolCall;
  turn: number;
  runId: string;
  request: PermissionRequest;
  reasonText: string;
  approvalFlowId: string;
  approvalAttemptIndex: number;
  approvalTarget: "user" | "main_agent";
  effectiveMode: ReturnType<RuntimeModeService["getEffectiveApprovalMode"]>;
}): ApprovalWaitOutcome & {
  approvalId: number;
  request: PermissionRequest;
  approvalTarget: "user" | "main_agent";
  skippedHumanApproval: true;
  approvalModeSource: EffectiveApprovalModeSource;
} {
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + input.approvalTimeoutMs);
  const approvalId = input.security.createApprovalRequest({
    ownerAgentId: input.session.ownerAgentId ?? "",
    requestedBySessionId: input.runInput.sessionId,
    request: input.request,
    approvalTarget: input.approvalTarget,
    reasonText: input.reasonText,
    createdAt,
    expiresAt,
    resumePayloadJson: buildApprovalResumePayloadJson(input),
  });
  const decidedAt = new Date();
  const actor = `system:${input.effectiveMode.source}`;
  const reasonText =
    input.effectiveMode.source === "autopilot"
      ? "Skipped human approval because Autopilot is active."
      : "Skipped human approval because YOLO mode is active.";

  logger.info("approval skipped by runtime mode without user-visible approval event", {
    sessionId: input.runInput.sessionId,
    approvalId,
    toolName: input.toolCall.name,
    actor,
    mode: input.effectiveMode.source,
    runId: input.runId,
    approvalFlowId: input.approvalFlowId,
    approvalAttemptIndex: input.approvalAttemptIndex,
  });

  return {
    decision: "approve",
    actor,
    rawInput: null,
    grantedBy: null,
    reasonText,
    decidedAt,
    queuedSteer: [],
    approvalId,
    request: input.request,
    approvalTarget: input.approvalTarget,
    skippedHumanApproval: true,
    approvalModeSource: input.effectiveMode.source,
  };
}

function buildApprovalResumePayloadJson(input: {
  toolCall: AgentToolCall;
  turn: number;
  runId: string;
}): string {
  return JSON.stringify({
    toolCallId: input.toolCall.id,
    toolName: input.toolCall.name,
    toolArgs: input.toolCall.args,
    turn: input.turn,
    runId: input.runId,
  } satisfies ApprovalResumePayload);
}

async function requestApprovalRound(input: {
  storage: import("@/src/storage/db/client.js").StorageDb;
  security: SecurityService;
  approvalWaits: SessionApprovalWaitRegistry;
  sessions: {
    updateStatus(input: { id: string; status: "paused" | "active"; updatedAt: Date }): void;
  };
  approvalTimeoutMs: number;
  runInput: RunAgentLoopInput;
  session: Session;
  toolCall: AgentToolCall;
  turn: number;
  runId: string;
  request: PermissionRequest;
  reasonText: string;
  approvalTitle?: string;
  approvalCommand?: string;
  grantOnApprove: boolean;
  signal: AbortSignal;
  recordEvent(event: AgentRuntimeEventInput): void;
  onRequested?: (input: { approvalId: number; createdAt: Date; expiresAt: Date }) => void;
  runtimeModes?: RuntimeModeService;
  approvalRoute: ReturnType<typeof resolveApprovalRouteForSession>;
  approvalFlowId: string;
  approvalAttemptIndex: number;
  approvalTarget: "user" | "main_agent";
  resolveFlowContinues: (outcome: ApprovalWaitOutcome) => boolean;
  setCurrentApprovalId: (approvalId: number) => void;
}): Promise<
  ApprovalWaitOutcome & {
    approvalId: number;
    request: PermissionRequest;
    approvalTarget: "user" | "main_agent";
    skippedHumanApproval?: boolean;
    approvalModeSource?: EffectiveApprovalModeSource;
  }
> {
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + input.approvalTimeoutMs);
  const resumePayloadJson = buildApprovalResumePayloadJson(input);
  const approvalId = input.security.createApprovalRequest({
    ownerAgentId: input.session.ownerAgentId ?? "",
    requestedBySessionId: input.runInput.sessionId,
    request: input.request,
    approvalTarget: input.approvalTarget,
    reasonText: input.reasonText,
    createdAt,
    expiresAt,
    resumePayloadJson,
  });
  input.setCurrentApprovalId(approvalId);

  logger.info("approval requested for tool call", {
    sessionId: input.runInput.sessionId,
    approvalId,
    toolName: input.toolCall.name,
    approvalTarget: input.approvalTarget,
    runtimeKind: input.approvalRoute.runtimeKind,
    scopeCount: input.request.scopes.length,
    scope:
      input.request.scopes[0] == null
        ? undefined
        : describePermissionScope(input.request.scopes[0]),
    runId: input.runId,
  });

  input.onRequested?.({
    approvalId,
    createdAt,
    expiresAt,
  });

  input.recordEvent({
    type: "approval_requested",
    approvalId: String(approvalId),
    approvalFlowId: input.approvalFlowId,
    approvalAttemptIndex: input.approvalAttemptIndex,
    approvalTarget: input.approvalTarget,
    grantOnApprove: input.grantOnApprove,
    title: input.approvalTitle ?? buildApprovalTitle(),
    request: input.request,
    reasonText: input.reasonText,
    ...(input.approvalCommand == null ? {} : { commandText: input.approvalCommand }),
    expiresAt: expiresAt.toISOString(),
    sessionId: input.runInput.sessionId,
    conversationId: input.session.conversationId,
    branchId: input.session.branchId,
    runId: input.runId,
  });

  const ownerAgentId = input.session.ownerAgentId;
  if (
    input.runtimeModes?.recordApprovalRequestForYoloSuggestion({
      ownerAgentId,
      approvalTarget: input.approvalTarget,
      requestedAt: createdAt,
    }) === true &&
    ownerAgentId != null
  ) {
    input.recordEvent({
      type: "runtime_nudge",
      ownerAgentId,
      anchor: {
        type: "approval_flow",
        id: input.approvalFlowId,
      },
      nudge: {
        kind: "yolo_suggestion",
        message: YOLO_SUGGESTION_MESSAGE,
      },
      sessionId: input.runInput.sessionId,
      conversationId: input.session.conversationId,
      branchId: input.session.branchId,
      runId: input.runId,
    });
  }

  const waitPromise = input.approvalWaits.beginWait({
    sessionId: input.runInput.sessionId,
    approvalId,
    timeoutMs: input.approvalTimeoutMs,
  });

  const outcome = await waitPromise;

  input.recordEvent({
    type: "approval_resolved",
    approvalId: String(approvalId),
    approvalFlowId: input.approvalFlowId,
    approvalAttemptIndex: input.approvalAttemptIndex,
    decision: outcome.decision,
    actor: outcome.actor,
    rawInput: outcome.rawInput,
    flowContinues: input.resolveFlowContinues(outcome),
    sessionId: input.runInput.sessionId,
    conversationId: input.session.conversationId,
    branchId: input.session.branchId,
    runId: input.runId,
  });
  logger.info("approval resolved for tool call", {
    sessionId: input.runInput.sessionId,
    approvalId,
    toolName: input.toolCall.name,
    decision: outcome.decision,
    actor: outcome.actor,
    runId: input.runId,
  });

  return {
    ...outcome,
    approvalId,
    request: input.request,
    approvalTarget: input.approvalTarget,
  };
}
