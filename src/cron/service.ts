import { randomUUID } from "node:crypto";
import {
  type CronScheduleDefinition,
  computeNextRunAt,
  normalizeScheduleDefinition,
  resolveInitialNextRunAt,
} from "@/src/cron/schedule.js";
import type { AgentManager } from "@/src/orchestration/agent-manager.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import {
  type CreateCronJobInput,
  CronJobsRepo,
  type ListCronJobsOptions,
  type UpdateCronJobInput,
} from "@/src/storage/repos/cron-jobs.repo.js";
import type { CronJob } from "@/src/storage/schema/types.js";

const logger = createSubsystemLogger("cron/service");

const DEFAULT_STALE_RUNNING_MS = 2 * 60 * 60 * 1000;
const DEFAULT_DUE_BATCH_LIMIT = 100;
const DEFAULT_MISSED_GRACE_MS = 3 * 60 * 1000;

export interface CronServiceDependencies {
  storage: StorageDb;
  agentManager: Pick<AgentManager, "runCronTaskExecutionFromJob">;
  now?: () => Date;
  staleRunningMs?: number;
  dueBatchLimit?: number;
  missedGraceMs?: number;
}

export interface CronServiceStatus {
  started: boolean;
  scanInFlight: boolean;
  inFlightRuns: number;
}

export interface ScanOnceResult {
  status: "ran" | "skipped";
  dueJobs: number;
  claimedJobs: number;
  missedJobs: number;
  staleCleared: number;
}

export interface AddCronJobInput
  extends Omit<CreateCronJobInput, "id" | "createdAt" | "updatedAt" | "nextRunAt" | "runningAt"> {}

export interface RunCronJobNowResult {
  accepted: boolean;
  cronJobId: string;
}

export class CronService {
  private readonly now: () => Date;
  private readonly staleRunningMs: number;
  private readonly dueBatchLimit: number;
  private readonly missedGraceMs: number;

  private started = false;
  private scanInFlight = false;
  private readonly inFlightRuns = new Set<Promise<void>>();

  constructor(private readonly deps: CronServiceDependencies) {
    this.now = deps.now ?? (() => new Date());
    this.staleRunningMs = deps.staleRunningMs ?? DEFAULT_STALE_RUNNING_MS;
    this.dueBatchLimit = deps.dueBatchLimit ?? DEFAULT_DUE_BATCH_LIMIT;
    this.missedGraceMs = deps.missedGraceMs ?? DEFAULT_MISSED_GRACE_MS;
  }

  start(): void {
    if (this.started) {
      logger.debug("cron service start skipped because it is already running");
      return;
    }

    this.started = true;
    logger.info("cron service started", {
      staleRunningMs: this.staleRunningMs,
      dueBatchLimit: this.dueBatchLimit,
      missedGraceMs: this.missedGraceMs,
    });
  }

  stop(): void {
    if (!this.started) {
      logger.debug("cron service stop skipped because it is already idle");
      return;
    }

    this.started = false;
    logger.info("cron service stopped", {
      inFlightRuns: this.inFlightRuns.size,
    });
  }

  status(): CronServiceStatus {
    return {
      started: this.started,
      scanInFlight: this.scanInFlight,
      inFlightRuns: this.inFlightRuns.size,
    };
  }

  async drain(): Promise<void> {
    const inFlight = Array.from(this.inFlightRuns);
    if (inFlight.length === 0) {
      logger.debug("cron drain completed immediately because there were no in-flight runs");
      return;
    }

    logger.info("waiting for in-flight cron runs to settle", {
      inFlightRuns: inFlight.length,
    });
    await Promise.allSettled(inFlight);
    logger.info("all in-flight cron runs settled");
  }

  list(options: ListCronJobsOptions = {}): CronJob[] {
    const jobs = this.repo().list(options);
    logger.debug("listed cron jobs", {
      count: jobs.length,
      ownerAgentId: options.ownerAgentId,
      ownerAgentIds: options.ownerAgentIds,
      includeDisabled: options.includeDisabled ?? false,
      limit: options.limit ?? 100,
    });
    return jobs;
  }

  add(input: AddCronJobInput): CronJob {
    const now = this.now();
    const normalized = normalizeScheduleDefinition(input, now);
    const nextRunAt = input.enabled === false ? null : resolveInitialNextRunAt(input, now);

    const created = this.repo().create({
      id: randomUUID(),
      ...input,
      scheduleValue: normalized.scheduleValue,
      nextRunAt,
      createdAt: now,
      updatedAt: now,
    });

    logger.info("created cron job", {
      cronJobId: created.id,
      ownerAgentId: created.ownerAgentId,
      targetConversationId: created.targetConversationId,
      targetBranchId: created.targetBranchId,
      scheduleKind: created.scheduleKind,
      enabled: created.enabled,
      nextRunAt: created.nextRunAt,
    });

    return created;
  }

  update(id: string, patch: Omit<UpdateCronJobInput, "id" | "updatedAt">): CronJob {
    const current = this.repo().getById(id);
    if (current == null) {
      throw new Error(`Unknown cron job ${id}`);
    }

    const updatedAt = this.now();
    const merged: CronScheduleDefinition & { enabled: boolean } = {
      scheduleKind: (patch.scheduleKind ??
        current.scheduleKind) as CronScheduleDefinition["scheduleKind"],
      scheduleValue: patch.scheduleValue ?? current.scheduleValue,
      timezone: patch.timezone === undefined ? current.timezone : patch.timezone,
      enabled: patch.enabled ?? current.enabled,
    };
    const hasSchedulePatch =
      patch.scheduleKind !== undefined ||
      patch.scheduleValue !== undefined ||
      patch.timezone !== undefined;
    const shouldRecomputeNextRun = hasSchedulePatch || patch.enabled !== undefined;
    const normalized = hasSchedulePatch ? normalizeScheduleDefinition(merged, updatedAt) : null;

    const nextRunAt = shouldRecomputeNextRun
      ? merged.enabled
        ? (normalized?.nextRunAt ?? resolveInitialNextRunAt(merged, updatedAt))
        : null
      : undefined;

    const updated = this.repo().update({
      id,
      ...patch,
      ...(normalized == null ? {} : { scheduleValue: normalized.scheduleValue }),
      ...(nextRunAt === undefined ? {} : { nextRunAt }),
      updatedAt,
    });
    if (updated == null) {
      throw new Error(`Cron job ${id} disappeared during update`);
    }

    logger.info("updated cron job", {
      cronJobId: updated.id,
      ownerAgentId: updated.ownerAgentId,
      enabled: updated.enabled,
      scheduleKind: updated.scheduleKind,
      nextRunAt: updated.nextRunAt,
    });

    return updated;
  }

  remove(id: string): boolean {
    const removed = this.repo().softDelete({
      id,
      deletedAt: this.now(),
    });
    if (removed) {
      logger.info("removed cron job", {
        cronJobId: id,
      });
    } else {
      logger.debug("cron job remove skipped because it does not exist", {
        cronJobId: id,
      });
    }

    return removed;
  }

  async runJobNow(jobId: string): Promise<RunCronJobNowResult> {
    const now = this.now();
    logger.info("attempting manual cron job run", {
      cronJobId: jobId,
      requestedAt: now.toISOString(),
    });

    const claimed = this.repo().claimManualRun({
      id: jobId,
      now,
      staleBefore: new Date(now.getTime() - this.staleRunningMs),
    });

    if (claimed == null) {
      logger.warn("manual cron job run rejected", {
        cronJobId: jobId,
        reason: "already_running_or_missing",
      });
      throw new Error(`Cron job ${jobId} is already running or does not exist`);
    }

    logger.info("accepted manual cron job run", {
      cronJobId: jobId,
      ownerAgentId: claimed.ownerAgentId,
      runningAt: claimed.runningAt,
    });

    this.kickoffClaimedRun(claimed, "manual");
    return {
      accepted: true,
      cronJobId: jobId,
    };
  }

  async scanOnce(): Promise<ScanOnceResult> {
    if (this.scanInFlight) {
      logger.debug("cron scan skipped because a previous scan is still running");
      return {
        status: "skipped",
        dueJobs: 0,
        claimedJobs: 0,
        missedJobs: 0,
        staleCleared: 0,
      };
    }

    this.scanInFlight = true;

    try {
      const now = this.now();
      const staleBefore = new Date(now.getTime() - this.staleRunningMs);
      const repo = this.repo();

      const staleCleared = repo.clearStaleRunning({ now, staleBefore });
      const dueJobs = repo.listDue(now, this.dueBatchLimit);

      logger.debug("cron scan loaded due jobs", {
        now: now.toISOString(),
        dueJobs: dueJobs.length,
        staleCleared,
        dueBatchLimit: this.dueBatchLimit,
      });

      let claimedJobs = 0;
      let missedJobs = 0;
      for (const dueJob of dueJobs) {
        const scheduledAt = dueJob.nextRunAt == null ? null : new Date(dueJob.nextRunAt);
        const overdueMs =
          scheduledAt == null || Number.isNaN(scheduledAt.getTime())
            ? 0
            : now.getTime() - scheduledAt.getTime();
        const nextRunAt = computeNextRunAt(toScheduleDefinition(dueJob), now);
        if (overdueMs > this.missedGraceMs) {
          repo.completeRun({
            id: dueJob.id,
            finishedAt: now,
            status: "missed",
            lastOutput: "Skipped because this scheduled run was already more than 3 minutes late.",
            nextRunAt,
          });
          missedJobs += 1;
          logger.info("marked overdue cron job as missed", {
            cronJobId: dueJob.id,
            ownerAgentId: dueJob.ownerAgentId,
            scheduledAt: dueJob.nextRunAt,
            overdueMs,
            nextRunAt: nextRunAt?.toISOString() ?? null,
          });
          continue;
        }

        logger.debug("attempting to claim due cron job", {
          cronJobId: dueJob.id,
          ownerAgentId: dueJob.ownerAgentId,
          previousNextRunAt: dueJob.nextRunAt,
          nextRunAt: nextRunAt?.toISOString() ?? null,
        });
        const claimed = repo.claimDueRun({
          id: dueJob.id,
          now,
          nextRunAt,
          staleBefore,
        });

        if (claimed == null) {
          logger.debug("skipped due cron job because another actor claimed it first", {
            cronJobId: dueJob.id,
          });
          continue;
        }

        claimedJobs += 1;
        this.kickoffClaimedRun(claimed, "scheduled");
      }

      logger.info("cron heartbeat", {
        tickAt: now.toISOString(),
        dueJobs: dueJobs.length,
        claimedJobs,
        missedJobs,
        staleCleared,
        inFlightRuns: this.inFlightRuns.size,
      });

      return {
        status: "ran",
        dueJobs: dueJobs.length,
        claimedJobs,
        missedJobs,
        staleCleared,
      };
    } finally {
      this.scanInFlight = false;
    }
  }

  async onHeartbeatTick(tickAt: Date = this.now()): Promise<void> {
    if (!this.started) {
      return;
    }

    try {
      logger.debug("cron service received minute heartbeat", {
        tickAt: tickAt.toISOString(),
      });
      await this.scanOnce();
    } catch (error) {
      logger.error("cron scan failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private kickoffClaimedRun(job: CronJob, triggerKind: "scheduled" | "manual"): void {
    logger.info("kicking off claimed cron job run", {
      cronJobId: job.id,
      triggerKind,
      ownerAgentId: job.ownerAgentId,
      targetConversationId: job.targetConversationId,
      targetBranchId: job.targetBranchId,
      runningAt: job.runningAt,
      nextRunAt: job.nextRunAt,
    });

    const runPromise = this.deps.agentManager
      .runCronTaskExecutionFromJob({
        cronJobId: job.id,
        createdAt: this.now(),
      })
      .then((result) => {
        const finishedAt = this.now();
        const output = summarizeTaskExecutionResult(result);

        const updated = this.repo().completeRun({
          id: job.id,
          finishedAt,
          status: result.status,
          lastOutput: output,
        });

        logger.info("settled cron job run", {
          cronJobId: job.id,
          triggerKind,
          status: result.status,
          taskRunId: result.settled.taskRun.id,
          executionSessionId: result.settled.taskRun.executionSessionId,
          lastRunAt: updated?.lastRunAt ?? finishedAt.toISOString(),
          nextRunAt: updated?.nextRunAt,
        });
      })
      .catch((error: unknown) => {
        const finishedAt = this.now();
        const message = error instanceof Error ? error.message : String(error);
        const updated = this.repo().completeRun({
          id: job.id,
          finishedAt,
          status: "failed",
          lastOutput: message,
        });

        logger.error("cron job execution crashed before settle", {
          cronJobId: job.id,
          triggerKind,
          error: message,
          nextRunAt: updated?.nextRunAt,
        });
      })
      .finally(() => {
        this.inFlightRuns.delete(runPromise);
        logger.debug("cron job run promise settled", {
          cronJobId: job.id,
          triggerKind,
          inFlightRuns: this.inFlightRuns.size,
        });
      });

    this.inFlightRuns.add(runPromise);
    logger.debug("registered in-flight cron job run", {
      cronJobId: job.id,
      triggerKind,
      inFlightRuns: this.inFlightRuns.size,
    });
  }

  private repo(): CronJobsRepo {
    return new CronJobsRepo(this.deps.storage);
  }
}

function summarizeTaskExecutionResult(
  result: Awaited<ReturnType<AgentManager["runCronTaskExecutionFromJob"]>>,
): string | null {
  switch (result.status) {
    case "completed":
    case "blocked":
      return result.settled.taskRun.resultSummary;
    case "failed":
    case "cancelled":
      return result.settled.taskRun.errorText ?? result.errorMessage;
  }
}

function toScheduleDefinition(
  job: Pick<CronJob, "scheduleKind" | "scheduleValue" | "timezone">,
): CronScheduleDefinition {
  return {
    scheduleKind: job.scheduleKind as CronScheduleDefinition["scheduleKind"],
    scheduleValue: job.scheduleValue,
    timezone: job.timezone,
  };
}
