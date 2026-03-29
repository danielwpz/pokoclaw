/**
 * Main-agent approval-session lifecycle helpers.
 *
 * Resolves or creates the dedicated approval chat session used for delegated
 * approvals. This keeps approval traffic out of the visible main chat session.
 */
import { APPROVAL_SESSION_TOOL_ALLOWLIST } from "@/src/agent/session-policy.js";
import { resolveMainAgentChatSessionForAgent } from "@/src/orchestration/main-agent-session.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import type { Session } from "@/src/storage/schema/types.js";

export const MAIN_AGENT_APPROVAL_SESSION_TOOL_ALLOWLIST = APPROVAL_SESSION_TOOL_ALLOWLIST;

export const MAIN_AGENT_APPROVAL_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface MainAgentApprovalSessionResult {
  mainAgentId: string;
  session: Session;
  forkSourceSessionId: string;
  created: boolean;
}

export function createMainAgentApprovalSessionId(input: {
  sourceSessionId: string;
  approvalId: number;
}): string {
  return `approval_${input.sourceSessionId}_${input.approvalId}`;
}

export function resolveOrCreateMainAgentApprovalSession(input: {
  db: StorageDb;
  ownerAgentId: string;
  sourceSessionId: string;
  approvalId: number;
  createdAt?: Date;
}): MainAgentApprovalSessionResult | null {
  const sessionsRepo = new SessionsRepo(input.db);
  const createdAt = input.createdAt ?? new Date();
  const existing = sessionsRepo.findLatestApprovalSessionForSource(input.sourceSessionId, {
    statuses: ["active", "paused"],
  });

  if (existing != null && !isApprovalSessionExpired(existing, createdAt)) {
    const mainAgentId = existing.ownerAgentId;
    if (mainAgentId == null) {
      return null;
    }

    return {
      mainAgentId,
      session: existing,
      forkSourceSessionId: existing.forkedFromSessionId ?? existing.id,
      created: false,
    };
  }

  const source = resolveMainAgentChatSessionForAgent({
    db: input.db,
    ownerAgentId: input.ownerAgentId,
  });
  if (source == null) {
    return null;
  }

  const messagesRepo = new MessagesRepo(input.db);
  const forkSourceSeq = Math.max(0, messagesRepo.getNextSeq(source.session.id) - 1);
  const sessionId = createMainAgentApprovalSessionId({
    sourceSessionId: input.sourceSessionId,
    approvalId: input.approvalId,
  });

  sessionsRepo.create({
    id: sessionId,
    conversationId: source.session.conversationId,
    branchId: source.session.branchId,
    ownerAgentId: source.mainAgentId,
    purpose: "approval",
    approvalForSessionId: input.sourceSessionId,
    forkedFromSessionId: source.session.id,
    forkSourceSeq,
    createdAt,
    updatedAt: createdAt,
  });

  const createdSession = sessionsRepo.getById(sessionId);
  if (createdSession == null) {
    throw new Error(`Failed to create approval session ${sessionId}`);
  }

  return {
    mainAgentId: source.mainAgentId,
    session: createdSession,
    forkSourceSessionId: source.session.id,
    created: true,
  };
}

function isApprovalSessionExpired(session: Session, now: Date): boolean {
  const createdAtMs = Date.parse(session.createdAt);
  if (!Number.isFinite(createdAtMs)) {
    return true;
  }

  return now.getTime() - createdAtMs > MAIN_AGENT_APPROVAL_SESSION_MAX_AGE_MS;
}
