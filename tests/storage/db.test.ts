import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { openStorageDatabase } from "@/src/storage/db/client.js";
import { getProductionDatabasePath, getTestDatabasePath } from "@/src/storage/db/paths.js";
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
      expect(tableNames).toContain("channel_surfaces");
      expect(tableNames).toContain("agents");
      expect(tableNames).toContain("sessions");
      expect(tableNames).toContain("messages");
      expect(tableNames).toContain("cron_jobs");
      expect(tableNames).toContain("task_runs");
      expect(tableNames).toContain("approval_ledger");
      expect(tableNames).toContain("agent_permission_grants");
      expect(tableNames).toContain("auth_events");
      expect(tableNames).toContain("harness_events");
      expect(tableNames).toContain("lark_object_bindings");
      expect(tableNames).toContain("meditation_state");
    } finally {
      await destroyTestDatabase(handle);
    }
  });

  test("approval_ledger includes expiry and resume payload columns", async () => {
    const handle = await createTestDatabase(import.meta.url);

    try {
      const rows = handle.storage.sqlite
        .prepare("PRAGMA table_info(approval_ledger)")
        .all() as Array<{ name: string }>;
      const columnNames = rows.map((row) => row.name);

      expect(columnNames).toContain("expires_at");
      expect(columnNames).toContain("resume_payload_json");
    } finally {
      await destroyTestDatabase(handle);
    }
  });

  test("upgrades legacy messages tables with inbound channel metadata columns", async () => {
    const dbPath = getTestDatabasePath(import.meta.url);
    await mkdir(path.dirname(dbPath), { recursive: true });

    const legacy = openStorageDatabase({ databasePath: dbPath, initializeSchema: false });
    try {
      legacy.sqlite.exec(`
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          role TEXT NOT NULL,
          message_type TEXT NOT NULL DEFAULT 'text',
          visibility TEXT NOT NULL DEFAULT 'user_visible',
          channel_message_id TEXT,
          provider TEXT,
          model TEXT,
          model_api TEXT,
          stop_reason TEXT,
          error_message TEXT,
          payload_json TEXT NOT NULL,
          token_input INTEGER,
          token_output INTEGER,
          token_cache_read INTEGER,
          token_cache_write INTEGER,
          token_total INTEGER,
          usage_json TEXT,
          created_at TEXT NOT NULL,
          UNIQUE(session_id, seq)
        );
      `);
    } finally {
      legacy.close();
    }

    const upgraded = openStorageDatabase({ databasePath: dbPath, initializeSchema: true });
    try {
      const rows = upgraded.sqlite.prepare("PRAGMA table_info(messages)").all() as Array<{
        name: string;
      }>;
      const columnNames = rows.map((row) => row.name);

      expect(columnNames).toContain("channel_message_id");
      expect(columnNames).toContain("channel_parent_message_id");
      expect(columnNames).toContain("channel_thread_id");
    } finally {
      upgraded.close();
      await rm(dbPath, { force: true });
    }
  });

  test("upgrades legacy cron_jobs tables with soft-delete support", async () => {
    const dbPath = getTestDatabasePath(import.meta.url);
    await mkdir(path.dirname(dbPath), { recursive: true });

    const legacy = openStorageDatabase({ databasePath: dbPath, initializeSchema: false });
    try {
      legacy.sqlite.exec(`
        CREATE TABLE cron_jobs (
          id TEXT PRIMARY KEY,
          owner_agent_id TEXT NOT NULL,
          target_conversation_id TEXT NOT NULL,
          target_branch_id TEXT NOT NULL,
          name TEXT,
          schedule_kind TEXT NOT NULL,
          schedule_value TEXT NOT NULL,
          timezone TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          session_target TEXT NOT NULL DEFAULT 'isolated',
          context_mode TEXT NOT NULL DEFAULT 'isolated',
          payload_json TEXT NOT NULL,
          next_run_at TEXT,
          running_at TEXT,
          last_run_at TEXT,
          last_status TEXT,
          last_output TEXT,
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          delete_after_run INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    } finally {
      legacy.close();
    }

    const upgraded = openStorageDatabase({ databasePath: dbPath, initializeSchema: true });
    try {
      const rows = upgraded.sqlite.prepare("PRAGMA table_info(cron_jobs)").all() as Array<{
        name: string;
      }>;
      const columnNames = rows.map((row) => row.name);

      expect(columnNames).toContain("deleted_at");
    } finally {
      upgraded.close();
      await rm(dbPath, { force: true });
    }
  });

  test("adds harness_events table during schema upgrade", async () => {
    const dbPath = getTestDatabasePath(import.meta.url);
    await mkdir(path.dirname(dbPath), { recursive: true });

    const legacy = openStorageDatabase({ databasePath: dbPath, initializeSchema: false });
    try {
      legacy.sqlite.exec(`
        CREATE TABLE channel_instances (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          account_key TEXT NOT NULL,
          display_name TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          config_ref TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE conversations (
          id TEXT PRIMARY KEY,
          channel_instance_id TEXT NOT NULL,
          external_chat_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          title TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE conversation_branches (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          branch_key TEXT NOT NULL,
          external_branch_id TEXT,
          parent_branch_id TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE channel_surfaces (
          id TEXT PRIMARY KEY,
          channel_type TEXT NOT NULL,
          channel_installation_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          branch_id TEXT NOT NULL,
          surface_key TEXT NOT NULL,
          surface_object_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE agents (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          main_agent_id TEXT,
          kind TEXT NOT NULL,
          display_name TEXT,
          description TEXT,
          workdir TEXT,
          policy_profile TEXT,
          default_model TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL,
          archived_at TEXT
        );

        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          branch_id TEXT NOT NULL,
          owner_agent_id TEXT,
          purpose TEXT NOT NULL,
          context_mode TEXT NOT NULL DEFAULT 'isolated',
          approval_for_session_id TEXT,
          forked_from_session_id TEXT,
          fork_source_seq INTEGER,
          status TEXT NOT NULL DEFAULT 'active',
          compact_cursor INTEGER NOT NULL DEFAULT 0,
          compact_summary TEXT,
          compact_summary_token_total INTEGER,
          compact_summary_usage_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          ended_at TEXT
        );

        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          role TEXT NOT NULL,
          message_type TEXT NOT NULL DEFAULT 'text',
          visibility TEXT NOT NULL DEFAULT 'user_visible',
          channel_message_id TEXT,
          provider TEXT,
          model TEXT,
          model_api TEXT,
          stop_reason TEXT,
          error_message TEXT,
          payload_json TEXT NOT NULL,
          token_input INTEGER,
          token_output INTEGER,
          token_cache_read INTEGER,
          token_cache_write INTEGER,
          token_total INTEGER,
          usage_json TEXT,
          created_at TEXT NOT NULL,
          UNIQUE(session_id, seq)
        );

        CREATE TABLE cron_jobs (
          id TEXT PRIMARY KEY,
          owner_agent_id TEXT NOT NULL,
          target_conversation_id TEXT NOT NULL,
          target_branch_id TEXT NOT NULL,
          schedule_kind TEXT NOT NULL,
          schedule_value TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          payload_json TEXT NOT NULL,
          next_run_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE task_runs (
          id TEXT PRIMARY KEY,
          run_type TEXT NOT NULL,
          owner_agent_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          branch_id TEXT NOT NULL,
          initiator_session_id TEXT,
          parent_run_id TEXT,
          cron_job_id TEXT,
          execution_session_id TEXT,
          status TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 0,
          attempt INTEGER NOT NULL DEFAULT 1,
          description TEXT,
          input_json TEXT,
          result_summary TEXT,
          error_text TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          duration_ms INTEGER,
          cancelled_by TEXT
        );

        CREATE TABLE approval_ledger (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          owner_agent_id TEXT NOT NULL,
          requested_by_session_id TEXT,
          requested_scope_json TEXT NOT NULL,
          approval_target TEXT NOT NULL,
          status TEXT NOT NULL,
          reason_text TEXT,
          expires_at TEXT,
          resume_payload_json TEXT,
          created_at TEXT NOT NULL,
          decided_at TEXT
        );

        CREATE TABLE agent_permission_grants (
          id TEXT PRIMARY KEY,
          owner_agent_id TEXT NOT NULL,
          source_approval_id INTEGER,
          scope_json TEXT NOT NULL,
          granted_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT
        );

        CREATE TABLE subagent_creation_requests (
          id TEXT PRIMARY KEY,
          source_session_id TEXT NOT NULL,
          source_agent_id TEXT NOT NULL,
          source_conversation_id TEXT NOT NULL,
          channel_instance_id TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          initial_task TEXT NOT NULL,
          workdir TEXT NOT NULL,
          initial_extra_scopes_json TEXT NOT NULL,
          status TEXT NOT NULL,
          created_subagent_agent_id TEXT,
          failure_reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          decided_at TEXT,
          expires_at TEXT
        );

        CREATE TABLE auth_events (
          id TEXT PRIMARY KEY,
          conversation_id TEXT,
          agent_id TEXT,
          event_type TEXT NOT NULL,
          provider TEXT,
          status TEXT NOT NULL,
          details_json TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE lark_object_bindings (
          id TEXT PRIMARY KEY,
          channel_installation_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          branch_id TEXT NOT NULL,
          internal_object_kind TEXT NOT NULL,
          internal_object_id TEXT NOT NULL,
          lark_message_id TEXT,
          lark_open_message_id TEXT,
          lark_card_id TEXT,
          thread_root_message_id TEXT,
          card_element_id TEXT,
          last_sequence INTEGER,
          status TEXT NOT NULL DEFAULT 'active',
          metadata_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    } finally {
      legacy.close();
    }

    const upgraded = openStorageDatabase({ databasePath: dbPath, initializeSchema: true });
    try {
      const rows = upgraded.sqlite.prepare("PRAGMA table_info(harness_events)").all() as Array<{
        name: string;
      }>;
      const columnNames = rows.map((row) => row.name);

      expect(columnNames).toContain("event_type");
      expect(columnNames).toContain("run_id");
      expect(columnNames).toContain("source_kind");
      expect(columnNames).toContain("request_scope");
    } finally {
      upgraded.close();
      await rm(dbPath, { force: true });
    }
  });

  test("adds meditation_state table during schema upgrade", async () => {
    const dbPath = getTestDatabasePath(import.meta.url);
    await mkdir(path.dirname(dbPath), { recursive: true });

    const legacy = openStorageDatabase({ databasePath: dbPath, initializeSchema: false });
    try {
      legacy.sqlite.exec(`
        CREATE TABLE channel_instances (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          account_key TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    } finally {
      legacy.close();
    }

    const upgraded = openStorageDatabase({ databasePath: dbPath, initializeSchema: true });
    try {
      const rows = upgraded.sqlite.prepare("PRAGMA table_info(meditation_state)").all() as Array<{
        name: string;
      }>;
      const columnNames = rows.map((row) => row.name);

      expect(columnNames).toContain("id");
      expect(columnNames).toContain("running");
      expect(columnNames).toContain("last_started_at");
      expect(columnNames).toContain("last_finished_at");
      expect(columnNames).toContain("last_success_at");
      expect(columnNames).toContain("last_status");
      expect(columnNames).toContain("updated_at");
    } finally {
      upgraded.close();
      await rm(dbPath, { force: true });
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
            '{"scopes":[{"kind":"fs.read","path":"/Users/example/.pokeclaw/workspace/**"}]}',
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
          '{"scopes":[{"kind":"fs.read","path":"/Users/example/.pokeclaw/workspace/**"}]}',
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
          '{"scopes":[{"kind":"fs.write","path":"/Users/example/.pokeclaw/workspace/**"}]}',
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
          '{"kind":"fs.write","path":"/Users/example/.pokeclaw/workspace/**"}',
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
