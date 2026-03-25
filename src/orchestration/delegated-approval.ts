import { resolveOrCreateMainAgentApprovalSession } from "@/src/orchestration/approval-session.js";
import type { SubmitMessageInput, SubmitMessageResult } from "@/src/runtime/ingress.js";
import { describePermissionScope, parsePermissionRequestJson } from "@/src/security/scope.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { ApprovalsRepo } from "@/src/storage/repos/approvals.repo.js";

export interface DelegatedApprovalDeliveryResult {
  status:
    | "delivered"
    | "delivered_reused_session"
    | "missing_approval"
    | "not_main_agent_target"
    | "missing_main_session";
  approvalId: number;
  targetSessionId?: string;
}

export interface DelegatedApprovalMessageIngress {
  submitMessage(input: SubmitMessageInput): Promise<SubmitMessageResult>;
}

export async function deliverDelegatedApprovalRequest(input: {
  db: StorageDb;
  ingress: DelegatedApprovalMessageIngress;
  approvalId: number;
}): Promise<DelegatedApprovalDeliveryResult> {
  const approvalsRepo = new ApprovalsRepo(input.db);
  const approval = approvalsRepo.getById(input.approvalId);
  if (approval == null) {
    return {
      status: "missing_approval",
      approvalId: input.approvalId,
    };
  }

  if (approval.approvalTarget !== "main_agent") {
    return {
      status: "not_main_agent_target",
      approvalId: input.approvalId,
    };
  }

  if (approval.requestedBySessionId == null) {
    return {
      status: "missing_main_session",
      approvalId: input.approvalId,
    };
  }

  const approvalSession = resolveOrCreateMainAgentApprovalSession({
    db: input.db,
    ownerAgentId: approval.ownerAgentId,
    sourceSessionId: approval.requestedBySessionId,
    approvalId: approval.id,
    createdAt: new Date(approval.createdAt),
  });
  if (approvalSession == null) {
    return {
      status: "missing_main_session",
      approvalId: input.approvalId,
    };
  }

  await input.ingress.submitMessage({
    sessionId: approvalSession.session.id,
    scenario: "chat",
    content: renderDelegatedApprovalMessage({
      approvalId: approval.id,
      ownerAgentId: approval.ownerAgentId,
      reasonText: approval.reasonText,
      requestedScopeJson: approval.requestedScopeJson,
      history: listRecentApprovalHistory({
        approvalsRepo,
        sourceSessionId: approval.requestedBySessionId,
        currentApprovalId: approval.id,
      }),
    }),
    messageType: "approval_request",
    visibility: "hidden_system",
  });

  return {
    status: approvalSession.created ? "delivered" : "delivered_reused_session",
    approvalId: approval.id,
    targetSessionId: approvalSession.session.id,
  };
}

export function renderDelegatedApprovalMessage(input: {
  approvalId: number;
  ownerAgentId: string;
  reasonText: string | null;
  requestedScopeJson: string;
  history?: ApprovalHistoryItem[];
}): string {
  const request = parsePermissionRequestJson(input.requestedScopeJson);
  const lines = request.scopes.map((scope) => `- ${describePermissionScope(scope)}`);
  const history = input.history ?? [];

  const rendered = [
    "<delegated_approval_request>",
    `  <approval_id>${input.approvalId}</approval_id>`,
    `  <owner_agent_id>${input.ownerAgentId}</owner_agent_id>`,
    "",
    "  <summary>",
    `    ${input.reasonText ?? "A background run needs additional approval."}`,
    "  </summary>",
    "",
    "  <requested_permissions>",
    ...lines.map((line) => `    ${line}`),
    "  </requested_permissions>",
    "",
    "  <guidance>",
    "    A background run paused because it needs approval.",
    "    Review the request in the context of the current task before approving or denying it.",
    "  </guidance>",
    "</delegated_approval_request>",
  ];

  if (history.length > 0) {
    rendered.push(
      "",
      "<approval_history>",
      ...history.flatMap((item) => [
        "  <item>",
        `    <approval_id>${item.approvalId}</approval_id>`,
        `    <decision>${item.decision}</decision>`,
        `    <permissions>${item.permissions}</permissions>`,
        `    <reason>${item.reason}</reason>`,
        "  </item>",
      ]),
      "</approval_history>",
    );
  }

  return rendered.join("\n");
}

interface ApprovalHistoryItem {
  approvalId: number;
  decision: "approved" | "denied";
  permissions: string;
  reason: string;
}

function listRecentApprovalHistory(input: {
  approvalsRepo: ApprovalsRepo;
  sourceSessionId: string;
  currentApprovalId: number;
}): ApprovalHistoryItem[] {
  return input.approvalsRepo
    .listBySession(input.sourceSessionId, {
      statuses: ["approved", "denied"],
      limit: 8,
    })
    .filter((approval) => approval.id !== input.currentApprovalId)
    .slice(0, 3)
    .reverse()
    .map((approval) => {
      const request = parsePermissionRequestJson(approval.requestedScopeJson);
      const permissions =
        request.scopes.length === 1 && request.scopes[0] != null
          ? describePermissionScope(request.scopes[0])
          : `${request.scopes.length} permissions`;
      const decision: ApprovalHistoryItem["decision"] =
        approval.status === "approved" ? "approved" : "denied";

      return {
        approvalId: approval.id,
        decision,
        permissions,
        reason: approval.reasonText ?? "No reason recorded.",
      };
    });
}
