import type { StorageDb } from "@/src/storage/db/client.js";
import { AgentRuntimeModesRepo } from "@/src/storage/repos/agent-runtime-modes.repo.js";
import type { AgentRuntimeMode } from "@/src/storage/schema/types.js";

export const YOLO_SUGGESTION_APPROVAL_THRESHOLD = 2;
export const YOLO_SUGGESTION_STREAK_WINDOW_MS = 5 * 60 * 1000;
export const YOLO_SUGGESTION_DEBOUNCE_MS = 12 * 60 * 60 * 1000;
export const YOLO_MANUAL_DISABLE_SNOOZE_MS = 3 * 24 * 60 * 60 * 1000;
export const YOLO_SUGGESTION_MESSAGE =
  "💡 Too many approval stops? Send `/yolo` if you want this agent to keep going without asking each time.";

export type EffectiveApprovalModeSource = "normal" | "yolo" | "autopilot";

export interface EffectiveApprovalMode {
  autopilotEnabled: boolean;
  yoloEnabled: boolean;
  skipHumanApproval: boolean;
  source: EffectiveApprovalModeSource;
}

export interface RuntimeModeServiceInput {
  storage: StorageDb;
  autopilotEnabled: boolean;
}

export interface ToggleYoloRuntimeModeInput {
  ownerAgentId: string;
  updatedBy?: string | null;
  updatedAt?: Date;
}

export interface RecordApprovalRequestForYoloSuggestionInput {
  ownerAgentId: string | null | undefined;
  approvalTarget: "user" | "main_agent";
  requestedAt?: Date;
}

export class RuntimeModeService {
  private readonly repo: AgentRuntimeModesRepo;

  constructor(private readonly input: RuntimeModeServiceInput) {
    this.repo = new AgentRuntimeModesRepo(input.storage);
  }

  isAutopilotEnabled(): boolean {
    return this.input.autopilotEnabled;
  }

  getEffectiveApprovalMode(ownerAgentId: string | null | undefined): EffectiveApprovalMode {
    const yoloEnabled =
      ownerAgentId == null || ownerAgentId.trim().length === 0
        ? false
        : this.repo.isYoloEnabled(ownerAgentId);

    if (this.input.autopilotEnabled) {
      return {
        autopilotEnabled: true,
        yoloEnabled,
        skipHumanApproval: true,
        source: "autopilot",
      };
    }

    if (yoloEnabled) {
      return {
        autopilotEnabled: false,
        yoloEnabled: true,
        skipHumanApproval: true,
        source: "yolo",
      };
    }

    return {
      autopilotEnabled: false,
      yoloEnabled: false,
      skipHumanApproval: false,
      source: "normal",
    };
  }

  toggleYolo(input: ToggleYoloRuntimeModeInput): AgentRuntimeMode {
    const updatedAt = input.updatedAt ?? new Date();
    return this.repo.toggleYolo({
      ownerAgentId: input.ownerAgentId,
      updatedAt,
      updatedBy: input.updatedBy ?? null,
      disableSnoozedUntil: new Date(updatedAt.getTime() + YOLO_MANUAL_DISABLE_SNOOZE_MS),
    });
  }

  recordApprovalRequestForYoloSuggestion(
    input: RecordApprovalRequestForYoloSuggestionInput,
  ): boolean {
    if (
      input.approvalTarget !== "user" ||
      this.input.autopilotEnabled ||
      input.ownerAgentId == null ||
      input.ownerAgentId.trim().length === 0
    ) {
      return false;
    }

    const ownerAgentId = input.ownerAgentId;
    const requestedAt = input.requestedAt ?? new Date();
    const existing = this.repo.getByOwnerAgentId(ownerAgentId);
    if (existing?.yoloEnabled === true) {
      return false;
    }

    const snoozedUntil = parseTimestamp(existing?.yoloSnoozedUntil);
    if (snoozedUntil != null && snoozedUntil.getTime() > requestedAt.getTime()) {
      return false;
    }

    const lastPromptedAt = parseTimestamp(existing?.lastYoloPromptedAt);
    if (
      lastPromptedAt != null &&
      requestedAt.getTime() - lastPromptedAt.getTime() < YOLO_SUGGESTION_DEBOUNCE_MS
    ) {
      return false;
    }

    const streakStartedAt = parseTimestamp(existing?.approvalStreakStartedAt);
    const lastApprovalRequestedAt = parseTimestamp(existing?.lastApprovalRequestedAt);
    const streakExpired =
      streakStartedAt == null ||
      lastApprovalRequestedAt == null ||
      requestedAt.getTime() - streakStartedAt.getTime() > YOLO_SUGGESTION_STREAK_WINDOW_MS;
    const nextStreakStartedAt = streakExpired ? requestedAt : streakStartedAt;
    const nextStreakCount = streakExpired ? 1 : (existing?.approvalStreakCount ?? 0) + 1;
    const shouldSuggest = nextStreakCount >= YOLO_SUGGESTION_APPROVAL_THRESHOLD;

    this.repo.updateYoloPromptState({
      ownerAgentId,
      updatedAt: requestedAt,
      approvalStreakCount: shouldSuggest ? 0 : nextStreakCount,
      approvalStreakStartedAt: shouldSuggest ? null : nextStreakStartedAt,
      lastApprovalRequestedAt: requestedAt,
      ...(shouldSuggest
        ? {
            lastYoloPromptedAt: requestedAt,
          }
        : {}),
    });

    return shouldSuggest;
  }
}

function parseTimestamp(value: string | null | undefined): Date | null {
  if (value == null) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
