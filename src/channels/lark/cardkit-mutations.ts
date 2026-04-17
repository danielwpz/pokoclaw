export interface LarkCardOperationResponse {
  code?: number;
  msg?: string;
  data?: Record<string, unknown>;
}

export interface LarkCardCreateResponse extends LarkCardOperationResponse {
  data?: {
    card_id?: string;
  };
  card_id?: string;
}

export type LarkSequencedCardMutationOperation = "card.update" | "cardElement.content";

export type LarkSequencedCardMutationOutcome<T extends LarkCardOperationResponse> =
  | {
      kind: "applied";
      response: T;
    }
  | {
      kind: "reconcile";
      nextSequenceFloor: number;
      reason: "ambiguous_transport_failure" | "sequence_compare_failed";
    };

export interface LarkCardkitLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const LARK_CARD_LOG_PREVIEW_MAX_LENGTH = 600;
const LARK_CARDKIT_NONZERO_CODE_RETRY_LIMIT = 1;
const LARK_CARDKIT_SEQUENCE_COMPARE_FAILED_CODE = 300317;
const LARK_CARDKIT_SEQUENCE_FLOOR_METADATA_KEY = "cardkitSequenceFloor";

export function parseBindingMetadata(raw: string | null): Record<string, unknown> {
  if (raw == null || raw.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed != null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {}
  return {};
}

export function readPositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

export function buildBindingMetadata(
  base: Record<string, unknown>,
  existingRaw: string | null | undefined,
): string {
  const existing = parseBindingMetadata(existingRaw ?? null);
  const sequenceFloor = readPositiveInteger(existing[LARK_CARDKIT_SEQUENCE_FLOOR_METADATA_KEY]);
  return JSON.stringify({
    ...(sequenceFloor == null
      ? {}
      : {
          [LARK_CARDKIT_SEQUENCE_FLOOR_METADATA_KEY]: sequenceFloor,
        }),
    ...base,
  });
}

export function setCardkitSequenceFloorInMetadata(
  raw: string | null | undefined,
  floor: number,
): string {
  const metadata = parseBindingMetadata(raw ?? null);
  const existingFloor =
    readPositiveInteger(metadata[LARK_CARDKIT_SEQUENCE_FLOOR_METADATA_KEY]) ?? 0;
  return JSON.stringify({
    ...metadata,
    [LARK_CARDKIT_SEQUENCE_FLOOR_METADATA_KEY]: Math.max(existingFloor, floor),
  });
}

export function getNextCardkitSequence(binding: {
  lastSequence?: number | null;
  metadataJson?: string | null;
}): number {
  const lastSequence = binding.lastSequence ?? 0;
  const metadata = parseBindingMetadata(binding.metadataJson ?? null);
  const floor = readPositiveInteger(metadata[LARK_CARDKIT_SEQUENCE_FLOOR_METADATA_KEY]) ?? 1;
  return Math.max(lastSequence + 1, floor);
}

export function readLarkHttpStatus(error: unknown): number | null {
  if (typeof error !== "object" || error == null) {
    return null;
  }
  const response = (error as { response?: { status?: unknown } }).response;
  if (response == null || typeof response !== "object") {
    return null;
  }
  return typeof response.status === "number" ? response.status : null;
}

export function isAmbiguousLarkCardkitTransportError(error: unknown): boolean {
  const status = readLarkHttpStatus(error);
  if (status != null) {
    return status >= 500 && status < 600;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /socket hang up|ETIMEDOUT|ECONNRESET|timed out|timeout|disconnected before secure TLS connection/i.test(
    message,
  );
}

export async function invokeLarkCardkitCallWithBusinessRetry<
  T extends LarkCardOperationResponse,
>(input: {
  logger: LarkCardkitLogger;
  operation: "card.create" | "card.update" | "cardElement.content";
  logContext: Record<string, unknown>;
  invoke: () => Promise<T>;
}): Promise<T> {
  let attempt = 0;
  while (true) {
    const response = await input.invoke();
    const code = response.code;
    if (code == null || code === 0) {
      return response;
    }

    const responsePreview = truncateLogText(safeJson(response), LARK_CARD_LOG_PREVIEW_MAX_LENGTH);
    if (attempt < LARK_CARDKIT_NONZERO_CODE_RETRY_LIMIT) {
      input.logger.warn("lark cardkit call returned non-zero code; retrying once", {
        operation: input.operation,
        attempt: attempt + 1,
        retryLimit: LARK_CARDKIT_NONZERO_CODE_RETRY_LIMIT,
        code,
        msg: response.msg ?? null,
        responsePreview,
        ...input.logContext,
      });
      attempt += 1;
      continue;
    }

    input.logger.error(
      "lark cardkit call kept non-zero code after retry; continuing with current logic",
      {
        operation: input.operation,
        attempt: attempt + 1,
        retryLimit: LARK_CARDKIT_NONZERO_CODE_RETRY_LIMIT,
        code,
        msg: response.msg ?? null,
        responsePreview,
        ...input.logContext,
      },
    );
    return response;
  }
}

export async function invokeSequencedLarkCardkitMutation<
  T extends LarkCardOperationResponse,
>(input: {
  logger: LarkCardkitLogger;
  operation: LarkSequencedCardMutationOperation;
  logContext: Record<string, unknown>;
  sequence: number;
  invoke: () => Promise<T>;
}): Promise<LarkSequencedCardMutationOutcome<T>> {
  try {
    const response = await input.invoke();
    const code = response.code;
    if (code == null || code === 0) {
      return {
        kind: "applied",
        response,
      };
    }

    const responsePreview = truncateLogText(safeJson(response), LARK_CARD_LOG_PREVIEW_MAX_LENGTH);
    if (code === LARK_CARDKIT_SEQUENCE_COMPARE_FAILED_CODE) {
      input.logger.warn("lark cardkit call reported sequence mismatch; scheduling reconcile", {
        operation: input.operation,
        ...input.logContext,
        code,
        msg: response.msg ?? null,
        responsePreview,
        sequence: input.sequence,
        nextSequenceFloor: input.sequence + 1,
      });
      return {
        kind: "reconcile",
        nextSequenceFloor: input.sequence + 1,
        reason: "sequence_compare_failed",
      };
    }

    const attempt = 0;
    while (attempt < LARK_CARDKIT_NONZERO_CODE_RETRY_LIMIT) {
      input.logger.warn("lark cardkit call returned non-zero code; retrying once", {
        operation: input.operation,
        ...input.logContext,
        attempt: attempt + 1,
        retryLimit: LARK_CARDKIT_NONZERO_CODE_RETRY_LIMIT,
        code,
        msg: response.msg ?? null,
        responsePreview,
        sequence: input.sequence,
      });
      const retryResponse = await input.invoke();
      const retryCode = retryResponse.code;
      if (retryCode == null || retryCode === 0) {
        return {
          kind: "applied",
          response: retryResponse,
        };
      }
      const retryPreview = truncateLogText(
        safeJson(retryResponse),
        LARK_CARD_LOG_PREVIEW_MAX_LENGTH,
      );
      if (retryCode === LARK_CARDKIT_SEQUENCE_COMPARE_FAILED_CODE) {
        input.logger.warn("lark cardkit retry reported sequence mismatch; scheduling reconcile", {
          operation: input.operation,
          ...input.logContext,
          attempt: attempt + 2,
          retryLimit: LARK_CARDKIT_NONZERO_CODE_RETRY_LIMIT,
          code: retryCode,
          msg: retryResponse.msg ?? null,
          responsePreview: retryPreview,
          sequence: input.sequence,
          nextSequenceFloor: input.sequence + 1,
        });
        return {
          kind: "reconcile",
          nextSequenceFloor: input.sequence + 1,
          reason: "sequence_compare_failed",
        };
      }

      input.logger.error(
        "lark cardkit call kept non-zero code after retry; continuing with current logic",
        {
          operation: input.operation,
          ...input.logContext,
          attempt: attempt + 2,
          retryLimit: LARK_CARDKIT_NONZERO_CODE_RETRY_LIMIT,
          code: retryCode,
          msg: retryResponse.msg ?? null,
          responsePreview: retryPreview,
          sequence: input.sequence,
        },
      );
      // Intentionally keep sequenced card mutations best-effort for explicit
      // business-code failures other than sequence mismatch. We only schedule
      // reconcile when remote state is ambiguous (transport failure) or when
      // Lark explicitly reports sequence compare failure (300317). Other
      // non-zero codes are treated as non-blocking so outbound delivery can
      // keep progressing, while logs preserve the failure for observation.
      return {
        kind: "applied",
        response: retryResponse,
      };
    }

    return {
      kind: "applied",
      response,
    };
  } catch (error) {
    if (!isAmbiguousLarkCardkitTransportError(error)) {
      throw error;
    }

    input.logger.warn("lark cardkit call failed ambiguously; scheduling reconcile", {
      operation: input.operation,
      ...input.logContext,
      sequence: input.sequence,
      nextSequenceFloor: input.sequence + 1,
      error: error instanceof Error ? error.message : String(error),
      httpStatus: readLarkHttpStatus(error),
    });
    return {
      kind: "reconcile",
      nextSequenceFloor: input.sequence + 1,
      reason: "ambiguous_transport_failure",
    };
  }
}

function truncateLogText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
