import type { ToolResult } from "@/src/tools/core/types.js";

export const TASK_COMPLETION_TOOL_NAME = "finish_task";

export type TaskCompletionStatus = "completed" | "blocked" | "failed";

export interface TaskCompletionImageAttachment {
  path: string;
  displayPath: string;
  alt?: string;
}

export interface TaskCompletionSignal {
  status: TaskCompletionStatus;
  summary: string;
  finalMessage: string;
  images?: TaskCompletionImageAttachment[];
}

export interface TaskCompletionDetails {
  taskCompletion: TaskCompletionSignal;
}

export function extractTaskCompletionSignal(input: {
  toolName?: string | null;
  result?: ToolResult | null;
  details?: unknown;
}): TaskCompletionSignal | null {
  if (
    input.toolName != null &&
    input.toolName.length > 0 &&
    input.toolName !== TASK_COMPLETION_TOOL_NAME
  ) {
    return null;
  }

  const details =
    input.details !== undefined ? input.details : (input.result?.details as unknown | undefined);
  if (!isRecord(details) || !("taskCompletion" in details) || !isRecord(details.taskCompletion)) {
    return null;
  }

  const status = normalizeCompletionStatus(details.taskCompletion.status);
  const summary = normalizeNonEmptyString(details.taskCompletion.summary);
  const finalMessage = normalizeNonEmptyString(details.taskCompletion.finalMessage);
  const images = normalizeCompletionImages(details.taskCompletion.images);
  if (status == null || summary == null || finalMessage == null) {
    return null;
  }

  return {
    status,
    summary,
    finalMessage,
    ...(images.length === 0 ? {} : { images }),
  };
}

export function resolveTaskCompletionResultSummary(signal: TaskCompletionSignal): string {
  return signal.finalMessage;
}

function normalizeCompletionStatus(value: unknown): TaskCompletionStatus | null {
  return value === "completed" || value === "blocked" || value === "failed" ? value : null;
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCompletionImages(value: unknown): TaskCompletionImageAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const images: TaskCompletionImageAttachment[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const path = normalizeNonEmptyString(item.path);
    const displayPath = normalizeNonEmptyString(item.displayPath);
    if (path == null || displayPath == null) {
      continue;
    }
    const alt = normalizeNonEmptyString(item.alt);
    images.push({
      path,
      displayPath,
      ...(alt == null ? {} : { alt }),
    });
  }
  return images;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}
