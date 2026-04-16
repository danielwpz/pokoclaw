import { describe, expect, test } from "vitest";

import {
  normalizeMeditationBacktestArgv,
  parseMeditationBacktestArgs,
} from "@/src/script/meditation-backtest.js";

describe("meditation backtest CLI parsing", () => {
  test("ignores standalone double-dash separators", () => {
    expect(
      normalizeMeditationBacktestArgv([
        "--",
        "--tick-at",
        "2026-04-15T12:30:00.000Z",
        "--lookback-days",
        "7",
      ]),
    ).toEqual(["--tick-at", "2026-04-15T12:30:00.000Z", "--lookback-days", "7"]);
  });

  test("parses pnpm style argv with double-dash separator", () => {
    const parsed = parseMeditationBacktestArgs([
      "--",
      "--tick-at",
      "2026-04-15T12:30:00.000Z",
      "--lookback-days",
      "7",
      "--last-success-at",
      "null",
      "--label",
      "manual",
    ]);

    expect(parsed.tickAt.toISOString()).toBe("2026-04-15T12:30:00.000Z");
    expect(parsed.lookbackDays).toBe(7);
    expect(parsed.lastSuccessAt).toBeNull();
    expect(parsed.label).toBe("manual");
  });
});
