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
      nextEpisode.steps.set(envelope.event.step.key, envelope.event.step);
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
