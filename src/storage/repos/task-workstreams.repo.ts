import { and, desc, eq } from "drizzle-orm";

import { toCanonicalUtcIsoTimestamp } from "@/src/shared/time.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { taskWorkstreams } from "@/src/storage/schema/tables.js";
import type { NewTaskWorkstream, TaskWorkstream } from "@/src/storage/schema/types.js";

export interface CreateTaskWorkstreamInput {
  id: string;
  ownerAgentId: string;
  conversationId: string;
  branchId: string;
  status?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export class TaskWorkstreamsRepo {
  constructor(private readonly db: StorageDb) {}

  create(input: CreateTaskWorkstreamInput): TaskWorkstream {
    const createdAt = input.createdAt ?? new Date();
    const updatedAt = input.updatedAt ?? createdAt;
    const row: NewTaskWorkstream = {
      id: input.id,
      ownerAgentId: input.ownerAgentId,
      conversationId: input.conversationId,
      branchId: input.branchId,
      status: input.status ?? "open",
      createdAt: toCanonicalUtcIsoTimestamp(createdAt),
      updatedAt: toCanonicalUtcIsoTimestamp(updatedAt),
    };

    this.db.insert(taskWorkstreams).values(row).run();

    const created = this.getById(input.id);
    if (created == null) {
      throw new Error(`Task workstream ${input.id} disappeared after create`);
    }
    return created;
  }

  getById(id: string): TaskWorkstream | null {
    return this.db.select().from(taskWorkstreams).where(eq(taskWorkstreams.id, id)).get() ?? null;
  }

  findLatestByConversationBranch(input: {
    conversationId: string;
    branchId: string;
    ownerAgentId?: string;
  }): TaskWorkstream | null {
    const predicates = [
      eq(taskWorkstreams.conversationId, input.conversationId),
      eq(taskWorkstreams.branchId, input.branchId),
    ];
    if (input.ownerAgentId != null) {
      predicates.push(eq(taskWorkstreams.ownerAgentId, input.ownerAgentId));
    }

    return (
      this.db
        .select()
        .from(taskWorkstreams)
        .where(and(...predicates))
        .orderBy(desc(taskWorkstreams.updatedAt), desc(taskWorkstreams.createdAt))
        .get() ?? null
    );
  }

  updateStatus(input: { id: string; status: string; updatedAt?: Date }): void {
    this.db
      .update(taskWorkstreams)
      .set({
        status: input.status,
        updatedAt: toCanonicalUtcIsoTimestamp(input.updatedAt ?? new Date()),
      })
      .where(eq(taskWorkstreams.id, input.id))
      .run();
  }
}
