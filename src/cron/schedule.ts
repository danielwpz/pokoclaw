import { Cron } from "croner";

export interface CronScheduleDefinition {
  scheduleKind: "at" | "every" | "cron";
  scheduleValue: string;
  timezone?: string | null | undefined;
}

export function computeNextRunAt(job: CronScheduleDefinition, now: Date): Date | null {
  switch (job.scheduleKind) {
    case "at":
      return computeAtNextRun(job.scheduleValue, now);
    case "every":
      return computeEveryNextRun(job.scheduleValue, now);
    case "cron":
      return computeCronNextRun(job.scheduleValue, job.timezone, now);
    default:
      throw new Error(`Unsupported schedule kind: ${job.scheduleKind}`);
  }
}

export function resolveInitialNextRunAt(input: CronScheduleDefinition, now: Date): Date | null {
  const nextRunAt = computeNextRunAt(input, now);
  if (input.scheduleKind === "at" && nextRunAt == null) {
    throw new Error("One-shot cron jobs must target a future time.");
  }

  return nextRunAt;
}

function computeAtNextRun(scheduleValue: string, now: Date): Date | null {
  const at = new Date(scheduleValue);
  if (Number.isNaN(at.getTime())) {
    throw new Error(`Invalid at schedule timestamp: ${scheduleValue}`);
  }
  return at.getTime() > now.getTime() ? at : null;
}

function computeEveryNextRun(scheduleValue: string, now: Date): Date {
  const everyMs = Number.parseInt(scheduleValue, 10);
  if (!Number.isFinite(everyMs) || everyMs <= 0) {
    throw new Error(`Invalid every schedule interval: ${scheduleValue}`);
  }

  return new Date(now.getTime() + everyMs);
}

function computeCronNextRun(
  scheduleValue: string,
  timezone: string | null | undefined,
  now: Date,
): Date | null {
  const cron = new Cron(
    scheduleValue,
    timezone == null
      ? undefined
      : {
          timezone,
        },
  );
  return cron.nextRun(now);
}
