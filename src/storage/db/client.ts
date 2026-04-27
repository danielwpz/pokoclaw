import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { getProductionDatabasePath } from "@/src/storage/db/paths.js";
import { applyDefaultPragmas } from "@/src/storage/db/pragmas.js";
import { runStorageMigrations } from "@/src/storage/migrate/runner.js";
import * as schema from "@/src/storage/schema/index.js";

export type StorageDb = BetterSQLite3Database<typeof schema>;

export interface OpenStorageDatabaseOptions {
  databasePath?: string;
  initializeSchema?: boolean;
  migrationsDir?: string;
  migrationClock?: () => Date;
}

export interface StorageDatabase {
  sqlite: Database.Database;
  db: StorageDb;
  close: () => void;
}

function ensureDatabaseDirectory(databasePath: string): void {
  const dir = path.dirname(databasePath);
  mkdirSync(dir, { recursive: true });
}

export function openStorageDatabase(options: OpenStorageDatabaseOptions = {}): StorageDatabase {
  const databasePath = options.databasePath ?? getProductionDatabasePath();
  const initializeSchema = options.initializeSchema ?? true;

  ensureDatabaseDirectory(databasePath);

  const sqlite = new Database(databasePath);
  applyDefaultPragmas(sqlite);

  try {
    if (initializeSchema) {
      runStorageMigrations(sqlite, {
        ...(options.migrationsDir == null ? {} : { migrationsDir: options.migrationsDir }),
        ...(options.migrationClock == null ? {} : { now: options.migrationClock }),
      });
    }

    const db = drizzle(sqlite, { schema });

    return {
      sqlite,
      db,
      close: (): void => {
        sqlite.close();
      },
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
