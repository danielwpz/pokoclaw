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
  subjectKind: "chat" | "task";
  branchId?: string | null;
  rootTaskRunId?: string | null;
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
