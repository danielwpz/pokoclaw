import type { Logger } from "@/src/shared/logger.js";
import type { StorageDb } from "@/src/storage/db/client.js";

export type ToolContentBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "json";
      json: unknown;
    };

export interface ToolResult<TDetails = unknown> {
  content: ToolContentBlock[];
  details?: TDetails;
}

export interface ToolExecutionContext {
  sessionId: string;
  conversationId: string;
  storage: StorageDb;
  logger: Logger;
  abortSignal?: AbortSignal;
  toolCallId?: string;
}

export interface ToolDefinition<TArgs = unknown, TDetails = unknown> {
  name: string;
  description: string;
  inputSchema?: unknown;
  validateArgs?: (input: unknown) => TArgs;
  execute: (
    context: ToolExecutionContext,
    args: TArgs,
  ) => Promise<ToolResult<TDetails>> | ToolResult<TDetails>;
}

export function textToolResult<TDetails = unknown>(
  text: string,
  details?: TDetails,
): ToolResult<TDetails> {
  const result: ToolResult<TDetails> = {
    content: [{ type: "text", text }],
  };

  if (details !== undefined) {
    result.details = details;
  }

  return result;
}

export function jsonToolResult<TDetails = unknown>(
  json: unknown,
  details?: TDetails,
): ToolResult<TDetails> {
  const result: ToolResult<TDetails> = {
    content: [{ type: "json", json }],
  };

  if (details !== undefined) {
    result.details = details;
  }

  return result;
}
