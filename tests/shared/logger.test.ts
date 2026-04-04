import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import {
  configureRuntimeLogging,
  createSubsystemLogger,
  flushRuntimeLoggingForTests,
  resetRuntimeLoggingForTests,
} from "@/src/shared/logger.js";

describe("runtime log file sink", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    await resetRuntimeLoggingForTests();
    if (tempDir != null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test("writes plain info+ lines to the runtime log file with local timestamps", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 4, 8, 9, 10, 123));

    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-logger-test-"));
    const runtimeLogPath = path.join(tempDir, "runtime.log");

    configureRuntimeLogging(
      {
        ...DEFAULT_CONFIG.logging,
        level: "debug",
        useColors: true,
      },
      { runtimeLogPath },
    );

    const logger = createSubsystemLogger("logger-test");
    logger.debug("debug line");
    logger.info("info line", { foo: "bar" });
    logger.warn("warn line");
    await flushRuntimeLoggingForTests();

    const text = await readFile(runtimeLogPath, "utf8");
    expect(text).not.toContain("\u001B[");
    expect(text).toContain("2026-04-04 08:09:10.123 INFO [logger-test] info line foo='bar'");
    expect(text).toContain("2026-04-04 08:09:10.123 WARN [logger-test] warn line");
    expect(text).not.toContain("debug line");
    expect(text).not.toContain("T08:09:10.123");
    expect(text).not.toContain("Z INFO");
  });
});
