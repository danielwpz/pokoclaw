import type { Static, TSchema } from "@sinclair/typebox";
import { Errors } from "@sinclair/typebox/errors";
import { Check, Clone, Default } from "@sinclair/typebox/value";
import type { SecurityConfig } from "@/src/config/schema.js";
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
  ownerAgentId?: string | null;
  cwd?: string;
  securityConfig: SecurityConfig;
  storage: StorageDb;
  abortSignal?: AbortSignal;
  toolCallId?: string;
  approvalState?: ToolExecutionApprovalState;
}

export interface ToolExecutionApprovalState {
  bashFullAccess?: {
    approved: true;
    mode: "one_shot";
    approvalId: number;
  };
}

export interface ToolDefinition<TArgs = unknown, TDetails = unknown> {
  name: string;
  description: string;
  inputSchema?: TSchema;
  execute(
    context: ToolExecutionContext,
    args: TArgs,
  ): Promise<ToolResult<TDetails>> | ToolResult<TDetails>;
}

export function defineTool<TInputSchema extends TSchema, TDetails = unknown>(input: {
  name: string;
  description: string;
  inputSchema: TInputSchema;
  execute: (
    context: ToolExecutionContext,
    args: Static<TInputSchema>,
  ) => Promise<ToolResult<TDetails>> | ToolResult<TDetails>;
}): ToolDefinition<Static<TInputSchema>, TDetails> {
  return input;
}

export function parseToolArgs<TInputSchema extends TSchema>(
  toolName: string,
  schema: TInputSchema,
  input: unknown,
): Static<TInputSchema> {
  const normalizedInput = Default(schema, Clone(input));
  if (!Check(schema, normalizedInput)) {
    const firstError = Errors(schema, normalizedInput).First();
    const message = firstError?.message ?? "Input does not match the declared schema";
    throw new Error(`${toolName} args are invalid: ${message}`);
  }

  return normalizedInput as Static<TInputSchema>;
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
