import { describe, expect, test, vi } from "vitest";

import { createBootstrapLogger, createTestLogger } from "@/src/shared/logger.js";

describe("logger", () => {
  test("bootstrap logger works without config", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-20T12:00:00.000Z"));
    const writes: string[] = [];
    const logger = createBootstrapLogger({
      subsystem: "bootstrap",
      write(line) {
        writes.push(line);
      },
    });

    logger.info("booting app", { step: "config" });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("INFO [bootstrap] booting app");
    expect(writes[0]).toContain("step='config'");
    vi.useRealTimers();
  });

  test("logger respects configured level", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-20T12:00:00.000Z"));
    const write = vi.fn<(line: string) => void>();
    const logger = createTestLogger(
      {
        level: "warn",
        useColors: false,
      },
      {
        subsystem: "runtime",
        write,
      },
    );

    logger.info("hidden");
    logger.warn("visible");

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toContain("WARN [runtime] visible");
    vi.useRealTimers();
  });

  test("logger prints human-readable lines instead of json", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-20T12:00:00.000Z"));
    const writes: string[] = [];
    const logger = createTestLogger(
      {
        level: "debug",
        useColors: false,
      },
      {
        write(line) {
          writes.push(line);
        },
        subsystem: "config",
      },
    );

    logger.debug("loaded config", { source: "config.toml" });

    expect(writes[0]).toContain("DEBUG [config] loaded config");
    expect(writes[0]).toContain("source='config.toml'");
    expect(writes[0]?.trim().startsWith("{")).toBe(false);
    vi.useRealTimers();
  });

  test("logger colors only level label when enabled", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-20T12:00:00.000Z"));
    const writes: string[] = [];
    const logger = createTestLogger(
      {
        level: "debug",
        useColors: true,
      },
      {
        write(line) {
          writes.push(line);
        },
        subsystem: "runtime",
      },
    );

    logger.warn("visible");

    expect(writes[0]).toContain("\u001B[33mWARN\u001B[0m [runtime] visible");
    expect(writes[0]).not.toContain("\u001B[33m[runtime]");
    expect(writes[0]).not.toContain("\u001B[33mvisible");
    vi.useRealTimers();
  });
});
