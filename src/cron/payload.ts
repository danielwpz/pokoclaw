export function serializeCronTaskDefinition(taskDefinition: string): string {
  return taskDefinition.trim();
}

export function extractCronTaskDefinition(payload: string): string {
  const trimmed = payload.trim();
  if (trimmed.length === 0) {
    return "";
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "string") {
      return parsed.trim();
    }
    if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (typeof record.taskDefinition === "string") {
        return record.taskDefinition.trim();
      }
      if (typeof record.prompt === "string") {
        return record.prompt.trim();
      }
    }
  } catch {}

  return trimmed;
}
