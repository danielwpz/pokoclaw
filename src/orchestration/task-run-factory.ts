import { randomUUID } from "node:crypto";

import type { StorageDb } from "@/src/storage/db/client.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { TaskRunsRepo } from "@/src/storage/repos/task-runs.repo.js";
import type { Session, TaskRun } from "@/src/storage/schema/types.js";

export interface CreateTaskExecutionInput {
  runType: "delegate" | "cron" | "system";
  ownerAgentId: string;
  conversationId: string;
  branchId: string;
  initiatorSessionId?: string | null;
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

    taskRunsRepo.create({
      id: taskRunId,
      runType: input.params.runType,
      ownerAgentId: input.params.ownerAgentId,
      conversationId: input.params.conversationId,
      branchId: input.params.branchId,
      initiatorSessionId: input.params.initiatorSessionId ?? null,
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
