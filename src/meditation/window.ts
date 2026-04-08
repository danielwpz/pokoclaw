import {
  type LocalCalendarContext,
  resolveLocalCalendarContext,
  toCanonicalUtcIsoTimestamp,
} from "@/src/shared/time.js";

export const DEFAULT_MEDITATION_LOOKBACK_DAYS = 7;

export interface ResolveMeditationWindowInput {
  tickAt: Date;
  lastSuccessAt: string | null;
  maxLookbackDays?: number;
  calendarContext?: LocalCalendarContext;
}

export interface MeditationWindow {
  startAt: string;
  endAt: string;
  lastSuccessAt: string | null;
  localDate: string;
  timezone: string;
  clippedByLookback: boolean;
}

export function resolveMeditationWindow(input: ResolveMeditationWindowInput): MeditationWindow {
  const tickAt = input.tickAt;
  const endAt = toCanonicalUtcIsoTimestamp(tickAt);
  const lookbackDays = input.maxLookbackDays ?? DEFAULT_MEDITATION_LOOKBACK_DAYS;
  const lookbackStartDate = new Date(tickAt.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const lookbackStartAt = toCanonicalUtcIsoTimestamp(lookbackStartDate);
  const calendarContext = input.calendarContext ?? resolveLocalCalendarContext(tickAt);

  const parsedLastSuccess = parseIsoTimestamp(input.lastSuccessAt);
  if (parsedLastSuccess == null) {
    return {
      startAt: lookbackStartAt,
      endAt,
      lastSuccessAt: input.lastSuccessAt,
      localDate: calendarContext.currentDate,
      timezone: calendarContext.timezone,
      clippedByLookback: true,
    };
  }

  if (parsedLastSuccess.getTime() > tickAt.getTime()) {
    return {
      startAt: endAt,
      endAt,
      lastSuccessAt: input.lastSuccessAt,
      localDate: calendarContext.currentDate,
      timezone: calendarContext.timezone,
      clippedByLookback: false,
    };
  }

  const clippedByLookback = parsedLastSuccess.getTime() < lookbackStartDate.getTime();
  return {
    startAt: clippedByLookback ? lookbackStartAt : toCanonicalUtcIsoTimestamp(parsedLastSuccess),
    endAt,
    lastSuccessAt: input.lastSuccessAt,
    localDate: calendarContext.currentDate,
    timezone: calendarContext.timezone,
    clippedByLookback,
  };
}

function parseIsoTimestamp(value: string | null): Date | null {
  if (value == null) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
