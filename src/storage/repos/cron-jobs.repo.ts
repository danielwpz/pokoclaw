import { eq } from "drizzle-orm";

import type { StorageDb } from "@/src/storage/db/client.js";
import { cronJobs } from "@/src/storage/schema/tables.js";
import type { CronJob } from "@/src/storage/schema/types.js";

export class CronJobsRepo {
  constructor(private readonly db: StorageDb) {}

  getById(id: string): CronJob | null {
    return this.db.select().from(cronJobs).where(eq(cronJobs.id, id)).get() ?? null;
  }
}
