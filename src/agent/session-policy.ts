/**
 * Session-level tool policy gates.
 *
 * This module encodes which tools are allowed for special session purposes
 * (notably approval sessions) so AgentLoop can enforce capability boundaries
 * before tool execution.
 */
import { toolRecoverableError } from "@/src/tools/core/errors.js";
import type { ToolDefinition } from "@/src/tools/core/types.js";

export const APPROVAL_SESSION_TOOL_ALLOWLIST = [
  "read",
  "ls",
  "find",
  "grep",
  "review_permission_request",
] as const;

export function isToolAllowedForSession(input: {
  purpose: string;
  agentKind?: string | null;
  toolName: string;
}): boolean {
  if (input.purpose === "approval") {
    return APPROVAL_SESSION_TOOL_ALLOWLIST.includes(
      input.toolName as (typeof APPROVAL_SESSION_TOOL_ALLOWLIST)[number],
    );
  }

  if (input.toolName === "create_subagent") {
    return input.purpose === "chat" && input.agentKind === "main";
  }

  if (input.toolName === "cron") {
    return input.purpose === "chat" && (input.agentKind === "main" || input.agentKind === "sub");
  }

  return true;
}

export function getAllowedToolsForSessionPurpose(purpose: string): readonly string[] | null {
  if (purpose === "approval") {
    return APPROVAL_SESSION_TOOL_ALLOWLIST;
  }

  return null;
}

export function filterVisibleToolsForSession<TTool extends Pick<ToolDefinition, "name">>(
  tools: readonly TTool[],
  input: {
    purpose: string;
    agentKind?: string | null;
  },
): TTool[] {
  return tools.filter((tool) => {
    const session = {
      purpose: input.purpose,
      ...(input.agentKind === undefined ? {} : { agentKind: input.agentKind }),
      toolName: tool.name,
    };
    return isToolAllowedForSession(session);
  });
}

export function assertToolAllowedForSessionPurpose(input: {
  purpose: string;
  toolName: string;
}): void {
  assertToolAllowedForSession({
    purpose: input.purpose,
    toolName: input.toolName,
  });
}

export function assertToolAllowedForSession(input: {
  purpose: string;
  agentKind?: string | null;
  toolName: string;
}): void {
  const session = {
    purpose: input.purpose,
    ...(input.agentKind === undefined ? {} : { agentKind: input.agentKind }),
    toolName: input.toolName,
  };
  if (isToolAllowedForSession(session)) {
    return;
  }

  const allowedTools = getAllowedToolsForSessionPurpose(input.purpose);
  if (allowedTools != null) {
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

  throw toolRecoverableError(`Tool ${input.toolName} is not available in this session.`, {
    code: "tool_not_allowed_for_session",
    toolName: input.toolName,
    sessionPurpose: input.purpose,
    agentKind: input.agentKind ?? null,
  });
}
