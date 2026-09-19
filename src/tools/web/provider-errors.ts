export type WebProviderFailureCode =
  | "aborted"
  | "authentication"
  | "quota_exhausted"
  | "rate_limited"
  | "invalid_request"
  | "not_found"
  | "timeout"
  | "transport"
  | "upstream_error"
  | "invalid_response";

export interface WebProviderFailure {
  code: WebProviderFailureCode;
  message: string;
  retryable: boolean;
  statusCode?: number;
  retryAfterMs?: number;
}

export class WebProviderError extends Error {
  readonly code: WebProviderFailureCode;
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly retryAfterMs?: number;

  constructor(input: {
    code: WebProviderFailureCode;
    message: string;
    retryable: boolean;
    statusCode?: number;
    retryAfterMs?: number;
  }) {
    super(input.message);
    this.name = "WebProviderError";
    this.code = input.code;
    this.retryable = input.retryable;
    if (input.statusCode != null) {
      this.statusCode = input.statusCode;
    }
    if (input.retryAfterMs != null) {
      this.retryAfterMs = input.retryAfterMs;
    }
  }
}

export function normalizeWebProviderFailure(error: unknown): WebProviderFailure {
  if (error instanceof WebProviderError) {
    return {
      code: error.code,
      message: sanitizeProviderErrorMessage(error.message),
      retryable: error.retryable,
      ...(error.statusCode == null ? {} : { statusCode: error.statusCode }),
      ...(error.retryAfterMs == null ? {} : { retryAfterMs: error.retryAfterMs }),
    };
  }

  if (isAbortError(error)) {
    return {
      code: "aborted",
      message: "Provider request was aborted.",
      retryable: false,
    };
  }

  const statusCode = readStatusCode(error);
  const message = sanitizeProviderErrorMessage(getErrorMessage(error));
  if (statusCode != null) {
    const retryAfterMs = readRetryAfterMs(error);
    return failureFromStatus(statusCode, message, retryAfterMs);
  }

  const code = readErrorCode(error);
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") {
    return { code: "timeout", message, retryable: true };
  }
  if (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ENETUNREACH" ||
    code === "EAI_AGAIN"
  ) {
    return { code: "transport", message, retryable: true };
  }

  const classifiedMessage = failureFromMessage(message);
  if (classifiedMessage != null) {
    return classifiedMessage;
  }

  return { code: "upstream_error", message, retryable: true };
}

export function createHttpProviderError(
  statusCode: number,
  message: string,
  headers?: Headers,
): WebProviderError {
  const retryAfterMs = parseRetryAfterMs(headers?.get("retry-after"));
  const failure = failureFromStatus(statusCode, message, retryAfterMs);
  return new WebProviderError({ ...failure, statusCode });
}

function failureFromStatus(
  statusCode: number,
  message: string,
  retryAfterMs?: number,
): WebProviderFailure {
  if (statusCode === 401 || statusCode === 403) {
    return { code: "authentication", message, retryable: false, statusCode };
  }
  if (statusCode === 402) {
    return { code: "quota_exhausted", message, retryable: false, statusCode };
  }
  if (statusCode === 404) {
    return { code: "not_found", message, retryable: false, statusCode };
  }
  if (statusCode === 408 || statusCode === 504) {
    return { code: "timeout", message, retryable: true, statusCode };
  }
  if (statusCode === 429) {
    const resolvedRetryAfterMs = retryAfterMs ?? parseRetryAfterMessageMs(message);
    return {
      code: "rate_limited",
      message,
      retryable: true,
      statusCode,
      ...(resolvedRetryAfterMs == null ? {} : { retryAfterMs: resolvedRetryAfterMs }),
    };
  }
  if (statusCode >= 500) {
    return { code: "upstream_error", message, retryable: true, statusCode };
  }
  return { code: "invalid_request", message, retryable: false, statusCode };
}

function failureFromMessage(message: string): WebProviderFailure | null {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("invalid api key") ||
    normalized.includes("missing api key") ||
    normalized.includes("invalid credential")
  ) {
    return { code: "authentication", message, retryable: false };
  }
  if (
    normalized.includes("payment required") ||
    normalized.includes("insufficient credit") ||
    normalized.includes("quota exceeded") ||
    normalized.includes("out of credits") ||
    normalized.includes("exceeds your plan's set usage limit") ||
    normalized.includes("usage limit has been reached")
  ) {
    return { code: "quota_exhausted", message, retryable: false };
  }
  if (normalized.includes("rate limit") || normalized.includes("too many requests")) {
    const retryAfterMs = parseRetryAfterMessageMs(message);
    return {
      code: "rate_limited",
      message,
      retryable: true,
      ...(retryAfterMs == null ? {} : { retryAfterMs }),
    };
  }
  if (normalized.includes("timed out") || normalized.includes("timeout")) {
    return { code: "timeout", message, retryable: true };
  }
  return null;
}

export function parseRetryAfterMs(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }

  const seconds = Number(normalized);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }

  const retryAt = Date.parse(normalized);
  if (Number.isNaN(retryAt)) {
    return undefined;
  }
  return Math.max(0, retryAt - now);
}

function parseRetryAfterMessageMs(message: string, now = Date.now()): number | undefined {
  const secondsMatch = /retry after\s+(\d+(?:\.\d+)?)s\b/iu.exec(message);
  if (secondsMatch?.[1] != null) {
    const seconds = Number(secondsMatch[1]);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.ceil(seconds * 1_000);
    }
  }

  const resetMatch = /resets at\s+(.+?)(?:\s+\(|$)/iu.exec(message);
  const retryAt = resetMatch?.[1] == null ? Number.NaN : Date.parse(resetMatch[1]);
  return Number.isNaN(retryAt) ? undefined : Math.max(0, retryAt - now);
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function readStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error == null) {
    return undefined;
  }

  for (const key of ["status", "statusCode"] as const) {
    const value = Reflect.get(error, key);
    if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) {
      return value;
    }
  }
  return undefined;
}

function readRetryAfterMs(error: unknown): number | undefined {
  if (typeof error !== "object" || error == null) {
    return undefined;
  }
  const headers = Reflect.get(error, "headers");
  if (headers instanceof Headers) {
    return parseRetryAfterMs(headers.get("retry-after"));
  }
  if (typeof headers !== "object" || headers == null) {
    return undefined;
  }
  const value = Reflect.get(headers, "retry-after") ?? Reflect.get(headers, "Retry-After");
  return typeof value === "string" ? parseRetryAfterMs(value) : undefined;
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error == null) {
    return undefined;
  }
  const value = Reflect.get(error, "code");
  return typeof value === "string" ? value.toUpperCase() : undefined;
}

function getErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().length === 0 ? "Unknown provider failure." : message;
}

function sanitizeProviderErrorMessage(message: string): string {
  return message
    .replace(
      /((?:api[\s_-]?key|authorization)["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^"'\s,}]+/giu,
      "$1<redacted>",
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer <redacted>")
    .slice(0, 500);
}
