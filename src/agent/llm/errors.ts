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
  const shape = classifyAgentLlmError({
    message,
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
  });

  return new AgentLlmError(shape);
}

export function isAgentLlmError(error: unknown): error is AgentLlmError {
  return error instanceof AgentLlmError;
}

function classifyAgentLlmError(input: {
  message: string;
  provider?: string;
  model?: string;
}): AgentLlmErrorShape {
  const { message, provider, model } = input;

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
    (lower.includes("input token count") && lower.includes("exceeds the maximum")) ||
    lower.includes("maximum prompt length") ||
    lower.includes("maximum context length") ||
    lower.includes("context length exceeded") ||
    lower.includes("context_window_exceeded") ||
    lower.includes("request_too_large") ||
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
