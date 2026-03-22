import { describe, expect, test } from "vitest";

import { getProductionDatabasePath } from "@/src/storage/db/paths.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

function seedConversationFixture(handle: TestDatabaseHandle): void {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_1', 'lark', 'acct_a', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES ('conv_1', 'ci_1', 'chat_1', 'dm', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
  `);
}

function seedAgentFixture(handle: TestDatabaseHandle): void {
  seedConversationFixture(handle);

  handle.storage.sqlite.exec(`
    INSERT INTO agents (id, conversation_id, kind, created_at)
    VALUES ('agent_1', 'conv_1', 'main', '2026-03-22T00:00:00.000Z');

    INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, created_at, updated_at)
    VALUES ('sess_1', 'conv_1', 'branch_1', 'agent_1', 'chat', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
  `);
}

describe("storage db bootstrap", () => {
  test("uses ~/.pokeclaw/workspace/pokeclaw.db as production path", () => {
    const productionPath = getProductionDatabasePath();
    expect(productionPath.endsWith("/.pokeclaw/workspace/pokeclaw.db")).toBe(true);
  });

  test("initializes all core tables on open", async () => {
    const handle = await createTestDatabase(import.meta.url);

    try {
      const rows = handle.storage.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC",
        )
        .all() as Array<{ name: string }>;
      const tableNames = rows.map((row) => row.name);

      expect(tableNames).toContain("channel_instances");
      expect(tableNames).toContain("conversations");
      expect(tableNames).toContain("conversation_branches");
      expect(tableNames).toContain("agents");
      expect(tableNames).toContain("sessions");
      expect(tableNames).toContain("messages");
      expect(tableNames).toContain("cron_jobs");
      expect(tableNames).toContain("task_runs");
      expect(tableNames).toContain("approval_ledger");
      expect(tableNames).toContain("agent_permission_grants");
      expect(tableNames).toContain("auth_events");
    } finally {
      await destroyTestDatabase(handle);
    }
  });

  test("db-level timestamp CHECK rejects invalid timestamp text", async () => {
    const handle = await createTestDatabase(import.meta.url);

    try {
      expect(() =>
        handle.storage.sqlite
          .prepare(
            "INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            "ci_bad_time",
            "lark",
            "acct_bad",
            "2026/03/22 09:00:00",
            "2026-03-22T09:00:00.000Z",
          ),
      ).toThrow();
    } finally {
      await destroyTestDatabase(handle);
    }
  });

  test("db-level enum CHECK rejects invalid stable values", async () => {
    const handle = await createTestDatabase(import.meta.url);

    try {
      expect(() =>
        handle.storage.sqlite
          .prepare(
            "INSERT INTO channel_instances (id, provider, account_key, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(
            "ci_bad_status",
            "lark",
            "acct_bad_status",
            "paused",
            "2026-03-22T00:00:00.000Z",
            "2026-03-22T00:00:00.000Z",
          ),
      ).toThrow();

      seedConversationFixture(handle);

      expect(() =>
        handle.storage.sqlite
          .prepare(
            "INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(
            "conv_bad_kind",
            "ci_1",
            "chat_bad_kind",
            "thread",
            "2026-03-22T00:00:00.000Z",
            "2026-03-22T00:00:00.000Z",
          ),
      ).toThrow();

      expect(() =>
        handle.storage.sqlite
          .prepare(
            "INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            "conv_bad_status",
            "ci_1",
            "chat_bad_status",
            "dm",
            "disabled",
            "2026-03-22T00:00:00.000Z",
            "2026-03-22T00:00:00.000Z",
          ),
      ).toThrow();
    } finally {
      await destroyTestDatabase(handle);
    }
  });

  test("db-level agent, cron, approval, and auth CHECKs reject invalid values", async () => {
    const handle = await createTestDatabase(import.meta.url);

    try {
      seedAgentFixture(handle);

      expect(() =>
        handle.storage.sqlite
          .prepare("INSERT INTO agents (id, conversation_id, kind, created_at) VALUES (?, ?, ?, ?)")
          .run("agent_bad_kind", "conv_1", "worker", "2026-03-22T00:00:00.000Z"),
      ).toThrow();

      expect(() =>
        handle.storage.sqlite
          .prepare(
            "INSERT INTO cron_jobs (id, owner_agent_id, target_conversation_id, target_branch_id, schedule_kind, schedule_value, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            "cron_bad_kind",
            "agent_1",
            "conv_1",
            "branch_1",
            "weekly",
            "0 8 * * *",
            "{}",
            "2026-03-22T00:00:00.000Z",
            "2026-03-22T00:00:00.000Z",
          ),
      ).toThrow();

      handle.storage.sqlite
        .prepare(
          "INSERT INTO cron_jobs (id, owner_agent_id, target_conversation_id, target_branch_id, schedule_kind, schedule_value, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "cron_1",
          "agent_1",
          "conv_1",
          "branch_1",
          "cron",
          "0 8 * * *",
          "{}",
          "2026-03-22T00:00:00.000Z",
          "2026-03-22T00:00:00.000Z",
        );

      expect(() =>
        handle.storage.sqlite
          .prepare(
            "INSERT INTO task_runs (id, run_type, owner_agent_id, conversation_id, branch_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            "run_bad_cron",
            "cron",
            "agent_1",
            "conv_1",
            "branch_1",
            "queued",
            "2026-03-22T00:00:00.000Z",
          ),
      ).toThrow();

      handle.storage.sqlite
        .prepare(
          "INSERT INTO task_runs (id, run_type, owner_agent_id, conversation_id, branch_id, cron_job_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "run_1",
          "cron",
          "agent_1",
          "conv_1",
          "branch_1",
          "cron_1",
          "queued",
          "2026-03-22T00:00:00.000Z",
        );

      expect(() =>
        handle.storage.sqlite
          .prepare(
            "INSERT INTO approval_ledger (owner_agent_id, conversation_id, task_run_id, request_source, requested_scope_json, decision, used_history_lookup, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            "agent_1",
            "conv_1",
            "run_1",
            "runtime",
            "{}",
            "allow",
            2,
            "2026-03-22T00:00:00.000Z",
          ),
      ).toThrow();

      expect(() =>
        handle.storage.sqlite
          .prepare(
            "INSERT INTO auth_events (id, conversation_id, agent_id, event_type, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(
            "auth_bad_status",
            "conv_1",
            "agent_1",
            "oauth_callback",
            "pending",
            "2026-03-22T00:00:00.000Z",
          ),
      ).toThrow();
    } finally {
      await destroyTestDatabase(handle);
    }
  });
});
