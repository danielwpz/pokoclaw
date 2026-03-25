import type { AgentRuntimeEvent } from "@/src/agent/events.js";
import {
  type DelegatedApprovalDeliveryResult,
  deliverDelegatedApprovalRequest,
} from "@/src/orchestration/delegated-approval.js";
import type { ApprovalResponseInput } from "@/src/runtime/approval-waits.js";
import type { SubmitMessageInput, SubmitMessageResult } from "@/src/runtime/ingress.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { StorageDb } from "@/src/storage/db/client.js";

const logger = createSubsystemLogger("orchestration/agent-manager");

export interface AgentManagerIngress {
  submitMessage(input: SubmitMessageInput): Promise<SubmitMessageResult>;
  submitApprovalDecision(input: ApprovalResponseInput): boolean;
}

export interface AgentManagerDependencies {
  storage: StorageDb;
  ingress: AgentManagerIngress;
}

// AgentManager is the orchestration-facing runtime entrypoint.
// It sits above session-local runtime ingress and handles cross-session
// coordination such as delegated approvals without pulling that logic into
// AgentLoop or session lanes.
export class AgentManager {
  constructor(private readonly deps: AgentManagerDependencies) {}

  submitUserMessage(input: SubmitMessageInput): Promise<SubmitMessageResult> {
    return this.deps.ingress.submitMessage(input);
  }

  submitApprovalDecision(input: ApprovalResponseInput): boolean {
    return this.deps.ingress.submitApprovalDecision(input);
  }

  emitRuntimeEvent(event: AgentRuntimeEvent): void {
    void this.handleRuntimeEvent(event).catch((error: unknown) => {
      logger.error("runtime event orchestration failed", {
        eventType: event.type,
        sessionId: event.sessionId,
        runId: event.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async handleRuntimeEvent(
    event: AgentRuntimeEvent,
  ): Promise<DelegatedApprovalDeliveryResult | null> {
    if (event.type !== "approval_requested" || event.approvalTarget !== "main_agent") {
      return null;
    }

    const approvalId = Number.parseInt(event.approvalId, 10);
    if (!Number.isFinite(approvalId)) {
      logger.warn("skipping delegated approval delivery with invalid approval id", {
        approvalId: event.approvalId,
        sessionId: event.sessionId,
        runId: event.runId,
      });
      return null;
    }

    logger.info("delivering delegated approval request to main agent", {
      approvalId,
      sourceSessionId: event.sessionId,
      sourceConversationId: event.conversationId,
      sourceBranchId: event.branchId,
      runId: event.runId,
    });

    const result = await deliverDelegatedApprovalRequest({
      db: this.deps.storage,
      ingress: this.deps.ingress,
      approvalId,
    });

    logger.info("delegated approval delivery finished", {
      approvalId,
      status: result.status,
      ...(result.targetSessionId == null ? {} : { targetSessionId: result.targetSessionId }),
      runId: event.runId,
    });

    return result;
  }
}
