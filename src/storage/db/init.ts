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
  upgradeMessagesSchema(sqlite);
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
