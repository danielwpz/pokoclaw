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
  test("uses ~/.pokeclaw/system/pokeclaw.db as production path", () => {
    const productionPath = getProductionDatabasePath();
    expect(productionPath.endsWith("/.pokeclaw/system/pokeclaw.db")).toBe(true);
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
            "INSERT INTO approval_ledger (owner_agent_id, requested_by_session_id, requested_scope_json, approval_target, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(
            "agent_1",
            "sess_1",
            '{"scopes":[{"kind":"fs.read","path":"/Users/daniel/.pokeclaw/workspace/**"}]}',
            "runtime",
            "waiting",
            "2026-03-22T00:00:00.000Z",
          ),
      ).toThrow();

      expect(() =>
        handle.storage.sqlite
          .prepare(
            "INSERT INTO agent_permission_grants (id, owner_agent_id, scope_json, granted_by, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            "grant_1",
            "agent_1",
            '{"kind":"db.read","database":"system"}',
            "system",
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

  test("approval_ledger accepts pending and approved states with optional decided_at", async () => {
    const handle = await createTestDatabase(import.meta.url);

    try {
      seedAgentFixture(handle);

      handle.storage.sqlite
        .prepare(
          "INSERT INTO approval_ledger (owner_agent_id, requested_by_session_id, requested_scope_json, approval_target, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          "agent_1",
          "sess_1",
          '{"scopes":[{"kind":"fs.read","path":"/Users/daniel/.pokeclaw/workspace/**"}]}',
          "user",
          "pending",
          "2026-03-22T00:00:00.000Z",
        );

      handle.storage.sqlite
        .prepare(
          "INSERT INTO approval_ledger (owner_agent_id, requested_by_session_id, requested_scope_json, approval_target, status, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "agent_1",
          "sess_1",
          '{"scopes":[{"kind":"db.read","database":"system"}]}',
          "main_agent",
          "approved",
          "2026-03-22T00:00:01.000Z",
          "2026-03-22T00:00:02.000Z",
        );

      const rows = handle.storage.sqlite
        .prepare("SELECT approval_target, status, decided_at FROM approval_ledger ORDER BY id")
        .all() as Array<{ approval_target: string; status: string; decided_at: string | null }>;

      expect(rows).toEqual([
        { approval_target: "user", status: "pending", decided_at: null },
        {
          approval_target: "main_agent",
          status: "approved",
          decided_at: "2026-03-22T00:00:02.000Z",
        },
      ]);
    } finally {
      await destroyTestDatabase(handle);
    }
  });

  test("agent_permission_grants accepts approval-linked and expiring grants", async () => {
    const handle = await createTestDatabase(import.meta.url);

    try {
      seedAgentFixture(handle);

      const approval = handle.storage.sqlite
        .prepare(
          "INSERT INTO approval_ledger (owner_agent_id, requested_by_session_id, requested_scope_json, approval_target, status, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "agent_1",
          "sess_1",
          '{"scopes":[{"kind":"fs.write","path":"/Users/daniel/.pokeclaw/workspace/**"}]}',
          "user",
          "approved",
          "2026-03-22T00:00:00.000Z",
          "2026-03-22T00:00:01.000Z",
        );

      handle.storage.sqlite
        .prepare(
          "INSERT INTO agent_permission_grants (id, owner_agent_id, source_approval_id, scope_json, granted_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "grant_1",
          "agent_1",
          approval.lastInsertRowid,
          '{"kind":"fs.write","path":"/Users/daniel/.pokeclaw/workspace/**"}',
          "user",
          "2026-03-22T00:00:02.000Z",
          "2026-03-29T00:00:02.000Z",
        );

      const rows = handle.storage.sqlite
        .prepare("SELECT granted_by, expires_at FROM agent_permission_grants")
        .all() as Array<{ granted_by: string; expires_at: string | null }>;

      expect(rows).toEqual([
        {
          granted_by: "user",
          expires_at: "2026-03-29T00:00:02.000Z",
        },
      ]);
    } finally {
      await destroyTestDatabase(handle);
    }
  });
});
