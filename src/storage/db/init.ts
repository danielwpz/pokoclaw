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
  sqlite.exec(initSql);
  upgradeCronJobsSchema(sqlite);
  upgradeMessagesSchema(sqlite);
  upgradeHarnessEventsSchema(sqlite);
  upgradeLarkObjectBindingsSchema(sqlite);
}

function upgradeCronJobsSchema(sqlite: Database.Database): void {
  const cronJobColumns = new Set(
    (
      sqlite.prepare("PRAGMA table_info(cron_jobs)").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  );

  if (!cronJobColumns.has("deleted_at")) {
    sqlite.exec("ALTER TABLE cron_jobs ADD COLUMN deleted_at TEXT");
  }
}

function upgradeMessagesSchema(sqlite: Database.Database): void {
  const messageColumns = new Set(
    (
      sqlite.prepare("PRAGMA table_info(messages)").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  );

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

function upgradeLarkObjectBindingsSchema(sqlite: Database.Database): void {
  const larkObjectBindingColumns = new Set(
    (
      sqlite.prepare("PRAGMA table_info(lark_object_bindings)").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  );

  if (!larkObjectBindingColumns.has("lark_message_uuid")) {
    sqlite.exec("ALTER TABLE lark_object_bindings ADD COLUMN lark_message_uuid TEXT");
  }

  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uidx_lark_object_bindings_message_uuid
      ON lark_object_bindings(channel_installation_id, lark_message_uuid);
  `);
}
