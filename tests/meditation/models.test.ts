import { describe, expect, test } from "vitest";

import { ProviderRegistry } from "@/src/agent/llm/provider-registry.js";
import type { AppConfig } from "@/src/config/schema.js";
import { resolveMeditationModels } from "@/src/meditation/models.js";

function createRegistry(options?: {
  bucketScenarioIds?: string[];
  consolidationScenarioIds?: string[];
}): ProviderRegistry {
  const config: Pick<AppConfig, "providers" | "models"> = {
    providers: {
      anthropic_main: {
        api: "anthropic-messages",
        apiKey: "anthropic-secret",
      },
      openai_main: {
        api: "openai-responses",
        apiKey: "openai-secret",
      },
    },
    models: {
      catalog: [
        {
          id: "anthropic_main/claude-sonnet-4-5",
          provider: "anthropic_main",
          upstreamId: "claude-sonnet-4-5-20250929",
          contextWindow: 200_000,
          maxOutputTokens: 16_384,
          supportsTools: true,
          supportsVision: true,
          reasoning: { enabled: true },
        },
        {
          id: "openai_main/gpt-5-mini",
          provider: "openai_main",
          upstreamId: "gpt-5-mini",
          contextWindow: 128_000,
          maxOutputTokens: 16_384,
          supportsTools: true,
          supportsVision: true,
          reasoning: { enabled: true },
        },
      ],
      scenarios: {
        chat: ["anthropic_main/claude-sonnet-4-5"],
        compaction: ["anthropic_main/claude-sonnet-4-5"],
        subagent: ["anthropic_main/claude-sonnet-4-5"],
        cron: ["openai_main/gpt-5-mini"],
        meditationBucket: options?.bucketScenarioIds ?? ["openai_main/gpt-5-mini"],
        meditationConsolidation: options?.consolidationScenarioIds ?? [
          "anthropic_main/claude-sonnet-4-5",
        ],
      },
    },
  };

  return new ProviderRegistry(config);
}

describe("resolveMeditationModels", () => {
  test("uses meditation-specific scenario models", () => {
    const models = resolveMeditationModels({
      registry: createRegistry(),
    });

    expect(models.bucket.id).toBe("openai_main/gpt-5-mini");
    expect(models.consolidation.id).toBe("anthropic_main/claude-sonnet-4-5");
  });

  test("allows both meditation scenarios to point at the same model", () => {
    const models = resolveMeditationModels({
      registry: createRegistry({
        bucketScenarioIds: ["anthropic_main/claude-sonnet-4-5"],
        consolidationScenarioIds: ["anthropic_main/claude-sonnet-4-5"],
      }),
    });

    expect(models.bucket.id).toBe("anthropic_main/claude-sonnet-4-5");
    expect(models.consolidation.id).toBe("anthropic_main/claude-sonnet-4-5");
  });

  test("throws when meditation bucket scenario is missing", () => {
    expect(() =>
      resolveMeditationModels({
        registry: createRegistry({
          bucketScenarioIds: [],
        }),
      }),
    ).toThrow("No model configured for scenario: meditationBucket");
  });

  test("throws when meditation consolidation scenario is missing", () => {
    expect(() =>
      resolveMeditationModels({
        registry: createRegistry({
          consolidationScenarioIds: [],
        }),
      }),
    ).toThrow("No model configured for scenario: meditationConsolidation");
  });
});
