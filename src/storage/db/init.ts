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
}
