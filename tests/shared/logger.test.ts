import { describe, expect, test, vi } from "vitest";

import { createBootstrapLogger, createLogger } from "@/src/shared/logger.js";

describe("logger", () => {
  test("bootstrap logger works without config", () => {
    const writes: string[] = [];
    const logger = createBootstrapLogger({
      subsystem: "bootstrap",
      now: () => new Date("2026-03-20T12:00:00.000Z"),
      write(line) {
        writes.push(line);
      },
    });

    logger.info("booting app", { step: "config" });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("INFO [bootstrap] booting app");
    expect(writes[0]).toContain("step='config'");
  });

  test("logger respects configured level", () => {
    const write = vi.fn<(line: string) => void>();
    const logger = createLogger(
      {
        level: "warn",
        useColors: false,
      },
      {
        subsystem: "runtime",
        now: () => new Date("2026-03-20T12:00:00.000Z"),
        write,
      },
    );

    logger.info("hidden");
    logger.warn("visible");

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toContain("WARN [runtime] visible");
  });

  test("logger prints human-readable lines instead of json", () => {
    const writes: string[] = [];
    const logger = createLogger(
      {
        level: "debug",
        useColors: false,
      },
      {
        now: () => new Date("2026-03-20T12:00:00.000Z"),
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
  });
});
