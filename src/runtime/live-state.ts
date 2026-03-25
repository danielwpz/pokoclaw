import { type AgentRuntimeRole, normalizeAgentKindToRuntimeRole } from "@/src/security/policy.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { AgentsRepo } from "@/src/storage/repos/agents.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { TaskRunsRepo } from "@/src/storage/repos/task-runs.repo.js";
import type { Session, TaskRun } from "@/src/storage/schema/types.js";

export interface ResolvedSessionLiveState {
  session: Session;
  ownerAgentId: string | null;
  ownerRole: AgentRuntimeRole;
  mainAgentId: string | null;
  taskRun: TaskRun | null;
  approvalSourceSession: Session | null;
}

export interface ResolvedAgentOwnershipState {
  agentId: string;
  ownerRole: AgentRuntimeRole;
  mainAgentId: string | null;
}

export interface ResolvedTaskRunLiveState {
  taskRun: TaskRun;
  executionSession: Session | null;
  latestApprovalSession: Session | null;
  ownerRole: AgentRuntimeRole;
  mainAgentId: string | null;
}

export function resolveSessionLiveState(input: {
  db: StorageDb;
  sessionId: string;
}): ResolvedSessionLiveState | null {
  const sessionsRepo = new SessionsRepo(input.db);
  const session = sessionsRepo.getById(input.sessionId);
  if (session == null) {
    return null;
  }

  return resolveSessionLiveStateFromSession({
    db: input.db,
    session,
  });
}

export function resolveSessionLiveStateFromSession(input: {
  db: StorageDb;
  session: Session;
}): ResolvedSessionLiveState {
  const taskRunsRepo = new TaskRunsRepo(input.db);
  const sessionsRepo = new SessionsRepo(input.db);
  const ownership =
    input.session.ownerAgentId == null
      ? null
      : resolveAgentOwnershipState({
          db: input.db,
          agentId: input.session.ownerAgentId,
        });

  return {
    session: input.session,
    ownerAgentId: input.session.ownerAgentId ?? null,
    ownerRole: ownership?.ownerRole ?? "subagent",
    mainAgentId: ownership?.mainAgentId ?? null,
    taskRun: taskRunsRepo.getByExecutionSessionId(input.session.id),
    approvalSourceSession:
      input.session.approvalForSessionId == null
        ? null
        : sessionsRepo.getById(input.session.approvalForSessionId),
  };
}

export function resolveAgentOwnershipState(input: {
  db: StorageDb;
  agentId: string;
}): ResolvedAgentOwnershipState | null {
  const agentsRepo = new AgentsRepo(input.db);
  const agent = agentsRepo.getById(input.agentId);
  if (agent == null) {
    return null;
  }

  return {
    agentId: agent.id,
    ownerRole: normalizeAgentKindToRuntimeRole(agent.kind),
    mainAgentId: agentsRepo.resolveMainAgentId(agent.id),
  };
}

export function resolveTaskRunLiveState(input: {
  db: StorageDb;
  taskRunId: string;
}): ResolvedTaskRunLiveState | null {
  const taskRunsRepo = new TaskRunsRepo(input.db);
  const taskRun = taskRunsRepo.getById(input.taskRunId);
  if (taskRun == null) {
    return null;
  }

  return resolveTaskRunLiveStateFromTaskRun({
    db: input.db,
    taskRun,
  });
}

export function resolveTaskRunLiveStateFromTaskRun(input: {
  db: StorageDb;
  taskRun: TaskRun;
}): ResolvedTaskRunLiveState {
  const sessionsRepo = new SessionsRepo(input.db);
  const executionSession =
    input.taskRun.executionSessionId == null
      ? null
      : sessionsRepo.getById(input.taskRun.executionSessionId);
  const ownership = resolveAgentOwnershipState({
    db: input.db,
    agentId: input.taskRun.ownerAgentId,
  });

  return {
    taskRun: input.taskRun,
    executionSession,
    latestApprovalSession:
      input.taskRun.executionSessionId == null
        ? null
        : sessionsRepo.findLatestApprovalSessionForSource(input.taskRun.executionSessionId),
    ownerRole: ownership?.ownerRole ?? "subagent",
    mainAgentId: ownership?.mainAgentId ?? null,
  };
}
