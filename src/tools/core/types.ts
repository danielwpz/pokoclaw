import type { Static, TSchema } from "@sinclair/typebox";
import { Errors } from "@sinclair/typebox/errors";
import { Check, Clone, Default } from "@sinclair/typebox/value";
import type { SecurityConfig } from "@/src/config/schema.js";
import type { RunLiveObservabilitySnapshot } from "@/src/runtime/run-observability.js";
import type { PermissionScope } from "@/src/security/scope.js";
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
  sessionPurpose?: string;
  ownerAgentId?: string | null;
  agentKind?: string | null;
  cwd?: string;
  securityConfig: SecurityConfig;
  storage: StorageDb;
  systemDatabasePath?: string;
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
  getRuntimeStatus?(input?: { runId?: string }):
    | {
        now: string;
        runs: RunLiveObservabilitySnapshot[];
      }
    | {
        now: string;
        found: true;
        run: RunLiveObservabilitySnapshot;
      }
    | {
        now: string;
        found: false;
        runId: string;
        message: string;
      };
  requestSubagentCreation?(input: {
    sourceSessionId: string;
    title: string;
    description: string;
    initialTask: string;
    cwd?: string;
    initialExtraScopes?: Array<
      | { kind: "fs.read" | "fs.write"; path: string }
      | { kind: "db.read" | "db.write"; database: "system" }
      | { kind: "bash.full_access"; prefix: string[] }
    >;
  }): Promise<{
    requestId: string;
    title: string;
    workdir: string;
    privateWorkspaceDir: string;
    status: "pending_confirmation";
    expiresAt: string | null;
  }>;
  runCronJobNow?(input: { jobId: string }): Promise<{
    accepted: boolean;
    cronJobId: string;
  }>;
  startBackgroundTask?(input: {
    sourceSessionId: string;
    description: string;
    task: string;
    contextMode?: "isolated" | "group";
  }): Promise<{
    accepted: boolean;
    taskRunId: string;
  }>;
  suppressBackgroundTaskCompletionNotice?(input: { taskRunId: string }): void;
}

export interface ToolExecutionApprovalState {
  runtimeModeAutoApproval?: {
    source: "yolo" | "autopilot";
  };
  bashFullAccess?: {
    approved: true;
    mode: "one_shot";
    approvalId: number;
  };
  ephemeralPermissionScopes?: PermissionScope[];
}

export interface ToolDefinition<TArgs = unknown, TDetails = unknown> {
  name: string;
  description: string;
  inputSchema?: TSchema;
  getInvocationTimeoutMs?(context: ToolExecutionContext, args: TArgs): number;
  getResultMaxChars?(context: ToolExecutionContext, args: TArgs): number;
  execute(
    context: ToolExecutionContext,
    args: TArgs,
  ): Promise<ToolResult<TDetails>> | ToolResult<TDetails>;
}

export interface ToolArgumentValidationIssue {
  path: string;
  message: string;
  value?: unknown;
}

export class ToolArgumentValidationError extends Error {
  readonly issues: ToolArgumentValidationIssue[];
  readonly allowedFields: string[];

  constructor(
    readonly toolName: string,
    readonly validationMessage: string,
    options: {
      issues?: ToolArgumentValidationIssue[];
      allowedFields?: string[];
    } = {},
  ) {
    super(`${toolName} args are invalid: ${validationMessage}`);
    this.name = "ToolArgumentValidationError";
    this.issues = options.issues ?? [];
    this.allowedFields = options.allowedFields ?? [];
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
  getInvocationTimeoutMs?: (context: ToolExecutionContext, args: Static<TInputSchema>) => number;
  getResultMaxChars?: (context: ToolExecutionContext, args: Static<TInputSchema>) => number;
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
    const issues = collectValidationIssues(schema, normalizedInput);
    const allowedFields = extractAllowedFields(schema);
    const message = renderValidationMessage(issues, allowedFields);
    throw new ToolArgumentValidationError(toolName, message, {
      issues,
      allowedFields,
    });
  }

  return normalizedInput as Static<TInputSchema>;
}

function collectValidationIssues(
  schema: TSchema,
  normalizedInput: unknown,
): ToolArgumentValidationIssue[] {
  const rawIssues = [...Errors(schema, normalizedInput)].map((issue) => ({
    path: issue.path,
    message: issue.message,
    ...(issue.value === undefined ? {} : { value: issue.value }),
  }));

  const requiredPropertyPaths = new Set(
    rawIssues
      .filter((issue) => issue.message === "Expected required property")
      .map((issue) => issue.path),
  );

  const deduped: ToolArgumentValidationIssue[] = [];
  const seen = new Set<string>();
  for (const issue of rawIssues) {
    if (issue.message === "Expected string" && requiredPropertyPaths.has(issue.path)) {
      continue;
    }

    const key = `${issue.path}\u0000${issue.message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(issue);
  }

  return deduped.slice(0, 5);
}

function extractAllowedFields(schema: TSchema): string[] {
  const raw = schema as { properties?: Record<string, unknown> };
  return raw.properties == null ? [] : Object.keys(raw.properties);
}

function renderValidationMessage(
  issues: ToolArgumentValidationIssue[],
  allowedFields: string[],
): string {
  const lines: string[] = [];
  if (issues.length > 0) {
    lines.push("Fix the following argument issues:");
    for (const issue of issues) {
      lines.push(`- ${renderIssuePath(issue.path)}: ${issue.message}.`);
    }
  } else {
    lines.push("Input does not match the declared schema.");
  }

  if (allowedFields.length > 0) {
    lines.push(`Allowed fields: ${allowedFields.join(", ")}.`);
  }

  return lines.join(" ");
}

function renderIssuePath(path: string): string {
  if (path.length === 0 || path === "/") {
    return "(root)";
  }

  return path;
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
