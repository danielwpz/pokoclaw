/**
 * Reducer state model for lark approval cards.
 *
 * Tracks approval request lifecycle (requested/resolved) independently from
 * run transcript cards so approval UX can be rendered and updated separately.
 */
import type { ApprovalRequestedEvent } from "@/src/agent/events.js";
import type { OrchestratedRuntimeEventEnvelope } from "@/src/orchestration/outbound-events.js";

export interface LarkApprovalState {
  approvalId: string;
  runId: string;
  conversationId: string;
  branchId: string;
  title: string;
  reasonText: string;
  approvalTarget: "user" | "main_agent";
  expiresAt: string | null;
  resolved: boolean;
  decision: "approve" | "deny" | null;
  actor: string | null;
  sourceRunCardObjectId: string | null;
  requestedBashPrefixes: string[][];
}

export function createLarkApprovalStateFromRequest(input: {
  event: ApprovalRequestedEvent;
  sourceRunCardObjectId: string | null;
  requestedBashPrefixes?: string[][];
}): LarkApprovalState {
  return {
    approvalId: input.event.approvalId,
    runId: input.event.runId,
    conversationId: input.event.conversationId,
    branchId: input.event.branchId,
    title: input.event.title,
    reasonText: input.event.reasonText,
    approvalTarget: input.event.approvalTarget,
    expiresAt: input.event.expiresAt,
    resolved: false,
    decision: null,
    actor: null,
    sourceRunCardObjectId: input.sourceRunCardObjectId,
    requestedBashPrefixes: input.requestedBashPrefixes ?? [],
  };
}

export function reduceLarkApprovalState(
  previous: LarkApprovalState | null,
  envelope: OrchestratedRuntimeEventEnvelope,
  input?: {
    sourceRunCardObjectId?: string | null;
    requestedBashPrefixes?: string[][];
  },
): LarkApprovalState | null {
  switch (envelope.event.type) {
    case "approval_requested":
      return (
        previous ??
        createLarkApprovalStateFromRequest({
          event: envelope.event,
          sourceRunCardObjectId: input?.sourceRunCardObjectId ?? null,
          requestedBashPrefixes: input?.requestedBashPrefixes ?? [],
        })
      );
    case "approval_resolved":
      if (previous == null) {
        return null;
      }
      return {
        ...previous,
        resolved: true,
        decision: envelope.event.decision,
        actor: envelope.event.actor,
      };
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
