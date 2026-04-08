import { eq } from "drizzle-orm";

import { toCanonicalUtcIsoTimestamp } from "@/src/shared/time.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { meditationState } from "@/src/storage/schema/tables.js";
import type { MeditationState, NewMeditationState } from "@/src/storage/schema/types.js";

export const DEFAULT_MEDITATION_STATE_ID = "default";

export interface MarkMeditationStartedInput {
  id?: string;
  startedAt?: Date;
}

export interface MarkMeditationFinishedInput {
  id?: string;
  status: string;
  finishedAt?: Date;
  markSuccess?: boolean;
}

export class MeditationStateRepo {
  constructor(private readonly db: StorageDb) {}

  get(id = DEFAULT_MEDITATION_STATE_ID): MeditationState | null {
    return this.db.select().from(meditationState).where(eq(meditationState.id, id)).get() ?? null;
  }

  getOrCreateDefault(now: Date = new Date()): MeditationState {
    const existing = this.get();
    if (existing != null) {
      return existing;
    }

    const row: NewMeditationState = {
      id: DEFAULT_MEDITATION_STATE_ID,
      running: false,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastSuccessAt: null,
      lastStatus: null,
      updatedAt: toCanonicalUtcIsoTimestamp(now),
    };
    this.db.insert(meditationState).values(row).run();
    return this.requireState(DEFAULT_MEDITATION_STATE_ID);
  }

  markStarted(input: MarkMeditationStartedInput = {}): MeditationState {
    const id = input.id ?? DEFAULT_MEDITATION_STATE_ID;
    const startedAt = input.startedAt ?? new Date();
    this.getOrCreateDefault(startedAt);
    this.db
      .update(meditationState)
      .set({
        running: true,
        lastStartedAt: toCanonicalUtcIsoTimestamp(startedAt),
        updatedAt: toCanonicalUtcIsoTimestamp(startedAt),
      })
      .where(eq(meditationState.id, id))
      .run();
    return this.requireState(id);
  }

  markFinished(input: MarkMeditationFinishedInput): MeditationState {
    const id = input.id ?? DEFAULT_MEDITATION_STATE_ID;
    const finishedAt = input.finishedAt ?? new Date();
    this.getOrCreateDefault(finishedAt);
    this.db
      .update(meditationState)
      .set({
        running: false,
        lastFinishedAt: toCanonicalUtcIsoTimestamp(finishedAt),
        lastSuccessAt: input.markSuccess ? toCanonicalUtcIsoTimestamp(finishedAt) : undefined,
        lastStatus: input.status,
        updatedAt: toCanonicalUtcIsoTimestamp(finishedAt),
      })
      .where(eq(meditationState.id, id))
      .run();
    return this.requireState(id);
  }

  private requireState(id: string): MeditationState {
    const state = this.get(id);
    if (state == null) {
      throw new Error(`Meditation state row missing after write: ${id}`);
    }
    return state;
  }
}
