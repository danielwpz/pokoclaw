import type { SelfHarnessConfig } from "@/src/config/schema.js";
import { computeNextRunAt } from "@/src/cron/schedule.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { MeditationStateRepo } from "@/src/storage/repos/meditation-state.repo.js";

const logger = createSubsystemLogger("meditation/scheduler");

export interface MeditationRunRequest {
  tickAt: Date;
}

export interface MeditationRunResult {
  skipped: boolean;
  reason?: "no_buckets";
  bucketsExecuted: number;
}

export interface MeditationRunner {
  runOnce(input: MeditationRunRequest): Promise<MeditationRunResult>;
}

export interface MeditationSchedulerDependencies {
  config: SelfHarnessConfig;
  state: MeditationStateRepo;
  runner: MeditationRunner;
  now?: () => Date;
}

export interface MeditationSchedulerStatus {
  started: boolean;
  inFlightRuns: number;
}

export class MeditationScheduler {
  private readonly now: () => Date;
  private started = false;
  private readonly inFlightRuns = new Set<Promise<void>>();

  constructor(private readonly deps: MeditationSchedulerDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  start(): void {
    if (this.started) {
      logger.debug("meditation scheduler start skipped because it is already running");
      return;
    }

    this.started = true;
    logger.info("meditation scheduler started", {
      enabled: this.deps.config.meditation.enabled,
      cron: this.deps.config.meditation.cron,
    });
  }

  stop(): void {
    if (!this.started) {
      logger.debug("meditation scheduler stop skipped because it is already idle");
      return;
    }

    this.started = false;
    logger.info("meditation scheduler stopped", {
      inFlightRuns: this.inFlightRuns.size,
    });
  }

  status(): MeditationSchedulerStatus {
    return {
      started: this.started,
      inFlightRuns: this.inFlightRuns.size,
    };
  }

  async drain(): Promise<void> {
    const inFlight = Array.from(this.inFlightRuns);
    if (inFlight.length === 0) {
      return;
    }
    await Promise.allSettled(inFlight);
  }

  onHeartbeatTick(tickAt: Date = this.now()): void {
    if (!this.started) {
      return;
    }

    const meditationConfig = this.deps.config.meditation;
    if (!meditationConfig.enabled) {
      return;
    }

    const state = this.deps.state.getOrCreateDefault(this.now());
    if (state.running) {
      logger.debug("meditation heartbeat skipped because a previous run is still active", {
        tickAt: tickAt.toISOString(),
      });
      return;
    }

    if (!matchesMeditationTick(meditationConfig.cron, tickAt)) {
      return;
    }

    if (isSameUtcMinute(state.lastStartedAt, tickAt)) {
      logger.debug("meditation heartbeat skipped because this minute was already started", {
        tickAt: tickAt.toISOString(),
        lastStartedAt: state.lastStartedAt,
      });
      return;
    }

    const startedAt = this.now();
    this.deps.state.markStarted({
      startedAt,
    });
    const runPromise = this.deps.runner
      .runOnce({
        tickAt,
      })
      .then((result) => {
        const finishedAt = this.now();
        this.deps.state.markFinished({
          status: "completed",
          finishedAt,
          markSuccess: true,
        });
        if (result.skipped) {
          logger.info("meditation run skipped", {
            tickAt: tickAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            reason: result.reason ?? "unknown",
          });
          return;
        }

        logger.info("meditation run completed", {
          tickAt: tickAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          bucketsExecuted: result.bucketsExecuted,
        });
      })
      .catch((error: unknown) => {
        const finishedAt = this.now();
        this.deps.state.markFinished({
          status: "failed",
          finishedAt,
          markSuccess: false,
        });
        logger.error("meditation run failed", {
          tickAt: tickAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.inFlightRuns.delete(runPromise);
      });

    this.inFlightRuns.add(runPromise);
  }
}

function matchesMeditationTick(cron: string, tickAt: Date): boolean {
  const previousSecond = new Date(tickAt.getTime() - 1_000);
  const candidate = computeNextRunAt(
    {
      scheduleKind: "cron",
      scheduleValue: cron,
    },
    previousSecond,
  );
  return candidate != null && candidate.getTime() === tickAt.getTime();
}

function isSameUtcMinute(previousIso: string | null, current: Date): boolean {
  if (previousIso == null) {
    return false;
  }

  const previous = new Date(previousIso);
  if (Number.isNaN(previous.getTime())) {
    return false;
  }

  return (
    previous.getUTCFullYear() === current.getUTCFullYear() &&
    previous.getUTCMonth() === current.getUTCMonth() &&
    previous.getUTCDate() === current.getUTCDate() &&
    previous.getUTCHours() === current.getUTCHours() &&
    previous.getUTCMinutes() === current.getUTCMinutes()
  );
}
