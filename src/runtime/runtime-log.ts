import { open } from "node:fs/promises";

const DEFAULT_TAIL_BYTES = 64 * 1024;
const ISO_TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/;

export async function readLastRuntimeLogTimestamp(
  runtimeLogPath: string,
  options: {
    tailBytes?: number;
  } = {},
): Promise<Date | null> {
  const handle = await open(runtimeLogPath, "r").catch((error: unknown) => {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  });
  if (handle == null) {
    return null;
  }

  try {
    const stat = await handle.stat();
    if (stat.size <= 0) {
      return null;
    }

    const tailBytes = Math.max(1024, options.tailBytes ?? DEFAULT_TAIL_BYTES);
    const start = Math.max(0, stat.size - tailBytes);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    if (bytesRead <= 0) {
      return null;
    }

    const chunk = buffer.subarray(0, bytesRead).toString("utf8");
    const lines = chunk
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (line == null) {
        continue;
      }
      const timestamp = extractTimestampPrefix(line);
      if (timestamp != null) {
        return timestamp;
      }
    }

    return null;
  } finally {
    await handle.close();
  }
}

function extractTimestampPrefix(line: string): Date | null {
  const match = ISO_TIMESTAMP_PREFIX.exec(line);
  if (match == null) {
    return null;
  }

  const timestamp = new Date(match[0]);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error != null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
