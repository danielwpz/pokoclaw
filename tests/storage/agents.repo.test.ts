import { describe, expect, test } from "vitest";

import { AgentsRepo } from "@/src/storage/repos/agents.repo.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

async function withHandle(fn: (handle: TestDatabaseHandle) => Promise<void>): Promise<void> {
  const handle = await createTestDatabase(import.meta.url);
  try {
    await fn(handle);
  } finally {
    await destroyTestDatabase(handle);
  }
}

function seedFixture(handle: TestDatabaseHandle): void {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_1', 'lark', 'acct_a', '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:00.000Z');

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES
      ('conv_main', 'ci_1', 'chat_main', 'dm', '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:00.000Z'),
      ('conv_sub', 'ci_1', 'chat_sub', 'group', '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:00.000Z');

    INSERT INTO agents (id, conversation_id, main_agent_id, kind, description, created_at)
    VALUES
      ('agent_main', 'conv_main', NULL, 'main', 'Primary assistant for this DM.', '2026-03-25T00:00:00.000Z'),
      ('agent_sub', 'conv_sub', 'agent_main', 'sub', 'Focused helper for the sub conversation.', '2026-03-25T00:00:00.000Z');
  `);
}

describe("agents repo", () => {
  test("resolves a main agent to itself", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      const repo = new AgentsRepo(handle.storage.db);

      expect(repo.resolveMainAgentId("agent_main")).toBe("agent_main");
    });
  });

  test("resolves a subagent to its owning main agent", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      const repo = new AgentsRepo(handle.storage.db);

      expect(repo.resolveMainAgentId("agent_sub")).toBe("agent_main");
    });
  });

  test("lists agents owned by a main agent", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      const repo = new AgentsRepo(handle.storage.db);

      expect(repo.listByMainAgent("agent_main").map((agent) => agent.id)).toEqual(["agent_sub"]);
    });
  });

  test("returns persisted agent descriptions", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      const repo = new AgentsRepo(handle.storage.db);

      expect(repo.getById("agent_main")?.description).toBe("Primary assistant for this DM.");
      expect(repo.getById("agent_sub")?.description).toBe(
        "Focused helper for the sub conversation.",
      );
    });
  });
});
