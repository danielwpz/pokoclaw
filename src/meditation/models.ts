import type { ResolvedModel } from "@/src/agent/llm/models.js";
import type { ProviderRegistry } from "@/src/agent/llm/provider-registry.js";

export interface ResolveMeditationModelsInput {
  registry: ProviderRegistry;
}

export interface ResolvedMeditationModels {
  bucket: ResolvedModel;
  consolidation: ResolvedModel;
}

export function maybeResolveMeditationModels(
  input: ResolveMeditationModelsInput,
): ResolvedMeditationModels | null {
  const bucket = input.registry.getScenarioModel("meditationBucket");
  const consolidation = input.registry.getScenarioModel("meditationConsolidation");

  if (bucket == null || consolidation == null) {
    return null;
  }

  return {
    bucket,
    consolidation,
  };
}

export function resolveMeditationModels(
  input: ResolveMeditationModelsInput,
): ResolvedMeditationModels {
  const resolved = maybeResolveMeditationModels(input);
  if (resolved != null) {
    return resolved;
  }

  const bucket = input.registry.getRequiredScenarioModel("meditationBucket");
  const consolidation = input.registry.getRequiredScenarioModel("meditationConsolidation");

  return {
    bucket,
    consolidation,
  };
}
