import type { PermissionRequest } from "@/src/security/scope.js";
import type { ToolContentBlock } from "@/src/tools/types.js";

export type ToolFailureKind =
  // A tool-declared, recoverable failure that should be returned to the model
  // as an error tool_result so it can decide what to do next.
  | "recoverable_error"
  // Anything the tool did not classify explicitly. This represents a runtime
  // or implementation problem and should be treated as non-recoverable.
  | "internal_error";

export interface ToolFailureShape {
  kind: ToolFailureKind;
  message: string;
  details?: unknown;
  rawMessage?: string;
}

export interface ToolApprovalRequiredShape {
  request: PermissionRequest;
  reasonText: string;
}

export class ToolFailure extends Error {
  readonly kind: ToolFailureKind;
  readonly details?: unknown;
  readonly rawMessage?: string;

  constructor(shape: ToolFailureShape) {
    super(shape.message);
    this.name = "ToolFailure";
    this.kind = shape.kind;
    if (shape.details !== undefined) {
      this.details = shape.details;
    }
    if (shape.rawMessage !== undefined) {
      this.rawMessage = shape.rawMessage;
    }
  }

  get retryable(): boolean {
    return false;
  }

  get shouldReturnToLlm(): boolean {
    return this.kind === "recoverable_error";
  }
}

export class ToolApprovalRequired extends Error {
  readonly request: PermissionRequest;
  readonly reasonText: string;

  constructor(shape: ToolApprovalRequiredShape) {
    super(shape.reasonText);
    this.name = "ToolApprovalRequired";
    this.request = shape.request;
    this.reasonText = shape.reasonText;
  }
}

// Recoverability must be declared by the tool itself. The runtime does not try
// to infer "this looks fixable" from generic error strings.
export function toolRecoverableError(message: string, details?: unknown): ToolFailure {
  return new ToolFailure({
    kind: "recoverable_error",
    message,
    ...(details !== undefined ? { details } : {}),
    rawMessage: message,
  });
}

export function toolApprovalRequired(shape: ToolApprovalRequiredShape): ToolApprovalRequired {
  return new ToolApprovalRequired(shape);
}

// Backwards-compatible alias while the tool layer is still being filled in.
export const toolExecutionError = toolRecoverableError;

export function toolInternalError(message: string, details?: unknown): ToolFailure {
  return new ToolFailure({
    kind: "internal_error",
    message,
    ...(details !== undefined ? { details } : {}),
    rawMessage: message,
  });
}

export function normalizeToolFailure(error: unknown): ToolFailure {
  if (error instanceof ToolFailure) {
    return error;
  }

  const rawMessage = getErrorMessage(error);
  const message = rawMessage.trim().length > 0 ? rawMessage : "Unknown tool execution failure";

  // TODO: permission / approval is intentionally not modeled as a tool error.
  // Once ../sandbox-runtime exposes a stable policy outcome, permission blocks
  // should be handled by a separate pause/resume approval flow above this layer.
  return toolInternalError("Tool execution failed due to an internal runtime error.", {
    rawMessage: message,
  });
}

export function buildToolFailureContent(failure: ToolFailure): ToolContentBlock[] {
  return [
    {
      type: "text",
      text: failure.message,
    },
  ];
}

export function isToolFailure(error: unknown): error is ToolFailure {
  return error instanceof ToolFailure;
}

export function isToolApprovalRequired(error: unknown): error is ToolApprovalRequired {
  return error instanceof ToolApprovalRequired;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : String(error);
}
