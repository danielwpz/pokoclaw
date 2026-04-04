import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { readLastRuntimeLogTimestamp } from "@/src/runtime/runtime-log.js";

describe("runtime log tail reader", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir != null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test("returns null when the runtime log does not exist", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-runtime-log-test-"));

    await expect(
      readLastRuntimeLogTimestamp(path.join(tempDir, "missing-runtime.log")),
    ).resolves.toBeNull();
  });

  test("reads the timestamp from the last non-empty runtime log line", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-runtime-log-test-"));
    const runtimeLogPath = path.join(tempDir, "runtime.log");
    await writeFile(
      runtimeLogPath,
      [
        "2026-04-04T00:00:00.000Z INFO [main] startup complete",
        "not a timestamp line",
        "2026-04-04T00:12:34.000Z INFO [cron/service] cron heartbeat dueJobs=0 claimedJobs=0",
        "",
      ].join("\n"),
      "utf8",
    );

    const timestamp = await readLastRuntimeLogTimestamp(runtimeLogPath);
    expect(timestamp?.toISOString()).toBe("2026-04-04T00:12:34.000Z");
  });
});
