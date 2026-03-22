import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { type InitSchemaOptions, initSchemaIfNeeded } from "@/src/storage/db/init.js";
import { getProductionDatabasePath } from "@/src/storage/db/paths.js";
import { applyDefaultPragmas } from "@/src/storage/db/pragmas.js";
import * as schema from "@/src/storage/schema/index.js";

export type StorageDb = BetterSQLite3Database<typeof schema>;

export interface OpenStorageDatabaseOptions extends InitSchemaOptions {
  databasePath?: string;
  initializeSchema?: boolean;
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

  if (initializeSchema) {
    if (options.initSqlPath != null) {
      initSchemaIfNeeded(sqlite, { initSqlPath: options.initSqlPath });
    } else {
      initSchemaIfNeeded(sqlite);
    }
  }

  const db = drizzle(sqlite, { schema });

  return {
    sqlite,
    db,
    close: (): void => {
      sqlite.close();
    },
  };
}
