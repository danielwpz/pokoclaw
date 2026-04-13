/**
 * Task-run creation helpers.
 *
 * Creates durable `task_runs` and their execution sessions with normalized
 * metadata for delegate/cron/system/thread workloads. AgentManager uses this factory
 * to start unattended execution units consistently.
 */
import { randomUUID } from "node:crypto";

import { materializeForkedSessionSnapshotInStorage } from "@/src/orchestration/session-fork.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { TaskRunsRepo } from "@/src/storage/repos/task-runs.repo.js";
import type { Session, TaskRun } from "@/src/storage/schema/types.js";

export interface CreateTaskExecutionInput {
  runType: "delegate" | "cron" | "system" | "thread";
  ownerAgentId: string;
  conversationId: string;
  branchId: string;
  workstreamId?: string | null;
  threadRootRunId?: string | null;
  initiatorSessionId?: string | null;
  initiatorThreadId?: string | null;
  forkSourceSessionId?: string | null;
  forkSourceSeq?: number | null;
  parentRunId?: string | null;
  cronJobId?: string | null;
  contextMode?: string;
  priority?: number;
  attempt?: number;
  description?: string | null;
  inputJson?: string | null;
  createdAt?: Date;
}

export interface CreatedTaskExecution {
  taskRun: TaskRun;
  executionSession: Session;
}

export function createTaskExecution(input: {
  db: StorageDb;
  params: CreateTaskExecutionInput;
}): CreatedTaskExecution {
  const createdAt = input.params.createdAt ?? new Date();
  const executionSessionId = randomUUID();
  const taskRunId = randomUUID();

  return input.db.transaction((tx) => {
    const sessionsRepo = new SessionsRepo(tx);
    const taskRunsRepo = new TaskRunsRepo(tx);
    const forkSourceSessionId = input.params.forkSourceSessionId ?? null;

    if (forkSourceSessionId != null) {
      materializeForkedSessionSnapshotInStorage({
        db: tx,
        targetSession: {
          id: executionSessionId,
          conversationId: input.params.conversationId,
          branchId: input.params.branchId,
          ownerAgentId: input.params.ownerAgentId,
          purpose: "task",
          contextMode: input.params.contextMode ?? "isolated",
          status: "active",
          createdAt,
          updatedAt: createdAt,
        },
        sourceSessionId: forkSourceSessionId,
        forkSourceSeq: input.params.forkSourceSeq,
      });
    } else {
      sessionsRepo.create({
        id: executionSessionId,
        conversationId: input.params.conversationId,
        branchId: input.params.branchId,
        ownerAgentId: input.params.ownerAgentId,
        purpose: "task",
        contextMode: input.params.contextMode ?? "isolated",
        status: "active",
        createdAt,
        updatedAt: createdAt,
      });
    }

    taskRunsRepo.create({
      id: taskRunId,
      runType: input.params.runType,
      ownerAgentId: input.params.ownerAgentId,
      conversationId: input.params.conversationId,
      branchId: input.params.branchId,
      workstreamId: input.params.workstreamId ?? null,
      threadRootRunId: input.params.threadRootRunId ?? taskRunId,
      initiatorSessionId: input.params.initiatorSessionId ?? null,
      initiatorThreadId: input.params.initiatorThreadId ?? null,
      parentRunId: input.params.parentRunId ?? null,
      cronJobId: input.params.cronJobId ?? null,
      executionSessionId,
      status: "running",
      priority: input.params.priority ?? 0,
      attempt: input.params.attempt ?? 1,
      description: input.params.description ?? null,
      inputJson: input.params.inputJson ?? null,
      startedAt: createdAt,
    });

    const executionSession = sessionsRepo.getById(executionSessionId);
    const taskRun = taskRunsRepo.getById(taskRunId);
    if (executionSession == null || taskRun == null) {
      throw new Error("Failed to create task execution session and task run");
    }

    return {
      taskRun,
      executionSession,
    };
  });
}
