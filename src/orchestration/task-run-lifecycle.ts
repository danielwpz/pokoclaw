import type { StorageDb } from "@/src/storage/db/client.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { TaskRunsRepo } from "@/src/storage/repos/task-runs.repo.js";
import type { Session, TaskRun } from "@/src/storage/schema/types.js";

export interface SettledTaskExecution {
  taskRun: TaskRun;
  executionSession: Session | null;
}

interface SettleTaskExecutionInput {
  db: StorageDb;
  taskRunId: string;
  status: "completed" | "failed" | "cancelled";
  resultSummary?: string | null;
  errorText?: string | null;
  cancelledBy?: string | null;
  finishedAt?: Date;
}

export function completeTaskExecution(input: {
  db: StorageDb;
  taskRunId: string;
  resultSummary?: string | null;
  finishedAt?: Date;
}): SettledTaskExecution {
  return settleTaskExecution({
    db: input.db,
    taskRunId: input.taskRunId,
    status: "completed",
    resultSummary: input.resultSummary,
    finishedAt: input.finishedAt,
  });
}

export function failTaskExecution(input: {
  db: StorageDb;
  taskRunId: string;
  errorText?: string | null;
  resultSummary?: string | null;
  finishedAt?: Date;
}): SettledTaskExecution {
  return settleTaskExecution({
    db: input.db,
    taskRunId: input.taskRunId,
    status: "failed",
    errorText: input.errorText,
    resultSummary: input.resultSummary,
    finishedAt: input.finishedAt,
  });
}

export function cancelTaskExecution(input: {
  db: StorageDb;
  taskRunId: string;
  cancelledBy: string;
  resultSummary?: string | null;
  finishedAt?: Date;
}): SettledTaskExecution {
  return settleTaskExecution({
    db: input.db,
    taskRunId: input.taskRunId,
    status: "cancelled",
    cancelledBy: input.cancelledBy,
    resultSummary: input.resultSummary,
    finishedAt: input.finishedAt,
  });
}

function settleTaskExecution(input: SettleTaskExecutionInput): SettledTaskExecution {
  const taskRunsRepo = new TaskRunsRepo(input.db);
  const taskRun = taskRunsRepo.getById(input.taskRunId);
  if (taskRun == null) {
    throw new Error(`Cannot settle unknown task run ${input.taskRunId}`);
  }

  const finishedAt = input.finishedAt ?? new Date();
  const durationMs = computeDurationMs(taskRun.startedAt, finishedAt);

  taskRunsRepo.updateStatus({
    id: input.taskRunId,
    status: input.status,
    ...(input.resultSummary === undefined ? {} : { resultSummary: input.resultSummary }),
    ...(input.errorText === undefined ? {} : { errorText: input.errorText }),
    ...(input.cancelledBy === undefined ? {} : { cancelledBy: input.cancelledBy }),
    finishedAt,
    durationMs,
  });

  const sessionsRepo = new SessionsRepo(input.db);
  if (taskRun.executionSessionId != null) {
    sessionsRepo.updateStatus({
      id: taskRun.executionSessionId,
      status: input.status,
      updatedAt: finishedAt,
      endedAt: finishedAt,
    });
  }

  const settledTaskRun = taskRunsRepo.getById(input.taskRunId);
  if (settledTaskRun == null) {
    throw new Error(`Task run ${input.taskRunId} disappeared after settle`);
  }

  return {
    taskRun: settledTaskRun,
    executionSession:
      settledTaskRun.executionSessionId == null
        ? null
        : sessionsRepo.getById(settledTaskRun.executionSessionId),
  };
}

function computeDurationMs(startedAtIso: string, finishedAt: Date): number | null {
  const startedAtMs = Date.parse(startedAtIso);
  if (!Number.isFinite(startedAtMs)) {
    return null;
  }

  return Math.max(0, finishedAt.getTime() - startedAtMs);
}
