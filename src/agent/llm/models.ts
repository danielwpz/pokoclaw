/**
 * LLM model/provider domain types and helpers.
 *
 * Defines normalized provider/model metadata, scenario model selection types,
 * and token usage/cost utility logic shared by runtime and status reporting.
 */
import type {
  ModelPricingConfig,
  ModelReasoningConfig,
  ModelScenarioConfig,
  ProviderConfig,
} from "@/src/config/schema.js";

export type ModelScenario = keyof ModelScenarioConfig;

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens?: number;
}

export interface UsageCostBreakdown extends ModelPricingConfig {
  total: number;
}

export interface ResolvedProvider {
  id: string;
  api: string;
  baseUrl?: string;
  apiKey?: string;
  authSource?: ProviderConfig["authSource"];
}

export interface ResolvedModel {
  id: string;
  providerId: string;
  upstreamId: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
  reasoning?: ModelReasoningConfig;
  pricing?: ModelPricingConfig;
  provider: ResolvedProvider;
}

const MODEL_SCENARIOS = [
  "chat",
  "compaction",
  "subagent",
  "cron",
  "meditationBucket",
  "meditationConsolidation",
] as const;

export function isModelScenario(value: string): value is ModelScenario {
  return MODEL_SCENARIOS.includes(value as ModelScenario);
}

export function resolveProvider(id: string, provider: ProviderConfig): ResolvedProvider {
  const resolved: ResolvedProvider = {
    id,
    api: provider.api,
  };

  if (provider.baseUrl != null) {
    resolved.baseUrl = provider.baseUrl;
  }

  if (provider.apiKey != null) {
    resolved.apiKey = provider.apiKey;
  }

  if (provider.authSource != null) {
    resolved.authSource = provider.authSource;
  }

  return resolved;
}

export function calculateUsageCost(
  model: Pick<ResolvedModel, "pricing">,
  usage: TokenUsage,
): UsageCostBreakdown | null {
  if (model.pricing == null) {
    return null;
  }

  const input = perMillion(model.pricing.input, usage.input);
  const output = perMillion(model.pricing.output, usage.output);
  const cacheRead = perMillion(model.pricing.cacheRead, usage.cacheRead);
  const cacheWrite = perMillion(model.pricing.cacheWrite, usage.cacheWrite);

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
  };
}

export function getTotalUsageTokens(usage: TokenUsage): number {
  return usage.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function perMillion(pricePerMillion: number, tokens: number): number {
  return (pricePerMillion / 1_000_000) * tokens;
}
