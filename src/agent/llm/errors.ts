/**
 * Normalized LLM error taxonomy.
 *
 * Maps heterogeneous upstream/provider failures into stable runtime error kinds
 * used by AgentLoop, orchestration, and channel observability paths.
 */
export type AgentLlmErrorKind =
  | "aborted"
  | "context_overflow"
  | "auth"
  | "billing"
  | "rate_limit"
  | "overloaded"
  | "timeout"
  | "upstream";

export interface AgentLlmErrorShape {
  kind: AgentLlmErrorKind;
  message: string;
  retryable: boolean;
  provider?: string;
  model?: string;
  rawMessage?: string;
}

export class AgentLlmError extends Error {
  readonly kind: AgentLlmErrorKind;
  readonly retryable: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly rawMessage?: string;

  constructor(shape: AgentLlmErrorShape) {
    super(shape.message);
    this.name = "AgentLlmError";
    this.kind = shape.kind;
    this.retryable = shape.retryable;
    if (shape.provider !== undefined) {
      this.provider = shape.provider;
    }
    if (shape.model !== undefined) {
      this.model = shape.model;
    }
    if (shape.rawMessage !== undefined) {
      this.rawMessage = shape.rawMessage;
    }
  }
}

export interface NormalizeAgentLlmErrorInput {
  error: unknown;
  provider?: string;
  model?: string;
}

export function normalizeAgentLlmError(input: NormalizeAgentLlmErrorInput): AgentLlmError {
  if (input.error instanceof AgentLlmError) {
    return input.error;
  }

  const rawMessage = getErrorMessage(input.error);
  const message = rawMessage.trim().length > 0 ? rawMessage : "Unknown upstream error";
  const httpStatus = getHttpStatusCode(input.error, message);
  const shape = classifyAgentLlmError({
    message,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
  });

  return new AgentLlmError(shape);
}

export function isAgentLlmError(error: unknown): error is AgentLlmError {
  return error instanceof AgentLlmError;
}

function classifyAgentLlmError(input: {
  httpStatus?: number;
  message: string;
  provider?: string;
  model?: string;
}): AgentLlmErrorShape {
  const { httpStatus, message, provider, model } = input;

  if (isAbortedMessage(message)) {
    return {
      kind: "aborted",
      message,
      retryable: false,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      rawMessage: message,
    };
  }

  if (isContextOverflowMessage(message)) {
    return {
      kind: "context_overflow",
      message,
      retryable: false,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      rawMessage: message,
    };
  }

  if (httpStatus !== undefined) {
    const statusShape = classifyAgentLlmErrorByStatus({
      httpStatus,
      message,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
    });
    if (statusShape != null) {
      return statusShape;
    }
  }

  if (isAuthMessage(message)) {
    return {
      kind: "auth",
      message,
      retryable: false,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      rawMessage: message,
    };
  }

  if (isBillingMessage(message)) {
    return {
      kind: "billing",
      message,
      retryable: false,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      rawMessage: message,
    };
  }

  if (isRateLimitMessage(message)) {
    return {
      kind: "rate_limit",
      message,
      retryable: true,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      rawMessage: message,
    };
  }

  if (isOverloadedMessage(message)) {
    return {
      kind: "overloaded",
      message,
      retryable: true,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      rawMessage: message,
    };
  }

  if (isTimeoutMessage(message)) {
    return {
      kind: "timeout",
      message,
      retryable: true,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      rawMessage: message,
    };
  }

  if (isNonRetryableUpstreamMessage(message)) {
    return {
      kind: "upstream",
      message,
      retryable: false,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      rawMessage: message,
    };
  }

  return {
    kind: "upstream",
    message,
    retryable: true,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    rawMessage: message,
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : String(error);
}

function getHttpStatusCode(error: unknown, message: string): number | undefined {
  const structuredStatus =
    readNumericField(error, ["status"]) ??
    readNumericField(error, ["statusCode"]) ??
    readNumericField(error, ["response", "status"]) ??
    readNumericField(error, ["response", "statusCode"]) ??
    readNumericField(error, ["cause", "status"]) ??
    readNumericField(error, ["cause", "statusCode"]) ??
    readNumericField(error, ["error", "status"]) ??
    readNumericField(error, ["error", "statusCode"]);

  if (structuredStatus !== undefined) {
    return structuredStatus;
  }

  return parseHttpStatusCodeFromMessage(message);
}

function classifyAgentLlmErrorByStatus(input: {
  httpStatus: number;
  message: string;
  provider?: string;
  model?: string;
}): AgentLlmErrorShape | null {
  const { httpStatus, message, provider, model } = input;
  const baseShape = {
    message,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    rawMessage: message,
  };

  if (httpStatus === 401) {
    return {
      kind: "auth",
      retryable: false,
      ...baseShape,
    };
  }

  if (httpStatus === 402) {
    return {
      kind: "billing",
      retryable: false,
      ...baseShape,
    };
  }

  if (httpStatus === 403) {
    if (isBillingMessage(message)) {
      return {
        kind: "billing",
        retryable: false,
        ...baseShape,
      };
    }

    if (isAuthMessage(message)) {
      return {
        kind: "auth",
        retryable: false,
        ...baseShape,
      };
    }

    return {
      kind: "upstream",
      retryable: false,
      ...baseShape,
    };
  }

  if (httpStatus === 404) {
    return {
      kind: "upstream",
      retryable: false,
      ...baseShape,
    };
  }

  if (httpStatus === 408) {
    return {
      kind: "timeout",
      retryable: true,
      ...baseShape,
    };
  }

  if (httpStatus === 413) {
    return {
      kind: "context_overflow",
      retryable: false,
      ...baseShape,
    };
  }

  if (httpStatus === 429) {
    return {
      kind: "rate_limit",
      retryable: true,
      ...baseShape,
    };
  }

  if (httpStatus >= 500 && httpStatus <= 599) {
    if (httpStatus === 504) {
      return {
        kind: "timeout",
        retryable: true,
        ...baseShape,
      };
    }

    return {
      kind: "overloaded",
      retryable: true,
      ...baseShape,
    };
  }

  if (httpStatus >= 400 && httpStatus <= 499) {
    return {
      kind: "upstream",
      retryable: false,
      ...baseShape,
    };
  }

  return null;
}

function readNumericField(value: unknown, path: string[]): number | undefined {
  if (value == null || typeof value !== "object") {
    return undefined;
  }

  let current: unknown = value;
  for (const key of path) {
    if (current == null || typeof current !== "object" || !(key in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return typeof current === "number" && Number.isInteger(current) ? current : undefined;
}

function parseHttpStatusCodeFromMessage(message: string): number | undefined {
  const match =
    message.match(/\bstatus\s*[=:]?\s*(\d{3})\b/i) ??
    message.match(/\bapi error\s*\((\d{3})\)/i) ??
    message.match(/\bhttp(?:\s+request)?(?:\s+failed)?[^\d]{0,24}(\d{3})\b/i) ??
    message.match(/^(\d{3})\b/);

  if (!match) {
    return undefined;
  }

  const capturedStatus = match[1];
  if (capturedStatus === undefined) {
    return undefined;
  }

  const status = Number.parseInt(capturedStatus, 10);
  return Number.isNaN(status) ? undefined : status;
}

function isAbortedMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("abort") ||
    lower.includes("cancelled") ||
    lower.includes("canceled") ||
    lower.includes("stop requested")
  );
}

function isContextOverflowMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("prompt is too long") ||
    lower.includes("exceeds the context window") ||
    lower.includes("context window exceeded") ||
    lower.includes("context window exceeds limit") ||
    (lower.includes("input token count") && lower.includes("exceeds the maximum")) ||
    lower.includes("maximum prompt length") ||
    lower.includes("maximum context length") ||
    lower.includes("context length exceeded") ||
    lower.includes("context_window_exceeded") ||
    lower.includes("request_too_large") ||
    lower.includes("too many tokens") ||
    lower.includes("token limit exceeded") ||
    lower.includes("exceeded model token limit") ||
    message.includes("上下文过长") ||
    message.includes("上下文超出") ||
    message.includes("超出最大上下文")
  );
}

function isAuthMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("unauthorized") ||
    lower.includes("authentication") ||
    lower.includes("invalid api key") ||
    (lower.includes("api key") && lower.includes("invalid")) ||
    lower.includes("forbidden") ||
    lower.includes("permission denied")
  );
}

function isBillingMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("insufficient credits") ||
    lower.includes("insufficient quota") ||
    lower.includes("insufficient balance") ||
    lower.includes("billing") ||
    lower.includes("payment required") ||
    lower.includes("credit balance")
  );
}

function isRateLimitMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("429") ||
    lower.includes("tokens per minute") ||
    lower.includes("requests per minute")
  );
}

function isOverloadedMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("overloaded") ||
    lower.includes("overload") ||
    lower.includes("service unavailable") ||
    lower.includes("server is busy")
  );
}

function isTimeoutMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("timeout") || lower.includes("timed out");
}

function isNonRetryableUpstreamMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("not available in your region") ||
    lower.includes("not available in your country") ||
    lower.includes("unsupported region") ||
    lower.includes("unsupported country") ||
    lower.includes("model is not available in your region") ||
    lower.includes("model is not available in your country")
  );
}
