import { mkdir, open, rm, stat } from "node:fs/promises";
import path from "node:path";

interface FileLockOptions {
  timeoutMs?: number;
  staleAfterMs?: number;
  pollIntervalMs?: number;
}

export async function withFileLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const lockPath = `${targetPath}.lock`;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const staleAfterMs = options.staleAfterMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  const startedAt = Date.now();
  await mkdir(path.dirname(lockPath), { recursive: true });

  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await writeFileHandleTimestamp(handle);
        return await fn();
      } finally {
        await handle.close();
        await rm(lockPath, { force: true });
      }
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }

      if (await isStaleLock(lockPath, staleAfterMs)) {
        await rm(lockPath, { force: true });
        continue;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for file lock: ${lockPath}`);
      }
      await sleep(pollIntervalMs);
    }
  }
}

async function writeFileHandleTimestamp(handle: Awaited<ReturnType<typeof open>>): Promise<void> {
  await handle.truncate(0);
  await handle.writeFile(String(Date.now()), "utf8");
}

async function isStaleLock(lockPath: string, staleAfterMs: number): Promise<boolean> {
  try {
    const lockStat = await stat(lockPath);
    return Date.now() - lockStat.mtimeMs >= staleAfterMs;
  } catch {
    return false;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
