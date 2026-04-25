import { and, eq } from "drizzle-orm";

import { toCanonicalUtcIsoTimestamp } from "@/src/shared/time.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { channelThreads } from "@/src/storage/schema/tables.js";
import type { ChannelThread, NewChannelThread } from "@/src/storage/schema/types.js";

export interface UpsertChannelThreadInput {
  id: string;
  channelType: string;
  channelInstallationId: string;
  homeConversationId: string;
  externalChatId: string;
  externalThreadId: string;
  subjectKind: "chat" | "task" | "think_tank";
  branchId?: string | null;
  rootTaskRunId?: string | null;
  rootThinkTankConsultationId?: string | null;
  openedFromMessageId?: string | null;
  status?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export class ChannelThreadsRepo {
  constructor(private readonly db: StorageDb) {}

  upsert(input: UpsertChannelThreadInput): ChannelThread {
    const createdAt = input.createdAt ?? new Date();
    const updatedAt = input.updatedAt ?? createdAt;
    const row: NewChannelThread = {
      id: input.id,
      channelType: input.channelType,
      channelInstallationId: input.channelInstallationId,
      homeConversationId: input.homeConversationId,
      externalChatId: input.externalChatId,
      externalThreadId: input.externalThreadId,
      subjectKind: input.subjectKind,
      branchId: input.branchId ?? null,
      rootTaskRunId: input.rootTaskRunId ?? null,
      rootThinkTankConsultationId: input.rootThinkTankConsultationId ?? null,
      openedFromMessageId: input.openedFromMessageId ?? null,
      status: input.status ?? "active",
      createdAt: toCanonicalUtcIsoTimestamp(createdAt),
      updatedAt: toCanonicalUtcIsoTimestamp(updatedAt),
    };

    this.db
      .insert(channelThreads)
      .values(row)
      .onConflictDoUpdate({
        target: [
          channelThreads.channelType,
          channelThreads.channelInstallationId,
          channelThreads.externalChatId,
          channelThreads.externalThreadId,
        ],
        set: {
          homeConversationId: row.homeConversationId,
          subjectKind: row.subjectKind,
          branchId: row.branchId,
          rootTaskRunId: row.rootTaskRunId,
          rootThinkTankConsultationId: row.rootThinkTankConsultationId,
          openedFromMessageId: row.openedFromMessageId,
          status: row.status,
          updatedAt: row.updatedAt,
        },
      })
      .run();

    const created = this.getByExternalThread({
      channelType: input.channelType,
      channelInstallationId: input.channelInstallationId,
      externalChatId: input.externalChatId,
      externalThreadId: input.externalThreadId,
    });
    if (created == null) {
      throw new Error(`Channel thread ${input.id} disappeared after upsert`);
    }
    return created;
  }

  getById(id: string): ChannelThread | null {
    return this.db.select().from(channelThreads).where(eq(channelThreads.id, id)).get() ?? null;
  }

  getByExternalThread(input: {
    channelType: string;
    channelInstallationId: string;
    externalChatId: string;
    externalThreadId: string;
  }): ChannelThread | null {
    return (
      this.db
        .select()
        .from(channelThreads)
        .where(
          and(
            eq(channelThreads.channelType, input.channelType),
            eq(channelThreads.channelInstallationId, input.channelInstallationId),
            eq(channelThreads.externalChatId, input.externalChatId),
            eq(channelThreads.externalThreadId, input.externalThreadId),
          ),
        )
        .get() ?? null
    );
  }

  getByRootTaskRun(input: {
    channelType: string;
    channelInstallationId: string;
    rootTaskRunId: string;
  }): ChannelThread | null {
    return (
      this.db
        .select()
        .from(channelThreads)
        .where(
          and(
            eq(channelThreads.channelType, input.channelType),
            eq(channelThreads.channelInstallationId, input.channelInstallationId),
            eq(channelThreads.rootTaskRunId, input.rootTaskRunId),
          ),
        )
        .get() ?? null
    );
  }

  getByRootThinkTankConsultation(input: {
    channelType: string;
    channelInstallationId: string;
    rootThinkTankConsultationId: string;
  }): ChannelThread | null {
    return (
      this.db
        .select()
        .from(channelThreads)
        .where(
          and(
            eq(channelThreads.channelType, input.channelType),
            eq(channelThreads.channelInstallationId, input.channelInstallationId),
            eq(channelThreads.rootThinkTankConsultationId, input.rootThinkTankConsultationId),
          ),
        )
        .get() ?? null
    );
  }

  patchByRootThinkTankConsultation(input: {
    channelType: string;
    channelInstallationId: string;
    rootThinkTankConsultationId: string;
    homeConversationId?: string;
    externalChatId?: string;
    externalThreadId?: string;
    subjectKind?: "chat" | "task" | "think_tank";
    openedFromMessageId?: string | null;
    status?: string;
    updatedAt?: Date;
  }): ChannelThread | null {
    const updatedAt = input.updatedAt ?? new Date();
    const result = this.db
      .update(channelThreads)
      .set({
        ...(input.homeConversationId === undefined
          ? {}
          : { homeConversationId: input.homeConversationId }),
        ...(input.externalChatId === undefined ? {} : { externalChatId: input.externalChatId }),
        ...(input.externalThreadId === undefined
          ? {}
          : { externalThreadId: input.externalThreadId }),
        ...(input.subjectKind === undefined ? {} : { subjectKind: input.subjectKind }),
        ...(input.openedFromMessageId === undefined
          ? {}
          : { openedFromMessageId: input.openedFromMessageId }),
        ...(input.status === undefined ? {} : { status: input.status }),
        updatedAt: toCanonicalUtcIsoTimestamp(updatedAt),
      })
      .where(
        and(
          eq(channelThreads.channelType, input.channelType),
          eq(channelThreads.channelInstallationId, input.channelInstallationId),
          eq(channelThreads.rootThinkTankConsultationId, input.rootThinkTankConsultationId),
        ),
      )
      .run();

    if ((result.changes ?? 0) < 1) {
      return null;
    }

    return this.getByRootThinkTankConsultation({
      channelType: input.channelType,
      channelInstallationId: input.channelInstallationId,
      rootThinkTankConsultationId: input.rootThinkTankConsultationId,
    });
  }

  getByBranch(input: {
    channelType: string;
    channelInstallationId: string;
    branchId: string;
  }): ChannelThread | null {
    return (
      this.db
        .select()
        .from(channelThreads)
        .where(
          and(
            eq(channelThreads.channelType, input.channelType),
            eq(channelThreads.channelInstallationId, input.channelInstallationId),
            eq(channelThreads.branchId, input.branchId),
          ),
        )
        .get() ?? null
    );
  }
}
