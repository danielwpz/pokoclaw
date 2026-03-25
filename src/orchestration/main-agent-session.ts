import type { StorageDb } from "@/src/storage/db/client.js";
import { AgentsRepo } from "@/src/storage/repos/agents.repo.js";
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
  const agentsRepo = new AgentsRepo(input.db);
  const sessionsRepo = new SessionsRepo(input.db);
  const mainAgentId = agentsRepo.resolveMainAgentId(input.ownerAgentId);
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
