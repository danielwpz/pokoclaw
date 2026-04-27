import type { ApprovalRecord } from "@/src/storage/schema/types.js";

export function parseApprovalResumeRunId(approval: ApprovalRecord | null): string | null {
  if (approval?.resumePayloadJson == null || approval.resumePayloadJson.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(approval.resumePayloadJson) as { runId?: unknown };
    return typeof parsed.runId === "string" && parsed.runId.length > 0 ? parsed.runId : null;
  } catch {
    return null;
  }
}

export function approvalBelongsToActiveRound(
  approval: ApprovalRecord,
  activeRunId: string | null,
): boolean {
  if (activeRunId == null) {
    return true;
  }

  return parseApprovalResumeRunId(approval) === activeRunId;
}
