export function toCanonicalUtcIsoTimestamp(input: Date): string {
  if (!(input instanceof Date)) {
    throw new Error("Timestamp must be a Date object");
  }
  if (Number.isNaN(input.getTime())) {
    throw new Error("Timestamp Date is invalid");
  }

  const date = input;
  return date.toISOString();
}

export interface LocalCalendarContext {
  currentDate: string;
  timezone: string;
}

export function resolveLocalCalendarContext(now: Date = new Date()): LocalCalendarContext {
  if (!(now instanceof Date)) {
    throw new Error("Timestamp must be a Date object");
  }
  if (Number.isNaN(now.getTime())) {
    throw new Error("Timestamp Date is invalid");
  }

  const timezone = resolveLocalTimezone();
  return {
    currentDate: formatDateInTimezone(now, timezone),
    timezone,
  };
}

function resolveLocalTimezone(): string {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone?.trim();
    if (timezone != null && timezone.length > 0) {
      formatDateInTimezone(new Date(), timezone);
      return timezone;
    }
  } catch {
    // Fall through to UTC.
  }

  return "UTC";
}

function formatDateInTimezone(input: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(input);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (year == null || month == null || day == null) {
    throw new Error(`Failed to format date for timezone ${timezone}`);
  }

  return `${year}-${month}-${day}`;
}
