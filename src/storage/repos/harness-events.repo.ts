import { desc, eq } from "drizzle-orm";

import { toCanonicalUtcIsoTimestamp } from "@/src/shared/time.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { harnessEvents } from "@/src/storage/schema/tables.js";
import type { HarnessEvent, NewHarnessEvent } from "@/src/storage/schema/types.js";

export interface CreateHarnessEventInput {
  id: string;
  eventType: string;
  runId: string;
  sessionId?: string | null;
  conversationId?: string | null;
  branchId?: string | null;
  agentId?: string | null;
  taskRunId?: string | null;
  cronJobId?: string | null;
  actor: string;
  sourceKind: string;
  requestScope: string;
  reasonText?: string | null;
  detailsJson?: string | null;
  createdAt?: Date;
}

export class HarnessEventsRepo {
  constructor(private readonly db: StorageDb) {}

  /**
   * Insert one append-only harness event. Canonical user_stop semantics live
   * with the harness_events schema/table definition.
   */
  create(input: CreateHarnessEventInput): void {
    const row: NewHarnessEvent = {
      id: input.id,
      eventType: input.eventType,
      runId: input.runId,
      sessionId: input.sessionId ?? null,
      conversationId: input.conversationId ?? null,
      branchId: input.branchId ?? null,
      agentId: input.agentId ?? null,
      taskRunId: input.taskRunId ?? null,
      cronJobId: input.cronJobId ?? null,
      actor: input.actor,
      sourceKind: input.sourceKind,
      requestScope: input.requestScope,
      reasonText: input.reasonText ?? null,
      detailsJson: input.detailsJson ?? null,
      createdAt: toCanonicalUtcIsoTimestamp(input.createdAt ?? new Date()),
    };

    this.db.insert(harnessEvents).values(row).run();
  }

  listByRunId(runId: string, limit = 50): HarnessEvent[] {
    return this.db
      .select()
      .from(harnessEvents)
      .where(eq(harnessEvents.runId, runId))
      .orderBy(desc(harnessEvents.createdAt), desc(harnessEvents.id))
      .limit(limit)
      .all();
  }
}
