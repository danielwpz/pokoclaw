import type { ToolResult } from "@/src/tools/core/types.js";

export const CONTEXT_HANDOFF_TOOL_NAME = "submit_context_handoff";

export interface ContextHandoffDetails {
  contextHandoff: {
    kickoffMessage: string;
  };
}

export function extractContextHandoffSignal(input: {
  toolName: string;
  result: ToolResult;
}): ContextHandoffDetails["contextHandoff"] | null {
  if (input.toolName !== CONTEXT_HANDOFF_TOOL_NAME) {
    return null;
  }
  const details = input.result.details;
  if (!isRecord(details) || !isRecord(details.contextHandoff)) {
    return null;
  }
  const kickoffMessage = details.contextHandoff.kickoffMessage;
  if (typeof kickoffMessage !== "string" || kickoffMessage.trim().length === 0) {
    return null;
  }
  return { kickoffMessage: kickoffMessage.trim() };
}

export function buildContextHandoffRequest(input: {
  sourceSessionId: string;
  sourceSeq: number;
}): string {
  return [
    "<context_handoff_request>",
    "The host is about to replace this long-running session's LLM message list with a fresh one. This is an internal continuity handoff, not a user request and not a user-visible reply.",
    "",
    "Your job is to preserve only the information that the fresh-context version of you needs in order to continue reliably.",
    "",
    "Before submitting the handoff:",
    "1. Inspect the context you currently have and identify durable facts, current work state, commitments, constraints, unresolved questions, important paths/IDs, and the next concrete actions.",
    "2. Persist genuinely long-lived information in the correct Memory file. Update existing entries instead of duplicating or contradicting them.",
    "3. Persist project-specific state, plans, artifacts, or detailed working notes in the appropriate workspace files when they need more detail than the kickoff message should carry.",
    "4. Do not preserve noise: omit obsolete attempts, routine tool output, raw logs, repeated conversation, transient speculation, and facts that are cheap to rediscover.",
    "5. Write a concise but sufficient kickoff message for a fresh-context version of yourself. It should state what is happening now, what has already been decided or completed, what constraints still apply, what remains open, and exactly how to resume. Include relevant Memory/workspace paths that should be read.",
    "",
    `The original session is ${input.sourceSessionId}. The clear boundary is source seq ${input.sourceSeq}.`,
    "You may use query_system_db to recover earlier messages or verify details that are missing or distorted after repeated compaction. The system database is read-only.",
    "Before calling query_system_db, read the system-observe skill and use its bounded, text-only conversation-history recipe with the original session ID and clear boundary above.",
    "Page farther back only when needed. Query raw payload_json only for a narrow seq range when exact non-text or tool details are genuinely required.",
    "",
    `Finish by calling ${CONTEXT_HANDOFF_TOOL_NAME} exactly once with only kickoffMessage. Calling it completes this internal handoff. Do not answer the user and do not merely end naturally.`,
    "</context_handoff_request>",
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}
