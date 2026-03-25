import type { AgentRuntimeEvent } from "@/src/agent/events.js";
import { resolveSessionLiveState } from "@/src/runtime/live-state.js";
import type { StorageDb } from "@/src/storage/db/client.js";

export interface OrchestratedRuntimeEventEnvelope {
  kind: "runtime_event";
  target: {
    conversationId: string;
    branchId: string;
  };
  session: {
    sessionId: string;
    purpose: string | null;
  };
  agent: {
    ownerAgentId: string | null;
    ownerRole: string | null;
    mainAgentId: string | null;
  };
  taskRun: {
    taskRunId: string | null;
    runType: string | null;
  };
  event: AgentRuntimeEvent;
}

export function projectRuntimeEvent(input: {
  db: StorageDb;
  event: AgentRuntimeEvent;
}): OrchestratedRuntimeEventEnvelope {
  const state = resolveSessionLiveState({
    db: input.db,
    sessionId: input.event.sessionId,
  });

  return {
    kind: "runtime_event",
    target: {
      conversationId: input.event.conversationId,
      branchId: input.event.branchId,
    },
    session: {
      sessionId: input.event.sessionId,
      purpose: state?.session.purpose ?? null,
    },
    agent: {
      ownerAgentId: state?.ownerAgentId ?? null,
      ownerRole: state?.ownerRole ?? null,
      mainAgentId: state?.mainAgentId ?? null,
    },
    taskRun: {
      taskRunId: state?.taskRun?.id ?? null,
      runType: state?.taskRun?.runType ?? null,
    },
    event: input.event,
  };
}
