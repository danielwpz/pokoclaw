import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

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
    await resetRuntimeLoggingForTests();
    if (tempDir != null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test("writes plain info+ lines to the runtime log file", async () => {
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
    expect(text).toContain("[logger-test] info line foo='bar'");
    expect(text).toContain("[logger-test] warn line");
    expect(text).not.toContain("debug line");
  });
});
