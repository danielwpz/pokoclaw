import type { PermissionRequest } from "@/src/security/scope.js";
import {
  ToolArgumentValidationError,
  type ToolContentBlock,
  type ToolExecutionApprovalState,
  ToolLookupError,
} from "@/src/tools/core/types.js";
import {
  isPermissionDeniedDetails,
  renderPermissionBlock,
} from "@/src/tools/helpers/permission-block.js";

export type ToolFailureKind =
  // A tool-declared, recoverable failure that should be returned to the model
  // as an error tool_result so it can decide what to do next.
  | "recoverable_error"
  // A tool/runtime problem that should still be surfaced back to the model so
  // the turn can continue with that failure visible in-context.
  | "internal_error"
  // A rare host/runtime invariant failure that should terminate the run.
  | "fatal_error";

export interface ToolFailureShape {
  kind: ToolFailureKind;
  message: string;
  details?: unknown;
  rawMessage?: string;
}

export interface ToolApprovalRequiredShape {
  request: PermissionRequest;
  reasonText: string;
  retryToolCallId?: string;
  approvalTitle?: string;
  grantOnApprove?: boolean;
  approvalState?: ToolExecutionApprovalState;
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
    return this.kind !== "fatal_error";
  }
}

export class ToolApprovalRequired extends Error {
  readonly request: PermissionRequest;
  readonly reasonText: string;
  readonly retryToolCallId?: string;
  readonly approvalTitle?: string;
  readonly grantOnApprove: boolean;
  readonly approvalState?: ToolExecutionApprovalState;

  constructor(shape: ToolApprovalRequiredShape) {
    super(shape.reasonText);
    this.name = "ToolApprovalRequired";
    this.request = shape.request;
    this.reasonText = shape.reasonText;
    this.grantOnApprove = shape.grantOnApprove ?? true;
    if (shape.retryToolCallId !== undefined) {
      this.retryToolCallId = shape.retryToolCallId;
    }
    if (shape.approvalTitle !== undefined) {
      this.approvalTitle = shape.approvalTitle;
    }
    if (shape.approvalState !== undefined) {
      this.approvalState = shape.approvalState;
    }
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

export const toolExecutionError = toolRecoverableError;

export function toolInternalError(message: string, details?: unknown): ToolFailure {
  return new ToolFailure({
    kind: "internal_error",
    message,
    ...(details !== undefined ? { details } : {}),
    rawMessage: message,
  });
}

export function toolFatalError(message: string, details?: unknown): ToolFailure {
  return new ToolFailure({
    kind: "fatal_error",
    message,
    ...(details !== undefined ? { details } : {}),
    rawMessage: message,
  });
}

export function normalizeToolFailure(error: unknown): ToolFailure {
  if (error instanceof ToolFailure) {
    return error;
  }

  if (error instanceof ToolArgumentValidationError) {
    return toolRecoverableError(error.message, {
      code: "invalid_tool_args",
      toolName: error.toolName,
      validationMessage: error.validationMessage,
      issues: error.issues,
      allowedFields: error.allowedFields,
    });
  }

  if (error instanceof ToolLookupError) {
    return toolRecoverableError(error.message, {
      code: "tool_not_found",
      toolName: error.toolName,
    });
  }

  const rawMessage = getErrorMessage(error);
  const message = rawMessage.trim().length > 0 ? rawMessage : "Unknown tool execution failure";

  return new ToolFailure({
    kind: "internal_error",
    message: "Tool execution failed due to an internal runtime error.",
    rawMessage: message,
    details: {
      rawMessage: message,
    },
  });
}

export function buildToolFailureContent(failure: ToolFailure): ToolContentBlock[] {
  if (isPermissionDeniedDetails(failure.details)) {
    return [
      {
        type: "text",
        text: renderPermissionBlock({
          requestable: failure.details.requestable,
          summary: failure.details.summary,
          entries: failure.details.entries,
          ...(failure.details.guidance == null ? {} : { guidance: failure.details.guidance }),
          ...(failure.details.failedToolCallId == null
            ? {}
            : { failedToolCallId: failure.details.failedToolCallId }),
          ...(failure.details.bashContext == null
            ? {}
            : { bashContext: failure.details.bashContext }),
        }),
      },
    ];
  }

  return [
    {
      type: "text",
      text:
        (failure.kind === "internal_error" || failure.kind === "fatal_error") &&
        failure.rawMessage != null
          ? `${failure.message}\n\nRaw error: ${failure.rawMessage}`
          : failure.message,
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
