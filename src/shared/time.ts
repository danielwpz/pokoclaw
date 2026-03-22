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
