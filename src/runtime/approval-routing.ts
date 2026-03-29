/**
 * Approval routing policy resolver.
 *
 * Determines whether a permission request should go to end-user approval or to
 * delegated main-agent approval based on runtime role/session ownership.
 */
import { resolveSessionLiveStateFromSession } from "@/src/runtime/live-state.js";
import type { AgentRuntimeRole } from "@/src/security/policy.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { StorageDb } from "@/src/storage/db/client.js";
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
  const state = resolveSessionLiveStateFromSession({
    db: input.db,
    session: input.session,
  });
  const ownerRole = state.ownerRole;
  const taskRun = state.taskRun;

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
