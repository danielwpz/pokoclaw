import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { toCanonicalUtcIsoTimestamp } from "@/src/shared/time.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { sessions } from "@/src/storage/schema/tables.js";
import type { NewSession, Session } from "@/src/storage/schema/types.js";

export interface CreateSessionInput {
  id: string;
  conversationId: string;
  branchId: string;
  ownerAgentId?: string | null;
  purpose: string;
  contextMode?: string;
  approvalForSessionId?: string | null;
  forkedFromSessionId?: string | null;
  forkSourceSeq?: number | null;
  status?: string;
  compactCursor?: number;
  compactSummary?: string | null;
  compactSummaryTokenTotal?: number | null;
  compactSummaryUsageJson?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
  endedAt?: Date | null;
}

export interface ListConversationSessionsOptions {
  statuses?: string[];
  limit?: number;
}

export interface FindLatestSessionByOwnerOptions {
  purpose?: string;
  statuses?: string[];
}

export interface FindLatestSessionByConversationBranchOptions {
  purpose?: string;
  statuses?: string[];
}

export interface FindLatestApprovalSessionOptions {
  statuses?: string[];
}

export interface UpdateSessionCompactionInput {
  id: string;
  compactCursor: number;
  compactSummary?: string | null;
  compactSummaryTokenTotal?: number | null;
  compactSummaryUsageJson?: string | null;
  updatedAt?: Date;
}

export interface UpdateSessionStatusInput {
  id: string;
  status: string;
  updatedAt?: Date;
  endedAt?: Date | null;
}

export class SessionsRepo {
  constructor(private readonly db: StorageDb) {}

  create(input: CreateSessionInput): void {
    const createdAt = input.createdAt ?? new Date();
    const updatedAt = input.updatedAt ?? createdAt;

    const row: NewSession = {
      id: input.id,
      conversationId: input.conversationId,
      branchId: input.branchId,
      ownerAgentId: input.ownerAgentId ?? null,
      purpose: input.purpose,
      contextMode: input.contextMode ?? "isolated",
      approvalForSessionId: input.approvalForSessionId ?? null,
      forkedFromSessionId: input.forkedFromSessionId ?? null,
      forkSourceSeq: normalizeOptionalNonNegativeInteger("forkSourceSeq", input.forkSourceSeq),
      status: input.status ?? "active",
      compactCursor: normalizeNonNegativeInteger("compactCursor", input.compactCursor ?? 0),
      compactSummary: input.compactSummary ?? null,
      compactSummaryTokenTotal: normalizeOptionalNonNegativeInteger(
        "compactSummaryTokenTotal",
        input.compactSummaryTokenTotal,
      ),
      compactSummaryUsageJson: input.compactSummaryUsageJson ?? null,
      createdAt: toCanonicalUtcIsoTimestamp(createdAt),
      updatedAt: toCanonicalUtcIsoTimestamp(updatedAt),
      endedAt: input.endedAt == null ? null : toCanonicalUtcIsoTimestamp(input.endedAt),
    };

    this.db.insert(sessions).values(row).run();
  }

  getById(id: string): Session | null {
    return this.db.select().from(sessions).where(eq(sessions.id, id)).get() ?? null;
  }

  listByConversation(
    conversationId: string,
    options: ListConversationSessionsOptions = {},
  ): Session[] {
    const limit = options.limit ?? 50;
    const statuses = options.statuses ?? [];

    if (statuses.length > 0) {
      return this.db
        .select()
        .from(sessions)
        .where(and(eq(sessions.conversationId, conversationId), inArray(sessions.status, statuses)))
        .orderBy(asc(sessions.createdAt))
        .limit(limit)
        .all();
    }

    return this.db
      .select()
      .from(sessions)
      .where(eq(sessions.conversationId, conversationId))
      .orderBy(asc(sessions.createdAt))
      .limit(limit)
      .all();
  }

  findLatestByOwnerAgent(
    ownerAgentId: string,
    options: FindLatestSessionByOwnerOptions = {},
  ): Session | null {
    const predicates = [eq(sessions.ownerAgentId, ownerAgentId)];

    if (options.purpose != null) {
      predicates.push(eq(sessions.purpose, options.purpose));
    }

    if ((options.statuses?.length ?? 0) > 0) {
      predicates.push(inArray(sessions.status, options.statuses ?? []));
    }

    return (
      this.db
        .select()
        .from(sessions)
        .where(and(...predicates))
        .orderBy(desc(sessions.updatedAt), desc(sessions.createdAt), desc(sessions.id))
        .get() ?? null
    );
  }

  findLatestByConversationBranch(
    conversationId: string,
    branchId: string,
    options: FindLatestSessionByConversationBranchOptions = {},
  ): Session | null {
    const predicates = [
      eq(sessions.conversationId, conversationId),
      eq(sessions.branchId, branchId),
    ];

    if (options.purpose != null) {
      predicates.push(eq(sessions.purpose, options.purpose));
    }

    if ((options.statuses?.length ?? 0) > 0) {
      predicates.push(inArray(sessions.status, options.statuses ?? []));
    }

    return (
      this.db
        .select()
        .from(sessions)
        .where(and(...predicates))
        .orderBy(desc(sessions.updatedAt), desc(sessions.createdAt), desc(sessions.id))
        .get() ?? null
    );
  }

  findLatestApprovalSessionForSource(
    approvalForSessionId: string,
    options: FindLatestApprovalSessionOptions = {},
  ): Session | null {
    const predicates = [
      eq(sessions.approvalForSessionId, approvalForSessionId),
      eq(sessions.purpose, "approval"),
    ];

    if ((options.statuses?.length ?? 0) > 0) {
      predicates.push(inArray(sessions.status, options.statuses ?? []));
    }

    return (
      this.db
        .select()
        .from(sessions)
        .where(and(...predicates))
        .orderBy(desc(sessions.updatedAt), desc(sessions.createdAt), desc(sessions.id))
        .get() ?? null
    );
  }

  updateCompaction(input: UpdateSessionCompactionInput): void {
    const updatedAt = input.updatedAt ?? new Date();

    this.db
      .update(sessions)
      .set({
        compactCursor: normalizeNonNegativeInteger("compactCursor", input.compactCursor),
        compactSummary: input.compactSummary ?? null,
        compactSummaryTokenTotal: normalizeOptionalNonNegativeInteger(
          "compactSummaryTokenTotal",
          input.compactSummaryTokenTotal,
        ),
        compactSummaryUsageJson: input.compactSummaryUsageJson ?? null,
        updatedAt: toCanonicalUtcIsoTimestamp(updatedAt),
      })
      .where(eq(sessions.id, input.id))
      .run();
  }

  updateStatus(input: UpdateSessionStatusInput): void {
    const updatedAt = input.updatedAt ?? new Date();

    this.db
      .update(sessions)
      .set({
        status: input.status,
        updatedAt: toCanonicalUtcIsoTimestamp(updatedAt),
        endedAt: input.endedAt == null ? null : toCanonicalUtcIsoTimestamp(input.endedAt),
      })
      .where(eq(sessions.id, input.id))
      .run();
  }
}

function normalizeOptionalNonNegativeInteger(
  field: string,
  value: number | null | undefined,
): number | null {
  if (value == null) {
    return null;
  }

  return normalizeNonNegativeInteger(field, value);
}

function normalizeNonNegativeInteger(field: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }

  return value;
}
