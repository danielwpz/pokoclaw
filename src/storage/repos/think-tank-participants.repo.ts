import { and, asc, eq } from "drizzle-orm";

import { toCanonicalUtcIsoTimestamp } from "@/src/shared/time.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { thinkTankParticipants } from "@/src/storage/schema/tables.js";
import type { NewThinkTankParticipant, ThinkTankParticipant } from "@/src/storage/schema/types.js";

export interface CreateThinkTankParticipantInput {
  id: string;
  consultationId: string;
  participantId: string;
  title?: string | null;
  modelId: string;
  personaText: string;
  continuationSessionId: string;
  sortOrder: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export class ThinkTankParticipantsRepo {
  constructor(private readonly db: StorageDb) {}

  create(input: CreateThinkTankParticipantInput): void {
    const createdAt = input.createdAt ?? new Date();
    const updatedAt = input.updatedAt ?? createdAt;
    const row: NewThinkTankParticipant = {
      id: input.id,
      consultationId: input.consultationId,
      participantId: input.participantId,
      title: input.title ?? null,
      modelId: input.modelId,
      personaText: input.personaText,
      continuationSessionId: input.continuationSessionId,
      sortOrder: input.sortOrder,
      createdAt: toCanonicalUtcIsoTimestamp(createdAt),
      updatedAt: toCanonicalUtcIsoTimestamp(updatedAt),
    };

    this.db.insert(thinkTankParticipants).values(row).run();
  }

  listByConsultation(consultationId: string): ThinkTankParticipant[] {
    return this.db
      .select()
      .from(thinkTankParticipants)
      .where(eq(thinkTankParticipants.consultationId, consultationId))
      .orderBy(asc(thinkTankParticipants.sortOrder), asc(thinkTankParticipants.createdAt))
      .all();
  }

  getByParticipantId(input: {
    consultationId: string;
    participantId: string;
  }): ThinkTankParticipant | null {
    return (
      this.db
        .select()
        .from(thinkTankParticipants)
        .where(
          and(
            eq(thinkTankParticipants.consultationId, input.consultationId),
            eq(thinkTankParticipants.participantId, input.participantId),
          ),
        )
        .get() ?? null
    );
  }

  getByContinuationSessionId(continuationSessionId: string): ThinkTankParticipant | null {
    return (
      this.db
        .select()
        .from(thinkTankParticipants)
        .where(eq(thinkTankParticipants.continuationSessionId, continuationSessionId))
        .get() ?? null
    );
  }
}
