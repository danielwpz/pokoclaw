import { eq } from "drizzle-orm";

import { type AgentRuntimeRole, normalizeAgentKindToRuntimeRole } from "@/src/security/policy.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { TaskRunsRepo } from "@/src/storage/repos/task-runs.repo.js";
import { agents } from "@/src/storage/schema/tables.js";
import type { Session } from "@/src/storage/schema/types.js";

const logger = createSubsystemLogger("runtime/approval-routing");

export type ApprovalTarget = "user" | "main_agent";

export type ApprovalRuntimeKind =
  | "main_chat"
  | "subagent_chat"
  | "task_session"
  | "delegate_run"
  | "cron_run"
  | "system_run";

export interface ResolvedApprovalRoute {
  target: ApprovalTarget;
  runtimeKind: ApprovalRuntimeKind;
  ownerRole: AgentRuntimeRole;
  taskRunId: string | null;
}

export function resolveApprovalRouteForSession(input: {
  db: StorageDb;
  session: Session;
}): ResolvedApprovalRoute {
  const ownerRole = resolveOwnerRole(input.db, input.session.ownerAgentId);
  const taskRun = new TaskRunsRepo(input.db).getByExecutionSessionId(input.session.id);

  if (taskRun != null) {
    switch (taskRun.runType) {
      case "delegate":
        return logResolvedRoute({
          sessionId: input.session.id,
          route: {
            target: "main_agent",
            runtimeKind: "delegate_run",
            ownerRole,
            taskRunId: taskRun.id,
          },
        });
      case "cron":
        return logResolvedRoute({
          sessionId: input.session.id,
          route: {
            target: "main_agent",
            runtimeKind: "cron_run",
            ownerRole,
            taskRunId: taskRun.id,
          },
        });
      case "system":
        return logResolvedRoute({
          sessionId: input.session.id,
          route: {
            target: "user",
            runtimeKind: "system_run",
            ownerRole,
            taskRunId: taskRun.id,
          },
        });
    }
  }

  if (input.session.purpose === "task" || ownerRole === "task") {
    return logResolvedRoute({
      sessionId: input.session.id,
      route: {
        target: "main_agent",
        runtimeKind: "task_session",
        ownerRole,
        taskRunId: null,
      },
    });
  }

  if (ownerRole === "main") {
    return logResolvedRoute({
      sessionId: input.session.id,
      route: {
        target: "user",
        runtimeKind: "main_chat",
        ownerRole,
        taskRunId: null,
      },
    });
  }

  return logResolvedRoute({
    sessionId: input.session.id,
    route: {
      target: "user",
      runtimeKind: "subagent_chat",
      ownerRole,
      taskRunId: null,
    },
  });
}

function resolveOwnerRole(db: StorageDb, ownerAgentId: string | null): AgentRuntimeRole {
  if (ownerAgentId == null || ownerAgentId.trim().length === 0) {
    return "subagent";
  }

  const row =
    db.select({ kind: agents.kind }).from(agents).where(eq(agents.id, ownerAgentId)).get() ?? null;
  return normalizeAgentKindToRuntimeRole(row?.kind);
}

function logResolvedRoute(input: {
  sessionId: string;
  route: ResolvedApprovalRoute;
}): ResolvedApprovalRoute {
  logger.debug("resolved approval route", {
    sessionId: input.sessionId,
    target: input.route.target,
    runtimeKind: input.route.runtimeKind,
    ownerRole: input.route.ownerRole,
    taskRunId: input.route.taskRunId,
  });
  return input.route;
}
