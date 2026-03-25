import { toolRecoverableError } from "@/src/tools/core/errors.js";

export const APPROVAL_SESSION_TOOL_ALLOWLIST = [
  "read",
  "ls",
  "find",
  "grep",
  "review_permission_request",
] as const;

export function getAllowedToolsForSessionPurpose(purpose: string): readonly string[] | null {
  if (purpose === "approval") {
    return APPROVAL_SESSION_TOOL_ALLOWLIST;
  }

  return null;
}

export function assertToolAllowedForSessionPurpose(input: {
  purpose: string;
  toolName: string;
}): void {
  const allowedTools = getAllowedToolsForSessionPurpose(input.purpose);
  if (allowedTools == null || allowedTools.includes(input.toolName)) {
    return;
  }

  throw toolRecoverableError(
    `Tool ${input.toolName} is not available in ${input.purpose} sessions. Use only the tools intended for that session type.`,
    {
      code: "tool_not_allowed_for_session_purpose",
      toolName: input.toolName,
      sessionPurpose: input.purpose,
      allowedTools: [...allowedTools],
    },
  );
}
