/**
 * Provider/model registry built from app config.
 *
 * Resolves configured providers and model catalog entries into runtime-safe
 * objects, and serves scenario-default model resolution for loop execution.
 */
import {
  type ModelScenario,
  type ResolvedModel,
  type ResolvedProvider,
  resolveProvider,
} from "@/src/agent/llm/models.js";
import type { AppConfig, ModelCatalogEntry, ModelScenarioConfig } from "@/src/config/schema.js";

type RegistryConfig = Pick<AppConfig, "providers" | "models">;

export class ProviderRegistry {
  private readonly providers = new Map<string, ResolvedProvider>();
  private readonly models = new Map<string, ResolvedModel>();
  private readonly scenarioModelIds: ModelScenarioConfig;

  constructor(config: RegistryConfig) {
    for (const [providerId, providerConfig] of Object.entries(config.providers)) {
      this.providers.set(providerId, resolveProvider(providerId, providerConfig));
    }

    for (const modelEntry of config.models.catalog) {
      this.models.set(modelEntry.id, this.resolveModel(modelEntry));
    }

    this.scenarioModelIds = {
      chat: [...config.models.scenarios.chat],
      compaction: [...config.models.scenarios.compaction],
      task: [...config.models.scenarios.task],
      meditationBucket: [...config.models.scenarios.meditationBucket],
      meditationConsolidation: [...config.models.scenarios.meditationConsolidation],
    };

    for (const scenario of getScenarioKeys()) {
      for (const modelId of this.scenarioModelIds[scenario]) {
        if (!this.models.has(modelId)) {
          throw new Error(`Scenario "${scenario}" references unknown model id: ${modelId}`);
        }
      }
    }
  }

  listProviders(): ResolvedProvider[] {
    return Array.from(this.providers.values());
  }

  getProvider(id: string): ResolvedProvider | null {
    return this.providers.get(id) ?? null;
  }

  getRequiredProvider(id: string): ResolvedProvider {
    const provider = this.getProvider(id);
    if (provider == null) {
      throw new Error(`Unknown provider: ${id}`);
    }

    return provider;
  }

  listModels(): ResolvedModel[] {
    return Array.from(this.models.values());
  }

  getModel(id: string): ResolvedModel | null {
    return this.models.get(id) ?? null;
  }

  getRequiredModel(id: string): ResolvedModel {
    const model = this.getModel(id);
    if (model == null) {
      throw new Error(`Unknown model id: ${id}`);
    }

    return model;
  }

  getScenarioModelIds(scenario: ModelScenario): string[] {
    return [...this.scenarioModelIds[scenario]];
  }

  getScenarioModels(scenario: ModelScenario): ResolvedModel[] {
    return this.scenarioModelIds[scenario].map((modelId) => this.getRequiredModel(modelId));
  }

  getScenarioModel(scenario: ModelScenario): ResolvedModel | null {
    const [firstModelId] = this.scenarioModelIds[scenario];
    if (firstModelId == null) {
      return null;
    }

    return this.getRequiredModel(firstModelId);
  }

  getRequiredScenarioModel(scenario: ModelScenario): ResolvedModel {
    const model = this.getScenarioModel(scenario);
    if (model == null) {
      throw new Error(`No model configured for scenario: ${scenario}`);
    }

    return model;
  }

  private resolveModel(entry: ModelCatalogEntry): ResolvedModel {
    const provider = this.providers.get(entry.provider);
    if (provider == null) {
      throw new Error(`Model "${entry.id}" references unknown provider: ${entry.provider}`);
    }

    const resolved: ResolvedModel = {
      id: entry.id,
      providerId: entry.provider,
      upstreamId: entry.upstreamId,
      contextWindow: entry.contextWindow,
      maxOutputTokens: entry.maxOutputTokens,
      supportsTools: entry.supportsTools,
      supportsVision: entry.supportsVision,
      provider,
    };

    if (entry.reasoning != null) {
      resolved.reasoning = { ...entry.reasoning };
    }

    if (entry.pricing != null) {
      resolved.pricing = { ...entry.pricing };
    }

    return resolved;
  }
}

function getScenarioKeys(): ModelScenario[] {
  return ["chat", "compaction", "task", "meditationBucket", "meditationConsolidation"];
}
