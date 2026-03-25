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
  runtimeControl?: ToolRuntimeControl;
}

export interface ToolRuntimeControl {
  submitApprovalDecision(input: {
    approvalId: number;
    decision: "approve" | "deny";
    actor: string;
    rawInput?: string | null;
    grantedBy?: "user" | "main_agent";
    reasonText?: string | null;
    decidedAt?: Date;
  }): boolean;
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

export class ToolArgumentValidationError extends Error {
  constructor(
    readonly toolName: string,
    readonly validationMessage: string,
  ) {
    super(`${toolName} args are invalid: ${validationMessage}`);
    this.name = "ToolArgumentValidationError";
  }
}

export class ToolLookupError extends Error {
  constructor(readonly toolName: string) {
    super(`Tool not found: ${toolName}`);
    this.name = "ToolLookupError";
  }
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
    throw new ToolArgumentValidationError(toolName, message);
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
