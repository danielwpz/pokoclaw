import { eq } from "drizzle-orm";

import type { StorageDb } from "@/src/storage/db/client.js";
import { agents } from "@/src/storage/schema/tables.js";
import type { Agent } from "@/src/storage/schema/types.js";

export class AgentsRepo {
  constructor(private readonly db: StorageDb) {}

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
