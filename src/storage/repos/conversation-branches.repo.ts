import { eq } from "drizzle-orm";

import { toCanonicalUtcIsoTimestamp } from "@/src/shared/time.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { conversationBranches } from "@/src/storage/schema/tables.js";
import type { ConversationBranch, NewConversationBranch } from "@/src/storage/schema/types.js";

export interface CreateConversationBranchInput {
  id: string;
  conversationId: string;
  kind: string;
  branchKey: string;
  externalBranchId?: string | null;
  parentBranchId?: string | null;
  status?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export class ConversationBranchesRepo {
  constructor(private readonly db: StorageDb) {}

  create(input: CreateConversationBranchInput): void {
    const createdAt = input.createdAt ?? new Date();
    const updatedAt = input.updatedAt ?? createdAt;
    const row: NewConversationBranch = {
      id: input.id,
      conversationId: input.conversationId,
      kind: input.kind,
      branchKey: input.branchKey,
      externalBranchId: input.externalBranchId ?? null,
      parentBranchId: input.parentBranchId ?? null,
      status: input.status ?? "active",
      createdAt: toCanonicalUtcIsoTimestamp(createdAt),
      updatedAt: toCanonicalUtcIsoTimestamp(updatedAt),
    };

    this.db.insert(conversationBranches).values(row).run();
  }

  getById(id: string): ConversationBranch | null {
    return (
      this.db.select().from(conversationBranches).where(eq(conversationBranches.id, id)).get() ??
      null
    );
  }
}
