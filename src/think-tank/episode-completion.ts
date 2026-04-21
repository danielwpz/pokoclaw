import type {
  ThinkTankEpisodeStepKind,
  ThinkTankStructuredSummary,
} from "@/src/think-tank/types.js";
import type { ToolResult } from "@/src/tools/core/types.js";

export const THINK_TANK_EPISODE_COMPLETION_TOOL_NAME = "finish_think_tank_episode";

export interface ThinkTankEpisodeSubmitParticipantEntry {
  participantId: string;
  content: string;
}

export interface ThinkTankEpisodeSubmitStep {
  key: string;
  kind: ThinkTankEpisodeStepKind;
  title: string;
  order: number;
  roundIndex?: number;
  participantEntries?: ThinkTankEpisodeSubmitParticipantEntry[];
  summaryKind?: "midpoint" | "final";
  summary?: ThinkTankStructuredSummary;
  errorMessage?: string;
}

export interface ThinkTankEpisodeCompletionSignal {
  summary: ThinkTankStructuredSummary;
  steps: ThinkTankEpisodeSubmitStep[];
}

export interface ThinkTankEpisodeCompletionDetails {
  thinkTankEpisodeCompletion: ThinkTankEpisodeCompletionSignal;
}

export function extractThinkTankEpisodeCompletionSignal(input: {
  toolName?: string | null;
  result?: ToolResult | null;
  details?: unknown;
}): ThinkTankEpisodeCompletionSignal | null {
  if (
    input.toolName != null &&
    input.toolName.length > 0 &&
    input.toolName !== THINK_TANK_EPISODE_COMPLETION_TOOL_NAME
  ) {
    return null;
  }

  const details =
    input.details !== undefined ? input.details : (input.result?.details as unknown | undefined);
  if (
    !isRecord(details) ||
    !("thinkTankEpisodeCompletion" in details) ||
    !isRecord(details.thinkTankEpisodeCompletion)
  ) {
    return null;
  }

  const completion = details.thinkTankEpisodeCompletion;
  const summary = normalizeSummary(completion.summary);
  const steps = normalizeSteps(completion.steps);
  if (summary == null || steps == null) {
    return null;
  }

  return {
    summary,
    steps,
  };
}

function normalizeSteps(value: unknown): ThinkTankEpisodeSubmitStep[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const normalized: ThinkTankEpisodeSubmitStep[] = [];
  for (const step of value) {
    if (!isRecord(step)) {
      return null;
    }

    const key = normalizeNonEmptyString(step.key);
    const kind = normalizeStepKind(step.kind);
    const title = normalizeNonEmptyString(step.title);
    const order = normalizeNonNegativeInteger(step.order);
    if (key == null || kind == null || title == null || order == null) {
      return null;
    }

    const normalizedStep: ThinkTankEpisodeSubmitStep = {
      key,
      kind,
      title,
      order,
    };

    if ("roundIndex" in step && step.roundIndex !== undefined) {
      const roundIndex = normalizePositiveInteger(step.roundIndex);
      if (roundIndex == null) {
        return null;
      }
      normalizedStep.roundIndex = roundIndex;
    }

    if ("participantEntries" in step && step.participantEntries !== undefined) {
      const entries = normalizeParticipantEntries(step.participantEntries);
      if (entries == null) {
        return null;
      }
      normalizedStep.participantEntries = entries;
    }

    if ("summaryKind" in step && step.summaryKind !== undefined) {
      const summaryKind =
        step.summaryKind === "midpoint" || step.summaryKind === "final" ? step.summaryKind : null;
      if (summaryKind == null) {
        return null;
      }
      normalizedStep.summaryKind = summaryKind;
    }

    if ("summary" in step && step.summary !== undefined) {
      const summary = normalizeSummary(step.summary);
      if (summary == null) {
        return null;
      }
      normalizedStep.summary = summary;
    }

    if ("errorMessage" in step && step.errorMessage !== undefined) {
      const errorMessage = normalizeNonEmptyString(step.errorMessage);
      if (errorMessage == null) {
        return null;
      }
      normalizedStep.errorMessage = errorMessage;
    }

    normalized.push(normalizedStep);
  }

  return normalized;
}

function normalizeParticipantEntries(
  value: unknown,
): ThinkTankEpisodeSubmitParticipantEntry[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const normalized: ThinkTankEpisodeSubmitParticipantEntry[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      return null;
    }
    const participantId = normalizeNonEmptyString(entry.participantId);
    const content = normalizeNonEmptyString(entry.content);
    if (participantId == null || content == null) {
      return null;
    }
    normalized.push({ participantId, content });
  }
  return normalized;
}

function normalizeSummary(value: unknown): ThinkTankStructuredSummary | null {
  if (!isRecord(value)) {
    return null;
  }

  const agreements = normalizeStringArray(value.agreements);
  const keyDifferences = normalizeStringArray(value.keyDifferences);
  const openQuestions = normalizeStringArray(value.openQuestions);
  const currentConclusion = normalizeNonEmptyString(value.currentConclusion);
  if (
    agreements == null ||
    keyDifferences == null ||
    openQuestions == null ||
    currentConclusion == null
  ) {
    return null;
  }

  return {
    agreements,
    keyDifferences,
    currentConclusion,
    openQuestions,
  };
}

function normalizeStepKind(value: unknown): ThinkTankEpisodeStepKind | null {
  return value === "participant_round" ||
    value === "moderator_summary" ||
    value === "final_summary" ||
    value === "error"
    ? value
    : null;
}

function normalizeStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const normalized: string[] = [];
  for (const item of value) {
    const normalizedItem = normalizeNonEmptyString(item);
    if (normalizedItem == null) {
      return null;
    }
    normalized.push(normalizedItem);
  }
  return normalized;
}

function normalizePositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return null;
  }
  return value;
}

function normalizeNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}
