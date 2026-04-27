import { eq } from "drizzle-orm";

import { toCanonicalUtcIsoTimestamp } from "@/src/shared/time.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { agentRuntimeModes } from "@/src/storage/schema/tables.js";
import type { AgentRuntimeMode, NewAgentRuntimeMode } from "@/src/storage/schema/types.js";

export interface SetYoloEnabledInput {
  ownerAgentId: string;
  enabled: boolean;
  updatedAt?: Date;
  updatedBy?: string | null;
  snoozedUntil?: Date | null;
}

export interface ToggleYoloInput {
  ownerAgentId: string;
  updatedAt?: Date;
  updatedBy?: string | null;
  disableSnoozedUntil?: Date | null;
}

export interface UpdateYoloPromptStateInput {
  ownerAgentId: string;
  updatedAt?: Date;
  approvalStreakCount?: number;
  approvalStreakStartedAt?: Date | null;
  lastApprovalRequestedAt?: Date | null;
  lastYoloPromptedAt?: Date | null;
  yoloPromptCountToday?: number;
  yoloPromptCountDay?: string | null;
  yoloSnoozedUntil?: Date | null;
}

export class AgentRuntimeModesRepo {
  constructor(private readonly db: StorageDb) {}

  getByOwnerAgentId(ownerAgentId: string): AgentRuntimeMode | null {
    return (
      this.db
        .select()
        .from(agentRuntimeModes)
        .where(eq(agentRuntimeModes.ownerAgentId, ownerAgentId))
        .get() ?? null
    );
  }

  isYoloEnabled(ownerAgentId: string): boolean {
    return this.getByOwnerAgentId(ownerAgentId)?.yoloEnabled ?? false;
  }

  setYoloEnabled(input: SetYoloEnabledInput): AgentRuntimeMode {
    const updatedAt = input.updatedAt ?? new Date();
    const updatedAtIso = toCanonicalUtcIsoTimestamp(updatedAt);
    const yoloEnabledAt = input.enabled ? updatedAtIso : null;
    const snoozedUntil =
      input.snoozedUntil === undefined
        ? undefined
        : input.snoozedUntil == null
          ? null
          : toCanonicalUtcIsoTimestamp(input.snoozedUntil);
    const row: NewAgentRuntimeMode = {
      ownerAgentId: input.ownerAgentId,
      yoloEnabled: input.enabled,
      yoloEnabledAt,
      yoloUpdatedAt: updatedAtIso,
      yoloUpdatedBy: input.updatedBy ?? null,
      approvalStreakCount: 0,
      approvalStreakStartedAt: null,
      lastApprovalRequestedAt: null,
      lastYoloPromptedAt: null,
      yoloPromptCountToday: 0,
      yoloPromptCountDay: null,
      yoloSnoozedUntil: snoozedUntil ?? null,
    };

    this.db
      .insert(agentRuntimeModes)
      .values(row)
      .onConflictDoUpdate({
        target: agentRuntimeModes.ownerAgentId,
        set: {
          yoloEnabled: row.yoloEnabled,
          yoloEnabledAt: row.yoloEnabledAt,
          yoloUpdatedAt: row.yoloUpdatedAt,
          yoloUpdatedBy: row.yoloUpdatedBy,
          approvalStreakCount: 0,
          approvalStreakStartedAt: null,
          lastApprovalRequestedAt: null,
          ...(snoozedUntil === undefined ? {} : { yoloSnoozedUntil: snoozedUntil }),
        },
      })
      .run();

    return this.requireByOwnerAgentId(input.ownerAgentId);
  }

  toggleYolo(input: ToggleYoloInput): AgentRuntimeMode {
    const enabled = !this.isYoloEnabled(input.ownerAgentId);
    return this.setYoloEnabled({
      ownerAgentId: input.ownerAgentId,
      enabled,
      ...(input.updatedAt == null ? {} : { updatedAt: input.updatedAt }),
      updatedBy: input.updatedBy ?? null,
      ...(enabled || input.disableSnoozedUntil === undefined
        ? {}
        : { snoozedUntil: input.disableSnoozedUntil }),
    });
  }

  updateYoloPromptState(input: UpdateYoloPromptStateInput): AgentRuntimeMode {
    const updatedAt = input.updatedAt ?? new Date();
    this.ensureRow(input.ownerAgentId, updatedAt);

    this.db
      .update(agentRuntimeModes)
      .set({
        ...(input.approvalStreakCount === undefined
          ? {}
          : { approvalStreakCount: input.approvalStreakCount }),
        ...(input.approvalStreakStartedAt === undefined
          ? {}
          : {
              approvalStreakStartedAt:
                input.approvalStreakStartedAt == null
                  ? null
                  : toCanonicalUtcIsoTimestamp(input.approvalStreakStartedAt),
            }),
        ...(input.lastApprovalRequestedAt === undefined
          ? {}
          : {
              lastApprovalRequestedAt:
                input.lastApprovalRequestedAt == null
                  ? null
                  : toCanonicalUtcIsoTimestamp(input.lastApprovalRequestedAt),
            }),
        ...(input.lastYoloPromptedAt === undefined
          ? {}
          : {
              lastYoloPromptedAt:
                input.lastYoloPromptedAt == null
                  ? null
                  : toCanonicalUtcIsoTimestamp(input.lastYoloPromptedAt),
            }),
        ...(input.yoloPromptCountToday === undefined
          ? {}
          : { yoloPromptCountToday: input.yoloPromptCountToday }),
        ...(input.yoloPromptCountDay === undefined
          ? {}
          : { yoloPromptCountDay: input.yoloPromptCountDay }),
        ...(input.yoloSnoozedUntil === undefined
          ? {}
          : {
              yoloSnoozedUntil:
                input.yoloSnoozedUntil == null
                  ? null
                  : toCanonicalUtcIsoTimestamp(input.yoloSnoozedUntil),
            }),
      })
      .where(eq(agentRuntimeModes.ownerAgentId, input.ownerAgentId))
      .run();

    return this.requireByOwnerAgentId(input.ownerAgentId);
  }

  private ensureRow(ownerAgentId: string, now: Date): void {
    if (this.getByOwnerAgentId(ownerAgentId) != null) {
      return;
    }

    this.db
      .insert(agentRuntimeModes)
      .values({
        ownerAgentId,
        yoloEnabled: false,
        yoloEnabledAt: null,
        yoloUpdatedAt: toCanonicalUtcIsoTimestamp(now),
        yoloUpdatedBy: null,
        approvalStreakCount: 0,
        approvalStreakStartedAt: null,
        lastApprovalRequestedAt: null,
        lastYoloPromptedAt: null,
        yoloPromptCountToday: 0,
        yoloPromptCountDay: null,
        yoloSnoozedUntil: null,
      })
      .onConflictDoNothing()
      .run();
  }

  private requireByOwnerAgentId(ownerAgentId: string): AgentRuntimeMode {
    const row = this.getByOwnerAgentId(ownerAgentId);
    if (row == null) {
      throw new Error(`Agent runtime mode row missing after write: ${ownerAgentId}`);
    }
    return row;
  }
}
