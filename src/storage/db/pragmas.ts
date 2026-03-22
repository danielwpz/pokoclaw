import type Database from "better-sqlite3";

export function applyDefaultPragmas(sqlite: Database.Database): void {
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
}
