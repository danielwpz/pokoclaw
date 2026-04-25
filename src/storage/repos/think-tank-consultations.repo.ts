import { desc, eq } from "drizzle-orm";

import { toCanonicalUtcIsoTimestamp } from "@/src/shared/time.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { thinkTankConsultations } from "@/src/storage/schema/tables.js";
import type {
  NewThinkTankConsultation,
  ThinkTankConsultation,
} from "@/src/storage/schema/types.js";
import type { ThinkTankStructuredSummary } from "@/src/think-tank/types.js";

export interface CreateThinkTankConsultationInput {
  id: string;
  sourceSessionId: string;
  sourceConversationId: string;
  sourceBranchId: string;
  ownerAgentId: string;
  moderatorSessionId: string;
  moderatorModelId: string;
  status: ThinkTankConsultation["status"];
  topic: string;
  contextText: string;
  latestSummaryJson?: string | null;
  firstCompletedAt?: Date | null;
  firstCompletionNoticeAt?: Date | null;
  lastEpisodeStartedAt?: Date | null;
  lastEpisodeFinishedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface UpdateThinkTankConsultationInput {
  id: string;
  status?: ThinkTankConsultation["status"];
  latestSummary?: ThinkTankStructuredSummary | null;
  firstCompletedAt?: Date | null;
  firstCompletionNoticeAt?: Date | null;
  lastEpisodeStartedAt?: Date | null;
  lastEpisodeFinishedAt?: Date | null;
  updatedAt?: Date;
}

export class ThinkTankConsultationsRepo {
  constructor(private readonly db: StorageDb) {}

  create(input: CreateThinkTankConsultationInput): void {
    const createdAt = input.createdAt ?? new Date();
    const updatedAt = input.updatedAt ?? createdAt;
    const row: NewThinkTankConsultation = {
      id: input.id,
      sourceSessionId: input.sourceSessionId,
      sourceConversationId: input.sourceConversationId,
      sourceBranchId: input.sourceBranchId,
      ownerAgentId: input.ownerAgentId,
      moderatorSessionId: input.moderatorSessionId,
      moderatorModelId: input.moderatorModelId,
      status: input.status,
      topic: input.topic,
      contextText: input.contextText,
      latestSummaryJson: input.latestSummaryJson ?? null,
      firstCompletedAt:
        input.firstCompletedAt == null ? null : toCanonicalUtcIsoTimestamp(input.firstCompletedAt),
      firstCompletionNoticeAt:
        input.firstCompletionNoticeAt == null
          ? null
          : toCanonicalUtcIsoTimestamp(input.firstCompletionNoticeAt),
      lastEpisodeStartedAt:
        input.lastEpisodeStartedAt == null
          ? null
          : toCanonicalUtcIsoTimestamp(input.lastEpisodeStartedAt),
      lastEpisodeFinishedAt:
        input.lastEpisodeFinishedAt == null
          ? null
          : toCanonicalUtcIsoTimestamp(input.lastEpisodeFinishedAt),
      createdAt: toCanonicalUtcIsoTimestamp(createdAt),
      updatedAt: toCanonicalUtcIsoTimestamp(updatedAt),
    };

    this.db.insert(thinkTankConsultations).values(row).run();
  }

  getById(id: string): ThinkTankConsultation | null {
    return (
      this.db
        .select()
        .from(thinkTankConsultations)
        .where(eq(thinkTankConsultations.id, id))
        .get() ?? null
    );
  }

  getByModeratorSessionId(moderatorSessionId: string): ThinkTankConsultation | null {
    return (
      this.db
        .select()
        .from(thinkTankConsultations)
        .where(eq(thinkTankConsultations.moderatorSessionId, moderatorSessionId))
        .orderBy(desc(thinkTankConsultations.updatedAt), desc(thinkTankConsultations.createdAt))
        .get() ?? null
    );
  }

  findLatestBySourceSession(sourceSessionId: string): ThinkTankConsultation | null {
    return (
      this.db
        .select()
        .from(thinkTankConsultations)
        .where(eq(thinkTankConsultations.sourceSessionId, sourceSessionId))
        .orderBy(desc(thinkTankConsultations.updatedAt), desc(thinkTankConsultations.createdAt))
        .get() ?? null
    );
  }

  update(input: UpdateThinkTankConsultationInput): void {
    this.db
      .update(thinkTankConsultations)
      .set({
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.latestSummary === undefined
          ? {}
          : {
              latestSummaryJson:
                input.latestSummary == null ? null : JSON.stringify(input.latestSummary),
            }),
        ...(input.firstCompletedAt === undefined
          ? {}
          : {
              firstCompletedAt:
                input.firstCompletedAt == null
                  ? null
                  : toCanonicalUtcIsoTimestamp(input.firstCompletedAt),
            }),
        ...(input.firstCompletionNoticeAt === undefined
          ? {}
          : {
              firstCompletionNoticeAt:
                input.firstCompletionNoticeAt == null
                  ? null
                  : toCanonicalUtcIsoTimestamp(input.firstCompletionNoticeAt),
            }),
        ...(input.lastEpisodeStartedAt === undefined
          ? {}
          : {
              lastEpisodeStartedAt:
                input.lastEpisodeStartedAt == null
                  ? null
                  : toCanonicalUtcIsoTimestamp(input.lastEpisodeStartedAt),
            }),
        ...(input.lastEpisodeFinishedAt === undefined
          ? {}
          : {
              lastEpisodeFinishedAt:
                input.lastEpisodeFinishedAt == null
                  ? null
                  : toCanonicalUtcIsoTimestamp(input.lastEpisodeFinishedAt),
            }),
        updatedAt: toCanonicalUtcIsoTimestamp(input.updatedAt ?? new Date()),
      })
      .where(eq(thinkTankConsultations.id, input.id))
      .run();
  }
}
