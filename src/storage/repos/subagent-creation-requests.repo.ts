import { desc, eq } from "drizzle-orm";

import { toCanonicalUtcIsoTimestamp } from "@/src/shared/time.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { subagentCreationRequests } from "@/src/storage/schema/tables.js";
import type {
  NewSubagentCreationRequest,
  SubagentCreationRequest,
} from "@/src/storage/schema/types.js";

export interface CreateSubagentCreationRequestInput {
  id: string;
  sourceSessionId: string;
  sourceAgentId: string;
  sourceConversationId: string;
  channelInstanceId: string;
  title: string;
  description: string;
  initialTask: string;
  workdir: string;
  initialExtraScopesJson: string;
  status: string;
  createdSubagentAgentId?: string | null;
  failureReason?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
  decidedAt?: Date | null;
  expiresAt?: Date | null;
}

export interface UpdateSubagentCreationRequestStatusInput {
  id: string;
  status: string;
  createdSubagentAgentId?: string | null;
  failureReason?: string | null;
  updatedAt?: Date;
  decidedAt?: Date | null;
}

export class SubagentCreationRequestsRepo {
  constructor(private readonly db: StorageDb) {}

  create(input: CreateSubagentCreationRequestInput): void {
    const createdAt = input.createdAt ?? new Date();
    const updatedAt = input.updatedAt ?? createdAt;
    const row: NewSubagentCreationRequest = {
      id: input.id,
      sourceSessionId: input.sourceSessionId,
      sourceAgentId: input.sourceAgentId,
      sourceConversationId: input.sourceConversationId,
      channelInstanceId: input.channelInstanceId,
      title: input.title,
      description: input.description,
      initialTask: input.initialTask,
      workdir: input.workdir,
      initialExtraScopesJson: input.initialExtraScopesJson,
      status: input.status,
      createdSubagentAgentId: input.createdSubagentAgentId ?? null,
      failureReason: input.failureReason ?? null,
      createdAt: toCanonicalUtcIsoTimestamp(createdAt),
      updatedAt: toCanonicalUtcIsoTimestamp(updatedAt),
      decidedAt: input.decidedAt == null ? null : toCanonicalUtcIsoTimestamp(input.decidedAt),
      expiresAt: input.expiresAt == null ? null : toCanonicalUtcIsoTimestamp(input.expiresAt),
    };

    this.db.insert(subagentCreationRequests).values(row).run();
  }

  getById(id: string): SubagentCreationRequest | null {
    return (
      this.db
        .select()
        .from(subagentCreationRequests)
        .where(eq(subagentCreationRequests.id, id))
        .get() ?? null
    );
  }

  listBySourceSession(sourceSessionId: string, limit = 50): SubagentCreationRequest[] {
    return this.db
      .select()
      .from(subagentCreationRequests)
      .where(eq(subagentCreationRequests.sourceSessionId, sourceSessionId))
      .orderBy(desc(subagentCreationRequests.createdAt), desc(subagentCreationRequests.id))
      .limit(limit)
      .all();
  }

  updateStatus(input: UpdateSubagentCreationRequestStatusInput): void {
    const updatedAt = input.updatedAt ?? new Date();

    this.db
      .update(subagentCreationRequests)
      .set({
        status: input.status,
        ...(input.createdSubagentAgentId === undefined
          ? {}
          : { createdSubagentAgentId: input.createdSubagentAgentId }),
        ...(input.failureReason === undefined ? {} : { failureReason: input.failureReason }),
        updatedAt: toCanonicalUtcIsoTimestamp(updatedAt),
        ...(input.decidedAt === undefined
          ? {}
          : {
              decidedAt:
                input.decidedAt == null ? null : toCanonicalUtcIsoTimestamp(input.decidedAt),
            }),
      })
      .where(eq(subagentCreationRequests.id, input.id))
      .run();
  }
}
