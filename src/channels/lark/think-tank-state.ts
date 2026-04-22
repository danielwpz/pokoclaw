import type { OrchestratedThinkTankEventEnvelope } from "@/src/orchestration/outbound-events.js";
import type {
  ThinkTankConsultationStatus,
  ThinkTankEpisodeStatus,
  ThinkTankEpisodeStepSnapshot,
  ThinkTankStructuredSummary,
} from "@/src/think-tank/types.js";

export interface LarkThinkTankParticipantDisplay {
  id: string;
  title: string | null;
  model: string;
}

export interface LarkThinkTankEpisodeState {
  episodeId: string;
  episodeSequence: number;
  prompt: string;
  status: ThinkTankEpisodeStatus;
  plannedSteps: Array<{
    key: string;
    kind: ThinkTankEpisodeStepSnapshot["kind"];
    title: string;
    order: number;
  }> | null;
  steps: Map<string, ThinkTankEpisodeStepSnapshot>;
}

export interface LarkThinkTankConsultationState {
  consultationId: string;
  conversationId: string;
  branchId: string;
  topic: string;
  status: ThinkTankConsultationStatus;
  participants: LarkThinkTankParticipantDisplay[];
  latestSummary: ThinkTankStructuredSummary | null;
  firstCompleted: boolean;
  episodes: Map<string, LarkThinkTankEpisodeState>;
}

export function reduceLarkThinkTankState(
  previous: LarkThinkTankConsultationState | null,
  envelope: OrchestratedThinkTankEventEnvelope,
): LarkThinkTankConsultationState {
  const initialTopic =
    envelope.event.type === "consultation_upserted" ? envelope.event.topic : null;
  const base =
    previous == null
      ? {
          consultationId: envelope.consultationId,
          conversationId: envelope.target.conversationId,
          branchId: envelope.target.branchId,
          topic: initialTopic ?? "Think Tank",
          status:
            envelope.event.type === "consultation_upserted" ? envelope.event.status : "running",
          participants:
            envelope.event.type === "consultation_upserted" ? envelope.event.participants : [],
          latestSummary:
            envelope.event.type === "consultation_upserted" ? envelope.event.latestSummary : null,
          firstCompleted:
            envelope.event.type === "consultation_upserted" ? envelope.event.firstCompleted : false,
          episodes: new Map<string, LarkThinkTankEpisodeState>(),
        }
      : {
          ...previous,
          episodes: new Map(previous.episodes),
        };

  switch (envelope.event.type) {
    case "consultation_upserted":
      return {
        ...base,
        consultationId: envelope.consultationId,
        conversationId: envelope.target.conversationId,
        branchId: envelope.target.branchId,
        topic: envelope.event.topic,
        status: envelope.event.status,
        participants: envelope.event.participants,
        latestSummary: envelope.event.latestSummary,
        firstCompleted: envelope.event.firstCompleted,
      };

    case "episode_started": {
      const nextEpisode: LarkThinkTankEpisodeState = {
        episodeId: envelope.event.episodeId,
        episodeSequence: envelope.event.episodeSequence,
        prompt: envelope.event.prompt,
        status: "running",
        plannedSteps: envelope.event.plannedSteps,
        steps: new Map<string, ThinkTankEpisodeStepSnapshot>(),
      };
      materializeNextPendingThinkTankStep(nextEpisode);
      base.episodes.set(envelope.event.episodeId, nextEpisode);
      return base;
    }

    case "episode_step_upserted": {
      const existingEpisode = base.episodes.get(envelope.event.episodeId);
      const nextEpisode: LarkThinkTankEpisodeState =
        existingEpisode == null
          ? {
              episodeId: envelope.event.episodeId,
              episodeSequence: envelope.event.episodeSequence,
              prompt: "",
              status: "running",
              plannedSteps: null,
              steps: new Map<string, ThinkTankEpisodeStepSnapshot>(),
            }
          : {
              ...existingEpisode,
              steps: new Map(existingEpisode.steps),
            };
      const normalizedStep = normalizeLarkThinkTankEpisodeStep({
        episode: nextEpisode,
        step: envelope.event.step,
      });
      nextEpisode.steps.set(normalizedStep.key, normalizedStep);
      base.episodes.set(envelope.event.episodeId, nextEpisode);
      return base;
    }

    case "episode_settled": {
      const existingEpisode = base.episodes.get(envelope.event.episodeId);
      const nextEpisode: LarkThinkTankEpisodeState =
        existingEpisode == null
          ? {
              episodeId: envelope.event.episodeId,
              episodeSequence: envelope.event.episodeSequence,
              prompt: "",
              status: envelope.event.status,
              plannedSteps: null,
              steps: new Map<string, ThinkTankEpisodeStepSnapshot>(),
            }
          : {
              ...existingEpisode,
              status: envelope.event.status,
              steps: new Map(existingEpisode.steps),
            };
      base.episodes.set(envelope.event.episodeId, nextEpisode);
      return base;
    }
  }
}

export function getLarkThinkTankEpisodeState(
  consultation: LarkThinkTankConsultationState,
  episodeId: string,
): LarkThinkTankEpisodeState | null {
  return consultation.episodes.get(episodeId) ?? null;
}

function materializeNextPendingThinkTankStep(episode: LarkThinkTankEpisodeState): void {
  if (episode.status !== "running" || episode.plannedSteps == null) {
    return;
  }

  for (const plannedStep of [...episode.plannedSteps].sort(
    (left, right) => left.order - right.order,
  )) {
    const existing = episode.steps.get(plannedStep.key);
    if (existing == null) {
      episode.steps.set(plannedStep.key, {
        key: plannedStep.key,
        kind: plannedStep.kind,
        title: plannedStep.title,
        order: plannedStep.order,
        status: "pending",
      });
      return;
    }
    if (existing.status !== "completed") {
      return;
    }
  }
}

function normalizeLarkThinkTankEpisodeStep(input: {
  episode: LarkThinkTankEpisodeState;
  step: ThinkTankEpisodeStepSnapshot;
}): ThinkTankEpisodeStepSnapshot {
  const matchedPlaceholderKey = findMatchingPendingPlaceholderKey(input);
  if (matchedPlaceholderKey == null || matchedPlaceholderKey === input.step.key) {
    return input.step;
  }
  return {
    ...input.step,
    key: matchedPlaceholderKey,
  };
}

function findMatchingPendingPlaceholderKey(input: {
  episode: LarkThinkTankEpisodeState;
  step: ThinkTankEpisodeStepSnapshot;
}): string | null {
  if (input.episode.steps.has(input.step.key)) {
    return null;
  }

  for (const existingStep of input.episode.steps.values()) {
    if (existingStep.status !== "pending") {
      continue;
    }
    if (!isSameThinkTankStepSlot(existingStep, input.step)) {
      continue;
    }
    return existingStep.key;
  }

  return null;
}

function isSameThinkTankStepSlot(
  left: ThinkTankEpisodeStepSnapshot,
  right: ThinkTankEpisodeStepSnapshot,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  if (left.kind === "participant_round" && right.kind === "participant_round") {
    const leftRoundIndex =
      left.participantRound?.roundIndex ?? parseThinkTankRoundIndexFromKey(left.key);
    const rightRoundIndex =
      right.participantRound?.roundIndex ?? parseThinkTankRoundIndexFromKey(right.key);
    if (leftRoundIndex != null && rightRoundIndex != null) {
      return leftRoundIndex === rightRoundIndex;
    }
    return left.order === right.order;
  }

  if (left.kind === "moderator_summary" && right.kind === "moderator_summary") {
    const leftSummaryKind = left.moderatorSummary?.summaryKind;
    const rightSummaryKind = right.moderatorSummary?.summaryKind;
    if (leftSummaryKind != null && rightSummaryKind != null) {
      return leftSummaryKind === rightSummaryKind;
    }
    return left.order === right.order;
  }

  if (left.kind === "final_summary" && right.kind === "final_summary") {
    return true;
  }

  return left.order === right.order;
}

function parseThinkTankRoundIndexFromKey(key: string): number | null {
  const match = /^round_(\d+)$/.exec(key);
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
