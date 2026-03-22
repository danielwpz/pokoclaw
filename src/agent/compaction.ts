import type { CompactionConfig } from "@/src/config/schema.js";

export type CompactionReason = "threshold" | "overflow";

export interface CompactionDecision {
  shouldCompact: boolean;
  reason: CompactionReason | null;
  effectiveWindow: number;
  thresholdTokens: number;
}

export interface DecideCompactionInput {
  contextTokens: number;
  contextWindow: number;
  config: CompactionConfig;
  overflow?: boolean;
}

export function getEffectiveCompactionWindow(contextWindow: number): number {
  return contextWindow;
}

export function getCompactionThresholdTokens(
  contextWindow: number,
  config: CompactionConfig,
): number {
  const reserveTokens = Math.max(config.reserveTokens, config.reserveTokensFloor);
  return Math.max(0, getEffectiveCompactionWindow(contextWindow) - reserveTokens);
}

export function decideCompaction(input: DecideCompactionInput): CompactionDecision {
  const thresholdTokens = getCompactionThresholdTokens(input.contextWindow, input.config);
  const effectiveWindow = getEffectiveCompactionWindow(input.contextWindow);

  if (input.overflow === true) {
    return {
      shouldCompact: true,
      reason: "overflow",
      effectiveWindow,
      thresholdTokens,
    };
  }

  if (input.contextTokens >= thresholdTokens) {
    return {
      shouldCompact: true,
      reason: "threshold",
      effectiveWindow,
      thresholdTokens,
    };
  }

  return {
    shouldCompact: false,
    reason: null,
    effectiveWindow,
    thresholdTokens,
  };
}
