import { describe, expect, test } from "vitest";
import { ProviderRegistry } from "@/src/agent/llm/provider-registry.js";
import type { AppConfig, ModelCatalogEntry } from "@/src/config/schema.js";

function createConfig(): Pick<AppConfig, "providers" | "models"> {
  return {
    providers: {
      anthropic_main: {
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        apiKey: "anthropic-secret",
      },
      openai_main: {
        api: "openai-responses",
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
          supportsReasoning: true,
          pricing: {
            input: 3,
            output: 15,
            cacheRead: 0.3,
            cacheWrite: 3.75,
          },
        },
        {
          id: "openai_main/gpt-5-mini",
          provider: "openai_main",
          upstreamId: "gpt-5-mini",
          contextWindow: 128_000,
          maxOutputTokens: 16_384,
          supportsTools: true,
          supportsVision: true,
          supportsReasoning: true,
        },
      ],
      scenarios: {
        chat: ["anthropic_main/claude-sonnet-4-5", "openai_main/gpt-5-mini"],
        compaction: ["openai_main/gpt-5-mini"],
        subagent: ["anthropic_main/claude-sonnet-4-5"],
        cron: ["anthropic_main/claude-sonnet-4-5"],
      },
    },
  };
}

describe("provider registry", () => {
  test("resolves the first configured scenario model and exposes fallback ids", () => {
    const registry = new ProviderRegistry(createConfig());

    expect(registry.getScenarioModelIds("chat")).toEqual([
      "anthropic_main/claude-sonnet-4-5",
      "openai_main/gpt-5-mini",
    ]);
    expect(registry.getRequiredScenarioModel("chat").id).toBe("anthropic_main/claude-sonnet-4-5");
  });

  test("resolves provider details onto the model view", () => {
    const registry = new ProviderRegistry(createConfig());

    const model = registry.getRequiredModel("anthropic_main/claude-sonnet-4-5");
    expect(model.provider.id).toBe("anthropic_main");
    expect(model.provider.api).toBe("anthropic-messages");
    expect(model.provider.baseUrl).toBe("https://api.anthropic.com");
    expect(model.provider.apiKey).toBe("anthropic-secret");
  });

  test("returns null for missing scenario selection when the list is empty", () => {
    const config = createConfig();
    config.models.scenarios.cron = [];

    const registry = new ProviderRegistry(config);
    expect(registry.getScenarioModel("cron")).toBeNull();
    expect(() => registry.getRequiredScenarioModel("cron")).toThrow(
      "No model configured for scenario: cron",
    );
  });

  test("rejects models that point at unknown providers", () => {
    const config = createConfig();
    const existing = config.models.catalog[0];
    if (existing == null) {
      throw new Error("expected seeded model catalog entry");
    }

    const nextEntry: ModelCatalogEntry = {
      id: existing.id,
      provider: "missing_provider",
      upstreamId: existing.upstreamId,
      contextWindow: existing.contextWindow,
      maxOutputTokens: existing.maxOutputTokens,
      supportsTools: existing.supportsTools,
      supportsVision: existing.supportsVision,
      supportsReasoning: existing.supportsReasoning,
    };
    if (existing.pricing != null) {
      nextEntry.pricing = existing.pricing;
    }

    config.models.catalog[0] = nextEntry;

    expect(() => new ProviderRegistry(config)).toThrow(
      'Model "anthropic_main/claude-sonnet-4-5" references unknown provider: missing_provider',
    );
  });

  test("rejects scenarios that reference unknown model ids", () => {
    const config = createConfig();
    config.models.scenarios.chat = ["missing/model"];

    expect(() => new ProviderRegistry(config)).toThrow(
      'Scenario "chat" references unknown model id: missing/model',
    );
  });
});
