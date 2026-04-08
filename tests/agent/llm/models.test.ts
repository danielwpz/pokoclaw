import { describe, expect, test } from "vitest";

import {
  calculateUsageCost,
  getTotalUsageTokens,
  isModelScenario,
  type ResolvedModel,
} from "@/src/agent/llm/models.js";

function createModel(overrides?: Partial<ResolvedModel>): ResolvedModel {
  return {
    id: "anthropic_main/claude-sonnet-4-5",
    providerId: "anthropic_main",
    upstreamId: "claude-sonnet-4-5-20250929",
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
    supportsTools: true,
    supportsVision: true,
    reasoning: { enabled: true },
    pricing: {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    },
    provider: {
      id: "anthropic_main",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
    },
    ...overrides,
  };
}

describe("llm models helpers", () => {
  test("calculates usage cost from per-million pricing", () => {
    const model = createModel();

    const cost = calculateUsageCost(model, {
      input: 1000,
      output: 200,
      cacheRead: 500,
      cacheWrite: 100,
    });

    expect(cost).toEqual({
      input: 0.003,
      output: 0.003,
      cacheRead: 0.00015,
      cacheWrite: 0.000375,
      total: 0.006525,
    });
  });

  test("returns null cost when model has no pricing", () => {
    const model = createModel();
    delete model.pricing;

    expect(
      calculateUsageCost(model, {
        input: 100,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
      }),
    ).toBeNull();
  });

  test("uses provided total token count when present", () => {
    expect(
      getTotalUsageTokens({
        input: 100,
        output: 20,
        cacheRead: 5,
        cacheWrite: 1,
        totalTokens: 999,
      }),
    ).toBe(999);

    expect(
      getTotalUsageTokens({
        input: 100,
        output: 20,
        cacheRead: 5,
        cacheWrite: 1,
      }),
    ).toBe(126);
  });

  test("recognizes configured model scenarios", () => {
    expect(isModelScenario("chat")).toBe(true);
    expect(isModelScenario("compaction")).toBe(true);
    expect(isModelScenario("meditationBucket")).toBe(true);
    expect(isModelScenario("agent")).toBe(false);
  });
});
