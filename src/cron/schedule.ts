import { Cron } from "croner";
import { toCanonicalUtcIsoTimestamp } from "@/src/shared/time.js";

export interface CronScheduleDefinition {
  scheduleKind: "at" | "every" | "cron";
  scheduleValue: string;
  timezone?: string | null | undefined;
}

export interface NormalizedCronScheduleDefinition extends CronScheduleDefinition {
  scheduleValue: string;
  nextRunAt: Date | null;
}

export class ScheduleDefinitionError extends Error {
  constructor(
    readonly scheduleKind: CronScheduleDefinition["scheduleKind"],
    readonly scheduleValue: string,
    readonly code:
      | "invalid_at_timestamp"
      | "past_at_timestamp"
      | "invalid_every_interval"
      | "invalid_cron_expression",
    message: string,
  ) {
    super(message);
    this.name = "ScheduleDefinitionError";
  }
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

export function normalizeScheduleDefinition(
  input: CronScheduleDefinition,
  now: Date,
): NormalizedCronScheduleDefinition {
  switch (input.scheduleKind) {
    case "at": {
      const resolved = resolveAtSchedule(input.scheduleValue, now);
      return {
        ...input,
        scheduleValue: toCanonicalUtcIsoTimestamp(resolved.scheduledAt),
        nextRunAt: resolved.nextRunAt,
      };
    }
    case "every":
    case "cron":
      return {
        ...input,
        nextRunAt: computeNextRunAt(input, now),
      };
    default:
      throw new Error(`Unsupported schedule kind: ${input.scheduleKind}`);
  }
}

export function resolveInitialNextRunAt(input: CronScheduleDefinition, now: Date): Date | null {
  const nextRunAt = normalizeScheduleDefinition(input, now).nextRunAt;
  if (input.scheduleKind === "at" && nextRunAt == null) {
    throw new ScheduleDefinitionError(
      input.scheduleKind,
      input.scheduleValue,
      "past_at_timestamp",
      "One-shot scheduled tasks must target a future time.",
    );
  }

  return nextRunAt;
}

function computeAtNextRun(scheduleValue: string, now: Date): Date | null {
  return resolveAtSchedule(scheduleValue, now).nextRunAt;
}

function computeEveryNextRun(scheduleValue: string, now: Date): Date {
  const everyMs = Number.parseInt(scheduleValue, 10);
  if (!Number.isFinite(everyMs) || everyMs <= 0) {
    throw new ScheduleDefinitionError(
      "every",
      scheduleValue,
      "invalid_every_interval",
      `Invalid every schedule interval: ${scheduleValue}`,
    );
  }

  return new Date(now.getTime() + everyMs);
}

function computeCronNextRun(
  scheduleValue: string,
  timezone: string | null | undefined,
  now: Date,
): Date | null {
  try {
    const cron = new Cron(
      scheduleValue,
      timezone == null
        ? undefined
        : {
            timezone,
          },
    );
    return cron.nextRun(now);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ScheduleDefinitionError(
      "cron",
      scheduleValue,
      "invalid_cron_expression",
      `Invalid cron schedule expression: ${detail}`,
    );
  }
}

function tryParseRelativeAt(scheduleValue: string, now: Date): Date | null {
  const match =
    /^\s*in\s+(\d+)\s*(seconds?|secs?|sec|s|minutes?|mins?|min|m|hours?|hrs?|hr|h|days?|d|weeks?|w)\s*$/i.exec(
      scheduleValue,
    );
  if (match == null) {
    return null;
  }

  const amount = Number.parseInt(match[1] ?? "", 10);
  const unit = (match[2] ?? "").toLowerCase();
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ScheduleDefinitionError(
      "at",
      scheduleValue,
      "invalid_at_timestamp",
      `Invalid at schedule timestamp: ${scheduleValue}`,
    );
  }

  const unitMs = unit.startsWith("s")
    ? 1_000
    : unit.startsWith("m")
      ? 60_000
      : unit.startsWith("h")
        ? 60 * 60_000
        : unit.startsWith("d")
          ? 24 * 60 * 60_000
          : 7 * 24 * 60 * 60_000;

  return new Date(now.getTime() + amount * unitMs);
}

function resolveAtSchedule(
  scheduleValue: string,
  now: Date,
): { scheduledAt: Date; nextRunAt: Date | null } {
  const relative = tryParseRelativeAt(scheduleValue, now);
  if (relative != null) {
    return {
      scheduledAt: relative,
      nextRunAt: relative,
    };
  }

  const at = new Date(scheduleValue);
  if (Number.isNaN(at.getTime())) {
    throw new ScheduleDefinitionError(
      "at",
      scheduleValue,
      "invalid_at_timestamp",
      `Invalid at schedule timestamp: ${scheduleValue}`,
    );
  }

  return {
    scheduledAt: at,
    nextRunAt: at.getTime() > now.getTime() ? at : null,
  };
}
