import { describe, expect, test } from "vitest";

import {
  decideCompaction,
  getCompactionThresholdTokens,
  getEffectiveCompactionWindow,
} from "@/src/agent/compaction.js";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";

describe("compaction helpers", () => {
  test("uses the model context window directly", () => {
    expect(getEffectiveCompactionWindow(128_000)).toBe(128_000);
    expect(getEffectiveCompactionWindow(400_000)).toBe(400_000);
  });

  test("computes threshold from effective window minus reserve tokens", () => {
    expect(getCompactionThresholdTokens(200_000, DEFAULT_CONFIG.compaction)).toBe(140_000);
    expect(getCompactionThresholdTokens(400_000, DEFAULT_CONFIG.compaction)).toBe(340_000);
  });

  test("prefers overflow compaction over threshold checks", () => {
    expect(
      decideCompaction({
        contextTokens: 100_000,
        contextWindow: 200_000,
        config: DEFAULT_CONFIG.compaction,
        overflow: true,
      }),
    ).toEqual({
      shouldCompact: true,
      reason: "overflow",
      effectiveWindow: 200_000,
      thresholdTokens: 140_000,
    });
  });

  test("triggers threshold compaction only once the budget is crossed", () => {
    expect(
      decideCompaction({
        contextTokens: 139_999,
        contextWindow: 200_000,
        config: DEFAULT_CONFIG.compaction,
      }).shouldCompact,
    ).toBe(false);

    expect(
      decideCompaction({
        contextTokens: 140_000,
        contextWindow: 200_000,
        config: DEFAULT_CONFIG.compaction,
      }),
    ).toEqual({
      shouldCompact: true,
      reason: "threshold",
      effectiveWindow: 200_000,
      thresholdTokens: 140_000,
    });
  });
});
