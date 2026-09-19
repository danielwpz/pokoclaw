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
}

export class WebProviderError extends Error {
  readonly code: WebProviderFailureCode;
  readonly retryable: boolean;
  readonly statusCode?: number;

  constructor(input: {
    code: WebProviderFailureCode;
    message: string;
    retryable: boolean;
    statusCode?: number;
  }) {
    super(input.message);
    this.name = "WebProviderError";
    this.code = input.code;
    this.retryable = input.retryable;
    if (input.statusCode != null) {
      this.statusCode = input.statusCode;
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
    return failureFromStatus(statusCode, message);
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

export function createHttpProviderError(statusCode: number, message: string): WebProviderError {
  const failure = failureFromStatus(statusCode, message);
  return new WebProviderError({ ...failure, statusCode });
}

function failureFromStatus(statusCode: number, message: string): WebProviderFailure {
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
    return { code: "rate_limited", message, retryable: true, statusCode };
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
    normalized.includes("out of credits")
  ) {
    return { code: "quota_exhausted", message, retryable: false };
  }
  if (normalized.includes("rate limit") || normalized.includes("too many requests")) {
    return { code: "rate_limited", message, retryable: true };
  }
  if (normalized.includes("timed out") || normalized.includes("timeout")) {
    return { code: "timeout", message, retryable: true };
  }
  return null;
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
