export interface BackgroundTaskPayload {
  kind: "background_task";
  version: 1;
  taskDefinition: string;
}

export function buildBackgroundTaskPayload(taskDefinition: string): string {
  return JSON.stringify({
    kind: "background_task",
    version: 1,
    taskDefinition: taskDefinition.trim(),
  } satisfies BackgroundTaskPayload);
}

export function parseBackgroundTaskPayload(
  inputJson: string | null | undefined,
): BackgroundTaskPayload | null {
  if (inputJson == null) {
    return null;
  }
  const trimmed = inputJson.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    const record = parsed as Record<string, unknown>;
    if (record.kind !== "background_task" || record.version !== 1) {
      return null;
    }

    const taskDefinition =
      typeof record.taskDefinition === "string" ? record.taskDefinition.trim() : "";
    if (taskDefinition.length === 0) {
      return null;
    }

    return {
      kind: "background_task",
      version: 1,
      taskDefinition,
    };
  } catch {
    return null;
  }
}
