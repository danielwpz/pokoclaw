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
