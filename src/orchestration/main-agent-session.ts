/**
 * Resolver for an agent's owning main-agent chat session.
 *
 * Used by orchestration flows that must operate against the main long-lived
 * conversation (for example delegated approvals and control operations).
 */
import { resolveAgentOwnershipState } from "@/src/runtime/live-state.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import type { Session } from "@/src/storage/schema/types.js";

export interface ResolvedMainAgentSession {
  mainAgentId: string;
  session: Session;
}

export function resolveMainAgentChatSessionForAgent(input: {
  db: StorageDb;
  ownerAgentId: string;
}): ResolvedMainAgentSession | null {
  const sessionsRepo = new SessionsRepo(input.db);
  const ownership = resolveAgentOwnershipState({
    db: input.db,
    agentId: input.ownerAgentId,
  });
  const mainAgentId = ownership?.mainAgentId ?? null;
  if (mainAgentId == null) {
    return null;
  }

  const session = sessionsRepo.findLatestByOwnerAgent(mainAgentId, {
    purpose: "chat",
    statuses: ["active", "paused"],
  });
  if (session == null) {
    return null;
  }

  return {
    mainAgentId,
    session,
  };
}
