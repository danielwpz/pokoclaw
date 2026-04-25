import { and, asc, desc, eq } from "drizzle-orm";

import { toCanonicalUtcIsoTimestamp } from "@/src/shared/time.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { thinkTankEpisodes } from "@/src/storage/schema/tables.js";
import type { NewThinkTankEpisode, ThinkTankEpisode } from "@/src/storage/schema/types.js";
import type { ThinkTankEpisodeResult } from "@/src/think-tank/types.js";

export interface CreateThinkTankEpisodeInput {
  id: string;
  consultationId: string;
  sequence: number;
  status: ThinkTankEpisode["status"];
  promptText: string;
  resultJson?: string | null;
  errorText?: string | null;
  startedAt?: Date;
  finishedAt?: Date | null;
}

export interface UpdateThinkTankEpisodeInput {
  id: string;
  status?: ThinkTankEpisode["status"];
  result?: ThinkTankEpisodeResult | null;
  errorText?: string | null;
  finishedAt?: Date | null;
}

export class ThinkTankEpisodesRepo {
  constructor(private readonly db: StorageDb) {}

  create(input: CreateThinkTankEpisodeInput): void {
    const startedAt = input.startedAt ?? new Date();
    const row: NewThinkTankEpisode = {
      id: input.id,
      consultationId: input.consultationId,
      sequence: input.sequence,
      status: input.status,
      promptText: input.promptText,
      resultJson: input.resultJson ?? null,
      errorText: input.errorText ?? null,
      startedAt: toCanonicalUtcIsoTimestamp(startedAt),
      finishedAt: input.finishedAt == null ? null : toCanonicalUtcIsoTimestamp(input.finishedAt),
    };

    this.db.insert(thinkTankEpisodes).values(row).run();
  }

  getById(id: string): ThinkTankEpisode | null {
    return (
      this.db.select().from(thinkTankEpisodes).where(eq(thinkTankEpisodes.id, id)).get() ?? null
    );
  }

  listByConsultation(consultationId: string): ThinkTankEpisode[] {
    return this.db
      .select()
      .from(thinkTankEpisodes)
      .where(eq(thinkTankEpisodes.consultationId, consultationId))
      .orderBy(asc(thinkTankEpisodes.sequence), asc(thinkTankEpisodes.startedAt))
      .all();
  }

  findLatestByConsultation(consultationId: string): ThinkTankEpisode | null {
    return (
      this.db
        .select()
        .from(thinkTankEpisodes)
        .where(eq(thinkTankEpisodes.consultationId, consultationId))
        .orderBy(desc(thinkTankEpisodes.sequence), desc(thinkTankEpisodes.startedAt))
        .get() ?? null
    );
  }

  findActiveByConsultation(consultationId: string): ThinkTankEpisode | null {
    return (
      this.db
        .select()
        .from(thinkTankEpisodes)
        .where(
          and(
            eq(thinkTankEpisodes.consultationId, consultationId),
            eq(thinkTankEpisodes.status, "running"),
          ),
        )
        .orderBy(desc(thinkTankEpisodes.sequence), desc(thinkTankEpisodes.startedAt))
        .get() ?? null
    );
  }

  update(input: UpdateThinkTankEpisodeInput): void {
    this.db
      .update(thinkTankEpisodes)
      .set({
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.result === undefined
          ? {}
          : { resultJson: input.result == null ? null : JSON.stringify(input.result) }),
        ...(input.errorText === undefined ? {} : { errorText: input.errorText }),
        ...(input.finishedAt === undefined
          ? {}
          : {
              finishedAt:
                input.finishedAt == null ? null : toCanonicalUtcIsoTimestamp(input.finishedAt),
            }),
      })
      .where(eq(thinkTankEpisodes.id, input.id))
      .run();
  }
}
