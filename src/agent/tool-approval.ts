import type { AgentRuntimeEventInput, AgentToolCall } from "@/src/agent/events.js";
import type { RunAgentLoopInput } from "@/src/agent/loop.js";
import { resolveApprovalRouteForSession } from "@/src/runtime/approval-routing.js";
import type {
  ApprovalWaitOutcome,
  SessionApprovalWaitRegistry,
} from "@/src/runtime/approval-waits.js";
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

export async function requestToolApproval(input: {
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
  signal: AbortSignal;
  recordEvent(event: AgentRuntimeEventInput): void;
}): Promise<ApprovalWaitOutcome & { approvalId: number; request: PermissionRequest }> {
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + input.approvalTimeoutMs);
  const approvalRoute = resolveApprovalRouteForSession({
    db: input.storage,
    session: input.session,
  });
  const resumePayloadJson = JSON.stringify({
    toolCallId: input.toolCall.id,
    toolName: input.toolCall.name,
    toolArgs: input.toolCall.args,
    turn: input.turn,
    runId: input.runId,
  } satisfies ApprovalResumePayload);
  const approvalId = input.security.createApprovalRequest({
    ownerAgentId: input.session.ownerAgentId ?? "",
    requestedBySessionId: input.runInput.sessionId,
    request: input.request,
    approvalTarget: approvalRoute.target,
    reasonText: input.reasonText,
    createdAt,
    expiresAt,
    resumePayloadJson,
  });
  logger.info("approval requested for tool call", {
    sessionId: input.runInput.sessionId,
    approvalId,
    toolName: input.toolCall.name,
    approvalTarget: approvalRoute.target,
    runtimeKind: approvalRoute.runtimeKind,
    scopeCount: input.request.scopes.length,
    scope:
      input.request.scopes[0] == null
        ? undefined
        : describePermissionScope(input.request.scopes[0]),
    runId: input.runId,
  });

  const waitPromise = input.approvalWaits.beginWait({
    sessionId: input.runInput.sessionId,
    approvalId,
    timeoutMs: input.approvalTimeoutMs,
  });

  input.sessions.updateStatus({
    id: input.runInput.sessionId,
    status: "paused",
    updatedAt: createdAt,
  });

  input.recordEvent({
    type: "approval_requested",
    approvalId: String(approvalId),
    approvalTarget: approvalRoute.target,
    title: input.approvalTitle ?? buildApprovalTitle(input.request),
    reasonText: input.reasonText,
    expiresAt: expiresAt.toISOString(),
    sessionId: input.runInput.sessionId,
    conversationId: input.session.conversationId,
    branchId: input.session.branchId,
    runId: input.runId,
  });

  const onAbort = () => {
    input.approvalWaits.cancelSession({
      sessionId: input.runInput.sessionId,
      actor: "system:cancel",
      reasonText: "Run cancelled while waiting for approval.",
      decidedAt: new Date(),
    });
  };
  input.signal.addEventListener("abort", onAbort, { once: true });

  try {
    const outcome = await waitPromise;
    if (input.signal.aborted && outcome.actor === "system:cancel") {
      input.security.resolveApproval({
        approvalId,
        status: "cancelled",
        reasonText: outcome.reasonText,
        decidedAt: outcome.decidedAt,
      });
      input.signal.throwIfAborted();
    }

    input.recordEvent({
      type: "approval_resolved",
      approvalId: String(approvalId),
      decision: outcome.decision,
      actor: outcome.actor,
      rawInput: outcome.rawInput,
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
    };
  } finally {
    input.signal.removeEventListener("abort", onAbort);
    input.sessions.updateStatus({
      id: input.runInput.sessionId,
      status: "active",
      updatedAt: new Date(),
    });
  }
}

function buildApprovalTitle(request: PermissionRequest): string {
  const firstScope = request.scopes[0];
  if (request.scopes.length === 1 && firstScope != null) {
    return `Approval required: ${describePermissionScope(firstScope)}`;
  }

  return `Approval required for ${request.scopes.length} permissions`;
}
