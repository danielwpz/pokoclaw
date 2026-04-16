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
  rawDetails?: AgentLlmRawErrorPayload;
}

const AGENT_LLM_RAW_ERROR_PAYLOAD_FORMAT = "pokoclaw.agent-llm-error.v1";

export interface AgentLlmRawErrorPayload {
  format: typeof AGENT_LLM_RAW_ERROR_PAYLOAD_FORMAT;
  message: string;
  rawMessage: string;
  serializedError?: string;
  errorName?: string;
  status?: number;
  statusCode?: number;
  responseStatus?: number;
  code?: string;
  responseErrorMessage?: string;
  causeName?: string;
  causeMessage?: string;
}

export class AgentLlmError extends Error {
  readonly kind: AgentLlmErrorKind;
  readonly retryable: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly rawMessage?: string;
  readonly rawDetails?: AgentLlmRawErrorPayload;

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
    if (shape.rawDetails !== undefined) {
      this.rawDetails = shape.rawDetails;
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

  const rawDetails = readAgentLlmRawErrorPayload(input.error);
  const rawMessage = rawDetails?.rawMessage ?? getErrorMessage(input.error);
  const message =
    rawDetails?.message ?? (rawMessage.trim().length > 0 ? rawMessage : "Unknown upstream error");
  const httpStatus = getHttpStatusCode(input.error, rawMessage);
  const shape = classifyAgentLlmError({
    message,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
  });

  return new AgentLlmError({
    ...shape,
    rawMessage,
    ...(rawDetails == null ? {} : { rawDetails }),
  });
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
  const rawPayload = readAgentLlmRawErrorPayload(error);
  if (rawPayload != null) {
    return rawPayload.rawMessage;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : String(error);
}

function getHttpStatusCode(error: unknown, message: string): number | undefined {
  const rawPayload = readAgentLlmRawErrorPayload(error);
  if (rawPayload != null) {
    return rawPayload.status ?? rawPayload.statusCode ?? rawPayload.responseStatus;
  }

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

function readStringField(value: unknown, path: string[]): string | undefined {
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

  return typeof current === "string" && current.trim().length > 0 ? current : undefined;
}

function appendUniqueMessage(messages: string[], candidate: string | undefined): void {
  if (candidate == null) {
    return;
  }

  const normalized = candidate.trim();
  if (normalized.length === 0) {
    return;
  }

  for (let index = 0; index < messages.length; index += 1) {
    const existing = messages[index];
    if (existing == null) {
      continue;
    }
    if (existing === normalized || existing.includes(normalized)) {
      return;
    }
    if (normalized.includes(existing)) {
      messages[index] = normalized;
      return;
    }
  }

  messages.push(normalized);
}

function collectRawErrorMessages(error: unknown): string[] {
  const messages: string[] = [];
  appendUniqueMessage(messages, readStringField(error, ["message"]));
  appendUniqueMessage(messages, readStringField(error, ["response", "error", "message"]));
  appendUniqueMessage(messages, readStringField(error, ["response", "data", "error", "message"]));
  appendUniqueMessage(messages, readStringField(error, ["response", "data", "message"]));
  appendUniqueMessage(messages, readStringField(error, ["response", "body", "error", "message"]));
  appendUniqueMessage(messages, readStringField(error, ["error", "message"]));
  appendUniqueMessage(messages, readStringField(error, ["cause", "message"]));

  if (messages.length === 0 && typeof error === "string" && error.trim().length > 0) {
    messages.push(error.trim());
  }

  return messages;
}

export function buildAgentLlmRawErrorPayload(error: unknown): AgentLlmRawErrorPayload {
  const messages = collectRawErrorMessages(error);
  const primaryMessage = messages[0] ?? getErrorMessage(error);
  const rawMessage = messages.length > 0 ? messages.join(" | ") : primaryMessage;
  const serializedError = serializeUnknownError(error);
  const errorName = readStringField(error, ["name"]);
  const status = readNumericField(error, ["status"]);
  const statusCode = readNumericField(error, ["statusCode"]);
  const responseStatus = readNumericField(error, ["response", "status"]);
  const code = readStringField(error, ["code"]) ?? readStringField(error, ["cause", "code"]);
  const responseErrorMessage = readStringField(error, ["response", "error", "message"]);
  const causeName = readStringField(error, ["cause", "name"]);
  const causeMessage = readStringField(error, ["cause", "message"]);

  const payload: AgentLlmRawErrorPayload = {
    format: AGENT_LLM_RAW_ERROR_PAYLOAD_FORMAT,
    message: primaryMessage,
    rawMessage,
  };
  if (serializedError != null) {
    payload.serializedError = JSON.stringify(serializedError);
  }
  if (errorName !== undefined) {
    payload.errorName = errorName;
  }
  if (status !== undefined) {
    payload.status = status;
  }
  if (statusCode !== undefined) {
    payload.statusCode = statusCode;
  }
  if (responseStatus !== undefined) {
    payload.responseStatus = responseStatus;
  }
  if (code !== undefined) {
    payload.code = code;
  }
  if (responseErrorMessage !== undefined) {
    payload.responseErrorMessage = responseErrorMessage;
  }
  if (causeName !== undefined) {
    payload.causeName = causeName;
  }
  if (causeMessage !== undefined) {
    payload.causeMessage = causeMessage;
  }

  return payload;
}

export function readAgentLlmRawErrorPayload(error: unknown): AgentLlmRawErrorPayload | null {
  if (error == null || typeof error !== "object") {
    return null;
  }

  const maybePayload = error as Partial<AgentLlmRawErrorPayload>;
  if (
    maybePayload.format !== AGENT_LLM_RAW_ERROR_PAYLOAD_FORMAT ||
    typeof maybePayload.message !== "string" ||
    typeof maybePayload.rawMessage !== "string"
  ) {
    return null;
  }

  return maybePayload as AgentLlmRawErrorPayload;
}

function serializeUnknownError(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth: number = 0,
): unknown {
  if (
    value == null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (depth >= 6) {
    return "[MaxDepth]";
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeUnknownError(item, seen, depth + 1));
  }

  if (typeof value !== "object") {
    return String(value);
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (value instanceof Error) {
    const serialized: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
    for (const key of Object.getOwnPropertyNames(value)) {
      if (key === "name" || key === "message" || key === "stack") {
        continue;
      }
      serialized[key] = serializeUnknownError(
        (value as unknown as Record<string, unknown>)[key],
        seen,
        depth + 1,
      );
    }
    return serialized;
  }

  const serialized: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    serialized[key] = serializeUnknownError(nested, seen, depth + 1);
  }
  return serialized;
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
