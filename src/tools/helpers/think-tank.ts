import { AgentsRepo } from "@/src/storage/repos/agents.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import type { Session } from "@/src/storage/schema/types.js";
import { toolInternalError, toolRecoverableError } from "@/src/tools/core/errors.js";
import type { ToolExecutionContext } from "@/src/tools/core/types.js";

export interface ThinkTankCallerContext {
  session: Session;
  ownerAgent: {
    id: string;
    kind: string;
  };
}

export function resolveThinkTankCaller(context: ToolExecutionContext): ThinkTankCallerContext {
  const sessionsRepo = new SessionsRepo(context.storage);
  const agentsRepo = new AgentsRepo(context.storage);
  const session = sessionsRepo.getById(context.sessionId);

  if (session == null) {
    throw toolInternalError(`Source session not found: ${context.sessionId}`);
  }
  if (session.purpose !== "chat") {
    throw toolRecoverableError("Think tank tools are only available in chat sessions.", {
      code: "think_tank_wrong_session_purpose",
      sessionPurpose: session.purpose,
    });
  }
  if (session.ownerAgentId == null) {
    throw toolRecoverableError("Think tank tools require a session owned by an agent.", {
      code: "think_tank_missing_owner_agent",
      sessionId: context.sessionId,
    });
  }

  const ownerAgent = agentsRepo.getById(session.ownerAgentId);
  if (ownerAgent == null || (ownerAgent.kind !== "main" && ownerAgent.kind !== "sub")) {
    throw toolRecoverableError("Think tank tools are only available to main/sub agents.", {
      code: "think_tank_wrong_agent_kind",
      agentKind: ownerAgent?.kind ?? null,
    });
  }

  return {
    session,
    ownerAgent: {
      id: ownerAgent.id,
      kind: ownerAgent.kind,
    },
  };
}
