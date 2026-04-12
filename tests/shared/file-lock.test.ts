import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { withFileLock } from "@/src/shared/file-lock.js";

let tempDir: string;
let lockTarget: string;

describe("file lock", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-file-lock-test-"));
    lockTarget = path.join(tempDir, "target.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  test("times out on active lock files instead of spinning forever", async () => {
    vi.useFakeTimers();
    const lockPath = `${lockTarget}.lock`;
    await writeFile(lockPath, "active", "utf8");

    const pending = withFileLock(lockTarget, async () => "ok", {
      timeoutMs: 50,
      staleAfterMs: 10_000,
    });

    await vi.advanceTimersByTimeAsync(60);

    await expect(pending).rejects.toThrow(`Timed out waiting for file lock: ${lockPath}`);
  });
});
