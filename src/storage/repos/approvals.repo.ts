import { and, desc, eq, inArray } from "drizzle-orm";

import { toCanonicalUtcIsoTimestamp } from "@/src/shared/time.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { approvalLedger } from "@/src/storage/schema/tables.js";
import type { ApprovalRecord, NewApprovalRecord } from "@/src/storage/schema/types.js";

export interface CreateApprovalInput {
  ownerAgentId: string;
  requestedBySessionId?: string | null;
  requestedScopeJson: string;
  approvalTarget: "user" | "main_agent";
  status?: "pending" | "approved" | "denied" | "cancelled";
  reasonText?: string | null;
  expiresAt?: Date | null;
  resumePayloadJson?: string | null;
  createdAt?: Date;
  decidedAt?: Date | null;
}

export interface ResolveApprovalInput {
  id: number;
  status: "approved" | "denied" | "cancelled";
  reasonText?: string | null;
  decidedAt?: Date;
}

export interface ListApprovalsBySessionOptions {
  statuses?: Array<"pending" | "approved" | "denied" | "cancelled">;
  limit?: number;
}

export class ApprovalsRepo {
  constructor(private readonly db: StorageDb) {}

  create(input: CreateApprovalInput): number {
    const createdAt = input.createdAt ?? new Date();
    const row: NewApprovalRecord = {
      ownerAgentId: input.ownerAgentId,
      requestedBySessionId: input.requestedBySessionId ?? null,
      requestedScopeJson: input.requestedScopeJson,
      approvalTarget: input.approvalTarget,
      status: input.status ?? "pending",
      reasonText: input.reasonText ?? null,
      expiresAt: input.expiresAt == null ? null : toCanonicalUtcIsoTimestamp(input.expiresAt),
      resumePayloadJson: input.resumePayloadJson ?? null,
      createdAt: toCanonicalUtcIsoTimestamp(createdAt),
      decidedAt: input.decidedAt == null ? null : toCanonicalUtcIsoTimestamp(input.decidedAt),
    };

    const result = this.db.insert(approvalLedger).values(row).run();
    return Number(result.lastInsertRowid);
  }

  getById(id: number): ApprovalRecord | null {
    return this.db.select().from(approvalLedger).where(eq(approvalLedger.id, id)).get() ?? null;
  }

  listByOwner(ownerAgentId: string, limit = 50): ApprovalRecord[] {
    return this.db
      .select()
      .from(approvalLedger)
      .where(eq(approvalLedger.ownerAgentId, ownerAgentId))
      .orderBy(desc(approvalLedger.createdAt), desc(approvalLedger.id))
      .limit(limit)
      .all();
  }

  listBySession(sessionId: string, options: ListApprovalsBySessionOptions = {}): ApprovalRecord[] {
    const limit = options.limit ?? 50;
    const statuses = options.statuses ?? [];

    if (statuses.length > 0) {
      return this.db
        .select()
        .from(approvalLedger)
        .where(
          and(
            eq(approvalLedger.requestedBySessionId, sessionId),
            inArray(approvalLedger.status, statuses),
          ),
        )
        .orderBy(desc(approvalLedger.createdAt), desc(approvalLedger.id))
        .limit(limit)
        .all();
    }

    return this.db
      .select()
      .from(approvalLedger)
      .where(eq(approvalLedger.requestedBySessionId, sessionId))
      .orderBy(desc(approvalLedger.createdAt), desc(approvalLedger.id))
      .limit(limit)
      .all();
  }

  resolve(input: ResolveApprovalInput): void {
    this.db
      .update(approvalLedger)
      .set({
        status: input.status,
        reasonText: input.reasonText ?? null,
        decidedAt: toCanonicalUtcIsoTimestamp(input.decidedAt ?? new Date()),
      })
      .where(eq(approvalLedger.id, input.id))
      .run();
  }
}
