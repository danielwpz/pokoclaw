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
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-runtime-log-test-"));

    await expect(
      readLastRuntimeLogTimestamp(path.join(tempDir, "missing-runtime.log")),
    ).resolves.toBeNull();
  });

  test("reads the timestamp from the last non-empty runtime log line in local time format", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-runtime-log-test-"));
    const runtimeLogPath = path.join(tempDir, "runtime.log");
    await writeFile(
      runtimeLogPath,
      [
        "2026-04-04 00:00:00.000 INFO [main] startup complete",
        "not a timestamp line",
        "2026-04-04 00:12:34.000 INFO [cron/service] cron heartbeat dueJobs=0 claimedJobs=0",
        "",
      ].join("\n"),
      "utf8",
    );

    const timestamp = await readLastRuntimeLogTimestamp(runtimeLogPath);
    expect(timestamp).not.toBeNull();
    expect(timestamp?.getFullYear()).toBe(2026);
    expect(timestamp?.getMonth()).toBe(3);
    expect(timestamp?.getDate()).toBe(4);
    expect(timestamp?.getHours()).toBe(0);
    expect(timestamp?.getMinutes()).toBe(12);
    expect(timestamp?.getSeconds()).toBe(34);
    expect(timestamp?.getMilliseconds()).toBe(0);
  });
});
