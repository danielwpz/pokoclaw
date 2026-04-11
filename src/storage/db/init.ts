import { readFileSync } from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

function getDefaultInitSqlPath(): string {
  return path.resolve(process.cwd(), "src/storage/migrate/files/0001_init.sql");
}

export interface InitSchemaOptions {
  initSqlPath?: string;
}

export function initSchemaIfNeeded(
  sqlite: Database.Database,
  options: InitSchemaOptions = {},
): void {
  const initSqlPath = options.initSqlPath ?? getDefaultInitSqlPath();
  const initSql = readFileSync(initSqlPath, "utf8");
  upgradeTaskThreadSchema(sqlite);
  sqlite.exec(initSql);
  upgradeCronJobsSchema(sqlite);
  upgradeMessagesSchema(sqlite);
  upgradeHarnessEventsSchema(sqlite);
  upgradeMeditationStateSchema(sqlite);
  upgradeLarkObjectBindingsSchema(sqlite);
}

function upgradeTaskThreadSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS task_workstreams (
      id TEXT PRIMARY KEY,
      owner_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      branch_id TEXT NOT NULL REFERENCES conversation_branches(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'archived')),
      created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z' AND datetime(created_at) IS NOT NULL),
      updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z' AND datetime(updated_at) IS NOT NULL)
    );

    CREATE TABLE IF NOT EXISTS channel_threads (
      id TEXT PRIMARY KEY,
      channel_type TEXT NOT NULL,
      channel_installation_id TEXT NOT NULL,
      home_conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      external_chat_id TEXT NOT NULL,
      external_thread_id TEXT NOT NULL,
      subject_kind TEXT NOT NULL
        CHECK (subject_kind IN ('chat', 'task')),
      branch_id TEXT REFERENCES conversation_branches(id) ON DELETE CASCADE,
      task_workstream_id TEXT REFERENCES task_workstreams(id) ON DELETE CASCADE,
      opened_from_message_id TEXT,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'archived')),
      created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z' AND datetime(created_at) IS NOT NULL),
      updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z' AND datetime(updated_at) IS NOT NULL),
      CHECK (
        (subject_kind = 'chat' AND branch_id IS NOT NULL AND task_workstream_id IS NULL)
        OR (subject_kind = 'task' AND task_workstream_id IS NOT NULL AND branch_id IS NULL)
      ),
      UNIQUE(channel_type, channel_installation_id, external_chat_id, external_thread_id),
      UNIQUE(channel_type, branch_id),
      UNIQUE(channel_type, task_workstream_id)
    );
  `);

  const cronJobColumns = getColumnNames(sqlite, "cron_jobs");
  if (cronJobColumns.size > 0 && !cronJobColumns.has("workstream_id")) {
    sqlite.exec(
      "ALTER TABLE cron_jobs ADD COLUMN workstream_id TEXT REFERENCES task_workstreams(id) ON DELETE SET NULL",
    );
  }

  const taskRunColumns = getColumnNames(sqlite, "task_runs");
  if (taskRunColumns.size > 0 && !taskRunColumns.has("workstream_id")) {
    sqlite.exec(
      "ALTER TABLE task_runs ADD COLUMN workstream_id TEXT REFERENCES task_workstreams(id) ON DELETE SET NULL",
    );
  }
  if (taskRunColumns.size > 0 && !taskRunColumns.has("initiator_thread_id")) {
    sqlite.exec(
      "ALTER TABLE task_runs ADD COLUMN initiator_thread_id TEXT REFERENCES channel_threads(id) ON DELETE SET NULL",
    );
  }
}

function getColumnNames(sqlite: Database.Database, tableName: string): Set<string> {
  const table = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(tableName) as { name: string } | undefined;
  if (table == null) {
    return new Set();
  }

  return new Set(
    (
      sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  );
}

function upgradeCronJobsSchema(sqlite: Database.Database): void {
  const cronJobColumns = getColumnNames(sqlite, "cron_jobs");

  if (!cronJobColumns.has("deleted_at")) {
    sqlite.exec("ALTER TABLE cron_jobs ADD COLUMN deleted_at TEXT");
  }
}

function upgradeMessagesSchema(sqlite: Database.Database): void {
  const messageColumns = getColumnNames(sqlite, "messages");

  if (!messageColumns.has("channel_parent_message_id")) {
    sqlite.exec("ALTER TABLE messages ADD COLUMN channel_parent_message_id TEXT");
  }
  if (!messageColumns.has("channel_thread_id")) {
    sqlite.exec("ALTER TABLE messages ADD COLUMN channel_thread_id TEXT");
  }

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_channel_parent_msg
      ON messages(channel_parent_message_id);
    CREATE INDEX IF NOT EXISTS idx_messages_channel_thread
      ON messages(channel_thread_id);
  `);
}

function upgradeHarnessEventsSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS harness_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      run_id TEXT NOT NULL,
      session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      branch_id TEXT REFERENCES conversation_branches(id) ON DELETE SET NULL,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      task_run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
      cron_job_id TEXT REFERENCES cron_jobs(id) ON DELETE SET NULL,
      actor TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      request_scope TEXT NOT NULL,
      reason_text TEXT,
      details_json TEXT,
      created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z' AND datetime(created_at) IS NOT NULL)
    );

    CREATE INDEX IF NOT EXISTS idx_harness_events_run_time
      ON harness_events(run_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_harness_events_session_time
      ON harness_events(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_harness_events_conversation_time
      ON harness_events(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_harness_events_task_run_time
      ON harness_events(task_run_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_harness_events_type_time
      ON harness_events(event_type, created_at);
  `);
}

function upgradeMeditationStateSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS meditation_state (
      id TEXT PRIMARY KEY,
      running INTEGER NOT NULL DEFAULT 0,
      last_started_at TEXT,
      last_finished_at TEXT,
      last_success_at TEXT,
      last_status TEXT,
      updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z' AND datetime(updated_at) IS NOT NULL)
    );
  `);
}

function upgradeLarkObjectBindingsSchema(sqlite: Database.Database): void {
  const larkObjectBindingColumns = getColumnNames(sqlite, "lark_object_bindings");

  if (!larkObjectBindingColumns.has("lark_message_uuid")) {
    sqlite.exec("ALTER TABLE lark_object_bindings ADD COLUMN lark_message_uuid TEXT");
  }

  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uidx_lark_object_bindings_message_uuid
      ON lark_object_bindings(channel_installation_id, lark_message_uuid);
  `);
}
