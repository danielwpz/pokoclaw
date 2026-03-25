import { desc, eq } from "drizzle-orm";

import { toCanonicalUtcIsoTimestamp } from "@/src/shared/time.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { taskRuns } from "@/src/storage/schema/tables.js";
import type { NewTaskRun, TaskRun } from "@/src/storage/schema/types.js";

export interface CreateTaskRunInput {
  id: string;
  runType: string;
  ownerAgentId: string;
  conversationId: string;
  branchId: string;
  initiatorSessionId?: string | null;
  parentRunId?: string | null;
  cronJobId?: string | null;
  executionSessionId?: string | null;
  status: string;
  priority?: number;
  attempt?: number;
  description?: string | null;
  inputJson?: string | null;
  resultSummary?: string | null;
  errorText?: string | null;
  startedAt?: Date;
  finishedAt?: Date | null;
  durationMs?: number | null;
  cancelledBy?: string | null;
}

export interface UpdateTaskRunStatusInput {
  id: string;
  status: string;
  resultSummary?: string | null;
  errorText?: string | null;
  finishedAt?: Date | null;
  durationMs?: number | null;
  cancelledBy?: string | null;
}

export class TaskRunsRepo {
  constructor(private readonly db: StorageDb) {}

  create(input: CreateTaskRunInput): void {
    const startedAt = input.startedAt ?? new Date();
    const row: NewTaskRun = {
      id: input.id,
      runType: input.runType,
      ownerAgentId: input.ownerAgentId,
      conversationId: input.conversationId,
      branchId: input.branchId,
      initiatorSessionId: input.initiatorSessionId ?? null,
      parentRunId: input.parentRunId ?? null,
      cronJobId: input.cronJobId ?? null,
      executionSessionId: input.executionSessionId ?? null,
      status: input.status,
      priority: input.priority ?? 0,
      attempt: input.attempt ?? 1,
      description: input.description ?? null,
      inputJson: input.inputJson ?? null,
      resultSummary: input.resultSummary ?? null,
      errorText: input.errorText ?? null,
      startedAt: toCanonicalUtcIsoTimestamp(startedAt),
      finishedAt: input.finishedAt == null ? null : toCanonicalUtcIsoTimestamp(input.finishedAt),
      durationMs: input.durationMs ?? null,
      cancelledBy: input.cancelledBy ?? null,
    };

    this.db.insert(taskRuns).values(row).run();
  }

  getById(id: string): TaskRun | null {
    return this.db.select().from(taskRuns).where(eq(taskRuns.id, id)).get() ?? null;
  }

  getByExecutionSessionId(executionSessionId: string): TaskRun | null {
    return (
      this.db
        .select()
        .from(taskRuns)
        .where(eq(taskRuns.executionSessionId, executionSessionId))
        .get() ?? null
    );
  }

  listByOwner(ownerAgentId: string, limit = 50): TaskRun[] {
    return this.db
      .select()
      .from(taskRuns)
      .where(eq(taskRuns.ownerAgentId, ownerAgentId))
      .orderBy(desc(taskRuns.startedAt), desc(taskRuns.id))
      .limit(limit)
      .all();
  }

  updateStatus(input: UpdateTaskRunStatusInput): void {
    this.db
      .update(taskRuns)
      .set({
        status: input.status,
        ...(input.resultSummary === undefined ? {} : { resultSummary: input.resultSummary }),
        ...(input.errorText === undefined ? {} : { errorText: input.errorText }),
        ...(input.finishedAt === undefined
          ? {}
          : {
              finishedAt:
                input.finishedAt == null ? null : toCanonicalUtcIsoTimestamp(input.finishedAt),
            }),
        ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
        ...(input.cancelledBy === undefined ? {} : { cancelledBy: input.cancelledBy }),
      })
      .where(eq(taskRuns.id, input.id))
      .run();
  }
}
