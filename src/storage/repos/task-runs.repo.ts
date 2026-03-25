import { desc, eq } from "drizzle-orm";

import type { StorageDb } from "@/src/storage/db/client.js";
import { taskRuns } from "@/src/storage/schema/tables.js";
import type { TaskRun } from "@/src/storage/schema/types.js";

export class TaskRunsRepo {
  constructor(private readonly db: StorageDb) {}

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
}
