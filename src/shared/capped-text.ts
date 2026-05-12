export interface CappedTextTailOptions {
  maxChars: number;
  truncationPrefix?: string;
}

const DEFAULT_TRUNCATION_PREFIX = "...[truncated]\n";

export function appendCappedTextTail(
  existing: string,
  next: string,
  options: CappedTextTailOptions,
): string {
  if (next.length === 0) {
    return capTextTail(existing, options);
  }

  const prefix = options.truncationPrefix ?? DEFAULT_TRUNCATION_PREFIX;
  const wasTruncated = existing.startsWith(prefix);
  const normalizedExisting = wasTruncated ? existing.slice(prefix.length) : existing;
  const combined = `${normalizedExisting}${next}`;
  if (wasTruncated && combined.length <= Math.max(0, options.maxChars)) {
    return `${prefix}${combined}`;
  }
  return capTextTail(combined, options);
}

export function capTextTail(value: string, options: CappedTextTailOptions): string {
  const maxChars = Math.max(0, options.maxChars);
  if (value.length <= maxChars) {
    return value;
  }

  const prefix = options.truncationPrefix ?? DEFAULT_TRUNCATION_PREFIX;
  return `${prefix}${value.slice(-maxChars)}`;
}
