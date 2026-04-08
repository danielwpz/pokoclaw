import type { ResolvedModel } from "@/src/agent/llm/models.js";
import type { ProviderRegistry } from "@/src/agent/llm/provider-registry.js";

export interface ResolveMeditationModelsInput {
  registry: ProviderRegistry;
}

export interface ResolvedMeditationModels {
  bucket: ResolvedModel;
  consolidation: ResolvedModel;
}

export function resolveMeditationModels(
  input: ResolveMeditationModelsInput,
): ResolvedMeditationModels {
  const bucket = input.registry.getRequiredScenarioModel("meditationBucket");
  const consolidation = input.registry.getRequiredScenarioModel("meditationConsolidation");

  return {
    bucket,
    consolidation,
  };
}
