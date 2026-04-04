const LARK_CARD_TRUNCATION_NOTICE = "\n...[truncated]";

export interface LarkCardValueTruncationOptions {
  maxChars: number;
  maxLines: number;
}

const DEFAULT_VALUE_TRUNCATION: LarkCardValueTruncationOptions = {
  maxChars: 220,
  maxLines: 6,
};

export function truncateLarkCardString(
  value: string,
  options: Partial<LarkCardValueTruncationOptions> = {},
): string {
  const resolved: LarkCardValueTruncationOptions = {
    ...DEFAULT_VALUE_TRUNCATION,
    ...options,
  };

  const normalized = value.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const lineLimited = lines.slice(0, Math.max(1, resolved.maxLines));
  let truncated = lineLimited.join("\n");
  const lineOverflow = lines.length > resolved.maxLines;

  if (truncated.length > resolved.maxChars) {
    truncated = truncated.slice(0, Math.max(0, resolved.maxChars));
  }

  const charOverflow = truncated.length < normalized.length;
  if (!lineOverflow && !charOverflow) {
    return normalized;
  }

  return `${truncated}${LARK_CARD_TRUNCATION_NOTICE}`;
}

export function truncateLarkCardValueDeep(
  value: unknown,
  options: Partial<LarkCardValueTruncationOptions> = {},
): unknown {
  const resolved: LarkCardValueTruncationOptions = {
    ...DEFAULT_VALUE_TRUNCATION,
    ...options,
  };

  return truncateValue(value, resolved);
}

export function capLarkCardReasoningTail(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `...\n${value.slice(-maxChars)}`;
}

function truncateValue(value: unknown, options: LarkCardValueTruncationOptions): unknown {
  if (typeof value === "string") {
    return truncateLarkCardString(value, options);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => truncateValue(entry, options));
  }

  if (value == null || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.entries(record).map(([key, entry]) => [
    key,
    truncateValue(entry, options),
  ]);
  return Object.fromEntries(entries);
}
