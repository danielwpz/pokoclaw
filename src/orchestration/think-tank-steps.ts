import type { ThinkTankEpisodeSubmitStep } from "@/src/think-tank/episode-completion.js";
import type {
  ThinkTankEpisodeResult,
  ThinkTankEpisodeStepSnapshot,
  ThinkTankEpisodeStepUpsertInput,
  ThinkTankParticipantRoundEntry,
} from "@/src/think-tank/types.js";

export interface ThinkTankParticipantRecord {
  participantId: string;
  title: string | null;
  modelId: string;
}

export function upsertThinkTankEpisodeResultStep(input: {
  current: ThinkTankEpisodeResult;
  step: ThinkTankEpisodeStepSnapshot;
}): ThinkTankEpisodeResult {
  const nextSteps = input.current.steps.filter((existing) => existing.key !== input.step.key);
  nextSteps.push(input.step);
  nextSteps.sort((left, right) => left.order - right.order);

  const latestSummary =
    input.step.status === "completed" &&
    (input.step.kind === "moderator_summary" || input.step.kind === "final_summary")
      ? (input.step.moderatorSummary?.summary ?? input.current.latestSummary)
      : input.current.latestSummary;

  return {
    steps: nextSteps,
    latestSummary,
  };
}

export function normalizeRunningThinkTankStep(input: {
  step: ThinkTankEpisodeStepUpsertInput;
  existingSteps: ThinkTankEpisodeStepSnapshot[];
  participants: ThinkTankParticipantRecord[];
  participantIndex: Map<string, ThinkTankParticipantRecord>;
}): ThinkTankEpisodeStepSnapshot {
  if (input.step.kind === "participant_round") {
    const slot = resolveRunningParticipantRoundSlot({
      existingSteps: input.existingSteps,
      ...(input.step.key === undefined ? {} : { key: input.step.key }),
      ...(input.step.roundIndex === undefined ? {} : { roundIndex: input.step.roundIndex }),
      ...(input.step.order === undefined ? {} : { order: input.step.order }),
    });
    const title =
      normalizeNonEmptyThinkTankText(input.step.title) ??
      slot.existing?.title ??
      defaultThinkTankParticipantRoundTitle(slot.roundIndex);
    const order =
      input.step.order ??
      slot.existing?.order ??
      defaultThinkTankParticipantRoundOrder(slot.roundIndex);
    const entries = mergeParticipantRoundEntries({
      existingEntries: slot.existing?.participantRound?.entries ?? [],
      upsertEntries: input.step.participantEntries ?? [],
      participants: input.participants,
      participantIndex: input.participantIndex,
    });

    return {
      key: slot.key,
      kind: "participant_round",
      title,
      order,
      status: input.step.status,
      participantRound: {
        roundIndex: slot.roundIndex,
        entries,
      },
    };
  }

  if (input.step.kind === "moderator_summary" || input.step.kind === "final_summary") {
    const slot = resolveRunningModeratorSummarySlot({
      kind: input.step.kind,
      existingSteps: input.existingSteps,
      ...(input.step.key === undefined ? {} : { key: input.step.key }),
      ...(input.step.roundIndex === undefined ? {} : { roundIndex: input.step.roundIndex }),
      ...(input.step.order === undefined ? {} : { order: input.step.order }),
      ...(input.step.summaryKind === undefined ? {} : { summaryKind: input.step.summaryKind }),
    });
    const title =
      normalizeNonEmptyThinkTankText(input.step.title) ??
      slot.existing?.title ??
      defaultThinkTankSummaryTitle({
        kind: slot.kind,
        roundIndex: slot.roundIndex,
      });
    const order =
      input.step.order ??
      slot.existing?.order ??
      defaultThinkTankSummaryOrder({
        kind: slot.kind,
        roundIndex: slot.roundIndex,
      });
    const summary = input.step.summary ?? slot.existing?.moderatorSummary?.summary;

    return {
      key: slot.key,
      kind: slot.kind,
      title,
      order,
      status: input.step.status,
      ...(summary == null
        ? {}
        : {
            moderatorSummary: {
              summaryKind: slot.summaryKind,
              summary,
            },
          }),
    };
  }

  const existingError = findThinkTankErrorStepByKey({
    steps: input.existingSteps,
    ...(input.step.key === undefined ? {} : { key: input.step.key }),
  });
  const errorKey = existingError?.key ?? normalizeNonEmptyThinkTankText(input.step.key) ?? "error";
  const title =
    normalizeNonEmptyThinkTankText(input.step.title) ?? existingError?.title ?? "Think Tank Error";
  const order = input.step.order ?? existingError?.order ?? 999;
  const errorMessage =
    normalizeNonEmptyThinkTankText(input.step.errorMessage) ??
    existingError?.error?.message ??
    "Think tank step failed.";

  return {
    key: errorKey,
    kind: "error",
    title,
    order,
    status: "failed",
    error: {
      message: errorMessage,
    },
  };
}

export function findThinkTankParticipantRoundStepBySlot(input: {
  steps: ThinkTankEpisodeStepSnapshot[];
  key?: string;
  roundIndex?: number;
  order?: number;
}): ThinkTankEpisodeStepSnapshot | null {
  return resolveRunningParticipantRoundSlot({
    existingSteps: input.steps,
    ...(input.key === undefined ? {} : { key: input.key }),
    ...(input.roundIndex === undefined ? {} : { roundIndex: input.roundIndex }),
    ...(input.order === undefined ? {} : { order: input.order }),
  }).existing;
}

export function normalizeSubmittedThinkTankSteps(input: {
  steps: ThinkTankEpisodeSubmitStep[];
  participantIndex: Map<string, ThinkTankParticipantRecord>;
}): ThinkTankEpisodeStepSnapshot[] {
  const usedKeys = new Set<string>();
  let participantRoundCount = 0;
  let moderatorSummaryCount = 0;
  let errorCount = 0;

  return [...input.steps]
    .sort((left, right) => left.order - right.order)
    .map((step) => {
      if (step.kind === "participant_round") {
        const roundIndex = step.roundIndex ?? participantRoundCount + 1;
        participantRoundCount = Math.max(participantRoundCount, roundIndex);
        const canonicalKey = allocateCanonicalThinkTankStepKey(usedKeys, `round_${roundIndex}`);
        const entries: ThinkTankParticipantRoundEntry[] = (step.participantEntries ?? []).map(
          (entry) => {
            const participant = input.participantIndex.get(entry.participantId);
            if (participant == null) {
              throw new Error(
                `Think tank episode result referenced unknown participant ${entry.participantId}`,
              );
            }
            return {
              participantId: participant.participantId,
              title: participant.title,
              model: participant.modelId,
              preview: buildThinkTankPreview(entry.content),
              content: entry.content,
            };
          },
        );

        return {
          key: canonicalKey,
          kind: step.kind,
          title: step.title,
          order: step.order,
          status: "completed",
          participantRound: {
            roundIndex,
            entries,
          },
        } satisfies ThinkTankEpisodeStepSnapshot;
      }

      if (step.kind === "moderator_summary" || step.kind === "final_summary") {
        if (step.summary == null) {
          throw new Error(`Think tank step ${step.key} is missing summary payload`);
        }
        const summaryKind =
          step.summaryKind ?? (step.kind === "final_summary" ? "final" : "midpoint");
        const canonicalKey =
          summaryKind === "final" || step.kind === "final_summary"
            ? allocateCanonicalThinkTankStepKey(usedKeys, "final")
            : allocateCanonicalThinkTankStepKey(
                usedKeys,
                moderatorSummaryCount === 0 ? "midpoint" : `midpoint_${moderatorSummaryCount + 1}`,
              );
        if (summaryKind !== "final" && step.kind !== "final_summary") {
          moderatorSummaryCount += 1;
        }
        return {
          key: canonicalKey,
          kind: step.kind,
          title: step.title,
          order: step.order,
          status: "completed",
          moderatorSummary: {
            summaryKind,
            summary: step.summary,
          },
        } satisfies ThinkTankEpisodeStepSnapshot;
      }

      errorCount += 1;
      return {
        key: allocateCanonicalThinkTankStepKey(
          usedKeys,
          errorCount === 1 ? "error" : `error_${errorCount}`,
        ),
        kind: "error",
        title: step.title,
        order: step.order,
        status: "failed",
        error: {
          message: step.errorMessage ?? "Think tank step failed.",
        },
      } satisfies ThinkTankEpisodeStepSnapshot;
    });
}

export function buildDefaultThinkTankPlannedSteps(): Array<{
  key: string;
  kind: ThinkTankEpisodeStepSnapshot["kind"];
  title: string;
  order: number;
}> {
  return [
    {
      key: "round_1",
      kind: "participant_round",
      title: "Round 1 · 独立观点",
      order: 10,
    },
  ];
}

function resolveRunningParticipantRoundSlot(input: {
  key?: string;
  roundIndex?: number;
  order?: number;
  existingSteps: ThinkTankEpisodeStepSnapshot[];
}): {
  key: string;
  roundIndex: number;
  existing: ThinkTankEpisodeStepSnapshot | null;
} {
  const explicitRoundIndex =
    input.roundIndex ??
    parseThinkTankRoundIndexFromKey(input.key) ??
    parseThinkTankRoundIndexFromOrder(input.order) ??
    latestPendingParticipantRoundIndex(input.existingSteps) ??
    nextThinkTankParticipantRoundIndex(input.existingSteps);
  const canonicalKey = `round_${explicitRoundIndex}`;
  const existing =
    input.existingSteps.find((step) => step.key === canonicalKey) ??
    input.existingSteps.find(
      (step) =>
        step.kind === "participant_round" &&
        (step.participantRound?.roundIndex ?? parseThinkTankRoundIndexFromKey(step.key)) ===
          explicitRoundIndex,
    ) ??
    null;

  return {
    key: canonicalKey,
    roundIndex: explicitRoundIndex,
    existing,
  };
}

function resolveRunningModeratorSummarySlot(input: {
  key?: string;
  kind: "moderator_summary" | "final_summary";
  roundIndex?: number;
  order?: number;
  summaryKind?: "midpoint" | "final";
  existingSteps: ThinkTankEpisodeStepSnapshot[];
}): {
  key: string;
  kind: "moderator_summary" | "final_summary";
  roundIndex: number;
  summaryKind: "midpoint" | "final";
  existing: ThinkTankEpisodeStepSnapshot | null;
} {
  const summaryKind =
    input.kind === "final_summary" || input.summaryKind === "final" || input.key === "final"
      ? "final"
      : "midpoint";
  const roundIndex =
    input.roundIndex ??
    parseThinkTankSummaryRoundIndexFromKey(input.key) ??
    parseThinkTankSummaryRoundIndexFromOrder(input.order) ??
    inferThinkTankSummaryRoundIndex(input.existingSteps, summaryKind);
  const key =
    summaryKind === "final" ? "final" : roundIndex <= 1 ? "midpoint" : `midpoint_${roundIndex}`;
  const existing =
    input.existingSteps.find((step) => step.key === key) ??
    input.existingSteps.find((step) => {
      if (summaryKind === "final") {
        return step.kind === "final_summary" || step.key === "final";
      }
      if (step.kind !== "moderator_summary") {
        return false;
      }
      const existingRoundIndex =
        parseThinkTankSummaryRoundIndexFromKey(step.key) ??
        parseThinkTankSummaryRoundIndexFromOrder(step.order) ??
        1;
      return existingRoundIndex === roundIndex;
    }) ??
    null;

  return {
    key,
    kind: summaryKind === "final" ? "final_summary" : "moderator_summary",
    roundIndex,
    summaryKind,
    existing,
  };
}

function findThinkTankErrorStepByKey(input: {
  steps: ThinkTankEpisodeStepSnapshot[];
  key?: string;
}): ThinkTankEpisodeStepSnapshot | null {
  if (input.key != null && input.key.trim().length > 0) {
    const normalizedKey = input.key.trim();
    return input.steps.find((step) => step.key === normalizedKey) ?? null;
  }
  return input.steps.find((step) => step.kind === "error") ?? null;
}

function mergeParticipantRoundEntries(input: {
  existingEntries: ThinkTankParticipantRoundEntry[];
  upsertEntries: NonNullable<ThinkTankEpisodeStepUpsertInput["participantEntries"]>;
  participants: ThinkTankParticipantRecord[];
  participantIndex: Map<string, ThinkTankParticipantRecord>;
}): ThinkTankParticipantRoundEntry[] {
  const entriesByParticipantId = new Map(
    input.existingEntries.map((entry) => [entry.participantId, entry] as const),
  );

  for (const entry of input.upsertEntries) {
    const participant = input.participantIndex.get(entry.participantId);
    if (participant == null) {
      throw new Error(`Think tank progress referenced unknown participant ${entry.participantId}`);
    }
    entriesByParticipantId.set(entry.participantId, {
      participantId: participant.participantId,
      title: participant.title,
      model: participant.modelId,
      preview: buildThinkTankPreview(entry.content),
      content: entry.content,
    });
  }

  return input.participants
    .map((participant) => entriesByParticipantId.get(participant.participantId) ?? null)
    .filter((entry): entry is ThinkTankParticipantRoundEntry => entry != null);
}

function normalizeNonEmptyThinkTankText(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseThinkTankRoundIndexFromKey(key: string | undefined): number | null {
  if (key == null) {
    return null;
  }
  const match = /^round_(\d+)$/.exec(key.trim());
  if (match == null) {
    return null;
  }
  const digits = match[1];
  if (digits == null) {
    return null;
  }
  const parsed = Number.parseInt(digits, 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

function parseThinkTankRoundIndexFromOrder(order: number | undefined): number | null {
  if (order == null || order < 10 || (order - 10) % 20 !== 0) {
    return null;
  }
  return (order - 10) / 20 + 1;
}

function parseThinkTankSummaryRoundIndexFromKey(key: string | undefined): number | null {
  if (key == null) {
    return null;
  }
  const trimmed = key.trim();
  if (trimmed === "midpoint") {
    return 1;
  }
  const match = /^midpoint_(\d+)$/.exec(trimmed);
  if (match == null) {
    return null;
  }
  const digits = match[1];
  if (digits == null) {
    return null;
  }
  const parsed = Number.parseInt(digits, 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

function parseThinkTankSummaryRoundIndexFromOrder(order: number | undefined): number | null {
  if (order == null || order < 20 || order % 20 !== 0) {
    return null;
  }
  return order / 20;
}

function latestPendingParticipantRoundIndex(steps: ThinkTankEpisodeStepSnapshot[]): number | null {
  const pendingRounds = steps
    .filter((step) => step.kind === "participant_round" && step.status === "pending")
    .map((step) => step.participantRound?.roundIndex ?? parseThinkTankRoundIndexFromKey(step.key))
    .filter((roundIndex): roundIndex is number => roundIndex != null);
  if (pendingRounds.length === 0) {
    return null;
  }
  return Math.max(...pendingRounds);
}

function nextThinkTankParticipantRoundIndex(steps: ThinkTankEpisodeStepSnapshot[]): number {
  const existingRoundIndexes = steps
    .filter((step) => step.kind === "participant_round")
    .map((step) => step.participantRound?.roundIndex ?? parseThinkTankRoundIndexFromKey(step.key))
    .filter((roundIndex): roundIndex is number => roundIndex != null);
  if (existingRoundIndexes.length === 0) {
    return 1;
  }
  return Math.max(...existingRoundIndexes) + 1;
}

function inferThinkTankSummaryRoundIndex(
  steps: ThinkTankEpisodeStepSnapshot[],
  summaryKind: "midpoint" | "final",
): number {
  const summaryRoundIndexes = steps
    .filter((step) =>
      summaryKind === "final" ? step.kind === "final_summary" : step.kind === "moderator_summary",
    )
    .map((step) =>
      step.kind === "final_summary"
        ? parseThinkTankSummaryRoundIndexFromOrder(step.order)
        : (parseThinkTankSummaryRoundIndexFromKey(step.key) ??
          parseThinkTankSummaryRoundIndexFromOrder(step.order)),
    )
    .filter((roundIndex): roundIndex is number => roundIndex != null);

  if (summaryKind === "final") {
    const latestParticipantRound = nextThinkTankParticipantRoundIndex(steps) - 1;
    return Math.max(1, latestParticipantRound);
  }

  if (summaryRoundIndexes.length > 0) {
    return Math.max(...summaryRoundIndexes) + 1;
  }

  const latestParticipantRound = nextThinkTankParticipantRoundIndex(steps) - 1;
  return Math.max(1, latestParticipantRound);
}

function defaultThinkTankParticipantRoundTitle(roundIndex: number): string {
  return roundIndex <= 1 ? "Round 1 · 独立观点" : `Round ${String(roundIndex)} · 次轮观点`;
}

function defaultThinkTankParticipantRoundOrder(roundIndex: number): number {
  return (roundIndex - 1) * 20 + 10;
}

function defaultThinkTankSummaryTitle(input: {
  kind: "moderator_summary" | "final_summary";
  roundIndex: number;
}): string {
  if (input.kind === "final_summary") {
    return "Final Synthesis · 当前结论";
  }
  return input.roundIndex <= 1
    ? "Moderator Synthesis · 第一轮结论"
    : `Moderator Synthesis · 第 ${String(input.roundIndex)} 轮结论`;
}

function defaultThinkTankSummaryOrder(input: {
  kind: "moderator_summary" | "final_summary";
  roundIndex: number;
}): number {
  if (input.kind === "final_summary") {
    return Math.max(20, input.roundIndex * 20);
  }
  return input.roundIndex * 20;
}

function allocateCanonicalThinkTankStepKey(usedKeys: Set<string>, baseKey: string): string {
  let candidate = baseKey;
  let suffix = 2;
  while (usedKeys.has(candidate)) {
    candidate = `${baseKey}_${suffix}`;
    suffix += 1;
  }
  usedKeys.add(candidate);
  return candidate;
}

function buildThinkTankPreview(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= 120) {
    return normalized;
  }
  return `${normalized.slice(0, 117)}...`;
}
