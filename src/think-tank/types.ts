export type ThinkTankConsultationStatus = "running" | "idle";

export type ThinkTankEpisodeStatus = "running" | "completed" | "failed" | "cancelled";

export interface ThinkTankParticipantDefinition {
  id: string;
  model: string;
  persona: string;
  title?: string | null;
}

export interface ThinkTankParticipantAssignment {
  id: string;
  model: string;
  title: string | null;
  continuationSessionId: string;
}

export interface ThinkTankCapabilities {
  availableModels: string[];
  recommendedParticipantCount: number;
  maxParticipantCount: number;
}

export interface ThinkTankStructuredSummary {
  agreements: string[];
  keyDifferences: string[];
  currentConclusion: string;
  openQuestions: string[];
}

export type ThinkTankEpisodeStepKind =
  | "participant_round"
  | "moderator_summary"
  | "final_summary"
  | "error";

export type ThinkTankEpisodeStepStatus = "pending" | "completed" | "failed";

export interface ThinkTankParticipantRoundEntry {
  participantId: string;
  title: string | null;
  model: string;
  preview: string;
  content: string;
}

export interface ThinkTankParticipantRoundEntryInput {
  participantId: string;
  content: string;
}

export interface ThinkTankParticipantRoundStepHint {
  key?: string;
  title?: string | null;
  order?: number;
  roundIndex?: number;
}

export interface ThinkTankEpisodeStepSnapshot {
  key: string;
  kind: ThinkTankEpisodeStepKind;
  title: string;
  order: number;
  status: ThinkTankEpisodeStepStatus;
  participantRound?: {
    roundIndex: number;
    entries: ThinkTankParticipantRoundEntry[];
  };
  moderatorSummary?: {
    summaryKind: "midpoint" | "final";
    summary: ThinkTankStructuredSummary;
  };
  error?: {
    message: string;
  };
}

export interface ThinkTankEpisodeStepUpsertInput {
  key?: string;
  kind: ThinkTankEpisodeStepKind;
  status: ThinkTankEpisodeStepStatus;
  title?: string | null;
  order?: number;
  roundIndex?: number;
  participantEntries?: ThinkTankParticipantRoundEntryInput[];
  summaryKind?: "midpoint" | "final";
  summary?: ThinkTankStructuredSummary;
  errorMessage?: string;
}

export interface ThinkTankEpisodeResult {
  steps: ThinkTankEpisodeStepSnapshot[];
  latestSummary: ThinkTankStructuredSummary | null;
}

export interface ThinkTankConsultationStatusView {
  consultationId: string;
  topic: string;
  status: ThinkTankConsultationStatus;
  latestEpisodeStatus: ThinkTankEpisodeStatus | null;
  participants: ThinkTankParticipantAssignment[];
  latestSummary: ThinkTankStructuredSummary | null;
  updatedAt: string;
}
