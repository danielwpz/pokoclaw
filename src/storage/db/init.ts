import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

const SCHEMA_MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
    CHECK (applied_at GLOB '????-??-??T??:??:??*Z' AND datetime(applied_at) IS NOT NULL)
);
`;

function getDefaultMigrationsDirPath(): string {
  return path.resolve(process.cwd(), "src/storage/migrate/files");
}

export interface InitSchemaOptions {
  initSqlPath?: string;
  migrationsDirPath?: string;
}

export function initSchemaIfNeeded(
  sqlite: Database.Database,
  options: InitSchemaOptions = {},
): void {
  if (options.initSqlPath != null) {
    const initSql = readFileSync(options.initSqlPath, "utf8");
    sqlite.exec(initSql);
    return;
  }

  sqlite.exec(SCHEMA_MIGRATIONS_TABLE_SQL);

  const migrationsDirPath = options.migrationsDirPath ?? getDefaultMigrationsDirPath();
  const applied = new Set(
    (
      sqlite.prepare("SELECT version FROM schema_migrations ORDER BY version ASC").all() as Array<{
        version: string;
      }>
    ).map((row) => row.version),
  );

  for (const migration of listMigrationFiles(migrationsDirPath)) {
    if (applied.has(migration.version)) {
      continue;
    }

    const appliedAt = new Date().toISOString();
    const foreignKeysEnabled = isForeignKeysEnabled(sqlite);
    if (foreignKeysEnabled) {
      sqlite.pragma("foreign_keys = OFF");
    }

    sqlite.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      sqlite.exec(migration.sql);
      assertNoForeignKeyViolations(sqlite, migration.version);
      sqlite
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(migration.version, appliedAt);
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    } finally {
      if (foreignKeysEnabled) {
        sqlite.pragma("foreign_keys = ON");
      }
    }
  }
}

interface MigrationFile {
  version: string;
  sql: string;
}

function listMigrationFiles(migrationsDirPath: string): MigrationFile[] {
  return readdirSync(migrationsDirPath)
    .filter((entry) => /^\d+_.+\.sql$/u.test(entry))
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => ({
      version: entry.slice(0, -".sql".length),
      sql: readFileSync(path.join(migrationsDirPath, entry), "utf8"),
    }));
}

function isForeignKeysEnabled(sqlite: Database.Database): boolean {
  const value = sqlite.pragma("foreign_keys", { simple: true });
  return value === 1;
}

function assertNoForeignKeyViolations(sqlite: Database.Database, migrationVersion: string): void {
  const violations = sqlite.pragma("foreign_key_check") as Array<{
    table: string;
    rowid: number;
    parent: string;
    fkid: number;
  }>;
  if (violations.length === 0) {
    return;
  }

  const details = violations
    .map(
      (violation) =>
        `${violation.table}(rowid=${String(violation.rowid)}) -> ${violation.parent} [fk=${String(violation.fkid)}]`,
    )
    .join(", ");
  throw new Error(`Migration ${migrationVersion} introduced foreign key violations: ${details}`);
}
