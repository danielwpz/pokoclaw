import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, or } from "drizzle-orm";

import { toCanonicalUtcIsoTimestamp } from "@/src/shared/time.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { cronJobs } from "@/src/storage/schema/tables.js";
import type { CronJob, NewCronJob } from "@/src/storage/schema/types.js";

export interface CreateCronJobInput {
  id: string;
  ownerAgentId: string;
  targetConversationId: string;
  targetBranchId: string;
  name?: string | null;
  scheduleKind: "at" | "every" | "cron";
  scheduleValue: string;
  timezone?: string | null;
  enabled?: boolean;
  sessionTarget?: "main" | "isolated";
  contextMode?: "group" | "isolated";
  payloadJson: string;
  nextRunAt?: Date | null;
  runningAt?: Date | null;
  lastRunAt?: Date | null;
  lastStatus?: string | null;
  lastOutput?: string | null;
  consecutiveFailures?: number;
  deleteAfterRun?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ListCronJobsOptions {
  ownerAgentId?: string;
  ownerAgentIds?: string[];
  includeDisabled?: boolean;
  limit?: number;
}

export interface UpdateCronJobInput {
  id: string;
  name?: string | null;
  scheduleKind?: "at" | "every" | "cron";
  scheduleValue?: string;
  timezone?: string | null;
  enabled?: boolean;
  sessionTarget?: "main" | "isolated";
  contextMode?: "group" | "isolated";
  payloadJson?: string;
  nextRunAt?: Date | null;
  deleteAfterRun?: boolean;
  updatedAt?: Date;
}

export interface SoftDeleteCronJobInput {
  id: string;
  deletedAt?: Date;
}

export interface CompleteCronJobRunInput {
  id: string;
  finishedAt?: Date;
  status: "completed" | "blocked" | "failed" | "cancelled" | "missed";
  lastOutput?: string | null;
  nextRunAt?: Date | null;
}

export class CronJobsRepo {
  constructor(private readonly db: StorageDb) {}

  create(input: CreateCronJobInput): CronJob {
    const createdAt = input.createdAt ?? new Date();
    const updatedAt = input.updatedAt ?? createdAt;
    const row: NewCronJob = {
      id: input.id,
      ownerAgentId: input.ownerAgentId,
      targetConversationId: input.targetConversationId,
      targetBranchId: input.targetBranchId,
      name: input.name ?? null,
      scheduleKind: input.scheduleKind,
      scheduleValue: input.scheduleValue,
      timezone: input.timezone ?? null,
      enabled: input.enabled ?? true,
      sessionTarget: input.sessionTarget ?? "isolated",
      contextMode: input.contextMode ?? "isolated",
      payloadJson: input.payloadJson,
      nextRunAt: toNullableIso(input.nextRunAt),
      runningAt: toNullableIso(input.runningAt),
      lastRunAt: toNullableIso(input.lastRunAt),
      lastStatus: input.lastStatus ?? null,
      lastOutput: input.lastOutput ?? null,
      consecutiveFailures: input.consecutiveFailures ?? 0,
      deleteAfterRun: input.deleteAfterRun ?? false,
      createdAt: toCanonicalUtcIsoTimestamp(createdAt),
      updatedAt: toCanonicalUtcIsoTimestamp(updatedAt),
    };

    this.db.insert(cronJobs).values(row).run();

    const created = this.getById(input.id);
    if (created == null) {
      throw new Error(`Cron job ${input.id} disappeared after create`);
    }
    return created;
  }

  getById(id: string): CronJob | null {
    return (
      this.db
        .select()
        .from(cronJobs)
        .where(and(eq(cronJobs.id, id), isNull(cronJobs.deletedAt)))
        .get() ?? null
    );
  }

  getByIdIncludingDeleted(id: string): CronJob | null {
    return this.db.select().from(cronJobs).where(eq(cronJobs.id, id)).get() ?? null;
  }

  list(options: ListCronJobsOptions = {}): CronJob[] {
    const predicates = [isNull(cronJobs.deletedAt)];

    if (options.ownerAgentId != null) {
      predicates.push(eq(cronJobs.ownerAgentId, options.ownerAgentId));
    }

    if ((options.ownerAgentIds?.length ?? 0) > 0) {
      predicates.push(inArray(cronJobs.ownerAgentId, options.ownerAgentIds ?? []));
    }

    if (!options.includeDisabled) {
      predicates.push(eq(cronJobs.enabled, true));
    }

    const query = this.db.select().from(cronJobs);
    const limited = query.orderBy(asc(cronJobs.nextRunAt), asc(cronJobs.id));

    return (
      (predicates.length > 0 ? limited.where(and(...predicates)) : limited)
        .limit(options.limit ?? 100)
        .all() ?? []
    );
  }

  listDue(now: Date, limit: number = 100): CronJob[] {
    return this.db
      .select()
      .from(cronJobs)
      .where(
        and(
          isNull(cronJobs.deletedAt),
          eq(cronJobs.enabled, true),
          lte(cronJobs.nextRunAt, toCanonicalUtcIsoTimestamp(now)),
          isNull(cronJobs.runningAt),
        ),
      )
      .orderBy(asc(cronJobs.nextRunAt), asc(cronJobs.id))
      .limit(limit)
      .all();
  }

  update(input: UpdateCronJobInput): CronJob | null {
    const updatedAt = input.updatedAt ?? new Date();
    const result = this.db
      .update(cronJobs)
      .set({
        ...(input.name === undefined ? {} : { name: input.name ?? null }),
        ...(input.scheduleKind === undefined ? {} : { scheduleKind: input.scheduleKind }),
        ...(input.scheduleValue === undefined ? {} : { scheduleValue: input.scheduleValue }),
        ...(input.timezone === undefined ? {} : { timezone: input.timezone ?? null }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.sessionTarget === undefined ? {} : { sessionTarget: input.sessionTarget }),
        ...(input.contextMode === undefined ? {} : { contextMode: input.contextMode }),
        ...(input.payloadJson === undefined ? {} : { payloadJson: input.payloadJson }),
        ...(input.nextRunAt === undefined ? {} : { nextRunAt: toNullableIso(input.nextRunAt) }),
        ...(input.deleteAfterRun === undefined ? {} : { deleteAfterRun: input.deleteAfterRun }),
        updatedAt: toCanonicalUtcIsoTimestamp(updatedAt),
      })
      .where(and(eq(cronJobs.id, input.id), isNull(cronJobs.deletedAt)))
      .run();

    if ((result.changes ?? 0) < 1) {
      return null;
    }

    return this.getById(input.id);
  }

  remove(id: string): boolean {
    return this.softDelete({ id });
  }

  softDelete(input: SoftDeleteCronJobInput): boolean {
    const deletedAt = input.deletedAt ?? new Date();
    const result = this.db
      .update(cronJobs)
      .set({
        enabled: false,
        nextRunAt: null,
        deletedAt: toCanonicalUtcIsoTimestamp(deletedAt),
        updatedAt: toCanonicalUtcIsoTimestamp(deletedAt),
      })
      .where(and(eq(cronJobs.id, input.id), isNull(cronJobs.deletedAt)))
      .run();

    return (result.changes ?? 0) > 0;
  }

  claimDueRun(input: {
    id: string;
    now: Date;
    nextRunAt: Date | null;
    staleBefore?: Date;
  }): CronJob | null {
    return this.claimRun({
      id: input.id,
      now: input.now,
      nextRunAt: input.nextRunAt,
      allowDisabled: false,
      requireDue: true,
      ...(input.staleBefore == null ? {} : { staleBefore: input.staleBefore }),
    });
  }

  claimManualRun(input: { id: string; now: Date; staleBefore?: Date }): CronJob | null {
    return this.claimRun({
      id: input.id,
      now: input.now,
      nextRunAt: undefined,
      allowDisabled: true,
      requireDue: false,
      ...(input.staleBefore == null ? {} : { staleBefore: input.staleBefore }),
    });
  }

  completeRun(input: CompleteCronJobRunInput): CronJob | null {
    const finishedAt = input.finishedAt ?? new Date();
    const current = this.getByIdIncludingDeleted(input.id);
    if (current == null) {
      return null;
    }

    if (current.deleteAfterRun && input.status === "completed") {
      this.remove(input.id);
      return this.getByIdIncludingDeleted(input.id);
    }

    const nextFailures =
      input.status === "failed"
        ? current.consecutiveFailures + 1
        : input.status === "missed"
          ? current.consecutiveFailures
          : 0;

    const enabled =
      current.scheduleKind === "at" && current.nextRunAt == null ? false : current.enabled;

    const result = this.db
      .update(cronJobs)
      .set({
        runningAt: null,
        lastRunAt: toCanonicalUtcIsoTimestamp(finishedAt),
        lastStatus: input.status,
        ...(input.lastOutput === undefined ? {} : { lastOutput: input.lastOutput ?? null }),
        ...(input.nextRunAt === undefined ? {} : { nextRunAt: toNullableIso(input.nextRunAt) }),
        consecutiveFailures: nextFailures,
        enabled,
        updatedAt: toCanonicalUtcIsoTimestamp(finishedAt),
      })
      .where(eq(cronJobs.id, input.id))
      .run();

    if ((result.changes ?? 0) < 1) {
      return null;
    }

    return this.getByIdIncludingDeleted(input.id);
  }

  clearStaleRunning(input: { now: Date; staleBefore: Date }): number {
    const result = this.db
      .update(cronJobs)
      .set({
        runningAt: null,
        lastStatus: "missed",
        updatedAt: toCanonicalUtcIsoTimestamp(input.now),
      })
      .where(
        and(
          isNotNull(cronJobs.runningAt),
          lt(cronJobs.runningAt, toCanonicalUtcIsoTimestamp(input.staleBefore)),
        ),
      )
      .run();

    return result.changes ?? 0;
  }

  private claimRun(input: {
    id: string;
    now: Date;
    nextRunAt: Date | null | undefined;
    allowDisabled: boolean;
    requireDue: boolean;
    staleBefore?: Date;
  }): CronJob | null {
    const nowIso = toCanonicalUtcIsoTimestamp(input.now);
    const staleBeforeIso =
      input.staleBefore == null ? null : toCanonicalUtcIsoTimestamp(input.staleBefore);

    const predicates = [eq(cronJobs.id, input.id)];
    predicates.push(isNull(cronJobs.deletedAt));

    if (!input.allowDisabled) {
      predicates.push(eq(cronJobs.enabled, true));
    }

    if (input.requireDue) {
      predicates.push(lte(cronJobs.nextRunAt, nowIso));
    }

    if (staleBeforeIso == null) {
      predicates.push(isNull(cronJobs.runningAt));
    } else {
      const runningPredicate = or(
        isNull(cronJobs.runningAt),
        lt(cronJobs.runningAt, staleBeforeIso),
      );
      if (runningPredicate == null) {
        throw new Error("Failed to construct cron job running-state predicate");
      }

      predicates.push(runningPredicate);
    }

    const result = this.db
      .update(cronJobs)
      .set({
        runningAt: nowIso,
        ...(input.nextRunAt === undefined ? {} : { nextRunAt: toNullableIso(input.nextRunAt) }),
        updatedAt: nowIso,
      })
      .where(and(...predicates))
      .run();

    if ((result.changes ?? 0) < 1) {
      return null;
    }

    return this.getById(input.id);
  }
}

function toNullableIso(value: Date | null | undefined): string | null {
  if (value == null) {
    return null;
  }

  return toCanonicalUtcIsoTimestamp(value);
}
