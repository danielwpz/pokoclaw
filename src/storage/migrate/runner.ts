import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type Database from "better-sqlite3";

import { toCanonicalUtcIsoTimestamp } from "@/src/shared/time.js";

const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9][a-z0-9_-]*)\.sql$/;

const SCHEMA_MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL CHECK (applied_at GLOB '????-??-??T??:??:??*Z' AND datetime(applied_at) IS NOT NULL)
)
`;

const BASELINE_REQUIRED_COLUMNS = new Map<string, readonly string[]>([
  ["channel_instances", ["id", "provider", "account_key", "created_at", "updated_at"]],
  ["conversations", ["id", "channel_instance_id", "external_chat_id", "kind", "created_at"]],
  ["conversation_branches", ["id", "conversation_id", "branch_key", "created_at"]],
  ["agents", ["id", "conversation_id", "kind", "created_at"]],
  ["sessions", ["id", "conversation_id", "branch_id", "purpose", "created_at", "updated_at"]],
  ["messages", ["id", "session_id", "seq", "payload_json", "created_at"]],
  [
    "approval_ledger",
    ["id", "owner_agent_id", "requested_scope_json", "approval_target", "status", "created_at"],
  ],
  ["agent_permission_grants", ["id", "owner_agent_id", "scope_json", "granted_by", "created_at"]],
  ["cron_jobs", ["id", "owner_agent_id", "schedule_kind", "payload_json", "created_at"]],
  ["task_runs", ["id", "run_type", "owner_agent_id", "status", "started_at"]],
]);

export interface StorageMigration {
  version: number;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
}

interface AppliedMigrationRow {
  version: number;
  name: string;
  checksum: string;
  applied_at: string;
}

export interface RunStorageMigrationsOptions {
  migrationsDir?: string;
  now?: () => Date;
}

export interface RunStorageMigrationsResult {
  latestVersion: number;
  newlyAppliedVersions: number[];
  stampedBaseline: boolean;
}

export function getDefaultStorageMigrationsDir(): string {
  return fileURLToPath(new URL("./files/", import.meta.url));
}

export function runStorageMigrations(
  sqlite: Database.Database,
  options: RunStorageMigrationsOptions = {},
): RunStorageMigrationsResult {
  const now = options.now ?? (() => new Date());
  const migrations = loadStorageMigrations(
    options.migrationsDir ?? getDefaultStorageMigrationsDir(),
  );
  const latestVersion = migrations.at(-1)?.version ?? 0;

  ensureSchemaMigrationsTable(sqlite);

  let appliedRows = listAppliedMigrations(sqlite);
  let stampedBaseline = false;

  if (appliedRows.length === 0 && hasExistingBaselineSchema(sqlite)) {
    // Pre-ledger databases cannot prove their original init SQL checksum, so
    // baseline stamping relies on structural compatibility with the current
    // baseline schema.
    assertBaselineSchemaCompatible(sqlite);
    insertAppliedMigration(sqlite, migrations[0], now());
    appliedRows = listAppliedMigrations(sqlite);
    stampedBaseline = true;
  }

  validateAppliedMigrations(appliedRows, migrations);

  const appliedVersionSet = new Set(appliedRows.map((row) => row.version));
  const newlyAppliedVersions: number[] = [];

  for (const migration of migrations) {
    if (appliedVersionSet.has(migration.version)) {
      continue;
    }

    applyMigration(sqlite, migration, now());
    newlyAppliedVersions.push(migration.version);
  }

  return {
    latestVersion,
    newlyAppliedVersions,
    stampedBaseline,
  };
}

export function loadStorageMigrations(migrationsDir: string): StorageMigration[] {
  const resolvedMigrationsDir = path.resolve(migrationsDir);

  if (!existsSync(resolvedMigrationsDir)) {
    throw new Error(`Storage migrations directory does not exist: ${resolvedMigrationsDir}`);
  }

  const migrations = readdirSync(resolvedMigrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .filter((entry) => !entry.name.startsWith("."))
    .flatMap((entry) => {
      if (!entry.name.endsWith(".sql")) {
        return [];
      }

      const match = MIGRATION_FILE_PATTERN.exec(entry.name);
      if (match == null) {
        throw new Error(
          `Invalid storage migration filename "${entry.name}". Expected NNNN_name.sql.`,
        );
      }

      const versionText = match[1];
      if (versionText == null) {
        throw new Error(`Invalid storage migration version in "${entry.name}".`);
      }

      const version = Number(versionText);
      if (!Number.isSafeInteger(version) || version < 1) {
        throw new Error(`Invalid storage migration version in "${entry.name}".`);
      }

      const name = match[2];
      if (name == null) {
        throw new Error(`Invalid storage migration name in "${entry.name}".`);
      }

      const sql = readFileSync(
        new URL(entry.name, pathToDirectoryUrl(resolvedMigrationsDir)),
        "utf8",
      );
      return [
        {
          version,
          name,
          filename: entry.name,
          sql,
          checksum: createHash("sha256").update(sql).digest("hex"),
        },
      ];
    })
    .sort((left, right) => left.version - right.version);

  if (migrations.length === 0) {
    throw new Error(`No storage migrations found in ${resolvedMigrationsDir}.`);
  }

  validateMigrationSequence(migrations);
  return migrations;
}

function pathToDirectoryUrl(input: string): URL {
  return pathToFileURL(input.endsWith("/") ? input : `${input}/`);
}

function validateMigrationSequence(migrations: readonly StorageMigration[]): void {
  const seenVersions = new Set<number>();

  migrations.forEach((migration, index) => {
    if (seenVersions.has(migration.version)) {
      throw new Error(`Duplicate storage migration version ${migration.version}.`);
    }
    seenVersions.add(migration.version);

    const expectedVersion = index + 1;
    if (migration.version !== expectedVersion) {
      throw new Error(
        `Storage migration version gap: expected ${formatMigrationVersion(expectedVersion)} but found ${migration.filename}.`,
      );
    }
  });
}

function ensureSchemaMigrationsTable(sqlite: Database.Database): void {
  sqlite.exec(SCHEMA_MIGRATIONS_TABLE_SQL);
}

function listAppliedMigrations(sqlite: Database.Database): AppliedMigrationRow[] {
  return sqlite
    .prepare(
      "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC",
    )
    .all() as AppliedMigrationRow[];
}

function validateAppliedMigrations(
  appliedRows: readonly AppliedMigrationRow[],
  migrations: readonly StorageMigration[],
): void {
  const latestKnownVersion = migrations.at(-1)?.version ?? 0;
  const migrationsByVersion = new Map(
    migrations.map((migration) => [migration.version, migration]),
  );

  appliedRows.forEach((row, index) => {
    if (row.version > latestKnownVersion) {
      throw new Error(
        `Database schema version ${row.version} is newer than this code supports (${latestKnownVersion}).`,
      );
    }

    const expectedVersion = index + 1;
    if (row.version !== expectedVersion) {
      throw new Error(
        `schema_migrations has a version gap: expected ${expectedVersion} but found ${row.version}.`,
      );
    }

    const migration = migrationsByVersion.get(row.version);
    if (migration == null) {
      throw new Error(`Applied storage migration ${row.version} is missing from code.`);
    }

    if (row.name !== migration.name) {
      throw new Error(
        `Applied storage migration ${row.version} name mismatch: DB has "${row.name}", code has "${migration.name}".`,
      );
    }

    if (row.checksum !== migration.checksum) {
      throw new Error(
        `Applied storage migration ${row.version} checksum mismatch. Migration files are immutable after release.`,
      );
    }
  });
}

function hasExistingBaselineSchema(sqlite: Database.Database): boolean {
  const requiredTableNames = [...BASELINE_REQUIRED_COLUMNS.keys()];
  const placeholders = requiredTableNames.map(() => "?").join(", ");
  const row = sqlite
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders}) LIMIT 1`,
    )
    .get(...requiredTableNames) as { name: string } | undefined;

  return row != null;
}

function assertBaselineSchemaCompatible(sqlite: Database.Database): void {
  for (const [tableName, requiredColumns] of BASELINE_REQUIRED_COLUMNS) {
    const tableRow = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName) as { name: string } | undefined;

    if (tableRow == null) {
      throw new Error(`Existing database is missing baseline table "${tableName}".`);
    }

    const columnRows = sqlite
      .prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
      .all() as Array<{
      name: string;
    }>;
    const columns = new Set(columnRows.map((row) => row.name));

    for (const columnName of requiredColumns) {
      if (!columns.has(columnName)) {
        throw new Error(
          `Existing database table "${tableName}" is missing baseline column "${columnName}".`,
        );
      }
    }
  }
}

function applyMigration(
  sqlite: Database.Database,
  migration: StorageMigration,
  appliedAt: Date,
): void {
  const apply = sqlite.transaction(() => {
    sqlite.exec(migration.sql);
    insertAppliedMigration(sqlite, migration, appliedAt);
  });

  apply();
}

function insertAppliedMigration(
  sqlite: Database.Database,
  migration: StorageMigration | undefined,
  appliedAt: Date,
): void {
  if (migration == null) {
    throw new Error("Cannot record baseline migration because version 1 is missing.");
  }

  sqlite
    .prepare(
      "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
    )
    .run(
      migration.version,
      migration.name,
      migration.checksum,
      toCanonicalUtcIsoTimestamp(appliedAt),
    );
}

function formatMigrationVersion(version: number): string {
  return version.toString().padStart(4, "0");
}

function quoteIdentifier(input: string): string {
  return `"${input.replaceAll('"', '""')}"`;
}
