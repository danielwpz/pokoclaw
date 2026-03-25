import { type Static, Type } from "@sinclair/typebox";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import { AgentsRepo } from "@/src/storage/repos/agents.repo.js";
import { ApprovalsRepo } from "@/src/storage/repos/approvals.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { toolInternalError, toolRecoverableError } from "@/src/tools/core/errors.js";
import { defineTool, textToolResult } from "@/src/tools/core/types.js";

export const REVIEW_PERMISSION_REQUEST_TOOL_SCHEMA = Type.Object(
  {
    approvalId: Type.Integer({
      minimum: 1,
      description: "The delegated approval request id shown in the approval session.",
    }),
    decision: Type.Union([Type.Literal("approve"), Type.Literal("deny")], {
      description: "Approve or deny the delegated approval request.",
    }),
    reason: Type.String({
      minLength: 3,
      description: "A short human-readable reason for the approval decision.",
    }),
  },
  { additionalProperties: false },
);

export type ReviewPermissionRequestToolArgs = Static<typeof REVIEW_PERMISSION_REQUEST_TOOL_SCHEMA>;

const logger = createSubsystemLogger("tools/review-permission-request");

export function createReviewPermissionRequestTool() {
  return defineTool({
    name: "review_permission_request",
    description:
      "Approve or deny a delegated permission request in an approval session. Use this only inside the dedicated approval-review session. Always include a short reason.",
    inputSchema: REVIEW_PERMISSION_REQUEST_TOOL_SCHEMA,
    execute(context, args) {
      const sessionsRepo = new SessionsRepo(context.storage);
      const approvalsRepo = new ApprovalsRepo(context.storage);
      const agentsRepo = new AgentsRepo(context.storage);
      const session = sessionsRepo.getById(context.sessionId);

      if (session == null) {
        throw toolInternalError(`Approval review session not found: ${context.sessionId}`);
      }
      if (session.purpose !== "approval" || session.approvalForSessionId == null) {
        throw toolRecoverableError(
          "review_permission_request is only available inside a delegated approval session.",
          {
            code: "review_permission_request_wrong_session",
            sessionId: context.sessionId,
            sessionPurpose: session.purpose,
          },
        );
      }

      const approval = approvalsRepo.getById(args.approvalId);
      if (approval == null) {
        throw toolRecoverableError(`Approval ${args.approvalId} was not found.`, {
          code: "approval_not_found",
          approvalId: args.approvalId,
        });
      }
      if (approval.approvalTarget !== "main_agent") {
        throw toolRecoverableError(
          `Approval ${args.approvalId} is not routed to the main agent review flow.`,
          {
            code: "approval_wrong_target",
            approvalId: args.approvalId,
            approvalTarget: approval.approvalTarget,
          },
        );
      }
      if (approval.status !== "pending") {
        throw toolRecoverableError(`Approval ${args.approvalId} is already ${approval.status}.`, {
          code: "approval_not_pending",
          approvalId: args.approvalId,
          status: approval.status,
        });
      }
      if (approval.requestedBySessionId !== session.approvalForSessionId) {
        throw toolRecoverableError(
          `Approval ${args.approvalId} does not belong to this approval session.`,
          {
            code: "approval_not_for_current_session",
            approvalId: args.approvalId,
            sourceSessionId: approval.requestedBySessionId,
            approvalForSessionId: session.approvalForSessionId,
          },
        );
      }

      const currentMainAgentId = session.ownerAgentId;
      const expectedMainAgentId = agentsRepo.resolveMainAgentId(approval.ownerAgentId);
      if (
        currentMainAgentId == null ||
        expectedMainAgentId == null ||
        currentMainAgentId !== expectedMainAgentId
      ) {
        throw toolRecoverableError(
          `Approval ${args.approvalId} is not owned by this main-agent approval session.`,
          {
            code: "approval_wrong_main_agent",
            approvalId: args.approvalId,
          },
        );
      }

      if (context.runtimeControl == null) {
        throw toolInternalError(
          "review_permission_request is missing runtime approval controls in this session.",
        );
      }

      const decidedAt = new Date();
      const matched = context.runtimeControl.submitApprovalDecision({
        approvalId: approval.id,
        decision: args.decision,
        actor: `main_agent:${currentMainAgentId}`,
        rawInput: JSON.stringify({
          decision: args.decision,
          reason: args.reason.trim(),
        }),
        ...(args.decision === "approve" ? { grantedBy: "main_agent" as const } : {}),
        reasonText: args.reason.trim(),
        decidedAt,
      });

      if (!matched) {
        throw toolRecoverableError(
          `Approval ${args.approvalId} is no longer waiting for a decision.`,
          {
            code: "approval_wait_not_found",
            approvalId: args.approvalId,
          },
        );
      }

      logger.info("delegated approval reviewed", {
        sessionId: context.sessionId,
        approvalId: approval.id,
        decision: args.decision,
        ownerAgentId: approval.ownerAgentId,
      });

      return textToolResult(
        `Recorded ${args.decision} for approval ${approval.id}. Reason: ${args.reason.trim()}`,
      );
    },
  });
}
