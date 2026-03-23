import { and, desc, eq, gt, isNull, or } from "drizzle-orm";

import { toCanonicalUtcIsoTimestamp } from "@/src/shared/time.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { agentPermissionGrants } from "@/src/storage/schema/tables.js";
import type { AgentPermissionGrant, NewAgentPermissionGrant } from "@/src/storage/schema/types.js";

export interface CreatePermissionGrantInput {
  id: string;
  ownerAgentId: string;
  sourceApprovalId?: number | null;
  scopeJson: string;
  grantedBy: "user" | "main_agent";
  createdAt?: Date;
  expiresAt?: Date | null;
}

export class PermissionGrantsRepo {
  constructor(private readonly db: StorageDb) {}

  create(input: CreatePermissionGrantInput): void {
    const createdAt = input.createdAt ?? new Date();
    const row: NewAgentPermissionGrant = {
      id: input.id,
      ownerAgentId: input.ownerAgentId,
      sourceApprovalId: input.sourceApprovalId ?? null,
      scopeJson: input.scopeJson,
      grantedBy: input.grantedBy,
      createdAt: toCanonicalUtcIsoTimestamp(createdAt),
      expiresAt: input.expiresAt == null ? null : toCanonicalUtcIsoTimestamp(input.expiresAt),
    };

    this.db.insert(agentPermissionGrants).values(row).run();
  }

  getById(id: string): AgentPermissionGrant | null {
    return (
      this.db.select().from(agentPermissionGrants).where(eq(agentPermissionGrants.id, id)).get() ??
      null
    );
  }

  listByOwner(ownerAgentId: string, limit = 100): AgentPermissionGrant[] {
    return this.db
      .select()
      .from(agentPermissionGrants)
      .where(eq(agentPermissionGrants.ownerAgentId, ownerAgentId))
      .orderBy(desc(agentPermissionGrants.createdAt), desc(agentPermissionGrants.id))
      .limit(limit)
      .all();
  }

  listActiveByOwner(ownerAgentId: string, activeAt: Date = new Date()): AgentPermissionGrant[] {
    const activeAtIso = toCanonicalUtcIsoTimestamp(activeAt);

    return this.db
      .select()
      .from(agentPermissionGrants)
      .where(
        and(
          eq(agentPermissionGrants.ownerAgentId, ownerAgentId),
          or(
            isNull(agentPermissionGrants.expiresAt),
            gt(agentPermissionGrants.expiresAt, activeAtIso),
          ),
        ),
      )
      .orderBy(desc(agentPermissionGrants.createdAt), desc(agentPermissionGrants.id))
      .all();
  }
}
