import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";

import { openStorageDatabase } from "@/src/storage/db/client.js";
import { getProductionDatabasePath, getTestDatabasePath } from "@/src/storage/db/paths.js";
import {
  getDefaultStorageMigrationsDir,
  runStorageMigrations,
} from "@/src/storage/migrate/runner.js";

const FIXED_NOW = new Date("2026-04-27T00:00:00.000Z");

const tempDirs: string[] = [];
const dbPaths: string[] = [];

interface LedgerRow {
  version: number;
  name: string;
  applied_at: string;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  await Promise.all(dbPaths.splice(0).map((dbPath) => removeSqliteFiles(dbPath)));
});

describe("storage migrations", () => {
  test("test database paths stay outside production storage", async () => {
    const dbPath = await createDbPath(import.meta.url);

    expect(dbPath).toContain(`${path.sep}.tmp${path.sep}test-db${path.sep}`);
    expect(dbPath).not.toBe(getProductionDatabasePath());
  });

  test("applies migrations to an empty database and records the ledger", async () => {
    const migrationsDir = await createMigrationDir({
      "0001_init.sql": `
        CREATE TABLE app_records (
          id TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `,
    });
    const dbPath = await createDbPath(import.meta.url);

    const storage = openStorageDatabase({
      databasePath: dbPath,
      migrationsDir,
      migrationNow: () => FIXED_NOW,
    });

    try {
      const tableRow = storage.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_records'")
        .get() as { name: string } | undefined;
      const ledgerRows = listLedgerRows(storage.sqlite);

      expect(tableRow?.name).toBe("app_records");
      expect(ledgerRows).toEqual([
        { version: 1, name: "init", applied_at: "2026-04-27T00:00:00.000Z" },
      ]);
    } finally {
      storage.close();
    }
  });

  test("applies pending migrations on a later open", async () => {
    const migrationsDir = await createMigrationDir({
      "0001_init.sql": `
        CREATE TABLE app_records (
          id TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `,
    });
    const dbPath = await createDbPath(import.meta.url);

    const firstStorage = openStorageDatabase({
      databasePath: dbPath,
      migrationsDir,
      migrationNow: () => FIXED_NOW,
    });
    firstStorage.close();

    await writeFile(
      path.join(migrationsDir, "0002_add_note.sql"),
      "ALTER TABLE app_records ADD COLUMN note TEXT;",
    );

    const secondStorage = openStorageDatabase({
      databasePath: dbPath,
      migrationsDir,
      migrationNow: () => FIXED_NOW,
    });

    try {
      const columns = secondStorage.sqlite
        .prepare("PRAGMA table_info(app_records)")
        .all() as Array<{ name: string }>;

      expect(columns.map((column) => column.name)).toContain("note");
      expect(listLedgerRows(secondStorage.sqlite).map((row) => row.version)).toEqual([1, 2]);
    } finally {
      secondStorage.close();
    }
  });

  test("does not re-run already applied migrations", async () => {
    const migrationsDir = await createMigrationDir({
      "0001_init.sql": `
        CREATE TABLE migration_effects (
          marker TEXT NOT NULL
        );

        INSERT INTO migration_effects (marker) VALUES ('v1');
      `,
    });
    const dbPath = await createDbPath(import.meta.url);

    const firstStorage = openStorageDatabase({ databasePath: dbPath, migrationsDir });
    firstStorage.close();

    const secondStorage = openStorageDatabase({ databasePath: dbPath, migrationsDir });

    try {
      const row = secondStorage.sqlite
        .prepare("SELECT count(*) AS count FROM migration_effects WHERE marker = 'v1'")
        .get() as { count: number };

      expect(row.count).toBe(1);
    } finally {
      secondStorage.close();
    }
  });

  test("rejects changed migration files after they have been applied", async () => {
    const migrationsDir = await createMigrationDir({
      "0001_init.sql": "CREATE TABLE app_records (id TEXT PRIMARY KEY);",
    });
    const dbPath = await createDbPath(import.meta.url);

    const firstStorage = openStorageDatabase({ databasePath: dbPath, migrationsDir });
    firstStorage.close();

    await writeFile(
      path.join(migrationsDir, "0001_init.sql"),
      "CREATE TABLE app_records (id TEXT PRIMARY KEY, value TEXT);",
    );

    expect(() => openStorageDatabase({ databasePath: dbPath, migrationsDir })).toThrow(
      /checksum mismatch/,
    );
  });

  test("rolls back a failed pending migration without recording its version", async () => {
    const migrationsDir = await createMigrationDir({
      "0001_init.sql": `
        CREATE TABLE app_records (
          id TEXT PRIMARY KEY
        );
      `,
    });
    const dbPath = await createDbPath(import.meta.url);

    const firstStorage = openStorageDatabase({ databasePath: dbPath, migrationsDir });
    firstStorage.close();

    await writeFile(
      path.join(migrationsDir, "0002_bad_change.sql"),
      `
        CREATE TABLE should_not_exist (
          id TEXT PRIMARY KEY
        );

        INSERT INTO missing_table (id) VALUES ('x');
      `,
    );

    expect(() => openStorageDatabase({ databasePath: dbPath, migrationsDir })).toThrow(
      /missing_table/,
    );

    const sqlite = new Database(dbPath);
    try {
      const tableRow = sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_not_exist'",
        )
        .get() as { name: string } | undefined;

      expect(tableRow).toBeUndefined();
      expect(listLedgerRows(sqlite).map((row) => row.version)).toEqual([1]);
    } finally {
      sqlite.close();
    }
  });

  test("rejects migration version gaps", async () => {
    const migrationsDir = await createMigrationDir({
      "0001_init.sql": "CREATE TABLE app_records (id TEXT PRIMARY KEY);",
      "0003_skip.sql": "CREATE TABLE skipped_records (id TEXT PRIMARY KEY);",
    });
    const dbPath = await createDbPath(import.meta.url);

    expect(() => openStorageDatabase({ databasePath: dbPath, migrationsDir })).toThrow(
      /version gap/,
    );
  });

  test("rejects invalid migration filenames", async () => {
    const migrationsDir = await createMigrationDir({
      "0001_init.sql": "CREATE TABLE app_records (id TEXT PRIMARY KEY);",
      "next.sql": "CREATE TABLE invalid_records (id TEXT PRIMARY KEY);",
    });
    const dbPath = await createDbPath(import.meta.url);

    expect(() => openStorageDatabase({ databasePath: dbPath, migrationsDir })).toThrow(
      /Invalid storage migration filename/,
    );
  });

  test("rejects databases newer than the current code", async () => {
    const migrationsDir = await createMigrationDir({
      "0001_init.sql": "CREATE TABLE app_records (id TEXT PRIMARY KEY);",
    });
    const dbPath = await createDbPath(import.meta.url);

    const sqlite = new Database(dbPath);
    sqlite.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );

      INSERT INTO schema_migrations (version, name, checksum, applied_at)
      VALUES (99, 'future', 'checksum', '2026-04-27T00:00:00.000Z');
    `);
    sqlite.close();

    expect(() => openStorageDatabase({ databasePath: dbPath, migrationsDir })).toThrow(
      /newer than this code supports/,
    );
  });

  test("baseline-stamps existing current-schema databases without re-running init", async () => {
    const dbPath = await createDbPath(import.meta.url);
    const sqlite = new Database(dbPath);

    try {
      sqlite.exec(
        readFileSync(path.join(getDefaultStorageMigrationsDir(), "0001_init.sql"), "utf8"),
      );

      const result = runStorageMigrations(sqlite, { now: () => FIXED_NOW });

      expect(result).toEqual({
        latestVersion: 1,
        appliedVersions: [],
        stampedBaseline: true,
      });
      expect(listLedgerRows(sqlite)).toEqual([
        { version: 1, name: "init", applied_at: "2026-04-27T00:00:00.000Z" },
      ]);
    } finally {
      sqlite.close();
    }
  });
});

async function createMigrationDir(files: Record<string, string>): Promise<string> {
  const root = path.join(process.cwd(), ".tmp", "test-migrations");
  await mkdir(root, { recursive: true });

  const dir = await mkdtemp(path.join(root, "case-"));
  tempDirs.push(dir);

  await Promise.all(
    Object.entries(files).map(([filename, content]) =>
      writeFile(path.join(dir, filename), content),
    ),
  );

  return dir;
}

async function createDbPath(testFileId: string): Promise<string> {
  const dbPath = getTestDatabasePath(testFileId);
  dbPaths.push(dbPath);
  await mkdir(path.dirname(dbPath), { recursive: true });
  return dbPath;
}

async function removeSqliteFiles(dbPath: string): Promise<void> {
  await Promise.all([
    rm(dbPath, { force: true }),
    rm(`${dbPath}-wal`, { force: true }),
    rm(`${dbPath}-shm`, { force: true }),
  ]);
}

function listLedgerRows(sqlite: Database.Database): LedgerRow[] {
  return sqlite
    .prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC")
    .all() as LedgerRow[];
}
