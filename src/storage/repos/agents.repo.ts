import { eq } from "drizzle-orm";

import { toCanonicalUtcIsoTimestamp } from "@/src/shared/time.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { agents } from "@/src/storage/schema/tables.js";
import type { Agent, NewAgent } from "@/src/storage/schema/types.js";

export interface CreateAgentInput {
  id: string;
  conversationId: string;
  mainAgentId?: string | null;
  kind: string;
  displayName?: string | null;
  description?: string | null;
  workdir?: string | null;
  policyProfile?: string | null;
  defaultModel?: string | null;
  status?: string;
  createdAt?: Date;
  archivedAt?: Date | null;
}

export class AgentsRepo {
  constructor(private readonly db: StorageDb) {}

  create(input: CreateAgentInput): void {
    const createdAt = input.createdAt ?? new Date();
    const row: NewAgent = {
      id: input.id,
      conversationId: input.conversationId,
      mainAgentId: input.mainAgentId ?? null,
      kind: input.kind,
      displayName: input.displayName ?? null,
      description: input.description ?? null,
      workdir: input.workdir ?? null,
      policyProfile: input.policyProfile ?? null,
      defaultModel: input.defaultModel ?? null,
      status: input.status ?? "active",
      createdAt: toCanonicalUtcIsoTimestamp(createdAt),
      archivedAt: input.archivedAt == null ? null : toCanonicalUtcIsoTimestamp(input.archivedAt),
    };

    this.db.insert(agents).values(row).run();
  }

  getById(id: string): Agent | null {
    return this.db.select().from(agents).where(eq(agents.id, id)).get() ?? null;
  }

  resolveMainAgentId(agentId: string): string | null {
    const agent = this.getById(agentId);
    if (agent == null) {
      return null;
    }

    if (agent.kind === "main") {
      return agent.id;
    }

    return agent.mainAgentId ?? null;
  }

  listByMainAgent(mainAgentId: string): Agent[] {
    return this.db.select().from(agents).where(eq(agents.mainAgentId, mainAgentId)).all();
  }
}
